import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { Capability, LaunchRequest, TerminalHandle, TerminalHost } from "./types.js";

function command(commandArgv: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!commandArgv.length) return reject(new Error("empty command transport"));
    const child = spawn(commandArgv[0], commandArgv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `command exited ${code}`)));
    child.stdin.end(input);
  });
}

export class StockTerminalHost implements TerminalHost {
  id = "stock";
  constructor(private terminal: string[]) {
    if (!terminal.length || terminal.some(item => typeof item !== "string" || item.includes("\0"))) throw new Error("stock terminalCommand must be configured as argv");
  }
  async capabilities(): Promise<Capability[]> { return []; }
  async launch(request: LaunchRequest): Promise<TerminalHandle> {
    const child = spawn(this.terminal[0], [...this.terminal.slice(1), request.executable, ...request.argv], {
      cwd: request.cwd, env: { ...process.env, ...request.env }, detached: true, stdio: "ignore",
    });
    child.unref();
    // A stock terminal launch gives no stable surface or controllable-process identity.
    return {};
  }
}

/** NDJSON adapter. Method names and all usable controls are negotiated with the running server. */
export class TermMuxHost implements TerminalHost {
  id = "term_mux";
  private hello?: { capabilities: Capability[] };
  constructor(private config: { socketPath?: string; command?: string[] }) {}

  private async request(method: string, params: unknown): Promise<any> {
    const message = `${JSON.stringify({ id: crypto.randomUUID(), method, params })}\n`;
    let raw: string;
    if (this.config.socketPath) {
      raw = await new Promise((resolve, reject) => {
        const socket = createConnection(this.config.socketPath!);
        let buffer = "";
        socket.on("data", chunk => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline >= 0) { socket.destroy(); resolve(buffer.slice(0, newline)); }
        });
        socket.on("error", reject);
        socket.on("connect", () => socket.write(message));
        socket.on("end", () => resolve(buffer));
      });
    } else if (this.config.command) {
      raw = await command(this.config.command, message);
    } else {
      throw new Error("term-mux socketPath or command must be configured");
    }
    const line = raw.trim().split("\n")[0];
    if (!line) throw new Error("term-mux returned no response");
    const response = JSON.parse(line);
    if (response.error) throw new Error(`term-mux: ${response.error.message ?? "request failed"}`);
    return response.result;
  }

  private async handshake(): Promise<{ capabilities: Capability[] }> {
    if (!this.hello) {
      const response = await this.request("handshake", { protocol: "pi-full-session/1" });
      if (!response || !Array.isArray(response.capabilities)) throw new Error("term-mux did not advertise capabilities");
      const known: Capability[] = ["focus", "send_input", "status", "stop", "lifecycle_events", "native_worktree"];
      this.hello = { capabilities: response.capabilities.filter((value: unknown): value is Capability => known.includes(value as Capability)) };
    }
    return this.hello;
  }

  async capabilities(): Promise<Capability[]> { return (await this.handshake()).capabilities; }
  async launch(request: LaunchRequest): Promise<TerminalHandle> {
    await this.handshake();
    const result = await this.request("launch", request);
    if (!result || typeof result !== "object" || (!result.workspaceId && !result.surfaceId)) throw new Error("term-mux launch returned no verified handle");
    return { workspaceId: result.workspaceId, surfaceId: result.surfaceId, processId: result.processId };
  }
  async focus(handle: TerminalHandle): Promise<void> { await this.request("focus", handle); }
  async sendInput(handle: TerminalHandle, text: string): Promise<void> { await this.request("send_input", { ...handle, text }); }
  async status(handle: TerminalHandle): Promise<unknown> { return this.request("status", handle); }
  async stop(handle: TerminalHandle): Promise<void> { await this.request("stop", handle); }
  async createWorktree(request: { cwd: string; branch: string; destination?: string }): Promise<{ path: string; branch: string }> {
    const result = await this.request("new_worktree", request);
    if (!result?.path || !result?.branch) throw new Error("term-mux returned invalid worktree");
    return result;
  }
}

/** Injectable contract fixture; it intentionally never starts a real process. */
export class FakeHost implements TerminalHost {
  id = "fake";
  launched: LaunchRequest[] = [];
  constructor(private caps: Capability[] = ["focus", "send_input", "status", "stop"]) {}
  async capabilities(): Promise<Capability[]> { return this.caps; }
  async launch(request: LaunchRequest): Promise<TerminalHandle> { this.launched.push(request); return { workspaceId: "fake-workspace", surfaceId: `fake-${request.launchId}` }; }
  async focus(): Promise<void> {}
  async sendInput(): Promise<void> {}
  async status(): Promise<unknown> { return { state: "running" }; }
  async stop(): Promise<void> {}
}
