import { constants } from "node:fs";
import { appendFile, lstat, open, readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const launchId = process.env.PI_FULL_SESSION_LAUNCH_ID;
const launchDir = process.env.PI_FULL_SESSION_LAUNCH_DIR;
const eventKey = process.env.PI_FULL_SESSION_EVENT_KEY;
const piSessionId = process.env.PI_FULL_SESSION_PI_SESSION_ID;
const handoffId = process.env.PI_FULL_SESSION_HANDOFF_ID;

type State = "ready" | "working" | "idle" | "ended";

function validText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0"); }

/** Refuse poisoned inherited environment rather than writing anywhere outside the pre-created launch dir. */
async function trustedDir(): Promise<string | undefined> {
  if (!validText(launchDir) || !isAbsolute(launchDir) || resolve(launchDir) !== launchDir) return undefined;
  try {
    const info = await lstat(launchDir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return undefined;
    return launchDir;
  } catch { return undefined; }
}

async function emit(state: State): Promise<void> {
  if (!validText(launchId) || !validText(eventKey) || !validText(piSessionId)) return;
  const dir = await trustedDir();
  if (!dir) return;
  const event = { launchId, piSessionId, state, at: new Date().toISOString() };
  const signature = createHmac("sha256", eventKey).update(JSON.stringify(event)).digest("hex");
  const file = `${dir}/lifecycle.ndjson`;
  try {
    try {
      const existing = await lstat(file);
      if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0) return;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify({ ...event, signature })}\n`); } finally { await handle.close(); }
  } catch { /* lifecycle reporting must not break Pi */ }
}

async function injectHandoff(pi: ExtensionAPI): Promise<void> {
  const dir = await trustedDir();
  if (!dir || !validText(handoffId) || !/^[0-9a-f-]{36}$/i.test(handoffId)) return;
  const file = `${dir}/handoff-${handoffId}.json`;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 131_072) return;
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
  pi.on("session_shutdown", () => emit("ended"));
  pi.on("input", () => { /* input alone cannot truthfully establish needs_input */ });
}
