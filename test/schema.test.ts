import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProtocolFabric, registerProtocolManifest, type JsonSchemaLite, type PiProtocolManifest } from "@kybernetria/pi-protocol";

const manifest = JSON.parse(
  await readFile(new URL("../pi.protocol.json", import.meta.url), "utf8"),
) as PiProtocolManifest;

const launchResult = {
  launched: true,
  piSessionId: "22222222-2222-4222-8222-222222222222",
  cwd: "/repository",
};

function registeredFabric(handler: () => unknown = () => launchResult) {
  const fabric = createProtocolFabric();
  registerProtocolManifest(fabric, { manifest, handlers: { launch: handler } });
  return fabric;
}

function assertSchemaLite(schema: JsonSchemaLite, path = "schema"): void {
  const supported = new Set(["type", "required", "properties", "items", "enum", "description"]);
  for (const key of Object.keys(schema)) assert.ok(supported.has(key), `${path}.${key} is not supported by JsonSchemaLite`);
  for (const [key, child] of Object.entries(schema.properties ?? {})) assertSchemaLite(child, `${path}.properties.${key}`);
  if (schema.items) assertSchemaLite(schema.items, `${path}.items`);
}

test("manifest exposes one handler-backed launch provide with supported schemas", () => {
  assert.deepEqual(manifest.provides.map(provide => provide.name), ["launch"]);
  assertSchemaLite(manifest.provides[0].inputSchema, "launch.inputSchema");
  assertSchemaLite(manifest.provides[0].outputSchema, "launch.outputSchema");
  assert.doesNotThrow(() => registeredFabric());
});

test("representative launch input and output satisfy the schemas", async () => {
  const result = await registeredFabric().invoke({
    nodeId: manifest.nodeId,
    provide: "launch",
    input: {
      cwd: "/repository",
      model: "provider/model",
      thinking: "high",
      name: "schema audit",
      initialPrompt: "Continue the audit",
    },
  });
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
});

test("protocol validation rejects malformed input before the handler runs", async () => {
  const missing = await registeredFabric().invoke({ nodeId: manifest.nodeId, provide: "launch", input: {} });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.message, "input.cwd is required");

  const malformed = await registeredFabric().invoke({ nodeId: manifest.nodeId, provide: "launch", input: { cwd: 42 } });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.message, "input.cwd must be string");
});

test("output schema rejects incomplete launch results", async () => {
  const result = await registeredFabric(() => ({ launched: true, cwd: "/repository" })).invoke({
    nodeId: manifest.nodeId,
    provide: "launch",
    input: { cwd: "/repository" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_OUTPUT");
    assert.equal(result.error.message, "output.piSessionId is required");
  }
});
