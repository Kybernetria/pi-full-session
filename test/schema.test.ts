import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { launchParameters, launchTool, registerFullSessionTools } from "../src/tools.ts";

test("ordinary tool exposes the bounded launch contract and prompt guidance", () => {
  assert.equal(launchTool.name, "pi_full_session_launch");
  assert.match(launchTool.promptSnippet ?? "", /cwd/);
  assert.equal(launchTool.promptGuidelines?.length, 2);
  assert.deepEqual(Object.keys(launchParameters.properties), ["cwd", "name", "initialPrompt"]);

  const registered: unknown[] = [];
  registerFullSessionTools({ registerTool: (definition: unknown) => registered.push(definition) } as never);
  assert.deepEqual((registered as Array<{ name: string }>).map((tool) => tool.name), ["pi_full_session_launch"]);
});

test("native Pi schema rejects malformed or deployment-authority input", () => {
  for (const input of [
    {},
    { cwd: 42 },
    { cwd: "relative/project" },
    { cwd: "C:relative\\project" },
    { cwd: "/repository", model: "provider/model" },
    { cwd: "/repository", initialPrompt: "--help" },
    { cwd: "/repository", name: "--help" },
    { cwd: "/repository", unexpected: true },
  ]) {
    assert.equal(Value.Check(launchParameters, input), false);
  }
});
