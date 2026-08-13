import { isAbsolute, resolve } from "node:path";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const MAX_INITIAL_PROMPT_UTF8_BYTES = 16_384;

export type ValidatedLaunchInput = {
  cwd: string;
  model?: string;
  thinking?: string;
  name?: string;
  initialPrompt?: string;
};

/** Validate launch input before filesystem or process effects occur. */
export function validateLaunchInput(
  value: unknown,
  allowedModels?: string[],
  allowedThinking?: string[],
): ValidatedLaunchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("launch input must be an object");
  const input = value as Record<string, unknown>;
  const supported = new Set(["cwd", "model", "thinking", "name", "initialPrompt"]);
  for (const key of Object.keys(input)) {
    if (!supported.has(key)) throw new Error(`unsupported launch input: ${key}`);
  }
  const cwd = absoluteDir(input.cwd);
  const model = validateModel(input.model, allowedModels);
  const thinking = validateThinking(input.thinking, allowedThinking);
  const name = safeName(input.name);
  const initialPrompt = safeText(input.initialPrompt, "initialPrompt", MAX_INITIAL_PROMPT_UTF8_BYTES);
  if (initialPrompt && /^[-@]/.test(initialPrompt)) {
    throw new Error("initialPrompt must not begin with '-' or '@' because Pi would parse it as a CLI option or file argument");
  }
  return { cwd, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(name ? { name } : {}), ...(initialPrompt ? { initialPrompt } : {}) };
}

export function absoluteDir(value: unknown, name = "cwd"): string {
  if (typeof value !== "string" || !value.trim() || /[\0-\x1f\x7f]/.test(value)) throw new Error(`${name} must be a non-empty path without control characters`);
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return resolve(value);
}

export function safeText(value: unknown, name: string, maxBytes = MAX_INITIAL_PROMPT_UTF8_BYTES): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || /[\0-\x1f\x7f]/.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} must be text up to ${maxBytes} UTF-8 bytes without control characters`);
  }
  return value;
}

export function safeName(value: unknown): string | undefined {
  const text = safeText(value, "name", 120);
  if (text === undefined) return undefined;
  const name = text.trim();
  if (!name || name.startsWith("-") || !/^[A-Za-z0-9_ .:/-]+$/.test(name)) {
    throw new Error("name contains unsupported characters, begins with '-', or is empty");
  }
  return name;
}

export function validateModel(value: unknown, allowed?: string[]): string | undefined {
  const model = safeText(value, "model", 200);
  if (model !== undefined
      && (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(model) || (allowed?.length && !allowed.includes(model)))) {
    throw new Error("model is not permitted by configuration");
  }
  return model;
}

export function validateThinking(value: unknown, allowed?: string[]): string | undefined {
  const level = safeText(value, "thinking", 20);
  if (level !== undefined && (!THINKING_LEVELS.has(level) || (allowed?.length && !allowed.includes(level)))) {
    throw new Error("thinking is not permitted");
  }
  return level;
}
