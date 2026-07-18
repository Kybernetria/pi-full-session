import { spawn } from "node:child_process";
import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import type { Capability, LaunchRequest, TerminalHandle, TerminalHost } from "./types.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateTransportCommand(command: string[]): string[] {
  if (!Array.isArray(command) || command.length === 0 || command.length > 64
      || command.some(value => typeof value !== "string" || value.length === 0 || value.includes("\0"))) {
    throw new Error("terminal command transport must be a non-empty argv array without NUL bytes");
  }
  return [...command];
}

function validateLaunchRequest(request: LaunchRequest): void {
  if (!request || typeof request !== "object") throw new Error("launch request must be an object");
  if (typeof request.executable !== "string" || !request.executable || request.executable.length > 4096 || request.executable.includes("\0")) {
    throw new Error("launch executable must be a bounded non-empty string without NUL bytes");
  }
  if (!Array.isArray(request.argv) || request.argv.length > 256
      || request.argv.some(value => typeof value !== "string" || value.includes("\0"))) {
    throw new Error("launch argv must contain at most 256 strings without NUL bytes");
  }
  if (Buffer.byteLength(request.argv.join(""), "utf8") > 128 * 1024) throw new Error("launch argv exceeds 128 KiB");
  if (typeof request.cwd !== "string" || !isAbsolute(request.cwd) || request.cwd.includes("\0")) {
    throw new Error("launch cwd must be an absolute path without NUL bytes");
  }
  const entries = Object.entries(request.env);
  if (entries.length > 128 || entries.some(([key, value]) => !ENVIRONMENT_NAME.test(key) || typeof value !== "string" || value.includes("\0"))) {
    throw new Error("launch env must contain at most 128 portable string entries");
  }
  if (entries.reduce((bytes, [key, value]) => bytes + Buffer.byteLength(key) + Buffer.byteLength(value), 0) > 128 * 1024) {
    throw new Error("launch env exceeds 128 KiB");
  }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 100 || value > 60_000) throw new Error("termMux.timeoutMs must be an integer from 100 to 60000");
  return value;
}

function runCommand(commandArgv: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandArgv[0], commandArgv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output ?? "");
    };
    const append = (current: Buffer, chunk: Buffer | string): Buffer => {
      const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (next.length > MAX_MESSAGE_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("term-mux command transport response exceeds 1 MiB"));
      }
      return next;
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.on("error", error => finish(new Error(`term-mux command transport failed: ${error.message}`)));
    child.on("exit", code => {
      if (code === 0) finish(undefined, stdout.toString("utf8"));
      else finish(new Error(stderr.toString("utf8").trim() || `term-mux command transport exited ${code}`));
    });
    child.stdin.on("error", error => finish(new Error(`term-mux command transport stdin failed: ${error.message}`)));
    child.stdin.end(input);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`term-mux command transport timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

export class StockTerminalHost implements TerminalHost {
  readonly id = "stock";
  private readonly terminal: string[];

  constructor(terminal: string[]) {
    this.terminal = validateTransportCommand(terminal);
  }

  async capabilities(): Promise<Capability[]> { return []; }

  async launch(request: LaunchRequest): Promise<TerminalHandle> {
    validateLaunchRequest(request);
    // Verify the terminal emulator is executable before spawning anything.
    await access(this.terminal[0], constants.X_OK).catch(error => {
      throw new Error(`terminal executable is not available: ${this.terminal[0]} (${errorMessage(error)})`);
    });
    const child = spawn(this.terminal[0], [...this.terminal.slice(1), request.executable, ...request.argv], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch(error => {
      throw new Error(`stock terminal failed to start: ${errorMessage(error)}`);
    });
    // Keep a listener after the initial spawn acknowledgement so a later
    // ChildProcess error cannot become an unhandled process event.
    child.on("error", () => undefined);
    child.unref();
    // A generic terminal emulator does not expose a stable surface identity.
    return {};
  }
}

/** Client for term-mux's versioned owner-only NDJSON control socket. */
export class TermMuxHost implements TerminalHost {
  readonly id = "term_mux";
  private readonly socketPath?: string;
  private readonly command?: string[];
  private readonly timeoutMs: number;
  private hello?: { capabilities: Capability[] };

  constructor(config: { socketPath?: string; command?: string[]; timeoutMs?: number }) {
    this.timeoutMs = boundedTimeout(config.timeoutMs);
    if (config.socketPath !== undefined) {
      if (typeof config.socketPath !== "string" || !isAbsolute(config.socketPath) || config.socketPath.includes("\0")) {
        throw new Error("termMux.socketPath must be an absolute path without NUL bytes");
      }
      this.socketPath = config.socketPath;
    } else if (config.command !== undefined) {
      this.command = validateTransportCommand(config.command);
    } else {
      const runtimeDir = process.env.XDG_RUNTIME_DIR
        ?? (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : undefined);
      if (!runtimeDir || !isAbsolute(runtimeDir)) throw new Error("term-mux socketPath or command must be configured");
      this.socketPath = join(runtimeDir, "term-mux", "term-mux.sock");
    }
  }

  private async verifySocket(): Promise<string> {
    const path = this.socketPath!;
    const info = await lstat(path).catch(error => {
      throw new Error(`term-mux control socket is unavailable at ${path}: ${errorMessage(error)}`);
    });
    if (!info.isSocket() || info.isSymbolicLink()) throw new Error("term-mux control path is not a Unix socket");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("term-mux control socket is owned by another user");
    if ((info.mode & 0o077) !== 0) throw new Error("term-mux control socket permissions are not private");
    return path;
  }

  private async socketRequest(message: string): Promise<string> {
    const path = await this.verifySocket();
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: Error, output?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(output ?? "");
      };
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_MESSAGE_BYTES) return finish(new Error("term-mux response exceeds 1 MiB"));
        const newline = buffer.indexOf(0x0a);
        if (newline >= 0) finish(undefined, buffer.subarray(0, newline).toString("utf8"));
      });
      socket.on("error", error => finish(new Error(`term-mux socket request failed: ${error.message}`)));
      socket.on("connect", () => socket.write(message, error => {
        if (error) finish(new Error(`term-mux socket write failed: ${error.message}`));
      }));
      socket.on("end", () => finish(new Error("term-mux closed the socket without a complete response")));
      const timer = setTimeout(() => finish(new Error(`term-mux request timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      timer.unref?.();
    });
  }

  private async request(action: string, argumentsValue: unknown): Promise<any> {
    const id = crypto.randomUUID();
    const message = `${JSON.stringify({ protocolVersion: 1, id, action, arguments: argumentsValue })}\n`;
    if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) throw new Error("term-mux request exceeds 1 MiB");
    const raw = this.socketPath
      ? await this.socketRequest(message)
      : await runCommand(this.command!, message, this.timeoutMs);
    const line = raw.trim().split("\n")[0];
    if (!line) throw new Error("term-mux returned no response");
    let response: any;
    try { response = JSON.parse(line); }
    catch (error) { throw new Error(`term-mux returned invalid JSON: ${errorMessage(error)}`); }
    if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("term-mux returned an invalid response envelope");
    if (response.protocolVersion !== 1) throw new Error("term-mux returned an unsupported protocol version");
    if (response.id !== id) throw new Error("term-mux response ID does not match the request");
    if (response.action !== action) throw new Error("term-mux response action does not match the request");
    if (response.ok !== true) {
      const code = typeof response.error?.code === "string" ? ` [${response.error.code}]` : "";
      const detail = typeof response.error?.message === "string" ? response.error.message : "request failed";
      throw new Error(`term-mux${code}: ${detail}`);
    }
    return response.data;
  }

  private async handshake(): Promise<{ capabilities: Capability[] }> {
    if (!this.hello) {
      const response = await this.request("integration.handshake", { protocol: "pi-full-session/1" });
      if (!response || typeof response !== "object" || response.protocol !== "pi-full-session/1"
          || !Array.isArray(response.capabilities) || response.capabilities.some((value: unknown) => typeof value !== "string")) {
        throw new Error("term-mux returned an invalid pi-full-session handshake");
      }
      const known: Capability[] = ["status", "stop", "lifecycle_events"];
      this.hello = {
        capabilities: response.capabilities.filter((value: string): value is Capability => known.includes(value as Capability)),
      };
    }
    return this.hello;
  }

  async capabilities(): Promise<Capability[]> { return [...(await this.handshake()).capabilities]; }

  async launch(request: LaunchRequest): Promise<TerminalHandle> {
    validateLaunchRequest(request);
    await this.handshake();
    const result = await this.request("process.launch", request);
    if (!result || typeof result !== "object" || !validHandleId(result.workspaceId) || !validHandleId(result.surfaceId)
        || result.backend !== "tmux") {
      throw new Error("term-mux launch returned no verified persistent tmux handle");
    }
    return {
      workspaceId: result.workspaceId,
      surfaceId: result.surfaceId,
      ...(validHandleId(result.processId) ? { processId: result.processId } : {}),
    };
  }

  async status(handle: TerminalHandle): Promise<unknown> {
    const id = this.surfaceId(handle);
    const result = await this.request("surface.status", { id });
    if (!result || typeof result !== "object" || result.surfaceId !== id) throw new Error("term-mux returned status for the wrong surface");
    return result;
  }

  async stop(handle: TerminalHandle): Promise<void> {
    await this.request("surface.kill", { id: this.surfaceId(handle), interactive: false });
  }

  private surfaceId(handle: TerminalHandle): string {
    if (!validHandleId(handle.surfaceId)) throw new Error("term-mux handle has no valid surface ID");
    return handle.surfaceId;
  }
}

function validHandleId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0-\x1f\x7f]/.test(value);
}

/** Injectable contract fixture; it intentionally never starts a real process. */
export class FakeHost implements TerminalHost {
  readonly id = "fake";
  readonly launched: LaunchRequest[] = [];
  constructor(private readonly caps: Capability[] = ["status", "stop"]) {}
  async capabilities(): Promise<Capability[]> { return [...this.caps]; }
  async launch(request: LaunchRequest): Promise<TerminalHandle> {
    this.launched.push(request);
    return { workspaceId: "fake-workspace", surfaceId: `fake-${request.launchId}` };
  }
  async status(): Promise<unknown> { return { state: "running" }; }
  async stop(): Promise<void> {}
}
