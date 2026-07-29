import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { absoluteDir, safeName, safeText, validateModel, validateThinking } from "./validation.js";

export type AppConfig = {
  piCommand?: string;
  zellijCommand?: string;
  zellijSession?: string;
  zellijTimeoutMs?: number;
  allowedModels?: string[];
  allowedThinking?: string[];
};

const DEFAULT_ZELLIJ_TIMEOUT_MS = 10_000;
const MAX_ZELLIJ_OUTPUT_BYTES = 16 * 1024;

export type LaunchResult = {
  launched: true;
  piSessionId: string;
  cwd: string;
};

export async function loadConfig(
  path = process.env.PI_FULL_SESSION_CONFIG || join(homedir(), ".pi/agent/pi-full-session.json"),
): Promise<AppConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readBoundedConfig(path));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`invalid PI_FULL_SESSION_CONFIG at ${path}: ${errorMessage(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("configuration must be an object");

  const config = raw as Record<string, unknown>;
  if ("selectedHost" in config || "termMux" in config) {
    throw new Error("term-mux configuration is obsolete; remove selectedHost and termMux (use {} to target the current Zellij session)");
  }
  if ("terminalCommand" in config) {
    throw new Error("terminalCommand is obsolete; pi-full-session now launches a tab through Zellij");
  }
  const supported = new Set([
    "piCommand", "zellijCommand", "zellijSession", "zellijTimeoutMs", "allowedModels", "allowedThinking",
  ]);
  for (const key of Object.keys(config)) {
    if (!supported.has(key)) throw new Error(`unsupported pi-full-session configuration key: ${key}`);
  }
  validateCommand(config.piCommand, "piCommand");
  validateCommand(config.zellijCommand, "zellijCommand");
  validateSessionName(config.zellijSession, "zellijSession");
  validateTimeout(config.zellijTimeoutMs);
  validateStringArray(config.allowedModels, "allowedModels");
  validateStringArray(config.allowedThinking, "allowedThinking");
  return config as AppConfig;
}

/** Launches Pi in a new tab of an existing Zellij session. It does not retain or control Pi. */
export class FullSessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async launch(input: unknown): Promise<LaunchResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("launch input must be an object");
    const request = input as Record<string, unknown>;
    const supported = new Set(["cwd", "model", "thinking", "name", "initialPrompt"]);
    for (const key of Object.keys(request)) {
      if (!supported.has(key)) throw new Error(`unsupported launch input: ${key}`);
    }
    const cwd = await existingDirectory(absoluteDir(request.cwd));
    const model = validateModel(request.model, this.config.allowedModels);
    const thinking = validateThinking(request.thinking, this.config.allowedThinking);
    const name = safeName(request.name);
    const prompt = safeText(request.initialPrompt, "initialPrompt");
    if (prompt && /^[\-@]/.test(prompt)) {
      throw new Error("initialPrompt must not begin with '-' or '@' because Pi would parse it as a CLI option or file argument");
    }
    const configuredPiCommand = validateCommand(this.config.piCommand ?? "pi", "piCommand")!;
    const configuredZellijCommand = validateCommand(this.config.zellijCommand ?? "zellij", "zellijCommand")!;
    const configuredSession = validateSessionName(this.config.zellijSession, "zellijSession");
    const ambientSession = configuredSession === undefined
      ? validateSessionName(this.environment.ZELLIJ_SESSION_NAME, "ZELLIJ_SESSION_NAME")
      : undefined;
    const zellijSession = configuredSession ?? ambientSession;
    if (!zellijSession) {
      throw new Error("no Zellij session is available; launch from inside Zellij or configure zellijSession");
    }
    const [piCommand, zellijCommand] = await Promise.all([
      resolveExecutable(configuredPiCommand, this.environment, "piCommand"),
      resolveExecutable(configuredZellijCommand, this.environment, "zellijCommand"),
    ]);

    const piSessionId = randomUUID();
    const piArgv = [
      "--session-id", piSessionId,
      ...(name ? ["--name", name] : []),
      ...(model ? ["--model", model] : []),
      ...(thinking ? ["--thinking", thinking] : []),
      ...(prompt ? [prompt] : []),
    ];
    const zellijArgv = [
      "--session", zellijSession,
      "action", "new-tab",
      "--cwd", cwd,
      ...(name ? ["--name", name] : []),
      "--close-on-exit",
      "--", piCommand, ...piArgv,
    ];

    await runZellij(zellijCommand, zellijArgv, cwd, this.environment, validateTimeout(this.config.zellijTimeoutMs))
      .catch(error => {
        throw new Error(`Zellij failed to launch Pi session ${piSessionId}: ${errorMessage(error)}`);
      });

    return { launched: true, piSessionId, cwd };
  }
}

function validateCommand(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 4096 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be a bounded non-empty string without control characters`);
  }
  return value;
}

function validateSessionName(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 256 || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be a non-empty string up to 256 UTF-8 bytes without control characters`);
  }
  const session = value.trim();
  if (session.startsWith("-")) throw new Error(`${name} must not begin with '-'`);
  return session;
}

async function resolveExecutable(
  command: string,
  environment: NodeJS.ProcessEnv,
  name: string,
): Promise<string> {
  if (command.includes("/") && !isAbsolute(command)) {
    throw new Error(`${name} must be an executable name or absolute path`);
  }
  const candidates = isAbsolute(command)
    ? [command]
    : (environment.PATH ?? "").split(delimiter)
      .filter(directory => isAbsolute(directory))
      .map(directory => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      if (/[\0-\x1f\x7f]/.test(canonical)) continue;
      await access(canonical, constants.X_OK);
      if ((await stat(canonical)).isFile()) return canonical;
    } catch {
      // Try the next absolute PATH entry.
    }
  }
  throw new Error(`${name} is not an executable file: ${command}`);
}

function validateTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_ZELLIJ_TIMEOUT_MS;
  if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 60_000) {
    throw new Error("zellijTimeoutMs must be an integer from 100 to 60000");
  }
  return value as number;
}

function runZellij(
  command: string,
  argv: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, argv, {
      cwd,
      env: environment,
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let exitObserved = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const append = (current: Buffer, chunk: Buffer | string): Buffer => {
      if (current.length >= MAX_ZELLIJ_OUTPUT_BYTES) return current;
      const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      return next.subarray(0, MAX_ZELLIJ_OUTPUT_BYTES);
    };

    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", error => finish(new Error(`client failed to start: ${error.message}`)));
    child.once("exit", () => {
      exitObserved = true;
      if (!timedOut) return;
      child.stdout.destroy();
      child.stderr.destroy();
      finish(new Error(`client timed out after ${timeoutMs}ms; the tab launch outcome is unknown`));
    });
    child.once("close", (code, signal) => {
      if (timedOut) return finish(new Error(`client timed out after ${timeoutMs}ms; the tab launch outcome is unknown`));
      if (code === 0) return finish();
      const detail = cleanDiagnostic(stderr.length ? stderr : stdout);
      if (signal) return finish(new Error(`client terminated by ${signal}${detail}`));
      return finish(new Error(`client exited with code ${code ?? "unknown"}${detail}`));
    });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          return finish(new Error(`client timed out and could not be killed: ${errorMessage(error)}`));
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      if (exitObserved) finish(new Error(`client timed out after ${timeoutMs}ms; the tab launch outcome is unknown`));
    }, timeoutMs);
    timer.unref?.();
  });
}

function cleanDiagnostic(value: Buffer): string {
  const text = value.toString("utf8")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? `: ${text}` : "";
}

function validateStringArray(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 512 || value.some(item =>
    typeof item !== "string" || Buffer.byteLength(item, "utf8") > 256 || /[\0-\x1f\x7f]/.test(item))) {
    throw new Error(`${name} must contain at most 512 strings of up to 256 UTF-8 bytes without control characters`);
  }
}

async function readBoundedConfig(path: string): Promise<string> {
  const limit = 64 * 1024;
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("configuration path must be a regular file");
    if (info.size > limit) throw new Error("configuration exceeds 64 KiB");
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error("configuration exceeds 64 KiB");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function existingDirectory(path: string): Promise<string> {
  await access(path, constants.R_OK | constants.X_OK);
  if (!(await stat(path)).isDirectory()) throw new Error("cwd must be an existing directory");
  return absoluteDir(await realpath(path));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
