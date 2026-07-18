import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProtocolFabric } from "@kybernetria/pi-protocol";
import { FakeHost, StockTerminalHost, TermMuxHost } from "./hosts.js";
import { LaunchRegistry } from "./registry.js";
import type { AppConfig, Capability, LaunchRecord, LifecycleState, TerminalHandle, TerminalHost } from "./types.js";
import {
  absoluteDir,
  absoluteNewPath,
  branch,
  safeName,
  safeText,
  uuid,
  validateModel,
  validateThinking,
  workspaceMode,
} from "./validation.js";

const DEFAULT_REGISTRY = join(homedir(), ".pi/agent/pi-full-session/launches");
const HANDOFF_MAX_ITEMS = 20;
const HANDOFF_MAX_ITEM_BYTES = 32_768;
const HANDOFF_MAX_BYTES = 131_072;
const PRIVATE_FILE_MAX_BYTES = 1024 * 1024;
const GIT_OUTPUT_MAX_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

type PreparedHandoff = { id: string; contents: string };
type PreparedLaunch = {
  request: Record<string, any>;
  sourceCwd: string;
  model?: string;
  thinking?: string;
  name?: string;
  prompt?: string;
  executable: string;
  launchId: string;
  piSessionId: string;
  host: TerminalHost;
  capabilities: Capability[];
  handoff?: PreparedHandoff;
};

export async function loadConfig(): Promise<AppConfig> {
  const path = process.env.PI_FULL_SESSION_CONFIG || join(homedir(), ".pi/agent/pi-full-session.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`invalid PI_FULL_SESSION_CONFIG at ${path}: ${errorMessage(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("configuration must be an object");
  const config = raw as Record<string, unknown>;

  for (const [key, value] of Object.entries(config)) {
    if (key === "selectedHost") {
      if (value !== "stock" && value !== "term_mux") throw new Error("selectedHost must be stock or term_mux");
    } else if (key === "piCommand") {
      if (typeof value !== "string" || value.includes("\0")) throw new Error("piCommand must be a string without NUL bytes");
    } else if (key === "terminalCommand") {
      if (!Array.isArray(value) || value.length === 0 || value.some((v: unknown) => typeof v !== "string" || v.includes("\0"))) {
        throw new Error("terminalCommand must be a non-empty argv array without NUL bytes");
      }
    } else if (key === "termMux") {
      if (value !== undefined && (typeof value !== "object" || Array.isArray(value) || !value)) throw new Error("termMux must be an object or undefined");
    } else if (key === "allowedModels") {
      if (value !== undefined && (!Array.isArray(value) || value.some((v: unknown) => typeof v !== "string"))) throw new Error("allowedModels must be a string array");
    } else if (key === "allowedThinking") {
      if (value !== undefined && (!Array.isArray(value) || value.some((v: unknown) => typeof v !== "string"))) throw new Error("allowedThinking must be a string array");
    } else if (key === "registryDir") {
      if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new Error("registryDir must be an absolute path without NUL bytes");
    } else if (key === "maxRecords") {
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10_000) throw new Error("maxRecords must be an integer from 1 to 10000");
    } else if (key === "allowedReferenceTargets") {
      if (value !== undefined && (!Array.isArray(value) || value.some((v: unknown) => typeof v !== "string"))) throw new Error("allowedReferenceTargets must be a string array");
    } else if (key === "allowSnapshotEffects") {
      if (value !== undefined && typeof value !== "boolean") throw new Error("allowSnapshotEffects must be a boolean");
    } else if (key === "installDependencies") {
      if (value !== undefined && typeof value !== "boolean") throw new Error("installDependencies must be a boolean");
    }
  }
  return config as AppConfig;
}

export class FullSessionService {
  constructor(private readonly fabric: ProtocolFabric, private readonly config: AppConfig, private readonly injectedHost?: TerminalHost) {}

  private registry(): LaunchRegistry {
    return new LaunchRegistry(this.config.registryDir ?? DEFAULT_REGISTRY, this.config.maxRecords ?? 200);
  }

  private artifactDir(launchId: string): string {
    return join(this.config.registryDir ?? DEFAULT_REGISTRY, launchId);
  }

  private async resolveHost(requested: unknown): Promise<TerminalHost> {
    if (this.injectedHost) return this.injectedHost;
    const id = requested ?? this.config.selectedHost ?? "stock";
    if (id === "stock") return new StockTerminalHost(this.config.terminalCommand ?? []);
    if (id === "term_mux") return new TermMuxHost(this.config.termMux ?? {});
    throw new Error("requested terminal host is unavailable");
  }

  async launch(input: unknown): Promise<LaunchRecord> {
    const request = this.object(input, "launch input");
    const prepared = await this.prepareLaunch(request, false);
    return this.startPrepared(prepared, prepared.sourceCwd);
  }

  async worktree(input: unknown): Promise<LaunchRecord> {
    const request = this.object(input, "worktree input");
    const sourceCwd = await this.existingDirectory(absoluteDir(request.cwd));
    const requestedBranch = branch(request.branch);
    const requestedDestination = request.destination === undefined ? undefined : absoluteNewPath(request.destination);

    const repositoryRoot = await this.repositoryRoot(sourceCwd);
    await runGit(repositoryRoot, ["check-ref-format", "--branch", requestedBranch]);
    if (await this.localBranchExists(repositoryRoot, requestedBranch)) {
      throw new Error(`Git branch already exists: ${requestedBranch}; launch_worktree creates a new branch`);
    }

    const target = requestedDestination ?? this.defaultWorktreePath(repositoryRoot, requestedBranch);
    await this.assertMissingDestination(target);

    // Complete every non-Git preflight (including host handshake, model/name
    // validation, and handoff resolution) before creating a branch/worktree.
    const prepared = await this.prepareLaunch({ ...request, cwd: sourceCwd }, true);

    let gitAddCompleted = false;
    try {
      await runGit(repositoryRoot, ["worktree", "add", "-b", requestedBranch, target]);
      gitAddCompleted = true;

      // Install dependencies so project-local Pi extensions can resolve.
      if (this.config.installDependencies !== false) {
        await npmInstall(target);
      }

      const verifiedPath = await this.verifyCreatedWorktree(repositoryRoot, target, requestedBranch);
      return await this.startPrepared(prepared, verifiedPath, {
        path: verifiedPath,
        branch: requestedBranch,
        recovery: true,
      });
    } catch (error) {
      const destinationExists = await pathExists(target);
      const branchExists = await this.localBranchExists(repositoryRoot, requestedBranch).catch(() => false);
      if (gitAddCompleted || destinationExists || branchExists) {
        const retained = destinationExists ? ` Worktree destination: ${target}.` : "";
        const retainedBranch = branchExists ? ` Branch: ${requestedBranch}.` : "";
        throw new Error(`launch_worktree failed after Git side effects; inspect and recover them manually.${retained}${retainedBranch} Cause: ${errorMessage(error)}`);
      }
      throw error;
    }
  }

  async status(input: unknown): Promise<LaunchRecord & { hostStatus: unknown }> {
    const request = this.object(input, "status input");
    let record = await this.registry().get(String(request.launchId));
    const event = await this.latestLifecycle(record);
    if (event && record.state !== "ended" && (!record.lifecycle || Date.parse(event.at) > Date.parse(record.lifecycle.at))) {
      record = await this.registry().update(record.launchId, current => ({ ...current, state: event.state, lifecycle: event }));
    }

    let capabilities: Capability[] = [];
    let hostStatus: unknown = "unknown";
    try {
      const host = await this.resolveHost(record.terminal.host);
      capabilities = await this.usableCapabilities(host);
      if (capabilities.includes("status") && host.status) hostStatus = await host.status(record.terminal.handle);
    } catch (error) {
      // Persisted lifecycle and recovery data remain useful when a terminal
      // server is temporarily unavailable or its configuration has changed.
      hostStatus = { state: "unavailable", error: errorMessage(error) };
    }
    return { ...record, terminal: { ...record.terminal, capabilities }, hostStatus };
  }

  async stop(input: unknown): Promise<{ launchId: string; ok: true }> {
    const request = this.object(input, "stop input");
    const record = await this.registry().get(String(request.launchId));
    const host = await this.resolveHost(record.terminal.host);
    const capabilities = await this.usableCapabilities(host);
    if (!capabilities.includes("stop") || !host.stop) {
      throw new Error(`stop capability unavailable for ${record.terminal.host}; a launch-only terminal has no controllable child identity`);
    }
    await host.stop(record.terminal.handle);
    await this.registry().update(record.launchId, current => ({ ...current, state: "ended" }));
    return { launchId: record.launchId, ok: true };
  }

  private async prepareLaunch(request: Record<string, any>, worktree: boolean): Promise<PreparedLaunch> {
    const requestedWorkspace = workspaceMode(request.workspace);
    if (worktree && requestedWorkspace) throw new Error("launch_worktree does not accept workspace.mode");

    const sourceCwd = await this.existingDirectory(absoluteDir(request.cwd));
    const model = validateModel(request.model, this.config.allowedModels);
    const thinking = validateThinking(request.thinking, this.config.allowedThinking);
    const name = safeName(request.name);
    const prompt = safeText(request.initialPrompt, "initialPrompt");
    const executable = safeText(this.config.piCommand ?? "pi", "piCommand", 4096);
    if (!executable) throw new Error("piCommand must not be empty");

    const host = await this.resolveHost(request.terminal);
    const capabilities = await this.usableCapabilities(host);
    const handoff = await this.prepareHandoff(request.handoff);

    return {
      request,
      sourceCwd,
      model,
      thinking,
      name,
      prompt,
      executable,
      launchId: uuid(),
      piSessionId: uuid(),
      host,
      capabilities,
      handoff,
    };
  }

  private async startPrepared(
    prepared: PreparedLaunch,
    cwd: string,
    worktree?: { path: string; branch: string; recovery: boolean },
  ): Promise<LaunchRecord> {
    const finalCwd = await this.existingDirectory(cwd);
    const artifactDir = await this.createArtifactDir(prepared.launchId);
    let handle: TerminalHandle | undefined;
    try {
      const lifecycleKey = randomBytes(32).toString("hex");
      await this.writePrivate(join(artifactDir, ".lifecycle-key"), lifecycleKey);
      if (prepared.handoff) {
        await this.writePrivate(join(artifactDir, `handoff-${prepared.handoff.id}.json`), prepared.handoff.contents);
      }

      const lifecycleExtension = fileURLToPath(new URL("../extensions/lifecycle.ts", import.meta.url));
      const argv = [
        "--session-id", prepared.piSessionId,
        "--extension", lifecycleExtension,
        ...(prepared.name ? ["--name", prepared.name] : []),
        ...(prepared.model ? ["--model", prepared.model] : []),
        ...(prepared.thinking ? ["--thinking", prepared.thinking] : []),
        ...(prepared.prompt ? [prepared.prompt] : []),
      ];
      // Wrap Pi in a login shell so the pane stays alive as a working
      // terminal after the user quits Pi.  Arguments are passed as $@ to
      // avoid any shell escaping of the validated argv entries.
      const launchArgv = ["-c", '"$0" "$@" ; exec "${SHELL:-bash}" -l', prepared.executable, ...argv];
      const launchExecutable = "/bin/sh";
      const env = {
        PI_FULL_SESSION_LAUNCH_ID: prepared.launchId,
        PI_FULL_SESSION_LAUNCH_DIR: artifactDir,
        PI_FULL_SESSION_EVENT_KEY: lifecycleKey,
        PI_FULL_SESSION_PI_SESSION_ID: prepared.piSessionId,
        ...(prepared.handoff ? { PI_FULL_SESSION_HANDOFF_ID: prepared.handoff.id } : {}),
      };

      handle = await prepared.host.launch({
        executable: launchExecutable,
        argv: launchArgv,
        cwd: finalCwd,
        env,
        launchId: prepared.launchId,
      });

      const now = new Date().toISOString();
      const record: LaunchRecord = {
        version: 1,
        launchId: prepared.launchId,
        ownerUid: process.getuid?.() ?? -1,
        createdAt: now,
        updatedAt: now,
        state: "launched",
        piSessionId: prepared.piSessionId,
        cwd: finalCwd,
        ...(worktree ? {
          branch: worktree.branch,
          worktreePath: worktree.path,
          recovery: {
            worktreeCreated: worktree.recovery,
            note: "Worktree is retained; remove it manually only after confirming it is safe.",
          },
        } : {}),
        terminal: { host: prepared.host.id, handle, capabilities: prepared.capabilities },
        ...(prepared.handoff ? { handoffId: prepared.handoff.id } : {}),
      };
      await this.registry().save(record);
      return record;
    } catch (error) {
      if (!handle) {
        await rm(artifactDir, { recursive: true, force: true }).catch(() => undefined);
      } else if (prepared.capabilities.includes("stop") && prepared.host.stop) {
        // A process without a durable registry record would be orphaned. A
        // controllable host can roll it back; a stock terminal cannot.
        try {
          await prepared.host.stop(handle);
          await rm(artifactDir, { recursive: true, force: true });
        } catch { /* preserve artifacts if rollback itself fails */ }
      }
      throw error;
    }
  }

  private async prepareHandoff(value: unknown): Promise<PreparedHandoff | undefined> {
    if (value === undefined) return undefined;
    const handoff = this.object(value, "handoff");
    if (!Array.isArray(handoff.items) || handoff.items.length > HANDOFF_MAX_ITEMS) {
      throw new Error(`handoff.items must be an array containing at most ${HANDOFF_MAX_ITEMS} items`);
    }
    if (handoff.allowEffects !== undefined && typeof handoff.allowEffects !== "boolean") {
      throw new Error("handoff.allowEffects must be boolean");
    }

    const entries: unknown[] = [];
    const aliases = new Set<string>();
    for (const rawItem of handoff.items) {
      const item = this.object(rawItem, "handoff item");
      if (typeof item.target !== "string" || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(item.target)) {
        throw new Error("invalid handoff target");
      }
      if (typeof item.as !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(item.as)) throw new Error("invalid handoff alias");
      if (aliases.has(item.as)) throw new Error(`duplicate handoff alias: ${item.as}`);
      aliases.add(item.as);
      if (item.mode !== "snapshot" && item.mode !== "reference") throw new Error("invalid handoff mode");
      if (item.required !== undefined && typeof item.required !== "boolean") throw new Error("handoff required must be boolean");
      stringifyJson(item.input, `handoff input for ${item.target}`);

      const dot = item.target.lastIndexOf(".");
      const nodeId = item.target.slice(0, dot);
      const provide = item.target.slice(dot + 1);
      const spec = this.fabric.describeProvide(nodeId, provide);
      let entry: unknown;

      if (item.mode === "reference") {
        const available = Boolean(spec && this.config.allowedReferenceTargets?.includes(item.target));
        if (item.required && !available) throw new Error(`required reference handoff is unavailable: ${item.target}`);
        entry = {
          target: item.target,
          as: item.as,
          mode: "reference",
          input: item.input,
          available,
        };
      } else {
        if (!spec) throw new Error(`snapshot handoff target is unavailable: ${item.target}`);
        if ((spec.effects?.length || spec.policy?.confirmation === "required")
            && !(handoff.allowEffects === true && this.config.allowSnapshotEffects === true)) {
          throw new Error("snapshot handoff effects require caller approval and allowSnapshotEffects policy");
        }
        const traceId = `handoff_${uuid()}`;
        const result = await this.fabric.invoke({ nodeId, provide, input: item.input ?? {}, traceId });
        if (!result.ok) {
          if (item.required) throw new Error(`required handoff failed: ${result.error.message}`);
          entry = {
            target: item.target,
            as: item.as,
            mode: "snapshot",
            traceId,
            timestamp: new Date().toISOString(),
            error: result.error.message,
          };
        } else {
          const output = stringifyJson(result.output, "snapshot handoff output");
          const bounded = truncateUtf8(output, HANDOFF_MAX_ITEM_BYTES);
          entry = {
            target: item.target,
            as: item.as,
            mode: "snapshot",
            traceId,
            timestamp: new Date().toISOString(),
            output: bounded,
            truncated: Buffer.byteLength(output, "utf8") > HANDOFF_MAX_ITEM_BYTES,
          };
        }
      }

      const candidate = stringifyJson([...entries, entry], "handoff bundle");
      if (Buffer.byteLength(candidate, "utf8") > HANDOFF_MAX_BYTES) throw new Error("handoff bundle exceeds 128 KiB");
      entries.push(entry);
    }

    return { id: uuid(), contents: stringifyJson(entries, "handoff bundle") };
  }

  private async latestLifecycle(record: LaunchRecord): Promise<{ state: Exclude<LifecycleState, "launched">; at: string } | undefined> {
    let dir: string;
    try { dir = await this.verifyArtifactDir(record.launchId); }
    catch { return undefined; }

    let key: string;
    try { key = await this.readPrivate(join(dir, ".lifecycle-key"), 1024); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    let data: string;
    try { data = await this.readPrivate(join(dir, "lifecycle.ndjson"), PRIVATE_FILE_MAX_BYTES); }
    catch {
      // Lifecycle output is child-controlled. Unsafe, oversized, or malformed
      // data must not make persisted status unusable or advance state.
      return undefined;
    }

    let newest: { state: Exclude<LifecycleState, "launched">; at: string } | undefined;
    for (const line of data.split("\n")) {
      if (!line || Buffer.byteLength(line, "utf8") > 4096) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const signature = parsed.signature;
        const { signature: _ignored, ...unsigned } = parsed;
        if (parsed.launchId !== record.launchId || parsed.piSessionId !== record.piSessionId
            || typeof signature !== "string" || !["ready", "working", "idle", "ended"].includes(String(parsed.state))
            || typeof parsed.at !== "string" || Number.isNaN(Date.parse(parsed.at))) continue;
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
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("launch artifact directory is unsafe");
    }
    return realpath(dir);
  }

  private async writePrivate(path: string, contents: string): Promise<void> {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async readPrivate(path: string, maxBytes: number): Promise<string> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || info.size > maxBytes || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("private launch artifact is unsafe or oversized");
    }
    return readFile(path, "utf8");
  }

  private async existingDirectory(path: string, label = "cwd"): Promise<string> {
    await access(path, constants.R_OK | constants.X_OK);
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`${label} must be an existing directory`);
    return realpath(path);
  }

  private async repositoryRoot(cwd: string): Promise<string> {
    const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    if (!root) throw new Error("Git did not return a repository root");
    return this.existingDirectory(absoluteDir(root, "Git repository root"), "Git repository root");
  }

  private defaultWorktreePath(repositoryRoot: string, requestedBranch: string): string {
    const repositorySlug = basename(repositoryRoot).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "repository";
    const branchSlug = requestedBranch.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "branch";
    const branchHash = createHash("sha256").update(requestedBranch).digest("hex").slice(0, 10);
    const sibling = join(dirname(repositoryRoot), `${repositorySlug}-${branchSlug}-${branchHash}`);

    // Pi scans ~/.pi/agent/extensions/ for extension packages.  If the
    // repository lives there, its siblings would be auto-discovered and
    // fail to load because worktrees lack node_modules.  Place those
    // worktrees under a dedicated directory outside Pi's scan path.
    const extensionScanRoot = join(homedir(), ".pi", "agent", "extensions");
    if (sibling.startsWith(extensionScanRoot + "/") || sibling === extensionScanRoot) {
      const fallback = join(homedir(), "pi-worktrees", `${repositorySlug}-${branchSlug}-${branchHash}`);
      return fallback;
    }
    return sibling;
  }

  private async localBranchExists(repositoryRoot: string, requestedBranch: string): Promise<boolean> {
    const result = await runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${requestedBranch}`], [0, 1]);
    return result.code === 0;
  }

  private async verifyCreatedWorktree(repositoryRoot: string, target: string, requestedBranch: string): Promise<string> {
    const path = await this.existingDirectory(target, "created worktree");
    const topLevel = (await runGit(path, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const canonicalTopLevel = await this.existingDirectory(absoluteDir(topLevel, "created worktree root"), "created worktree root");
    if (canonicalTopLevel !== path) throw new Error("created worktree root does not match its requested destination");

    const checkedOutBranch = (await runGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    if (checkedOutBranch !== requestedBranch) throw new Error(`created worktree checked out unexpected branch: ${checkedOutBranch || "detached HEAD"}`);

    // -z avoids Git's path quoting rules, so spaces and non-ASCII paths can
    // be compared without guessing how core.quotePath is configured.
    const listing = (await runGit(repositoryRoot, ["worktree", "list", "--porcelain", "-z"])).stdout;
    const expectedRef = `refs/heads/${requestedBranch}`;
    // -z separates records with \0\0.  The final record may or may not be
    // terminated by an extra \0, so we strip a single trailing \0 if present
    // before splitting so the last record is never silently dropped.
    const normalized = listing.endsWith("\0") ? listing.slice(0, -1) : listing;
    const matched = normalized.split("\0\0").some(block => {
      if (!block) return false;
      const fields = block.split("\0");
      const worktreeField = fields.find(field => field.startsWith("worktree "));
      return worktreeField?.slice("worktree ".length) === path && fields.includes(`branch ${expectedRef}`);
    });
    if (!matched) throw new Error("Git did not register the requested path and branch as a linked worktree");
    return path;
  }

  private async assertMissingDestination(destination: string): Promise<void> {
    try {
      await lstat(destination);
      throw new Error(`worktree destination already exists: ${destination}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async usableCapabilities(host: TerminalHost): Promise<Capability[]> {
    const advertised = await host.capabilities();
    if (!Array.isArray(advertised)) throw new Error(`${host.id} returned invalid capabilities`);
    const known = new Set<Capability>(["status", "stop", "lifecycle_events"]);
    return [...new Set(advertised)].filter(capability => known.has(capability)).filter(capability =>
      capability === "status" ? Boolean(host.status)
        : capability === "stop" ? Boolean(host.stop)
          : true,
    );
  }

  private object(value: unknown, label: string): Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, any>;
  }
}

type GitResult = { code: number; stdout: string; stderr: string };

function runGit(cwd: string, args: string[], acceptedCodes: number[] = [0]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, result?: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result!);
    };
    const append = (current: Buffer, chunk: Buffer | string): Buffer => {
      const next = Buffer.concat([current, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (next.length > GIT_OUTPUT_MAX_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("Git output exceeded 1 MiB"));
      }
      return next;
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.on("error", error => finish(new Error(`could not execute Git: ${error.message}`)));
    child.on("exit", (code, signal) => {
      const exitCode = code ?? -1;
      const result = { code: exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
      if (acceptedCodes.includes(exitCode)) return finish(undefined, result);
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${exitCode}${signal ? ` (${signal})` : ""}`;
      finish(new Error(`git ${args.map(shellDisplay).join(" ")} failed: ${detail}`));
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`git ${args.map(shellDisplay).join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    timer.unref?.();
  });
}

function shellDisplay(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function stringifyJson(value: unknown, label: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return "null";
    return serialized;
  } catch (error) {
    throw new Error(`${label} is not JSON serializable: ${errorMessage(error)}`);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

async function npmInstall(cwd: string): Promise<void> {
  let useCi = false;
  try {
    await access(join(cwd, "package-lock.json"), constants.R_OK);
    useCi = true;
  } catch { /* npm install will generate one */ }

  return new Promise((resolve) => {
    // `npm ci` is the correct command for a fresh checkout with a lockfile.
    // `npm install` is the fallback.  Neither failure should block the
    // launch — the spawned Pi can still start, and missing dependencies
    // will surface as extension-load errors from Pi itself.
    const args = useCi
      ? ["ci", "--prefer-offline", "--no-audit", "--no-fund", "--no-progress"]
      : ["install", "--prefer-offline", "--no-audit", "--no-fund", "--no-progress"];
    const child = spawn("npm", args, { cwd, stdio: "pipe", timeout: 120_000 });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.on("error", () => resolve());
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      // Log a single line so the caller can see what happened but the
      // launch proceeds regardless.
      const summary = stderr.split("\n").filter(Boolean).slice(-2).join("; ") || `npm exit ${code}`;
      console.error(`pi-full-session: npm ${useCi ? "ci" : "install"} warning in ${cwd}: ${summary.slice(0, 500)}`);
      resolve();
    });
  });
}
