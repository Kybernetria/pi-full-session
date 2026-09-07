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
    const values = asRecord(args);
    const cwd = display(values?.cwd, 120);
    const name = display(values?.name, 80);
    const target = cwd || "…";
    return new Text(`${theme.fg("toolTitle", theme.bold("Launch Pi session"))}${theme.fg("dim", ` → ${target}${name ? ` ${name}` : ""}`)}`, 0, 0);
  },
  renderResult(result, options, theme, context) {
    const isPartial = options?.isPartial === true;
    const expanded = options?.expanded === true;
    if (isPartial) return new Text(theme.fg("warning", "Launching Pi session…"), 0, 0);

    const resultRecord = asRecord(result);
    const details = asRecord(resultRecord?.details);
    const errorText = resultText(resultRecord);
    if (context?.isError === true || resultRecord?.isError === true || details?.launched !== true) {
      const reason = display(errorText, 240);
      const text = reason ? `Pi session launch failed: ${reason}` : "Pi session launch failed";
      return new Text(theme.fg("error", text), 0, 0);
    }

    let text = theme.fg("success", theme.bold("✓ Pi session launched"));
    text += `\n${theme.fg("dim", `child ${display(details?.piSessionId, 160) || "unavailable"}`)}`;
    text += `\n${theme.fg("dim", `cwd ${display(details?.cwd, 160) || "unavailable"}`)}`;

    const provenance = asRecord(details?.provenance);
    if (provenance) {
      if (typeof provenance.zellijSession === "string") {
        text += `\n${theme.fg("dim", `Zellij ${display(provenance.zellijSession, 120)}`)}`;
      }
      if (typeof provenance.originatingSessionId === "string") {
        const tool = display(provenance.originatingToolCallId, 120) || "unavailable";
        text += `\n${theme.fg("muted", `parent ${display(provenance.originatingSessionId, 120)} · tool ${tool}`)}`;
      }
      if (expanded) {
        const launchId = display(provenance.launchId, 120);
        const launchedAt = display(provenance.launchedAt, 80);
        if (launchId || launchedAt) {
          text += `\n${theme.fg("muted", `launch ${launchId || "unavailable"} · ${launchedAt || "unavailable"}`)}`;
        }
        const parentFile = display(provenance.originatingSessionFile, 200);
        if (parentFile) text += `\n${theme.fg("muted", `parent file ${parentFile}`)}`;
        const lineageFile = display(provenance.originatingParentSessionFile, 200);
        if (lineageFile) text += `\n${theme.fg("muted", `lineage parent ${lineageFile}`)}`;
      }
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function resultText(result: Record<string, unknown> | undefined): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .map(asRecord)
    .filter((content): content is Record<string, unknown> => content?.type === "text" && typeof content.text === "string")
    .map(content => content.text as string)
    .join("\n");
}

function display(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const safe = value
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[PX^_][^\x1B]*(?:\x1B\\)|[@-_])/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`;
}

export function registerFullSessionTools(pi: ExtensionAPI): void {
  pi.registerTool(createLaunchTool(pi));
}
