import { chmod, lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
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
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const info = await lstat(this.dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("registry directory must be a real directory");
    this.assertOwnedPrivate(info, "registry directory", false);
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
    if (record.ownerUid !== this.uid()) throw new Error("launch is owned by another user");
    if (record.launchId !== id) throw new Error("launch record identity mismatch");
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
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    await chmod(file, 0o600);
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
    const ranked = await Promise.all(files.map(async file => ({ file, time: (await stat(join(this.dir, file))).mtimeMs })));
    for (const item of ranked.sort((a, b) => a.time - b.time).slice(0, files.length - this.max)) {
      const info = await lstat(join(this.dir, item.file));
      this.assertOwnedPrivate(info, "launch record", true);
      await unlink(join(this.dir, item.file));
    }
  }

  private uid(): number { return process.getuid?.() ?? -1; }

  private assertOwnedPrivate(info: Awaited<ReturnType<typeof lstat>>, label: string, regular: boolean): void {
    if (info.isSymbolicLink() || (regular && !info.isFile())) throw new Error(`${label} is not a regular private file`);
    if (typeof process.getuid === "function" && info.uid !== this.uid()) throw new Error(`${label} is owned by another user`);
    if ((Number(info.mode) & PRIVATE_MASK) !== 0) throw new Error(`${label} permissions are not private`);
  }
}
