import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProtocolFabric, ensureProtocolFabric } from "@kybernetria/pi-protocol";
import extension from "../extension.ts";
import { FakeHost } from "../src/hosts.js";
import { FullSessionService } from "../src/service.js";
import { branch, validateModel } from "../src/validation.js";

test("extension registers all handler-backed provides", () => {
  extension({} as never);
  assert.deepEqual(ensureProtocolFabric().describeNode("pi_full_session")?.provides.map(provide => provide.name), ["launch", "launch_worktree", "status", "focus", "send_input", "stop"]);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pfs-"));
  const cwd = join(root, "cwd");
  const registryDir = join(root, "registry");
  await mkdir(cwd);
  return { root, cwd, registryDir };
}

test("validation rejects unsafe branch, unconfigured models, and invalid workspace mode", async () => {
  assert.throws(() => branch("../bad"));
  assert.throws(() => validateModel("bad;rm", undefined));
  assert.throws(() => validateModel("x/y", ["a/b"]));
  assert.equal(branch("agent/good"), "agent/good");
  const { cwd, registryDir } = await fixture();
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, new FakeHost());
  await assert.rejects(() => service.launch({ cwd, workspace: { mode: "new_worktree" } }), /workspace.mode/);
});

test("launch uses argv, starts launched, and exposes honest fake controls", async () => {
  const { cwd, registryDir } = await fixture();
  const host = new FakeHost();
  const service = new FullSessionService(createProtocolFabric(), { registryDir, piCommand: "pi-test", allowedModels: ["provider/model"] }, host);
  const record = await service.launch({ cwd, initialPrompt: "hello; not shell", model: "provider/model", thinking: "medium", name: "safe name", workspace: { mode: "existing" } });
  assert.equal(record.state, "launched");
  assert.equal(host.launched[0].executable, "pi-test");
  assert.deepEqual(host.launched[0].argv.slice(0, 4), ["--session", record.piSessionId, "--extension", host.launched[0].argv[3]]);
  assert.ok(host.launched[0].argv.includes("hello; not shell"));
  assert.deepEqual((await service.status({ launchId: record.launchId })).hostStatus, { state: "running" });
  assert.deepEqual(await service.control("stop", { launchId: record.launchId }), { launchId: record.launchId, ok: true });
});

test("only private correctly signed newer lifecycle events advance state", async () => {
  const { cwd, registryDir } = await fixture();
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, new FakeHost());
  const record = await service.launch({ cwd });
  const key = await readFile(join(registryDir, record.launchId, ".lifecycle-key"), "utf8");
  const event = { launchId: record.launchId, piSessionId: record.piSessionId, state: "idle", at: new Date().toISOString() };
  const signature = createHmac("sha256", key).update(JSON.stringify(event)).digest("hex");
  const lifecycle = join(registryDir, record.launchId, "lifecycle.ndjson");
  await appendFile(lifecycle, `${JSON.stringify({ ...event, signature })}\n`);
  await chmod(lifecycle, 0o600);
  assert.equal((await service.status({ launchId: record.launchId })).state, "idle");
  const old = { ...event, state: "working", at: "2000-01-01T00:00:00.000Z" };
  const oldSignature = createHmac("sha256", key).update(JSON.stringify(old)).digest("hex");
  await appendFile(lifecycle, `${JSON.stringify({ ...old, signature: oldSignature })}\n`);
  assert.equal((await service.status({ launchId: record.launchId })).state, "idle");
  await chmod(lifecycle, 0o644);
  assert.equal((await service.status({ launchId: record.launchId })).state, "idle");
});

test("launch-only host refuses unsupported controls", async () => {
  const { cwd, registryDir } = await fixture();
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, new FakeHost([]));
  const record = await service.launch({ cwd });
  await assert.rejects(() => service.control("stop", { launchId: record.launchId }), /capability unavailable/);
});

test("snapshot handoff rejects effects and references require configured exposure", async () => {
  const { cwd, registryDir } = await fixture();
  const fabric = createProtocolFabric();
  fabric.register({ node: { nodeId: "x", purpose: "x", provides: [{ name: "y", description: "y", effects: ["file_write"], inputSchema: { type: "object" }, outputSchema: { type: "object" }, execution: { type: "handler", handler: "y" } }] }, handlers: { y: () => ({ value: "safe" }) } });
  const blocked = new FullSessionService(fabric, { registryDir }, new FakeHost());
  await assert.rejects(() => blocked.launch({ cwd, handoff: { items: [{ target: "x.y", as: "x", mode: "snapshot" }] } }), /effects/);
  const allowed = new FullSessionService(fabric, { registryDir, allowedReferenceTargets: ["x.y"] }, new FakeHost());
  const record = await allowed.launch({ cwd, handoff: { items: [{ target: "x.y", as: "ref", mode: "reference" }] } });
  const bundle = await readFile(join(registryDir, record.launchId, `handoff-${record.handoffId}.json`), "utf8");
  assert.match(bundle, /"available":true/);
});

test("worktree destination must not preexist", async () => {
  const { cwd, registryDir } = await fixture();
  const destination = join(cwd, "already-there");
  await mkdir(destination);
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, new FakeHost());
  await assert.rejects(() => service.worktree({ cwd, branch: "agent/test", destination }), /git rev-parse --is-inside-work-tree failed|destination already exists/);
});
