import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { FullSessionService, loadConfig, type LaunchResult } from "./service.js";
import { createLaunchOrigin, FULL_SESSION_PROVENANCE_ENTRY } from "./provenance.js";

const cwdSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 8192, pattern: "^/" }),
  Type.String({ minLength: 1, maxLength: 8192, pattern: "^[A-Za-z]:[\\\\/]" }),
]);

export const launchParameters = Type.Object({
  cwd: cwdSchema,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9_ .:/][A-Za-z0-9_ .:/-]*$" })),
  initialPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16384, pattern: "^[^@-].*$" })),
}, { additionalProperties: false });

export function createLaunchTool(pi?: ExtensionAPI): ToolDefinition<typeof launchParameters, LaunchResult> {
  return {
  name: "pi_full_session_launch",
  label: "Launch Pi session",
  description: "Launch an interactive Pi CLI session in a new tab of an existing Zellij session and return a durable provenance receipt.",
  promptSnippet: "pi_full_session_launch(cwd, name?, initialPrompt?)",
  promptGuidelines: [
    "Use pi_full_session_launch only when the user asks to open a separate interactive Pi session.",
    "pi_full_session_launch requires an existing Zellij session and returns after tab creation is acknowledged; it does not monitor or control the launched session.",
  ],
  parameters: launchParameters,
  async execute(toolCallId, input, signal, _onUpdate, ctx) {
    const origin = createLaunchOrigin(ctx, toolCallId);
    const result = await new FullSessionService(await loadConfig()).launch(input, signal, origin);
    piAppendLaunchProvenance(pi, result);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    };
  },
  renderCall(args, theme) {
    const name = typeof args.name === "string" ? ` ${display(args.name, 80)}` : "";
    return new Text(`${theme.fg("toolTitle", theme.bold("Launch Pi session"))}${theme.fg("dim", ` → ${display(args.cwd, 120)}${name}`)}`, 0, 0);
  },
  renderResult(result, { isPartial, expanded }, theme) {
    if (isPartial) return new Text(theme.fg("warning", "Launching Pi session…"), 0, 0);
    const details = result.details as LaunchResult | undefined;
    if (!details?.launched) return new Text(theme.fg("error", "Pi session launch failed"), 0, 0);
    const provenance = details.provenance;
    let text = theme.fg("success", theme.bold("✓ Pi session launched"));
    text += `\n${theme.fg("dim", `child ${details.piSessionId}`)}`;
    text += `\n${theme.fg("dim", `cwd ${display(details.cwd, 160)}`)}`;
    text += `\n${theme.fg("dim", `Zellij ${display(provenance.zellijSession, 120)}`)}`;
    text += `\n${theme.fg("muted", `parent ${display(provenance.originatingSessionId, 120)} · tool ${display(provenance.originatingToolCallId ?? "unavailable", 120)}`)}`;
    if (expanded) {
      text += `\n${theme.fg("muted", `launch ${provenance.launchId} · ${provenance.launchedAt}`)}`;
      if (provenance.originatingSessionFile) text += `\n${theme.fg("muted", `parent file ${display(provenance.originatingSessionFile, 200)}`)}`;
      if (provenance.originatingParentSessionFile) text += `\n${theme.fg("muted", `lineage parent ${display(provenance.originatingParentSessionFile, 200)}`)}`;
    }
    return new Text(text, 0, 0);
  },
  };
}

export const launchTool = createLaunchTool();

function piAppendLaunchProvenance(pi: ExtensionAPI | undefined, result: LaunchResult): void {
  // appendEntry is host-owned and keeps this record in the originating session;
  // it is not a registry, monitor, or control channel for the child. A
  // persistence failure must not turn an already acknowledged launch into a
  // reported launch failure.
  try {
    pi?.appendEntry(FULL_SESSION_PROVENANCE_ENTRY, result.provenance);
  } catch (error) {
    console.error(`[pi-full-session] could not record launch receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function display(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function registerFullSessionTools(pi: ExtensionAPI): void {
  pi.registerTool(createLaunchTool(pi));
}
