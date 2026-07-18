import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProtocolFabric, registerProtocolManifest, type JsonSchemaLite, type PiProtocolManifest } from "@kybernetria/pi-protocol";

const manifest = JSON.parse(
  await readFile(new URL("../pi.protocol.json", import.meta.url), "utf8"),
) as PiProtocolManifest;

const timestamp = "2026-07-18T12:00:00.000Z";
const terminal = {
  host: "term_mux",
  handle: { workspaceId: "workspace-1", surfaceId: "surface-1", processId: "process-1" },
  capabilities: ["status", "lifecycle_events", "stop"],
};
const launchRecord = {
  version: 1,
  launchId: "11111111-1111-4111-8111-111111111111",
  ownerUid: 1000,
  createdAt: timestamp,
  updatedAt: timestamp,
  state: "launched",
  piSessionId: "22222222-2222-4222-8222-222222222222",
  cwd: "/repository",
  handoffId: "33333333-3333-4333-8333-333333333333",
  terminal,
};
const worktreeRecord = {
  ...launchRecord,
  cwd: "/repository-agent-schema",
  branch: "agent/schema",
  worktreePath: "/repository-agent-schema",
  recovery: { worktreeCreated: true, note: "Worktree is retained." },
};
const statusRecord = {
  ...worktreeRecord,
  state: "idle",
  lifecycle: { state: "idle", at: timestamp },
  hostStatus: { state: "unavailable", error: "terminal server unavailable" },
};

function handlers(overrides: Record<string, () => unknown> = {}) {
  return {
    launch: () => launchRecord,
    launch_worktree: () => worktreeRecord,
    status: () => statusRecord,
    stop: () => ({ launchId: launchRecord.launchId, ok: true }),
    ...overrides,
  };
}

function registeredFabric(overrides: Record<string, () => unknown> = {}) {
  const fabric = createProtocolFabric();
  registerProtocolManifest(fabric, { manifest, handlers: handlers(overrides) });
  return fabric;
}

async function invoke(provide: string, input: unknown) {
  return registeredFabric().invoke({ nodeId: manifest.nodeId, provide, input });
}

function assertSchemaLite(schema: JsonSchemaLite, path = "schema"): void {
  const supported = new Set(["type", "required", "properties", "items", "enum", "description"]);
  for (const key of Object.keys(schema)) assert.ok(supported.has(key), `${path}.${key} is not supported by JsonSchemaLite`);
  for (const [key, child] of Object.entries(schema.properties ?? {})) assertSchemaLite(child, `${path}.properties.${key}`);
  if (schema.items) assertSchemaLite(schema.items, `${path}.items`);
}

test("all provide schemas use only supported JsonSchemaLite keywords and executions are registered", () => {
  assert.deepEqual(manifest.provides.map(provide => provide.name), ["launch", "launch_worktree", "status", "stop"]);
  for (const provide of manifest.provides) {
    assertSchemaLite(provide.inputSchema, `${provide.name}.inputSchema`);
    assertSchemaLite(provide.outputSchema, `${provide.name}.outputSchema`);
  }
  assert.doesNotThrow(() => registeredFabric());
});

test("representative launch, worktree, status, and stop values satisfy their complete schemas", async () => {
  const cases = [
    ["launch", {
      cwd: "/repository",
      workspace: { mode: "existing" },
      terminal: "term_mux",
      model: "provider/model",
      thinking: "high",
      name: "schema audit",
      initialPrompt: "Continue the audit",
      handoff: { items: [{ target: "node.provide", input: { key: 1 }, as: "context", mode: "reference", required: false }] },
    }],
    ["launch_worktree", {
      cwd: "/repository/subdirectory",
      branch: "agent/schema",
      destination: "/repository-agent-schema",
      terminal: "term_mux",
      handoff: { allowEffects: true, items: [] },
    }],
    ["status", { launchId: launchRecord.launchId }],
    ["stop", { launchId: launchRecord.launchId }],
  ] as const;

  for (const [provide, input] of cases) {
    const result = await invoke(provide, input);
    assert.equal(result.ok, true, result.ok ? undefined : `${provide}: ${result.error.code} ${result.error.message}`);
  }
});

test("protocol validation rejects malformed representative inputs before handlers run", async () => {
  const cases = [
    ["launch", { cwd: "/repository", workspace: {} }, "input.workspace.mode is required"],
    ["launch", { cwd: "/repository", handoff: {} }, "input.handoff.items is required"],
    ["launch", { cwd: "/repository", handoff: { items: [{ target: "node.provide", as: "context" }] } }, "input.handoff.items[0].mode is required"],
    ["launch_worktree", { cwd: "/repository", branch: 42 }, "input.branch must be string"],
    ["status", { launchId: 42 }, "input.launchId must be string"],
    ["stop", {}, "input.launchId is required"],
  ] as const;

  for (const [provide, input, message] of cases) {
    const result = await invoke(provide, input);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, "INVALID_INPUT");
    assert.equal(result.error.message, message);
  }
});

test("complete output schemas reject incomplete launch records and invalid terminal capabilities", async () => {
  const missingOwner = registeredFabric({ launch: () => {
    const { ownerUid: _ownerUid, ...record } = launchRecord;
    return record;
  } });
  const missingResult = await missingOwner.invoke({ nodeId: manifest.nodeId, provide: "launch", input: { cwd: "/repository" } });
  assert.equal(missingResult.ok, false);
  if (!missingResult.ok) {
    assert.equal(missingResult.error.code, "INVALID_OUTPUT");
    assert.equal(missingResult.error.message, "output.ownerUid is required");
  }

  const badCapability = registeredFabric({ status: () => ({
    ...statusRecord,
    terminal: { ...terminal, capabilities: ["send_input"] },
  }) });
  const capabilityResult = await badCapability.invoke({ nodeId: manifest.nodeId, provide: "status", input: { launchId: launchRecord.launchId } });
  assert.equal(capabilityResult.ok, false);
  if (!capabilityResult.ok) {
    assert.equal(capabilityResult.error.code, "INVALID_OUTPUT");
    assert.match(capabilityResult.error.message, /output\.terminal\.capabilities\[0\] must be one of/);
  }
});
