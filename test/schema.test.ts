async function invokeResult(fabric: { invokeTracked(request: any): Promise<any> }, request: any): Promise<any> {
  return (await fabric.invokeTracked(request)).result;
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createProtocolFabric } from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest } from "@kybernetria/pi-protocol/contract";
import { validateLaunchInput } from "../src/validation.js";

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
  assert.deepEqual(definition.manifest.provides[0].extensions, {
    "x-kyvernetria-utf8-limits": {
      initialPrompt: { maxBytes: 16384, encoding: "utf-8", enforcedAt: "protocol-boundary" },
    },
  });
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

test("schema admits the complete UTF-8 byte-valid prompt domain", async () => {
  const prompts = [
    "a".repeat(16_384),
    "é".repeat(8_192),
    "€".repeat(5_461) + "a",
    "😀".repeat(4_096),
  ];
  for (const initialPrompt of prompts) {
    assert.equal(Buffer.byteLength(initialPrompt, "utf8") <= 16_384, true);
    assert.equal(definition.provides.launch.validateInput({ cwd: "/repository", initialPrompt }).valid, true);
  }

  for (const initialPrompt of ["é\u0001mixed", "€\u001fmixed", "😀\u007fmixed"]) {
    assert.equal(definition.provides.launch.validateInput({ cwd: "/repository", initialPrompt }).valid, false);
  }

  const overBytePrompt = "😀".repeat(4_097);
  assert.equal(definition.provides.launch.validateInput({ cwd: "/repository", initialPrompt: overBytePrompt }).valid, true);
  assert.throws(
    () => validateLaunchInput({ cwd: "/repository", initialPrompt: overBytePrompt }),
    /initialPrompt must be text up to 16384 UTF-8 bytes/,
  );
});

test("output schema rejects incomplete launch results", async () => {
  const result = await invokeResult(registeredFabric(() => ({ launched: true, cwd: "/repository" })), {
    nodeId: "pi_full_session", provide: "launch", input: { cwd: "/repository" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OUTPUT_INVALID");
});
