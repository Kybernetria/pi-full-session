# Implementation plan

## Goals

1. Launch a durable, interactive Pi CLI/TUI process through a protocol handler and return stable metadata without streaming its conversation through the invoking call.
2. Support an existing directory and a new Git worktree.
3. Work with term-mux when available, while remaining usable with a selected stock terminal.
4. Deliver generic, safe protocol handoffs to the launched Pi session.
5. Keep SDK-backed protocol agents and full Pi processes explicitly separate.

## Non-goals

- Reimplement Pi's TUI or `AgentSession` SDK.
- Treat a launched `pi` process as an SDK agent executor.
- Scrape terminal output or infer lifecycle state from process names, titles, or timestamps.
- Make `pi_todo`, term-mux, or any workflow package a dependency of protocol core.
- Automatically remove worktrees or force-stop sessions.

## Architecture

### Package boundaries

- **`@kybernetria/pi-full-session`**: protocol node `pi_full_session`; validation, launch records, handoffs, lifecycle state, and orchestration.
- **Terminal-host adapters**: an internal interface with separate implementations. The initial adapter is term-mux; a stock-terminal adapter provides launch-only behavior.
- **Pi lifecycle extension**: an optional extension loaded into launched Pi sessions. It uses official Pi lifecycle events and the inherited host/session identity to report `ready`, `working`, `idle`, `needs_input`, and `ended` events. No screen scraping.
- **Protocol core**: unchanged. It supplies registry/discovery/invocation/tracing only.

### Host adapter contract

```ts
interface TerminalHost {
  id: string;
  capabilities(): Array<"focus" | "send_input" | "status" | "lifecycle_events">;
  launch(request: LaunchProcessRequest): Promise<TerminalLaunch>;
  focus(handle: TerminalHandle): Promise<void>;
  sendInput?(handle: TerminalHandle, text: string): Promise<void>;
  status?(handle: TerminalHandle): Promise<TerminalStatus>;
}
```

`LaunchProcessRequest` contains an executable plus a validated argument array, cwd, an allowlisted environment map, and a generated launch ID. It never accepts arbitrary shell snippets.

The selected-host resolver is configuration-driven. If no adapter can satisfy a requested control, launch fails clearly or returns a launch-only result; it must not imitate term-mux semantics.

### Full-Pi launch lifecycle

1. Validate paths, model/thinking input, session name, and requested host.
2. If requested, create and verify a new Git worktree. Retain it on later failures for recovery; report the exact path and branch.
3. Resolve the host and prepare the Pi CLI argument array (`--session-id`, optional model/thinking/name, extension path, and initial prompt).
4. Resolve snapshot handoffs before launch; write the bounded handoff bundle to a private launch directory.
5. Ask the terminal host to launch the Pi process at the final cwd.
6. Persist a launch record and return `state: "launched"` with independent protocol, Pi, worktree, and terminal IDs.
7. The optional lifecycle extension updates the record only from official Pi events. Until it reports, state remains `launched`, not `ready`.

## Public provides

### `pi_full_session.launch`

Launch at an existing cwd. `workspace.mode` is `none` or `existing`.

### `pi_full_session.launch_worktree`

Create a branch/worktree and launch there. This is separate from `launch` to keep the normal call simple and make Git effects visible in discovery/policy metadata.

### `pi_full_session.status`

Return the persisted launch record, latest explicit lifecycle event, and host capabilities. It reports `unknown` when a stock terminal cannot provide status.

### `pi_full_session.focus`, `send_input`, and `stop`

These are capability-gated. `stop` requests a graceful Pi shutdown when the host/lifecycle integration can do so; no destructive terminal or worktree removal is implied.

## Generic handoffs

`launch` accepts optional `handoff.items`:

```ts
{
  target: "node.provide";
  input?: unknown;
  as: string;
  mode: "snapshot" | "reference";
  required?: boolean;
}
```

- A **snapshot** invokes the target through the normal fabric before launch and serializes its output with target, trace, timestamp, size, and truncation metadata.
- A **reference** preserves the target and input instruction. The launcher checks that the spawned Pi's configured package set can expose that target, otherwise marks it unavailable.
- Snapshot calls with declared effects or required confirmation are rejected by default unless an explicit user-approved policy permits them.
- Handoff contents are bounded, treated as untrusted data, and stored in a private file rather than shell arguments or environment variables.
- The lifecycle extension injects the handoff as a durable custom message or initial user context. It must label source and truncation state.

A workflow integration may create/claim a `pi_todo` item before launch and add it as a normal handoff item. This remains optional and outside core package dependencies.

## Delivery phases

### Phase 0 — contract and compatibility spike

- Define TypeScript schemas, launch-record format, error codes, and capability matrix.
- Verify current Pi CLI flags for session ID, name, model, thinking, extension loading, and initial prompt.
- Verify the term-mux NDJSON API version currently running, not only source-tree APIs.
- Decide the selected-terminal configuration location and trust model.
- Produce fixtures for a launch-only stock-terminal adapter and a controllable fake host.

**Exit criterion:** the manifest and host contract are reviewed; every returned ID has an owner and lifecycle meaning.

### Phase 1 — package and launch registry

- Create the Pi package manifest, `pi.protocol.json`, extension registration, and handler-backed provides.
- Implement secure launch-record persistence with file locking, ownership checks, bounded retention, and no secrets.
- Implement `launch` for an existing cwd using a fake host in tests.
- Validate model/thinking values against the target Pi installation or reject unsupported combinations before launch.

**Exit criterion:** a caller can launch a fake full Pi process and retrieve a stable `launched` record via `status`.

### Phase 2 — term-mux adapter

- Implement an owner-only NDJSON client with version negotiation and structured error mapping.
- Support native term-mux worktree creation when the running server advertises it.
- Add the safe fallback: create a Git worktree, then request `new-workspace --cwd`.
- Implement focus/input/status only where the running term-mux version actually supports them.
- Add integration tests against a disposable term-mux server or protocol fixture.

**Exit criterion:** an interactive Pi process is visibly running in a separate term-mux surface and its returned metadata addresses that exact surface.

### Phase 3 — Pi lifecycle extension

- Create the launch-scoped extension passed to the Pi CLI.
- Emit lifecycle events from `session_start`, `agent_start`, `agent_settled`, `session_shutdown`, and user-input/needs-input handling where the API can support it honestly.
- Persist session name/ID and launch ID in durable custom entries as needed.
- Test normal exit, Ctrl+C, reload, session replacement, and host disconnect.

**Exit criterion:** `status` transitions from `launched` to `ready` only after an explicit Pi event, and eventually reports `ended` after graceful exit.

### Phase 4 — worktree and handoff orchestration

- Implement `launch_worktree` with branch/path validation, fresh Git verification, and failure recovery metadata.
- Implement snapshot/reference handoffs with effect-policy checks, output truncation, private artifact storage, and provenance.
- Add optional workflow adapter discovery so pi-todo can participate without becoming a dependency.
- Test unavailable, malformed, oversized, side-effectful, and failed handoffs.

**Exit criterion:** a launched full Pi session receives bounded, attributable context from arbitrary compatible provides.

### Phase 5 — selected stock-terminal adapter and UX

- Implement configuration-driven terminal selection and a launch-only adapter for stock terminals.
- Return an explicit capability list instead of invented surface/process metadata.
- Add a Pi command/tool UI for listing, focusing, and opening launch records when supported.
- Write installation, security, recovery, and compatibility documentation.

**Exit criterion:** the same launch API works with term-mux and a stock terminal, with honest differences in returned capabilities.

## Test matrix

- unit: schemas, validation, branch/path safety, ID separation, record persistence, handoff bounds/policy;
- contract: fake host behavior and failure mapping;
- integration: Git worktree lifecycle, current term-mux server versions, selected stock terminal;
- Pi extension: lifecycle events, session replacement, graceful shutdown, no-TUI modes;
- security: shell-injection resistance, untrusted handoff content, secret redaction, ownership checks, stale-record recovery;
- manual: user can take over, send a follow-up, close Pi, and recover the worktree without data loss.

## Open decisions

1. Should status records be project-local, user-global, or both?
2. What exact host-selection configuration and priority rules should apply?
3. Which lifecycle event can truthfully represent `needs_input` without inspecting terminal content?
4. Should a snapshot handoff permit any declared `effects`, or only an explicit allowlist of read-only tags?
5. Which term-mux release/version becomes the first supported native-worktree baseline?
