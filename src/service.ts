import { access, chmod, lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ProtocolFabric } from "@kybernetria/pi-protocol";
import { FakeHost, StockTerminalHost, TermMuxHost } from "./hosts.js";
import { LaunchRegistry } from "./registry.js";
import type { AppConfig, Capability, LaunchRecord, LifecycleState, TerminalHost } from "./types.js";
import { absoluteDir, absoluteNewPath, branch, safeName, safeText, uuid, validateModel, validateThinking, workspaceMode } from "./validation.js";

const DEFAULT_REGISTRY = join(homedir(), ".pi/agent/pi-full-session/launches");
const HANDOFF_MAX_ITEMS = 20;
const HANDOFF_MAX_ITEM_BYTES = 32_768;
const HANDOFF_MAX_BYTES = 131_072;

export async function loadConfig(): Promise<AppConfig> {
  const path = process.env.PI_FULL_SESSION_CONFIG || join(homedir(), ".pi/agent/pi-full-session.json");
  try {
    const config = JSON.parse(await readFile(path, "utf8")) as AppConfig;
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("configuration must be an object");
    return config;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`invalid PI_FULL_SESSION_CONFIG: ${(error as Error).message}`);
  }
}

export class FullSessionService {
  constructor(private fabric: ProtocolFabric, private config: AppConfig, private injectedHost?: TerminalHost) {}

  private registry(): LaunchRegistry { return new LaunchRegistry(this.config.registryDir ?? DEFAULT_REGISTRY, this.config.maxRecords ?? 200); }
  private artifactDir(launchId: string): string { return join(this.config.registryDir ?? DEFAULT_REGISTRY, launchId); }

  private async resolveHost(requested: unknown): Promise<TerminalHost> {
    if (this.injectedHost) return this.injectedHost;
    const id = requested ?? this.config.selectedHost ?? "stock";
    if (id === "stock") return new StockTerminalHost(this.config.terminalCommand ?? []);
    if (id === "term_mux") return new TermMuxHost(this.config.termMux ?? {});
    throw new Error("requested terminal host is unavailable");
  }

  async launch(input: unknown, worktree?: { path: string; branch: string; recovery: boolean }): Promise<LaunchRecord> {
    const request = this.object(input, "launch input");
    const requestedWorkspace = workspaceMode(request.workspace);
    if (requestedWorkspace && requestedWorkspace !== "existing" && !worktree) throw new Error("launch only accepts workspace.mode none or existing");
    if (worktree && requestedWorkspace) throw new Error("launch_worktree does not accept workspace.mode");
    const cwd = absoluteDir(request.cwd);
    await access(cwd, constants.R_OK | constants.X_OK);
    const model = validateModel(request.model, this.config.allowedModels);
    const thinking = validateThinking(request.thinking, this.config.allowedThinking);
    const name = safeName(request.name);
    const prompt = safeText(request.initialPrompt, "initialPrompt");
    const launchId = uuid();
    const piSessionId = uuid();
    const host = await this.resolveHost(request.terminal);
    const capabilities = await this.usableCapabilities(host);
    const artifactDir = await this.createArtifactDir(launchId);
    const lifecycleKey = randomBytes(32).toString("hex");
    await this.writePrivate(join(artifactDir, ".lifecycle-key"), lifecycleKey);
    const handoffId = await this.handoff(request.handoff, artifactDir);
    const lifecycleExtension = fileURLToPath(new URL("../extensions/lifecycle.ts", import.meta.url));
    const argv = [
      "--session", piSessionId,
      "--extension", lifecycleExtension,
      ...(name ? ["--name", name] : []),
      ...(model ? ["--model", model] : []),
      ...(thinking ? ["--thinking", thinking] : []),
      ...(prompt ? [prompt] : []),
    ];
    const env = {
      PI_FULL_SESSION_LAUNCH_ID: launchId,
      PI_FULL_SESSION_LAUNCH_DIR: artifactDir,
      PI_FULL_SESSION_EVENT_KEY: lifecycleKey,
      PI_FULL_SESSION_PI_SESSION_ID: piSessionId,
      ...(handoffId ? { PI_FULL_SESSION_HANDOFF_ID: handoffId } : {}),
    };
    let handle;
    try {
      handle = await host.launch({ executable: this.config.piCommand ?? "pi", argv, cwd: worktree?.path ?? cwd, env, launchId });
    } catch (error) {
      if (worktree) throw new Error(`launch failed; worktree retained at ${worktree.path}: ${String(error)}`);
      throw error;
    }
    const now = new Date().toISOString();
    const record: LaunchRecord = {
      version: 1, launchId, ownerUid: process.getuid?.() ?? -1, createdAt: now, updatedAt: now,
      state: "launched", piSessionId, cwd: worktree?.path ?? cwd,
      ...(worktree ? { branch: worktree.branch, worktreePath: worktree.path, recovery: { worktreeCreated: worktree.recovery, note: "Worktree is retained; remove it manually after recovery." } } : {}),
      terminal: { host: host.id, handle, capabilities },
      ...(handoffId ? { handoffId } : {}),
    };
    await this.registry().save(record);
    return record;
  }

  async worktree(input: unknown): Promise<LaunchRecord> {
    const request = this.object(input, "worktree input");
    const cwd = absoluteDir(request.cwd);
    const requestedBranch = branch(request.branch);
    const destination = request.destination === undefined ? undefined : absoluteNewPath(request.destination);
    await access(cwd, constants.R_OK | constants.X_OK);
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (destination) await this.assertMissingDestination(destination);
    const host = await this.resolveHost(request.terminal);
    let created: { path: string; branch: string };
    if ((await this.usableCapabilities(host)).includes("native_worktree") && host.createWorktree) {
      created = await host.createWorktree({ cwd, branch: requestedBranch, destination });
    } else {
      const target = destination ?? join(resolve(cwd, ".."), requestedBranch.replaceAll("/", "-"));
      await this.assertMissingDestination(target);
      await git(cwd, ["worktree", "add", "-b", requestedBranch, target]);
      created = { path: target, branch: requestedBranch };
    }
    const verifiedPath = absoluteDir(created.path, "created worktree");
    await git(verifiedPath, ["rev-parse", "--is-inside-work-tree"]);
    return this.launch({ ...request, cwd: verifiedPath }, { path: verifiedPath, branch: created.branch, recovery: true });
  }

  async status(input: unknown): Promise<LaunchRecord & { hostStatus: unknown }> {
    const request = this.object(input, "status input");
    let record = await this.registry().get(String(request.launchId));
    const event = await this.latestLifecycle(record);
    if (event && record.state !== "ended" && (!record.lifecycle || Date.parse(event.at) > Date.parse(record.lifecycle.at))) {
      record = await this.registry().update(record.launchId, current => ({ ...current, state: event.state, lifecycle: event }));
    }
    const host = await this.resolveHost(record.terminal.host);
    const capabilities = await this.usableCapabilities(host);
    const hostStatus = capabilities.includes("status") && host.status ? await host.status(record.terminal.handle) : "unknown";
    return { ...record, hostStatus };
  }

  async control(kind: "focus" | "send_input" | "stop", input: unknown): Promise<{ launchId: string; ok: true }> {
    const request = this.object(input, "control input");
    const record = await this.registry().get(String(request.launchId));
    const host = await this.resolveHost(record.terminal.host);
    const capabilities = await this.usableCapabilities(host);
    if (!capabilities.includes(kind)) throw new Error(`${kind} capability unavailable for ${record.terminal.host}; stock launch-only terminals cannot be stopped honestly`);
    if (kind === "focus" && host.focus) await host.focus(record.terminal.handle);
    if (kind === "send_input" && host.sendInput) await host.sendInput(record.terminal.handle, safeText(request.text, "text")!);
    if (kind === "stop" && host.stop) await host.stop(record.terminal.handle);
    return { launchId: record.launchId, ok: true };
  }

  private async handoff(value: unknown, dir: string): Promise<string | undefined> {
    if (value === undefined) return undefined;
    const handoff = this.object(value, "handoff");
    if (!Array.isArray(handoff.items) || handoff.items.length > HANDOFF_MAX_ITEMS) throw new Error(`handoff.items must contain at most ${HANDOFF_MAX_ITEMS} items`);
    const entries: unknown[] = [];
    let size = 0;
    for (const rawItem of handoff.items) {
      const item = this.object(rawItem, "handoff item");
      if (typeof item.target !== "string" || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(item.target)) throw new Error("invalid handoff target");
      if (typeof item.as !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(item.as)) throw new Error("invalid handoff alias");
      if (item.mode !== "snapshot" && item.mode !== "reference") throw new Error("invalid handoff mode");
      const dot = item.target.lastIndexOf(".");
      const nodeId = item.target.slice(0, dot);
      const provide = item.target.slice(dot + 1);
      const spec = this.fabric.describeProvide(nodeId, provide);
      if (item.mode === "reference") {
        entries.push({ target: item.target, as: item.as, mode: "reference", input: item.input, available: Boolean(spec && this.config.allowedReferenceTargets?.includes(item.target)) });
        continue;
      }
      if (!spec) throw new Error(`snapshot handoff target is unavailable: ${item.target}`);
      if ((spec.effects?.length || spec.policy?.confirmation === "required") && !(handoff.allowEffects === true && this.config.allowSnapshotEffects === true)) {
        throw new Error("snapshot handoff effects require caller approval and allowSnapshotEffects policy");
      }
      const traceId = `handoff_${uuid()}`;
      const result = await this.fabric.invoke({ nodeId, provide, input: item.input ?? {}, traceId });
      if (!result.ok) {
        if (item.required) throw new Error(`required handoff failed: ${result.error.message}`);
        entries.push({ target: item.target, as: item.as, mode: "snapshot", traceId, timestamp: new Date().toISOString(), error: result.error.message });
        continue;
      }
      const output = JSON.stringify(result.output);
      const bounded = output.slice(0, HANDOFF_MAX_ITEM_BYTES);
      size += Buffer.byteLength(bounded);
      if (size > HANDOFF_MAX_BYTES) throw new Error("handoff bundle exceeds 128 KiB");
      entries.push({ target: item.target, as: item.as, mode: "snapshot", traceId, timestamp: new Date().toISOString(), output: bounded, truncated: Buffer.byteLength(output) > HANDOFF_MAX_ITEM_BYTES });
    }
    const id = uuid();
    await this.writePrivate(join(dir, `handoff-${id}.json`), JSON.stringify(entries));
    return id;
  }

  private async latestLifecycle(record: LaunchRecord): Promise<{ state: Exclude<LifecycleState, "launched">; at: string } | undefined> {
    const dir = await this.verifyArtifactDir(record.launchId);
    let key: string;
    try {
      key = await this.readPrivate(join(dir, ".lifecycle-key"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let data: string;
    try {
      data = await this.readPrivate(join(dir, "lifecycle.ndjson"));
    } catch {
      // A lifecycle event file is child-controlled/untrusted; an unsafe or
      // malformed one must not make status unusable or advance state.
      return undefined;
    }
    let newest: { state: Exclude<LifecycleState, "launched">; at: string } | undefined;
    for (const line of data.split("\n")) {
      if (!line || line.length > 4096) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const signature = parsed.signature;
        const { signature: _ignored, ...unsigned } = parsed;
        if (parsed.launchId !== record.launchId || parsed.piSessionId !== record.piSessionId || typeof signature !== "string" || !["ready", "working", "idle", "ended"].includes(String(parsed.state)) || typeof parsed.at !== "string" || Number.isNaN(Date.parse(parsed.at))) continue;
        const expected = createHmac("sha256", key).update(JSON.stringify(unsigned)).digest();
        const supplied = Buffer.from(signature, "hex");
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) continue;
        const event = { state: parsed.state as Exclude<LifecycleState, "launched">, at: parsed.at };
        if (!newest || Date.parse(event.at) > Date.parse(newest.at)) newest = event;
      } catch { /* malformed event is untrusted input */ }
    }
    return newest;
  }

  private async createArtifactDir(launchId: string): Promise<string> {
    await this.registry().init();
    const dir = this.artifactDir(launchId);
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
    return this.verifyArtifactDir(launchId);
  }

  private async verifyArtifactDir(launchId: string): Promise<string> {
    const dir = this.artifactDir(launchId);
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("launch artifact directory is unsafe");
    return dir;
  }

  private async writePrivate(path: string, contents: string): Promise<void> {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  }

  private async readPrivate(path: string): Promise<string> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("private launch artifact is unsafe");
    return readFile(path, "utf8");
  }

  private async assertMissingDestination(destination: string): Promise<void> {
    try { await lstat(destination); throw new Error("worktree destination already exists"); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async usableCapabilities(host: TerminalHost): Promise<Capability[]> {
    const advertised = await host.capabilities();
    return advertised.filter(capability =>
      capability === "focus" ? Boolean(host.focus) :
      capability === "send_input" ? Boolean(host.sendInput) :
      capability === "status" ? Boolean(host.status) :
      capability === "stop" ? Boolean(host.stop) :
      capability === "native_worktree" ? Boolean(host.createWorktree) : true,
    );
  }

  private object(value: unknown, label: string): Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, any>;
  }
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed`)));
  });
}
