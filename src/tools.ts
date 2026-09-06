import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FullSessionService, loadConfig } from "./service.js";

const cwdSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 8192, pattern: "^/" }),
  Type.String({ minLength: 1, maxLength: 8192, pattern: "^[A-Za-z]:[\\\\/]" }),
]);

export const launchParameters = Type.Object({
  cwd: cwdSchema,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9_ .:/][A-Za-z0-9_ .:/-]*$" })),
  initialPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16384, pattern: "^[^@-].*$" })),
}, { additionalProperties: false });

export const launchTool: ToolDefinition = {
  name: "pi_full_session_launch",
  label: "Launch Pi session",
  description: "Launch an interactive Pi CLI session in a new tab of an existing Zellij session.",
  promptSnippet: "pi_full_session_launch(cwd, name?, initialPrompt?)",
  promptGuidelines: [
    "Use pi_full_session_launch only when the user asks to open a separate interactive Pi session.",
    "pi_full_session_launch requires an existing Zellij session and returns after tab creation is acknowledged; it does not monitor or control the launched session.",
  ],
  parameters: launchParameters,
  async execute(_toolCallId, input, signal) {
    const result = await new FullSessionService(await loadConfig()).launch(input, signal);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    };
  },
};

export function registerFullSessionTools(pi: ExtensionAPI): void {
  pi.registerTool(launchTool);
}
