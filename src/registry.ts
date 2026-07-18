import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { LaunchRecord } from "./types.js";

const PRIVATE_MASK = 0o077;
const STALE_LOCK_MS = 120_000;

/** A small user-owned JSON registry. It never accepts a record filename from callers. */
export class LaunchRegistry {
  constructor(readonly dir: string, readonly max = 200) {}

  private file(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid launch ID");
    return join(this.dir, `${id}.json`);
  }

  async init(): Promise<void> {
    try {
      const existing = await lstat(this.dir);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("registry directory must be a real directory");
      this.assertOwnedPrivate(existing, "registry directory", false);
      return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const created = await lstat(this.dir);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("registry directory must be a real directory");
    this.assertOwnedPrivate(created, "registry directory", false);
  }

  async save(record: LaunchRecord): Promise<void> {
    await this.withLock(async () => this.writeUnlocked(record));
  }

  async get(id: string): Promise<LaunchRecord> {
    await this.init();
    const file = this.file(id);
    const info = await lstat(file);
    this.assertOwnedPrivate(info, "launch record", true);
    let record: LaunchRecord;
    try {
      record = JSON.parse(await readFile(file, "utf8")) as LaunchRecord;
    } catch {
      throw new Error("launch record is malformed");
    }
    if (!record || typeof record !== "object" || record.version !== 1 || record.ownerUid !== this.uid()) {
      throw new Error("launch record has an invalid version or owner");
    }
    if (record.launchId !== id) throw new Error("launch record identity mismatch");
    if (typeof record.piSessionId !== "string" || typeof record.cwd !== "string"
        || !["launched", "ready", "working", "idle", "ended"].includes(record.state)
        || !record.terminal || typeof record.terminal !== "object" || typeof record.terminal.host !== "string") {
      throw new Error("launch record is missing required fields");
    }
    return record;
  }

  async update(id: string, mutate: (record: LaunchRecord) => LaunchRecord): Promise<LaunchRecord> {
    return this.withLock(async () => {
      const record = await this.get(id);
      const next = mutate(record);
      if (next.launchId !== id || next.ownerUid !== this.uid()) throw new Error("invalid launch record update");
      next.updatedAt = new Date().toISOString();
      await this.writeUnlocked(next);
      return next;
    });
  }

  private async writeUnlocked(record: LaunchRecord): Promise<void> {
    await this.init();
    if (record.ownerUid !== this.uid()) throw new Error("launch ownership mismatch");
    const file = this.file(record.launchId);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let writeError: unknown;
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } catch (error) {
      writeError = error;
    } finally {
      await handle.close();
    }
    if (writeError) {
      await unlink(temp).catch(() => undefined);
      throw writeError;
    }
    try { await rename(temp, file); }
    catch (error) { await unlink(temp).catch(() => undefined); throw error; }
    await this.pruneUnlocked();
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await this.init();
    const lock = join(this.dir, ".registry.lock");
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          await handle.writeFile(String(process.pid));
          return await work();
        } finally {
          await handle.close();
          await unlink(lock).catch(() => undefined);
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await lstat(lock);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("registry lock is unsafe");
          if (Date.now() - info.mtimeMs > STALE_LOCK_MS) await unlink(lock);
        } catch (lockError: unknown) {
          if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    throw new Error("registry lock unavailable");
  }

  private async pruneUnlocked(): Promise<void> {
    const files = (await readdir(this.dir)).filter(file => /^[0-9a-f-]{36}\.json$/i.test(file));
    if (files.length <= this.max) return;
    const ranked = await Promise.all(files.map(async file => {
      const path = join(this.dir, file);
      const info = await lstat(path);
      this.assertOwnedPrivate(info, "launch record", true);
      let ended = false;
      try { ended = (JSON.parse(await readFile(path, "utf8")) as { state?: unknown }).state === "ended"; }
      catch { /* malformed records are retained for manual inspection */ }
      return { file, time: (await stat(path)).mtimeMs, ended };
    }));
    // Never discard the only durable handle for a potentially running launch.
    // The registry may temporarily exceed max when too few ended records exist.
    const removable = ranked.filter(item => item.ended).sort((a, b) => a.time - b.time)
      .slice(0, Math.max(0, files.length - this.max));
    for (const item of removable) {
      await unlink(join(this.dir, item.file));
      const launchId = item.file.slice(0, -".json".length);
      const artifactDir = join(this.dir, launchId);
      try {
        const info = await lstat(artifactDir);
        if (info.isDirectory() && !info.isSymbolicLink() && (info.mode & PRIVATE_MASK) === 0
            && (typeof process.getuid !== "function" || info.uid === this.uid())) {
          await rm(artifactDir, { recursive: true });
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private uid(): number { return process.getuid?.() ?? -1; }

  private assertOwnedPrivate(info: Awaited<ReturnType<typeof lstat>>, label: string, regular: boolean): void {
    if (info.isSymbolicLink() || (regular && !info.isFile())) throw new Error(`${label} is not a regular private file`);
    if (typeof process.getuid === "function" && info.uid !== this.uid()) throw new Error(`${label} is owned by another user`);
    if ((Number(info.mode) & PRIVATE_MASK) !== 0) throw new Error(`${label} permissions are not private`);
  }
}
