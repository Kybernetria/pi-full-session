# pi-full-session

A protocol package for launching durable, interactive **Pi CLI/TUI processes** in a selected terminal host. It is intentionally distinct from a protocol SDK-backed `AgentSession`.

A full Pi session keeps normal Pi behavior: project/resource discovery, extensions, skills, session persistence, interactive user takeover, model selection, and a real terminal. Protocol calls launch and manage it through stable metadata; they do not proxy its token stream.

## Proposed provides

```text
pi_full_session.launch
pi_full_session.launch_worktree
pi_full_session.status
pi_full_session.focus
pi_full_session.send_input
pi_full_session.stop
```

`launch` supports an existing `cwd` or no worktree. `launch_worktree` is the explicit convenience operation for a new isolated Git worktree.

## Core launch contract

```json
{
  "cwd": "/absolute/path/to/repository",
  "workspace": {
    "mode": "new_worktree",
    "branch": "agent/auth",
    "destination": null
  },
  "terminal": "selected",
  "model": "openai-codex/gpt-5.6-terra",
  "thinking": "medium",
  "initialPrompt": "Implement the requested auth changes.",
  "name": "auth-agent",
  "handoff": { "items": [] }
}
```

The response returns a launch record, not an SDK agent session:

```json
{
  "state": "launched",
  "piSessionId": "...",
  "worktreePath": "/...",
  "branch": "agent/auth",
  "terminal": {
    "host": "term_mux",
    "workspaceId": "...",
    "surfaceId": "...",
    "capabilities": ["focus", "send_input", "status"]
  },
  "handoffId": "..."
}
```

`piSessionId`, protocol `request.session.id`, and any terminal-host IDs are separate identifiers.

## Terminal hosts

`pi_full_session` depends on a small host-adapter contract rather than requiring term-mux:

- **term-mux:** durable workspace/surface IDs, focus, input, and explicit lifecycle events.
- **selected stock terminal:** launches Pi in the configured terminal and returns only capabilities that the terminal actually supports.
- **current terminal:** optional adapter for launching Pi in the caller's existing terminal.

A host must never claim readiness, process control, or input delivery that it cannot verify.

## Handoffs

A handoff carries protocol **data or references**, not a provide implementation. A launch may request:

- `snapshot`: invoke a compatible provide before launch and deliver its bounded output to the new Pi session;
- `reference`: deliver a target and instruction for the new Pi session to call, after confirming it is available there.

Handoff sources are generic; `pi_todo` is one optional source, not a core dependency. See [the implementation plan](docs/PLAN.md).
