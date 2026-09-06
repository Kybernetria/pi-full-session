import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FULL_SESSION_PROVENANCE_ENTRY = "pi-full-session.launch";
export const FULL_SESSION_PROVENANCE_VERSION = 1;

export type LaunchOrigin = {
  originatingSessionId: string;
  originatingSessionFile?: string;
  originatingParentSessionFile?: string;
  originatingToolCallId?: string;
};

export type LaunchProvenance = LaunchOrigin & {
  schemaVersion: 1;
  launchId: string;
  launchedAt: string;
  piSessionId: string;
  cwd: string;
  zellijSession: string;
};

export type InheritedLaunchProvenance = LaunchProvenance;

const ENV_KEYS = [
  "PI_FULL_SESSION_LAUNCH_ID",
  "PI_FULL_SESSION_LAUNCHED_AT",
  "PI_FULL_SESSION_PI_SESSION_ID",
  "PI_FULL_SESSION_CWD",
  "PI_FULL_SESSION_ZELLIJ_SESSION",
  "PI_FULL_SESSION_ORIGINATING_SESSION_ID",
  "PI_FULL_SESSION_ORIGINATING_SESSION_FILE",
  "PI_FULL_SESSION_ORIGINATING_PARENT_SESSION_FILE",
  "PI_FULL_SESSION_ORIGINATING_TOOL_CALL_ID",
] as const;

export function createLaunchOrigin(ctx: ExtensionContext, toolCallId: string): LaunchOrigin {
  const sessionId = boundedMetadata(ctx.sessionManager.getSessionId(), "originating session id", 512);
  const sessionFile = optionalMetadata(ctx.sessionManager.getSessionFile(), "originating session file", 16_384);
  const parentSessionFile = optionalMetadata(ctx.sessionManager.getHeader()?.parentSession, "originating parent session file", 16_384);
  const originatingToolCallId = boundedMetadata(toolCallId, "originating tool call id", 2_048);
  return {
    originatingSessionId: sessionId,
    ...(sessionFile ? { originatingSessionFile: sessionFile } : {}),
    ...(parentSessionFile ? { originatingParentSessionFile: parentSessionFile } : {}),
    ...(originatingToolCallId ? { originatingToolCallId } : {}),
  };
}

export function validateLaunchOrigin(origin: LaunchOrigin | undefined): LaunchOrigin | undefined {
  if (origin === undefined) return undefined;
  const originatingSessionId = boundedMetadata(origin.originatingSessionId, "originating session id", 512);
  const originatingSessionFile = optionalMetadata(origin.originatingSessionFile, "originating session file", 16_384);
  const originatingParentSessionFile = optionalMetadata(origin.originatingParentSessionFile, "originating parent session file", 16_384);
  const originatingToolCallId = optionalMetadata(origin.originatingToolCallId, "originating tool call id", 2_048);
  return {
    originatingSessionId,
    ...(originatingSessionFile ? { originatingSessionFile } : {}),
    ...(originatingParentSessionFile ? { originatingParentSessionFile } : {}),
    ...(originatingToolCallId ? { originatingToolCallId } : {}),
  };
}

export function launchProvenanceEnvironmentArguments(provenance: LaunchProvenance): string[] {
  const environment = withLaunchProvenanceEnvironment({}, provenance);
  return ENV_KEYS.map(key => `${key}=${environment[key] ?? ""}`);
}

export function withLaunchProvenanceEnvironment(
  environment: NodeJS.ProcessEnv,
  provenance: LaunchProvenance,
): NodeJS.ProcessEnv {
  const next = { ...environment };
  for (const key of ENV_KEYS) delete next[key];
  next.PI_FULL_SESSION_LAUNCH_ID = provenance.launchId;
  next.PI_FULL_SESSION_LAUNCHED_AT = provenance.launchedAt;
  next.PI_FULL_SESSION_PI_SESSION_ID = provenance.piSessionId;
  next.PI_FULL_SESSION_CWD = provenance.cwd;
  next.PI_FULL_SESSION_ZELLIJ_SESSION = provenance.zellijSession;
  next.PI_FULL_SESSION_ORIGINATING_SESSION_ID = provenance.originatingSessionId;
  if (provenance.originatingSessionFile) next.PI_FULL_SESSION_ORIGINATING_SESSION_FILE = provenance.originatingSessionFile;
  if (provenance.originatingParentSessionFile) next.PI_FULL_SESSION_ORIGINATING_PARENT_SESSION_FILE = provenance.originatingParentSessionFile;
  if (provenance.originatingToolCallId) next.PI_FULL_SESSION_ORIGINATING_TOOL_CALL_ID = provenance.originatingToolCallId;
  return next;
}

export function readInheritedLaunchProvenance(environment: NodeJS.ProcessEnv): InheritedLaunchProvenance | undefined {
  try {
    const launchId = optionalMetadata(environment.PI_FULL_SESSION_LAUNCH_ID, "launch id", 512);
    const launchedAt = optionalMetadata(environment.PI_FULL_SESSION_LAUNCHED_AT, "launch timestamp", 128);
    const piSessionId = optionalMetadata(environment.PI_FULL_SESSION_PI_SESSION_ID, "Pi session id", 512);
    const cwd = optionalMetadata(environment.PI_FULL_SESSION_CWD, "launch cwd", 16_384);
    const zellijSession = optionalMetadata(environment.PI_FULL_SESSION_ZELLIJ_SESSION, "Zellij session", 512);
    const originatingSessionId = optionalMetadata(environment.PI_FULL_SESSION_ORIGINATING_SESSION_ID, "originating session id", 512);
    if (!launchId || !launchedAt || !piSessionId || !cwd || !zellijSession || !originatingSessionId) return undefined;
    const originatingSessionFile = optionalMetadata(environment.PI_FULL_SESSION_ORIGINATING_SESSION_FILE, "originating session file", 16_384);
    const originatingParentSessionFile = optionalMetadata(environment.PI_FULL_SESSION_ORIGINATING_PARENT_SESSION_FILE, "originating parent session file", 16_384);
    const originatingToolCallId = optionalMetadata(environment.PI_FULL_SESSION_ORIGINATING_TOOL_CALL_ID, "originating tool call id", 2_048);
    return {
      schemaVersion: FULL_SESSION_PROVENANCE_VERSION,
      launchId,
      launchedAt,
      piSessionId,
      cwd,
      zellijSession,
      originatingSessionId,
      ...(originatingSessionFile ? { originatingSessionFile } : {}),
      ...(originatingParentSessionFile ? { originatingParentSessionFile } : {}),
      ...(originatingToolCallId ? { originatingToolCallId } : {}),
    };
  } catch {
    // Environment variables are only a best-effort child-session handoff.
    return undefined;
  }
}

export function childLaunchProvenance(
  inherited: InheritedLaunchProvenance,
  ctx: ExtensionContext,
): Record<string, unknown> {
  const childSessionId = boundedMetadata(ctx.sessionManager.getSessionId(), "child session id", 512);
  const childSessionFile = optionalMetadata(ctx.sessionManager.getSessionFile(), "child session file", 16_384);
  return {
    ...inherited,
    childSessionId,
    ...(childSessionFile ? { childSessionFile } : {}),
    recordedAt: new Date().toISOString(),
  };
}

function boundedMetadata(value: string, name: string, maxBytes: number): string {
  const normalized = optionalMetadata(value, name, maxBytes);
  if (!normalized) throw new Error(`${name} is unavailable`);
  return normalized;
}

function optionalMetadata(value: unknown, name: string, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maxBytes || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}
