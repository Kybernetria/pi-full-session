export type Capability = "focus" | "send_input" | "status" | "lifecycle_events" | "stop" | "native_worktree";

export type TerminalHandle = {
  workspaceId?: string;
  surfaceId?: string;
  processId?: string;
};

/** Deliberately argv-only: adapters never receive shell source. */
export type LaunchRequest = {
  executable: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  launchId: string;
};

export interface TerminalHost {
  id: string;
  capabilities(): Promise<Capability[]>;
  launch(request: LaunchRequest): Promise<TerminalHandle>;
  focus?(handle: TerminalHandle): Promise<void>;
  sendInput?(handle: TerminalHandle, text: string): Promise<void>;
  status?(handle: TerminalHandle): Promise<unknown>;
  stop?(handle: TerminalHandle): Promise<void>;
  createWorktree?(request: { cwd: string; branch: string; destination?: string }): Promise<{ path: string; branch: string }>;
}

export type LifecycleState = "launched" | "ready" | "working" | "idle" | "ended";

export type LaunchRecord = {
  version: 1;
  launchId: string;
  ownerUid: number;
  createdAt: string;
  updatedAt: string;
  state: LifecycleState;
  piSessionId: string;
  cwd: string;
  branch?: string;
  worktreePath?: string;
  terminal: { host: string; handle: TerminalHandle; capabilities: Capability[] };
  lifecycle?: { state: Exclude<LifecycleState, "launched">; at: string };
  handoffId?: string;
  recovery?: { worktreeCreated: boolean; note: string };
};

export type AppConfig = {
  selectedHost?: "stock" | "term_mux";
  piCommand?: string;
  terminalCommand?: string[];
  termMux?: { socketPath?: string; command?: string[] };
  allowedModels?: string[];
  allowedThinking?: string[];
  registryDir?: string;
  maxRecords?: number;
  /** Exact node.provide IDs that installed Pi packages are permitted to expose. */
  allowedReferenceTargets?: string[];
  /** Deployment policy gate; callers must also set handoff.allowEffects. */
  allowSnapshotEffects?: boolean;
};
