async function invokeResult(fabric: { invokeTracked(request: any): Promise<any> }, request: any): Promise<any> {
  return (await fabric.invokeTracked(request)).result;
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProtocolFabric } from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest } from "@kybernetria/pi-protocol/contract";

const definition = parseProtocolManifest(
  await readFile(new URL("../pi.protocol.json", import.meta.url), "utf8"),
);
const launchResult = {
  launched: true,
  piSessionId: "22222222-2222-4222-8222-222222222222",
  cwd: "/repository",
};

function registeredFabric(handler: () => unknown = () => launchResult) {
  const fabric = createProtocolFabric({ confirmationBroker: { confirm: () => true } });
  fabric.install(definition, { handlers: { launch: handler } });
  return fabric;
}

test("manifest exposes one canonical bounded launch contract", () => {
  assert.equal(definition.manifest.node.id, "pi_full_session");
  assert.deepEqual(definition.manifest.provides.map((provide) => provide.name), ["launch"]);
  assert.equal(JSON.stringify(definition.manifest).includes("execution"), false);
  assert.deepEqual(definition.manifest.provides[0].effects, ["process.spawn", "system.configure"]);
  assert.deepEqual(Object.keys(definition.manifest.provides[0].inputSchema.properties ?? {}), ["cwd", "initialPrompt", "name"]);
  assert.doesNotThrow(() => registeredFabric());
});

test("representative launch input and output satisfy the schemas", async () => {
  const result = await invokeResult(registeredFabric(), {
    nodeId: "pi_full_session",
    provide: "launch",
    input: { cwd: "/repository", name: "schema audit", initialPrompt: "Continue the audit" },
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
});

test("canonical validation rejects malformed or deployment-authority input", async () => {
  for (const input of [{}, { cwd: 42 }, { cwd: "/repository", model: "provider/model" }]) {
    const result = await invokeResult(registeredFabric(), { nodeId: "pi_full_session", provide: "launch", input });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INPUT_INVALID");
  }
});

test("output schema rejects incomplete launch results", async () => {
  const result = await invokeResult(registeredFabric(() => ({ launched: true, cwd: "/repository" })), {
    nodeId: "pi_full_session", provide: "launch", input: { cwd: "/repository" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OUTPUT_INVALID");
});
