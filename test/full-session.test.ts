import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extension.ts";
import { FullSessionService, loadConfig } from "../src/service.js";
import {
  readInheritedLaunchProvenance,
  withLaunchProvenanceEnvironment,
} from "../src/provenance.js";
import { createLaunchTool } from "../src/tools.js";
import { safeText, validateModel } from "../src/validation.js";

test("extension registers the ordinary launch tool", () => {
  const registered: string[] = [];
  extension({
    registerTool(definition: { name: string }) { registered.push(definition.name); },
    on() { return undefined; },
  } as never);
  assert.deepEqual(registered, ["pi_full_session_launch"]);
});

test("child session records inherited provenance once without adding conversation content", async () => {
  let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
  const appended: Array<{ type: string; data: unknown }> = [];
  extension({
    registerTool() { return undefined; },
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") sessionStart = handler;
    },
    appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
  } as never);
  assert.ok(sessionStart);

  const provenance = {
    schemaVersion: 1 as const,
    launchId: "launch-id",
    launchedAt: "2026-09-06T12:00:00.000Z",
    piSessionId: "pi-session-id",
    cwd: "/project",
    zellijSession: "zellij-session",
    originatingSessionId: "parent-session-id",
    originatingSessionFile: "/sessions/parent.jsonl",
    originatingToolCallId: "call-id",
  };
  const inheritedEnvironment = withLaunchProvenanceEnvironment({}, provenance);
  const keys = [
    "PI_FULL_SESSION_LAUNCH_ID",
    "PI_FULL_SESSION_LAUNCHED_AT",
    "PI_FULL_SESSION_PI_SESSION_ID",
    "PI_FULL_SESSION_CWD",
    "PI_FULL_SESSION_ZELLIJ_SESSION",
    "PI_FULL_SESSION_ORIGINATING_SESSION_ID",
    "PI_FULL_SESSION_ORIGINATING_SESSION_FILE",
    "PI_FULL_SESSION_ORIGINATING_TOOL_CALL_ID",
  ] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (inheritedEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = inheritedEnvironment[key];
    }
    const ctx = {
      sessionManager: {
        getEntries: () => [],
        getSessionId: () => "child-session-id",
        getSessionFile: () => "/sessions/child.jsonl",
      },
    };
    await sessionStart!({}, ctx);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].type, "pi-full-session.launch");
    assert.deepEqual(appended[0].data, {
      ...provenance,
      childSessionId: "child-session-id",
      childSessionFile: "/sessions/child.jsonl",
      recordedAt: (appended[0].data as { recordedAt: string }).recordedAt,
    });

    appended.length = 0;
    const duplicateCtx = {
      sessionManager: {
        getEntries: () => [{
          type: "custom",
          customType: "pi-full-session.launch",
          data: { launchId: provenance.launchId },
        }],
        getSessionId: () => "child-session-id",
        getSessionFile: () => "/sessions/child.jsonl",
      },
    };
    await sessionStart!({}, duplicateCtx);
    assert.deepEqual(appended, []);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pfs-"));
  const cwd = join(root, "cwd");
  const pi = join(root, "pi-test");
  await mkdir(cwd);
  await executable(pi, "process.exitCode = 0;");
  return { root, cwd, pi };
}

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
  await chmod(path, 0o700);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

test("tool returns a clear parent launch receipt and keeps launch success when receipt persistence fails", async () => {
  const { root, cwd, pi } = await fixture();
  const zellij = join(root, "receipt-zellij.cjs");
  await executable(zellij, "process.exitCode = 0;");
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ piCommand: pi, zellijCommand: zellij, zellijSession: "test" }));

  const previousConfig = process.env.PI_FULL_SESSION_CONFIG;
  process.env.PI_FULL_SESSION_CONFIG = config;
  try {
    let appended: unknown;
    const tool = createLaunchTool({
      appendEntry(_type: string, data: unknown) { appended = data; throw new Error("session is read-only"); },
    } as never);
    const result = await tool.execute("tool-call-id", { cwd }, undefined, undefined, {
      sessionManager: {
        getSessionId: () => "parent-session-id",
        getSessionFile: () => "/sessions/parent.jsonl",
        getHeader: () => ({ parentSession: "/sessions/root.jsonl" }),
      },
    } as never);
    assert.equal(result.details?.launched, true);
    assert.equal((result.details as { provenance: { originatingSessionId: string } }).provenance.originatingSessionId, "parent-session-id");
    assert.equal((appended as { originatingToolCallId: string }).originatingToolCallId, "tool-call-id");
    assert.match(result.content[0].type === "text" ? result.content[0].text : "", /\"launchId\"/);
  } finally {
    if (previousConfig === undefined) delete process.env.PI_FULL_SESSION_CONFIG;
    else process.env.PI_FULL_SESSION_CONFIG = previousConfig;
  }
});

test("launch opens a named Zellij tab with Pi and validated arguments", async () => {
  const { root, cwd, pi } = await fixture();
  const zellij = join(root, "zellij.cjs");
  const output = join(root, "output.json");
  await executable(zellij, `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2),env:{launchId:process.env.PI_FULL_SESSION_LAUNCH_ID,piSessionId:process.env.PI_FULL_SESSION_PI_SESSION_ID,parentSessionId:process.env.PI_FULL_SESSION_ORIGINATING_SESSION_ID,parentToolCallId:process.env.PI_FULL_SESSION_ORIGINATING_TOOL_CALL_ID}})); process.stdout.write("17\\n");`);

  const origin = {
    originatingSessionId: "parent-session-id",
    originatingSessionFile: "/sessions/parent.jsonl",
    originatingParentSessionFile: "/sessions/root.jsonl",
    originatingToolCallId: "call-parent-1",
  };
  const service = new FullSessionService({
    piCommand: pi,
    zellijCommand: zellij,
    allowedModels: ["provider/model"],
    allowedThinking: ["high"],
  }, { ...process.env, ZELLIJ_SESSION_NAME: "test-zellij" });
  const result = await service.launch({
    cwd,
    model: "provider/model",
    thinking: "high",
    name: "test session",
    initialPrompt: "hello; this is not shell",
  }, undefined, origin);

  const canonicalCwd = await realpath(cwd);
  assert.equal(result.launched, true);
  assert.equal(result.cwd, canonicalCwd);
  assert.match(result.piSessionId, /^[0-9a-f-]{36}$/i);
  assert.match(result.provenance.launchId, /^[0-9a-f-]{36}$/i);
  assert.match(result.provenance.launchedAt, /^20\d{2}-\d{2}-\d{2}T/);
  assert.deepEqual({
    ...result.provenance,
    launchedAt: undefined,
  }, {
    schemaVersion: 1,
    launchId: result.provenance.launchId,
    launchedAt: undefined,
    piSessionId: result.piSessionId,
    cwd: canonicalCwd,
    zellijSession: "test-zellij",
    ...origin,
  });
  const observed = JSON.parse(await readFile(output, "utf8")) as { cwd: string; argv: string[] };
  assert.equal(observed.cwd, canonicalCwd);
  const prefix = [
    "--session", "test-zellij", "action", "new-tab",
    "--cwd", canonicalCwd, "--name", "test session", "--close-on-exit", "--",
  ];
  assert.deepEqual(observed.argv.slice(0, prefix.length), prefix);
  if (process.platform !== "win32") {
    assert.match(observed.argv[prefix.length], /^\//);
    assert.deepEqual(observed.argv.slice(prefix.length + 1, observed.argv.indexOf(pi)), [
      `PI_FULL_SESSION_LAUNCH_ID=${result.provenance.launchId}`,
      `PI_FULL_SESSION_LAUNCHED_AT=${result.provenance.launchedAt}`,
      `PI_FULL_SESSION_PI_SESSION_ID=${result.piSessionId}`,
      `PI_FULL_SESSION_CWD=${canonicalCwd}`,
      "PI_FULL_SESSION_ZELLIJ_SESSION=test-zellij",
      `PI_FULL_SESSION_ORIGINATING_SESSION_ID=${origin.originatingSessionId}`,
      `PI_FULL_SESSION_ORIGINATING_SESSION_FILE=${origin.originatingSessionFile}`,
      `PI_FULL_SESSION_ORIGINATING_PARENT_SESSION_FILE=${origin.originatingParentSessionFile}`,
      `PI_FULL_SESSION_ORIGINATING_TOOL_CALL_ID=${origin.originatingToolCallId}`,
    ]);
  }
  assert.deepEqual(observed.argv.slice(observed.argv.indexOf(pi)), [
    pi, "--session-id", result.piSessionId,
    "--name", "test session", "--model", "provider/model",
    "--thinking", "high", "hello; this is not shell",
  ]);
});

test("configured Zellij session overrides the ambient session", async () => {
  const { root, cwd, pi } = await fixture();
  const zellij = join(root, "zellij.cjs");
  const output = join(root, "argv.json");
  await executable(zellij, `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);

  await new FullSessionService(
    { piCommand: pi, zellijCommand: zellij, zellijSession: "configured-zellij" },
    { ...process.env, ZELLIJ_SESSION_NAME: "ambient-zellij" },
  ).launch({ cwd });

  assert.deepEqual(JSON.parse(await readFile(output, "utf8")).slice(0, 2), ["--session", "configured-zellij"]);
});

test("launch rejects missing targets and CLI-reserved input prefixes", async () => {
  const { cwd, pi } = await fixture();
  await assert.rejects(
    () => new FullSessionService({ piCommand: pi }, {}).launch({ cwd }),
    /no Zellij session is available/,
  );
  await assert.rejects(
    () => new FullSessionService({ piCommand: pi }, { ZELLIJ_SESSION_NAME: "test" }).launch({ cwd, initialPrompt: "--help" }),
    /must not begin with '-' or '@'/,
  );
  await assert.rejects(
    () => new FullSessionService({ piCommand: pi }, { ZELLIJ_SESSION_NAME: "test" }).launch({ cwd, initialPrompt: "@/home/user/.ssh/id_rsa" }),
    /must not begin with '-' or '@'/,
  );
  await assert.rejects(
    () => new FullSessionService({ piCommand: pi }, { ZELLIJ_SESSION_NAME: "--help" }).launch({ cwd }),
    /ZELLIJ_SESSION_NAME must not begin with '-'/,
  );
  await assert.rejects(
    () => new FullSessionService({ piCommand: pi }, { ZELLIJ_SESSION_NAME: "test" }).launch({ cwd, name: "--help" }),
    /name contains unsupported characters, begins with '-'/,
  );
});

test("launch rejects disallowed values and a missing Pi executable", async () => {
  const { root, cwd, pi } = await fixture();
  await assert.rejects(
    () => new FullSessionService(
      { piCommand: pi, allowedModels: ["allowed/model"] },
      { ZELLIJ_SESSION_NAME: "test" },
    ).launch({ cwd, model: "other/model" }),
    /model is not permitted/,
  );
  await assert.rejects(
    () => new FullSessionService(
      { piCommand: join(root, "missing-pi"), zellijCommand: process.execPath },
      { ZELLIJ_SESSION_NAME: "test" },
    ).launch({ cwd }),
    /piCommand is not an executable file/,
  );
  assert.throws(() => validateModel("bad;rm", undefined));
  assert.throws(() => safeText("😀😀", "tiny", 7), /UTF-8 bytes/);
  await assert.rejects(
    () => new FullSessionService({ piCommand: pi }, { ZELLIJ_SESSION_NAME: "test" }).launch({ cwd: `/${"x".repeat(8_192)}` }),
    /UTF-8 bytes/,
  );
});

test("obsolete and oversized configuration gets an actionable error", async () => {
  const { root } = await fixture();
  const obsolete = join(root, "obsolete.json");
  await writeFile(obsolete, JSON.stringify({ selectedHost: "term_mux", termMux: { socketPath: "/tmp/obsolete" } }));
  await assert.rejects(() => loadConfig(obsolete), /term-mux configuration is obsolete.*current Zellij session/);

  const oversized = join(root, "oversized.json");
  await writeFile(oversized, JSON.stringify({ extra: "x".repeat(65 * 1024) }));
  await assert.rejects(() => loadConfig(oversized), /configuration exceeds 64 KiB/);
  await assert.rejects(() => loadConfig(root), /configuration path must be a regular file/);
});

test("Zellij startup and action failures are returned to the caller", async () => {
  const { root, cwd, pi } = await fixture();
  await assert.rejects(
    () => new FullSessionService(
      { piCommand: pi, zellijCommand: join(root, "missing-zellij"), zellijSession: "test" },
      process.env,
    ).launch({ cwd }),
    /zellijCommand is not an executable file/,
  );

  const zellij = join(root, "failing-zellij.cjs");
  await executable(zellij, `process.stderr.write("session not found\\n"); process.exitCode = 1;`);
  await assert.rejects(
    () => new FullSessionService(
      { piCommand: pi, zellijCommand: zellij, zellijSession: "missing" },
      process.env,
    ).launch({ cwd }),
    /client exited with code 1: session not found/,
  );
});

test("cancelling a launch kills and reaps the Zellij client", async () => {
  const { root, cwd, pi } = await fixture();
  const zellij = join(root, "cancelled-zellij.cjs");
  const pidFile = join(root, "cancelled-pid");
  await executable(zellij, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => undefined, 10_000);`);
  const controller = new AbortController();
  const launch = new FullSessionService({
    piCommand: pi,
    zellijCommand: zellij,
    zellijSession: "test",
    zellijTimeoutMs: 10_000,
  }, process.env).launch({ cwd }, controller.signal);
  for (let attempt = 0; attempt < 100 && !(await fileExists(pidFile)); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(await fileExists(pidFile), true);
  controller.abort();
  await assert.rejects(launch, error => error instanceof Error && error.name === "AbortError");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
});

test("cancellation after client exit does not signal its process group", async () => {
  const { root, cwd, pi } = await fixture();
  const zellij = join(root, "exited-zellij.cjs");
  const parentPidFile = join(root, "exited-parent-pid");
  const descendantPidFile = join(root, "exited-descendant-pid");
  await executable(zellij, `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    fs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));
    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 10000)"], {stdio: ["ignore", "inherit", "inherit"]});
    fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));
    process.exit(0);
  `);
  const controller = new AbortController();
  const launch = new FullSessionService({
    piCommand: pi,
    zellijCommand: zellij,
    zellijSession: "test",
    zellijTimeoutMs: 10_000,
  }, process.env).launch({ cwd }, controller.signal);
  let descendantPid: number | undefined;
  try {
    for (let attempt = 0; attempt < 100 && !(await fileExists(parentPidFile)); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(await fileExists(parentPidFile), true);
    for (let attempt = 0; attempt < 100 && !(await fileExists(descendantPidFile)); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(await fileExists(descendantPidFile), true);
    const parentPid = Number(await readFile(parentPidFile, "utf8"));
    descendantPid = Number(await readFile(descendantPidFile, "utf8"));
    let parentExited = false;
    for (let attempt = 0; attempt < 100 && !parentExited; attempt += 1) {
      try {
        process.kill(parentPid, 0);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        parentExited = true;
      }
      if (!parentExited) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(parentExited, true);
    controller.abort();
    await assert.rejects(launch, error => error instanceof Error && error.name === "AbortError");
    assert.doesNotThrow(() => process.kill(descendantPid!, 0));
  } finally {
    controller.abort();
    await launch.catch(() => undefined);
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
});

test("a hung Zellij client is killed and reaped before failure is returned", async () => {
  const { root, cwd, pi } = await fixture();
  const zellij = join(root, "hung-zellij.cjs");
  const pidFile = join(root, "pid");
  await executable(zellij, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => undefined, 10_000);`);
  await assert.rejects(
    () => new FullSessionService({
      piCommand: pi,
      zellijCommand: zellij,
      zellijSession: "test",
      // Allow the fake Node client to start even under parallel CI load.
      zellijTimeoutMs: 1_000,
    }, process.env).launch({ cwd }),
    /timed out after 1000ms; the tab launch outcome is unknown/,
  );

  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
});

test("timeout remains bounded when an exited client leaves inherited pipes open", async () => {
  const { root, cwd, pi } = await fixture();
  const zellij = join(root, "pipe-holder-zellij.cjs");
  await executable(zellij, `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => undefined, 10_000)"], {stdio:["ignore", "inherit", "inherit"]});`);

  const started = Date.now();
  await assert.rejects(
    () => new FullSessionService({
      piCommand: pi,
      zellijCommand: zellij,
      zellijSession: "test",
      zellijTimeoutMs: 100,
    }, process.env).launch({ cwd }),
    /timed out after 100ms; the tab launch outcome is unknown/,
  );
  assert.ok(Date.now() - started < 2_000, "timeout should not wait for inherited pipes");
});
