import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { appendFile, chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { createProtocolFabric, ensureProtocolFabric } from "@kybernetria/pi-protocol";
import extension from "../extension.ts";
import { FakeHost, StockTerminalHost, TermMuxHost } from "../src/hosts.js";
import { FullSessionService } from "../src/service.js";
import { branch, safeText, validateModel } from "../src/validation.js";
import type { LaunchRequest, TerminalHandle } from "../src/types.js";

const execFileAsync = promisify(execFile);

test("extension registers only the supported handler-backed provides", () => {
  extension({} as never);
  assert.deepEqual(
    ensureProtocolFabric().describeNode("pi_full_session")?.provides.map(provide => provide.name),
    ["launch", "launch_worktree", "status", "stop"],
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pfs-"));
  const cwd = join(root, "cwd");
  const registryDir = join(root, "registry");
  await mkdir(cwd);
  return { root, cwd, registryDir };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

async function gitFixture() {
  const root = await mkdtemp(join(tmpdir(), "pfs-git-"));
  const repository = join(root, "repository");
  const registryDir = join(root, "registry");
  await mkdir(repository);
  await git(repository, ["init", "-q"]);
  await git(repository, ["config", "user.name", "Pi Full Session Tests"]);
  await git(repository, ["config", "user.email", "pi-full-session@example.invalid"]);
  await writeFile(join(repository, "tracked.txt"), "initial\n");
  await git(repository, ["add", "tracked.txt"]);
  await git(repository, ["commit", "-q", "-m", "initial"]);
  return { root, repository, registryDir };
}

async function privateSocketServer(
  root: string,
  responder: (request: Record<string, any>) => Record<string, any> | undefined,
): Promise<{ server: Server; socketPath: string; requests: Array<Record<string, any>> }> {
  const socketPath = join(root, "control.sock");
  const requests: Array<Record<string, any>> = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      const response = responder(request);
      if (response) socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  return { server, socketPath, requests };
}

async function closeServer(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

function success(request: Record<string, any>, data: unknown): Record<string, any> {
  return { protocolVersion: 1, id: request.id, ok: true, action: request.action, data };
}

test("validation rejects unsafe values, measures UTF-8 bytes, and accepts both launch workspace modes", async () => {
  assert.throws(() => branch("../bad"));
  assert.throws(() => validateModel("bad;rm", undefined));
  assert.throws(() => validateModel("x/y", ["a/b"]));
  assert.throws(() => safeText("😀😀", "tiny", 7), /UTF-8 bytes/);
  assert.equal(branch("agent/good"), "agent/good");

  const { cwd, registryDir } = await fixture();
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, new FakeHost());
  await assert.rejects(() => service.launch({ cwd, workspace: { mode: "new_worktree" } }), /workspace.mode/);
  assert.equal((await service.launch({ cwd, workspace: { mode: "none" } })).cwd, await realpath(cwd));
  assert.equal((await service.launch({ cwd, workspace: { mode: "existing" } })).cwd, await realpath(cwd));
});

test("launch uses argv, persists lifecycle identity, sanitizes legacy capabilities, and records stop", async () => {
  const { cwd, registryDir } = await fixture();
  const host = new FakeHost();
  const service = new FullSessionService(
    createProtocolFabric(),
    { registryDir, piCommand: "pi-test", allowedModels: ["provider/model"] },
    host,
  );
  const record = await service.launch({
    cwd,
    initialPrompt: "hello; not shell",
    model: "provider/model",
    thinking: "medium",
    name: "safe name",
    workspace: { mode: "existing" },
  });
  assert.equal(record.state, "launched");
  assert.equal(host.launched[0].executable, "/bin/sh");
  assert.equal(host.launched[0].argv[0], "-c");
  assert.match(host.launched[0].argv[1], /"\$0" "\$@" ; exec "\$\{SHELL:-bash\}" -l/);
  assert.equal(host.launched[0].argv[2], "pi-test");
  assert.equal(host.launched[0].argv[3], "--session-id");
  assert.ok(host.launched[0].argv.includes("hello; not shell"));
  assert.equal(host.launched[0].env.PI_FULL_SESSION_LAUNCH_ID, record.launchId);
  assert.deepEqual((await service.status({ launchId: record.launchId })).hostStatus, { state: "running" });

  const recordPath = join(registryDir, `${record.launchId}.json`);
  const legacyRecord = JSON.parse(await readFile(recordPath, "utf8"));
  legacyRecord.terminal.capabilities = ["focus", "send_input", "status", "stop", "native_worktree"];
  await writeFile(recordPath, JSON.stringify(legacyRecord));
  assert.deepEqual((await service.status({ launchId: record.launchId })).terminal.capabilities, ["status", "stop"]);

  assert.deepEqual(await service.stop({ launchId: record.launchId }), { launchId: record.launchId, ok: true });
  assert.equal((await service.status({ launchId: record.launchId })).state, "ended");
});

test("stock terminal launches argv without a shell and reports spawn failures", async () => {
  const { root } = await fixture();
  const terminal = join(root, "terminal.cjs");
  const output = join(root, "terminal-output.json");
  await writeFile(terminal, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.PFS_STOCK_OUTPUT, JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2),launchId:process.env.PI_FULL_SESSION_LAUNCH_ID}));\n`);
  await chmod(terminal, 0o700);

  const host = new StockTerminalHost([terminal]);
  await host.launch({
    executable: "/path/to/pi",
    argv: ["argument with spaces", ";not-shell"],
    cwd: root,
    env: { PFS_STOCK_OUTPUT: output, PI_FULL_SESSION_LAUNCH_ID: "launch-1" },
    launchId: "launch-1",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await readFile(output); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    cwd: root,
    argv: ["/path/to/pi", "argument with spaces", ";not-shell"],
    launchId: "launch-1",
  });

  const missing = new StockTerminalHost([join(root, "missing-terminal")]);
  await assert.rejects(() => missing.launch({ executable: "pi", argv: [], cwd: root, env: {}, launchId: "x" }), /terminal executable is not available/);
});

test("term-mux adapter enforces the documented envelope and persistent handle contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "pfs-term-mux-"));
  const fixture = await privateSocketServer(root, request => {
    const data = request.action === "integration.handshake"
      ? { protocol: "pi-full-session/1", capabilities: ["focus", "send_input", "status", "stop", "future"] }
      : request.action === "process.launch"
        ? { workspaceId: "workspace-1", surfaceId: "surface-1", backend: "tmux" }
        : request.action === "surface.status"
          ? { surfaceId: "surface-1", status: "running", backend: "tmux" }
          : {};
    return success(request, data);
  });
  try {
    const host = new TermMuxHost({ socketPath: fixture.socketPath });
    assert.deepEqual(await host.capabilities(), ["status", "stop"]);
    const handle = await host.launch({
      executable: "pi",
      argv: ["hello;not-shell"],
      cwd: root,
      env: { PFS_TEST: "yes" },
      launchId: "launch-1",
    });
    assert.deepEqual(handle, { workspaceId: "workspace-1", surfaceId: "surface-1" });
    assert.deepEqual(await host.status(handle), { surfaceId: "surface-1", status: "running", backend: "tmux" });
    await host.stop(handle);
  } finally {
    await closeServer(fixture.server);
  }
  assert.deepEqual(fixture.requests.map(request => request.action), [
    "integration.handshake", "process.launch", "surface.status", "surface.kill",
  ]);
  assert.ok(fixture.requests.every(request => request.protocolVersion === 1 && request.arguments && !request.method));
  assert.deepEqual(fixture.requests[1].arguments.argv, ["hello;not-shell"]);
  assert.deepEqual(fixture.requests[3].arguments, { id: "surface-1", interactive: false });
});

test("term-mux rejects mismatched responses, invalid handles, public sockets, and timeouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pfs-term-mux-errors-"));
  const mismatch = await privateSocketServer(root, request => ({
    ...success(request, { protocol: "pi-full-session/1", capabilities: [] }),
    id: "wrong-id",
  }));
  try {
    await assert.rejects(() => new TermMuxHost({ socketPath: mismatch.socketPath }).capabilities(), /response ID/);
  } finally { await closeServer(mismatch.server); }

  const publicRoot = await mkdtemp(join(tmpdir(), "pfs-term-mux-public-"));
  const publicSocket = await privateSocketServer(publicRoot, request => success(request, {}));
  await chmod(publicSocket.socketPath, 0o666);
  try {
    await assert.rejects(() => new TermMuxHost({ socketPath: publicSocket.socketPath }).capabilities(), /permissions are not private/);
  } finally { await closeServer(publicSocket.server); }

  const timeoutRoot = await mkdtemp(join(tmpdir(), "pfs-term-mux-timeout-"));
  const timeoutSocket = await privateSocketServer(timeoutRoot, () => undefined);
  try {
    await assert.rejects(() => new TermMuxHost({ socketPath: timeoutSocket.socketPath, timeoutMs: 100 }).capabilities(), /timed out/);
  } finally { await closeServer(timeoutSocket.server); }

  const invalidRoot = await mkdtemp(join(tmpdir(), "pfs-term-mux-handle-"));
  const invalidHandle = await privateSocketServer(invalidRoot, request => success(
    request,
    request.action === "integration.handshake"
      ? { protocol: "pi-full-session/1", capabilities: [] }
      : { workspaceId: "workspace", backend: "tmux" },
  ));
  try {
    const host = new TermMuxHost({ socketPath: invalidHandle.socketPath });
    await assert.rejects(() => host.launch({ executable: "pi", argv: [], cwd: invalidRoot, env: {}, launchId: "x" }), /verified persistent tmux handle/);
  } finally { await closeServer(invalidHandle.server); }
});

test("launch_worktree creates and verifies the exact branch from a nested repository cwd", async () => {
  const { repository, registryDir } = await gitFixture();
  const nested = join(repository, "src", "nested");
  await mkdir(nested, { recursive: true });
  const host = new FakeHost();
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, host);

  const record = await service.worktree({ cwd: nested, branch: "agent/deep-fix", initialPrompt: "inspect worktree" });
  const expected = record.worktreePath!;
  assert.equal(dirname(expected), dirname(repository));
  assert.match(basename(expected), /^repository-agent-deep-fix-[0-9a-f]{10}$/);
  assert.equal(record.cwd, await realpath(expected));
  assert.equal(record.branch, "agent/deep-fix");
  assert.equal(host.launched[0].cwd, await realpath(expected));
  assert.equal((await git(expected, ["symbolic-ref", "--short", "HEAD"])).trim(), "agent/deep-fix");
  assert.match(await git(repository, ["worktree", "list", "--porcelain"]), /branch refs\/heads\/agent\/deep-fix/);
});

test("launch_worktree completes launch preflight before creating Git state", async () => {
  const { root, repository, registryDir } = await gitFixture();
  const destination = join(root, "should-not-exist");
  const service = new FullSessionService(
    createProtocolFabric(),
    { registryDir, allowedModels: ["allowed/model"] },
    new FakeHost(),
  );
  await assert.rejects(
    () => service.worktree({ cwd: repository, branch: "agent/no-side-effect", destination, model: "other/model" }),
    /model is not permitted/,
  );
  await assert.rejects(() => readFile(destination), /ENOENT/);
  await assert.rejects(() => git(repository, ["show-ref", "--verify", "refs/heads/agent/no-side-effect"]));

  await assert.rejects(
    () => service.worktree({ cwd: repository, branch: "invalid.lock", destination }),
    /check-ref-format/,
  );
});

test("launch_worktree rejects existing destinations before host launch", async () => {
  const { root, repository, registryDir } = await gitFixture();
  const destination = join(root, "already-there");
  await mkdir(destination);
  const host = new FakeHost();
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, host);
  await assert.rejects(() => service.worktree({ cwd: repository, branch: "agent/test", destination }), /destination already exists/);
  assert.equal(host.launched.length, 0);
});

test("launch_worktree retains and precisely reports Git recovery state after terminal failure", async () => {
  class FailingHost extends FakeHost {
    override async launch(_request: LaunchRequest): Promise<TerminalHandle> { throw new Error("terminal unavailable"); }
  }
  const { root, repository, registryDir } = await gitFixture();
  const destination = join(root, "retained-worktree");
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, new FailingHost());
  await assert.rejects(
    () => service.worktree({ cwd: repository, branch: "agent/retained", destination }),
    error => {
      assert.match(String(error), /failed after Git side effects/);
      assert.match(String(error), new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(String(error), /agent\/retained/);
      assert.match(String(error), /terminal unavailable/);
      return true;
    },
  );
  assert.equal((await git(destination, ["symbolic-ref", "--short", "HEAD"])).trim(), "agent/retained");
});

test("launch_worktree passes the verified worktree cwd to a real term-mux protocol adapter", async () => {
  const { root, repository, registryDir } = await gitFixture();
  const terminalRoot = join(root, "terminal");
  await mkdir(terminalRoot);
  const fixture = await privateSocketServer(terminalRoot, request => success(
    request,
    request.action === "integration.handshake"
      ? { protocol: "pi-full-session/1", capabilities: ["status", "stop"] }
      : { workspaceId: "workspace-worktree", surfaceId: "surface-worktree", backend: "tmux" },
  ));
  try {
    const service = new FullSessionService(createProtocolFabric(), {
      registryDir,
      selectedHost: "term_mux",
      termMux: { socketPath: fixture.socketPath },
    });
    const destination = join(root, "term-mux-worktree");
    const record = await service.worktree({ cwd: repository, branch: "agent/term-mux", destination });
    const launchRequest = fixture.requests.find(request => request.action === "process.launch");
    assert.ok(launchRequest);
    assert.equal(launchRequest.arguments.cwd, await realpath(destination));
    assert.equal(launchRequest.arguments.launchId, record.launchId);
    assert.deepEqual(fixture.requests.map(request => request.action), ["integration.handshake", "process.launch"]);
  } finally { await closeServer(fixture.server); }
});

test("status remains useful when the recorded terminal host is unavailable", async () => {
  const { cwd, registryDir } = await fixture();
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, new FakeHost());
  const record = await service.launch({ cwd });
  const unavailable = new FullSessionService(createProtocolFabric(), {
    registryDir,
    selectedHost: "term_mux",
    termMux: { socketPath: join(dirname(registryDir), "missing.sock"), timeoutMs: 100 },
  });
  const stored = JSON.parse(await readFile(join(registryDir, `${record.launchId}.json`), "utf8"));
  stored.terminal.host = "term_mux";
  await writeFile(join(registryDir, `${record.launchId}.json`), JSON.stringify(stored));
  const status = await unavailable.status({ launchId: record.launchId });
  assert.equal(status.launchId, record.launchId);
  assert.deepEqual(status.terminal.capabilities, []);
  assert.match(String((status.hostStatus as any).error), /unavailable/);
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

test("launch-only host refuses unsupported stop", async () => {
  const { cwd, registryDir } = await fixture();
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, new FakeHost([]));
  const record = await service.launch({ cwd });
  await assert.rejects(() => service.stop({ launchId: record.launchId }), /capability unavailable/);
});

test("registry retention never prunes potentially running launch handles", async () => {
  const { cwd, registryDir } = await fixture();
  const service = new FullSessionService(createProtocolFabric(), { registryDir, maxRecords: 1 }, new FakeHost());
  const first = await service.launch({ cwd, name: "first" });
  const second = await service.launch({ cwd, name: "second" });
  assert.equal((await service.status({ launchId: first.launchId })).launchId, first.launchId);
  assert.equal((await service.status({ launchId: second.launchId })).launchId, second.launchId);

  await service.stop({ launchId: first.launchId });
  await assert.rejects(() => service.status({ launchId: first.launchId }), /ENOENT/);
  assert.equal((await service.status({ launchId: second.launchId })).launchId, second.launchId);
});

test("registry rejects an existing non-private directory instead of silently chmodding it", async () => {
  const { cwd, registryDir } = await fixture();
  await mkdir(registryDir);
  await chmod(registryDir, 0o755);
  const service = new FullSessionService(createProtocolFabric(), { registryDir }, new FakeHost());
  await assert.rejects(() => service.launch({ cwd }), /permissions are not private/);
});

test("snapshot handoffs enforce effects policy and bound the complete serialized bundle", async () => {
  const { cwd, registryDir } = await fixture();
  const fabric = createProtocolFabric();
  fabric.register({
    node: {
      nodeId: "x",
      purpose: "x",
      provides: [{
        name: "y",
        description: "y",
        effects: ["file_write"],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        execution: { type: "handler", handler: "y" },
      }],
    },
    handlers: { y: () => ({ value: "😀".repeat(20_000) }) },
  });
  const blocked = new FullSessionService(fabric, { registryDir }, new FakeHost());
  await assert.rejects(() => blocked.launch({
    cwd,
    handoff: { items: [{ target: "x.y", as: "x", mode: "snapshot" }] },
  }), /effects/);

  const allowed = new FullSessionService(
    fabric,
    { registryDir, allowSnapshotEffects: true, allowedReferenceTargets: ["x.y"] },
    new FakeHost(),
  );
  const record = await allowed.launch({
    cwd,
    handoff: {
      allowEffects: true,
      items: [
        { target: "x.y", as: "snapshot", mode: "snapshot" },
        { target: "x.y", as: "ref", mode: "reference" },
      ],
    },
  });
  const bundle = await readFile(join(registryDir, record.launchId, `handoff-${record.handoffId}.json`));
  assert.ok(bundle.length <= 131_072);
  assert.match(bundle.toString("utf8"), /"truncated":true/);
  assert.match(bundle.toString("utf8"), /"available":true/);
});
