import { constants } from "node:fs";
import { appendFileSync, lstatSync, writeFileSync } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const launchId = process.env.PI_FULL_SESSION_LAUNCH_ID;
const launchDir = process.env.PI_FULL_SESSION_LAUNCH_DIR;
const eventKey = process.env.PI_FULL_SESSION_EVENT_KEY;
const piSessionId = process.env.PI_FULL_SESSION_PI_SESSION_ID;
const handoffId = process.env.PI_FULL_SESSION_HANDOFF_ID;
const MAX_LIFECYCLE_BYTES = 512 * 1024;

type State = "ready" | "working" | "idle" | "ended";

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

/** Refuse poisoned inherited environment rather than writing outside the pre-created launch directory. */
async function trustedDir(): Promise<string | undefined> {
  if (!validText(launchDir) || !isAbsolute(launchDir) || resolve(launchDir) !== launchDir) return undefined;
  try {
    const canonical = await realpath(launchDir);
    if (canonical !== launchDir) return undefined;
    const info = await lstat(canonical);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || !ownedByCurrentUser(info.uid)) return undefined;
    return canonical;
  } catch { return undefined; }
}

async function writeEvent(state: State): Promise<void> {
  if (!validText(launchId) || !validText(eventKey) || !validText(piSessionId)) return;
  const dir = await trustedDir();
  if (!dir) return;
  const event = { launchId, piSessionId, state, at: new Date().toISOString() };
  const signature = createHmac("sha256", eventKey).update(JSON.stringify(event)).digest("hex");
  const file = `${dir}/lifecycle.ndjson`;
  try {
    let truncate = false;
    try {
      const existing = await lstat(file);
      if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0 || !ownedByCurrentUser(existing.uid)) return;
      truncate = existing.size >= MAX_LIFECYCLE_BYTES;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
      | (truncate ? constants.O_TRUNC : constants.O_APPEND);
    const handle = await open(file, flags, 0o600);
    try { await handle.writeFile(`${JSON.stringify({ ...event, signature })}\n`); }
    finally { await handle.close(); }
  } catch { /* lifecycle reporting must not break Pi */ }
}

let emitQueue: Promise<void> = Promise.resolve();
let queueLength = 0;
const MAX_QUEUE = 256;
function emit(state: State): Promise<void> {
  // Drop events rather than growing an unbounded chain when writes stall.
  if (queueLength >= MAX_QUEUE) return Promise.resolve();
  queueLength++;
  emitQueue = emitQueue.then(() => writeEvent(state), () => writeEvent(state))
    .finally(() => { queueLength--; });
  return emitQueue;
}

function emitSync(state: State): void {
  // Called from session_shutdown where Pi does not await async listeners.
  // Uses synchronous I/O so the "ended" event is durable before the
  // process exits.  The write is a tiny append — safe to block briefly.
  queueLength = MAX_QUEUE; // suppress queued async writes
  writeEventSync(state);
}

function writeEventSync(state: State): void {
  if (!validText(launchId) || !validText(eventKey) || !validText(piSessionId)) return;
  // trustedDir is async (realpath), so replicate the essential checks inline.
  if (!validText(launchDir) || !isAbsolute(launchDir)) return;
  try {
    const info = lstatSync(launchDir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || !ownedByCurrentUser(info.uid)) return;
  } catch { return; }
  const event = { launchId, piSessionId, state, at: new Date().toISOString() };
  const signature = createHmac("sha256", eventKey!).update(JSON.stringify(event)).digest("hex");
  const file = `${launchDir}/lifecycle.ndjson`;
  try {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(file); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { writeFileSync(file, `${JSON.stringify({ ...event, signature })}\n`, { mode: 0o600, flag: "wx" }); }
        catch { /* best effort */ }
        return;
      }
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || !ownedByCurrentUser(stat.uid)) return;
    if (stat.size >= MAX_LIFECYCLE_BYTES) {
      try { writeFileSync(file, `${JSON.stringify({ ...event, signature })}\n`, { mode: 0o600, flag: "w" }); }
      catch { /* best effort */ }
    } else {
      try { appendFileSync(file, `${JSON.stringify({ ...event, signature })}\n`); }
      catch { /* best effort */ }
    }
  } catch { /* lifecycle reporting must not break Pi */ }
}

async function injectHandoff(pi: ExtensionAPI): Promise<void> {
  const dir = await trustedDir();
  if (!dir || !validText(handoffId) || !/^[0-9a-f-]{36}$/i.test(handoffId)) return;
  const file = `${dir}/handoff-${handoffId}.json`;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
        || !ownedByCurrentUser(info.uid) || info.size > 131_072) return;
    const raw = await readFile(file, "utf8");
    pi.sendMessage({
      customType: "pi_full_session.handoff",
      content: `Untrusted protocol handoff (inspect source, availability, and truncation metadata):\n${raw}`,
      display: true,
    });
  } catch { /* handoffs are optional */ }
}

export default function lifecycle(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    pi.appendEntry("pi_full_session.identity", { launchId, piSessionId, sessionId: ctx.sessionManager.getSessionId() });
    await injectHandoff(pi);
    await emit("ready");
  });
  pi.on("agent_start", () => emit("working"));
  pi.on("agent_settled", () => emit("idle"));
  pi.on("session_shutdown", () => emitSync("ended"));
  pi.on("input", () => { /* input alone cannot truthfully establish needs_input */ });
}
