# pi-full-session

`@kybernetria/pi-full-session` is a Pi Protocol 0.2.0 node (`pi_full_session`) that launches a real, durable **Pi CLI/TUI process**. It never substitutes an SDK `AgentSession` and does not proxy the launched conversation through the protocol call.

## Provides

- `launch` — launch Pi in an existing absolute directory
- `launch_worktree` — create and verify a new Git branch/worktree, then launch Pi there
- `status` — return persisted lifecycle/recovery data and host status when available
- `stop` — terminate an exactly identified host surface when supported; never removes a worktree

Launch and control effects require protocol confirmation. Pi is invoked as an executable plus an argument array, never shell source:

```text
pi --session-id <generated UUID> --extension <lifecycle extension> [--name NAME] [--model MODEL] [--thinking LEVEL] [initial prompt]
```

Protocol launch IDs, exact Pi session IDs, terminal workspace IDs, and terminal surface IDs are independent identifiers.

## Configuration

Configuration is read from `PI_FULL_SESSION_CONFIG`, otherwise `~/.pi/agent/pi-full-session.json`.

### Generic terminal emulator

```json
{
  "selectedHost": "stock",
  "piCommand": "pi",
  "terminalCommand": ["xterm", "-e"],
  "allowedModels": ["provider/model-id"],
  "allowedThinking": ["off", "low", "medium", "high"],
  "allowedReferenceTargets": ["pi_todo.get", "my_node.context"],
  "allowSnapshotEffects": false,
  "maxRecords": 200
}
```

`terminalCommand` is an argv prefix. The adapter appends the Pi executable and its validated argv. Common prefixes include `['xterm','-e']`, `['konsole','-e']`, `['gnome-terminal','--']`, and `['alacritty','-e']`; configure the convention required by the selected terminal. No shell command string is constructed.

The stock adapter waits for the emulator process to spawn and reports executable/startup failures. It is intentionally launch-only because a generic emulator does not return a stable surface or child identity. Consequently, stock launches report host status as `"unknown"` and do not support `stop`.

### term-mux

```json
{
  "selectedHost": "term_mux",
  "termMux": {
    "socketPath": "/run/user/1000/term-mux/term-mux.sock",
    "timeoutMs": 5000
  }
}
```

When `socketPath` is omitted, the adapter uses `$XDG_RUNTIME_DIR/term-mux/term-mux.sock` (or the matching `/run/user/<uid>` path). The socket must be an owner-controlled `0600` Unix socket. `timeoutMs` may be 100–60000.

The adapter:

1. performs `integration.handshake` for `pi-full-session/1`;
2. correlates every protocol-version, request-ID, and action field;
3. caps requests/responses and enforces timeouts;
4. launches through argv-safe `process.launch`;
5. accepts only a persistent `tmux` result containing both stable `workspaceId` and `surfaceId`;
6. uses `surface.status` and `surface.kill` only when advertised.

`termMux.command` can alternatively name an argv-only transport that reads one NDJSON request from stdin and writes one response to stdout. It is **not** a shell snippet and is not the normal `termmuxctl` command-line interface.

## Worktree behavior

`launch_worktree` has deliberately strict semantics:

- `cwd` may be the repository root or any nested directory in a non-bare Git worktree.
- `branch` must be a **new** local branch. Git's own `check-ref-format --branch` is authoritative, and an existing branch is rejected.
- The branch starts from the current `HEAD` of the resolved repository worktree.
- An explicit `destination` must be absolute and must not exist.
- Without `destination`, a bounded, collision-resistant sibling path is generated from repository name, branch, and a short branch hash.
- All model/name/host/handoff preflight completes before Git is changed.
- After `git worktree add -b`, the implementation verifies the canonical top-level path, checked-out symbolic branch, and Git's linked-worktree registry before launching.
- The same preflighted terminal-host instance launches Pi with the verified worktree as its exact `cwd`.

term-mux's asynchronous native worktree action is intentionally not used: full-session requires completed local Git verification before `process.launch`. If anything fails after Git creates a destination or branch, no automatic destructive cleanup occurs. The error reports the retained path/branch for manual recovery.

## Security, lifecycle, and status

Launch records are user-owned `0600` JSON files under `~/.pi/agent/pi-full-session/launches` (or `registryDir`), atomically replaced under a bounded lock. Records contain no API keys or lifecycle signing key. Each launch has a private `0700` artifact directory containing bounded handoffs and a lifecycle verification key.

The included `extensions/lifecycle.ts` receives only explicit `PI_FULL_SESSION_*` values. It signs events written inside the private launch directory and uses Pi's official `session_start`, `agent_start`, `agent_settled`, and `session_shutdown` events. State therefore begins as `launched` and advances to `ready`, `working`, `idle`, or `ended` only from a verified event or an explicit successful `stop`.

`status` prioritizes persisted lifecycle and recovery information. If term-mux is stopped, replaced, or misconfigured, status still returns the record and reports a structured `hostStatus: {state:"unavailable", error:...}` rather than losing recovery data.

## Handoffs

`handoff.items` accepts at most 20 bounded `snapshot` or `reference` entries. Snapshot output is capped at 32 KiB on a valid UTF-8 boundary; the complete serialized bundle, including metadata and reference input, is capped at 128 KiB. Snapshot targets declaring effects or confirmation are rejected unless both `handoff.allowEffects` and user-global `allowSnapshotEffects` are true. References are available only when the target exists and its exact ID appears in `allowedReferenceTargets`.

Handoff content is untrusted context stored in a private file, not copied implementation and not a shell argument.

## Verification

```text
npm test
npm run typecheck
```

The automated suite uses real temporary Git repositories, a stock-terminal executable fixture, fake hosts, and owner-only NDJSON socket fixtures. It does not require a graphical terminal or mutate a developer repository.
