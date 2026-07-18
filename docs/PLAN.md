# pi-full-session implementation contract

## Goals

1. Launch a durable interactive Pi CLI/TUI process and return stable metadata without streaming its conversation through the invoking protocol call.
2. Support an existing directory and a newly created, verified Git linked worktree.
3. Work through term-mux's versioned control socket and through configurable argv-based terminal emulators.
4. Preserve bounded, attributable protocol handoffs and signed Pi lifecycle state.
5. Keep full Pi processes distinct from SDK-backed protocol agents.

## Non-goals

- Reimplement Pi's TUI or `AgentSession` SDK.
- Scrape terminal output or infer lifecycle from titles, process names, or timestamps.
- Route arguments through shell source.
- Automatically remove worktrees or branches after partial failure.
- Expose terminal focus or terminal text injection as protocol provides.
- Treat term-mux's asynchronous worktree UI action as proof that a worktree is ready for launch.

## Package boundaries

- **Protocol node `pi_full_session`**: validation, preflight, launch records, handoffs, lifecycle state, Git orchestration, and host selection.
- **Terminal adapters**: `StockTerminalHost` and `TermMuxHost` behind one internal contract.
- **Pi lifecycle extension**: loaded explicitly into every spawned Pi process and writes signed launch-scoped events.
- **Protocol fabric**: discovery/invocation/tracing only; a launched Pi process is not an SDK executor.

## Host contract

```ts
interface TerminalHost {
  id: string;
  capabilities(): Promise<Array<"status" | "stop" | "lifecycle_events">>;
  launch(request: LaunchRequest): Promise<TerminalHandle>;
  status?(handle: TerminalHandle): Promise<unknown>;
  stop?(handle: TerminalHandle): Promise<void>;
}
```

`LaunchRequest` contains an executable, validated argument array, existing canonical cwd, bounded environment overrides, and generated launch ID. It never accepts shell source.

A stock terminal is launch-only and returns no invented handle. A host capability is usable only when both advertised and implemented.

## Existing-directory launch transaction

1. Validate the complete request, workspace mode, model, thinking level, name, prompt, and configured Pi command.
2. Canonicalize and verify the existing cwd.
3. Resolve one host instance and complete its capability/handshake preflight.
4. Resolve all handoffs in memory and enforce effect and complete-bundle limits.
5. Generate independent protocol launch and exact Pi session IDs.
6. Create private launch artifacts and invoke the host with `pi --session-id ...`.
7. Validate the host's returned handle and atomically persist the launch record.
8. If launch fails before a process handle exists, remove incomplete artifacts. If persistence fails after a controllable launch, attempt host rollback rather than knowingly orphaning it.

State begins as `launched`; it does not become `ready` until the lifecycle extension emits a valid signed Pi event.

## Worktree transaction

`launch_worktree` creates a **new** local branch from the current `HEAD` of the repository containing `cwd`.

1. Canonicalize `cwd` and resolve `git rev-parse --show-toplevel`, so nested source directories behave identically to repository roots.
2. Apply the local branch syntax gate, then Git's authoritative `check-ref-format --branch`.
3. Reject an existing `refs/heads/<branch>`.
4. Resolve an explicit absolute missing destination or generate a bounded collision-resistant sibling path.
5. Complete all non-Git launch preflight—including term-mux handshake and handoff invocation—before changing Git.
6. Run argv-only `git worktree add -b <branch> <destination>` with bounded output and timeout.
7. Canonicalize the result and prove:
   - its top-level path is the requested destination;
   - symbolic `HEAD` is the exact requested branch;
   - `git worktree list --porcelain -z` contains that exact path/ref pair.
8. Launch through the already-preflighted host with the verified path as exact cwd.

If Git may have created a destination or branch before a later failure, the implementation retains it and reports both identifiers. It never performs automatic destructive cleanup based on an uncertain partial state.

## term-mux contract

The adapter uses term-mux protocol version 1 over its owner-only Unix socket:

- request envelope: `{protocolVersion, id, action, arguments}`;
- exact handshake: `integration.handshake` / `pi-full-session/1`;
- launch: `process.launch` with `{executable, argv, cwd, env, launchId}`;
- status: `surface.status` with the exact returned surface ID;
- stop: `surface.kill` with the exact returned surface ID and `interactive:false`.

Every response must match protocol version, request ID, and action. Messages are capped at 1 MiB and calls have bounded timeouts. Launch succeeds only with both stable workspace and surface IDs and `backend:"tmux"`.

term-mux deliberately does not advertise synchronous native worktree support. Git creation remains local and verified before `process.launch`; this is the supported term-mux worktree path.

## Generic terminals

`terminalCommand` is an argv prefix such as `xterm -e`, `konsole -e`, or `gnome-terminal --`. The stock adapter appends Pi's executable and argv directly, inherits the invoking environment plus explicit lifecycle overrides, waits for the emulator spawn event, and reports startup errors.

Generic terminal APIs do not provide a portable stable surface/process identity. Therefore stock status is `unknown` and stop is unavailable.

## Status and stop

`status` returns the persisted record even if the configured host or term-mux server is unavailable. Host failures become structured unavailable status rather than hiding lifecycle/recovery data. Capabilities are recomputed so legacy records cannot revive removed controls.

`stop` is capability-gated. For term-mux it terminates the exact persistent surface and marks the launch ended. It does not claim graceful in-band Pi shutdown and never removes a Git worktree or branch.

## Handoffs

`handoff.items` accepts at most 20 snapshot/reference entries.

- Snapshots use normal fabric invocation and carry target, trace, timestamp, truncation, and error metadata.
- Declared effects or required confirmation require both caller approval and deployment policy.
- Snapshot output is truncated only on a valid UTF-8 boundary at 32 KiB.
- The entire serialized bundle—including references and metadata—is capped at 128 KiB.
- References are available only when the provide exists and its exact ID is allowlisted in configuration.
- Artifacts are private files and are labeled as untrusted context by the lifecycle extension.

## Verification matrix

Automated tests cover:

- provide registration and schemas;
- UTF-8/path/model/workspace validation;
- argv-only stock terminal launch and spawn failure;
- term-mux socket ownership, handshake, response correlation, bounds, timeout, handles, status, and stop;
- real Git repositories, nested cwd resolution, exact branch/worktree verification, preflight ordering, existing destinations, and retained recovery state;
- worktree cwd delivery through the real `TermMuxHost` protocol adapter;
- signed lifecycle state and unavailable-host status;
- handoff effects policy and complete serialized bounds.

Manual live verification additionally launches current Pi through the running term-mux server in both an existing directory and a newly created worktree, observes `ready` plus exact host cwd, then stops the exact surface.

## Known operational limits

1. A generic stock terminal cannot expose portable status or stop controls.
2. If a host accepts a launch but loses its response before returning a stable handle, no client can safely guess which surface to control; term-mux minimizes this with request correlation and bounded readiness acknowledgement.
3. Worktrees and branches are intentionally retained after post-Git failures and require explicit manual cleanup.
4. Lifecycle state depends on the explicitly loaded Pi extension; terminal status remains a separate signal.
