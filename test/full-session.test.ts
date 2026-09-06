import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extension.ts";
import { FullSessionService, loadConfig } from "../src/service.js";
import { safeText, validateModel } from "../src/validation.js";

test("extension registers the ordinary launch tool", () => {
  const registered: string[] = [];
  extension({ registerTool(definition: { name: string }) { registered.push(definition.name); } } as never);
  assert.deepEqual(registered, ["pi_full_session_launch"]);
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

test("launch opens a named Zellij tab with Pi and validated arguments", async () => {
  const { root, cwd, pi } = await fixture();
  const zellij = join(root, "zellij.cjs");
  const output = join(root, "output.json");
  await executable(zellij, `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)})); process.stdout.write("17\\n");`);

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
  });

  const canonicalCwd = await realpath(cwd);
  assert.equal(result.launched, true);
  assert.equal(result.cwd, canonicalCwd);
  assert.match(result.piSessionId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    cwd: canonicalCwd,
    argv: [
      "--session", "test-zellij", "action", "new-tab",
      "--cwd", canonicalCwd, "--name", "test session", "--close-on-exit", "--",
      pi, "--session-id", result.piSessionId,
      "--name", "test session", "--model", "provider/model",
      "--thinking", "high", "hello; this is not shell",
    ],
  });
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
