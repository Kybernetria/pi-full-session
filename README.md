# pi-full-session

`@kybernetria/pi-full-session` is a Pi Protocol 0.2.0 node (`pi_full_session`) that launches a real, durable **Pi CLI/TUI process**. It never uses an SDK `AgentSession` and does not stream the launched conversation through the protocol call.

## Install

Install this package as a Pi extension/package in the normal Pi package configuration, then enable it. The package requires compatible `@kybernetria/pi-protocol` and Pi coding-agent installations. Its manifest registers handler-backed provides:

- `launch` — existing absolute directory
- `launch_worktree` — validated Git branch/worktree
- `status`, `focus`, `send_input`, `stop`

All launch/control effects require protocol confirmation. Pi is invoked safely as an executable plus argument array:

```text
pi --session <generated UUID> --extension <lifecycle extension> [--name NAME] [--model MODEL] [--thinking LEVEL] [initial prompt]
```

`--session` is deliberately used (Pi accepts partial UUID lookup behavior); protocol launch IDs, Pi session IDs, and terminal IDs are independent.

## User-global configuration

Configuration is read from `PI_FULL_SESSION_CONFIG`, otherwise `~/.pi/agent/pi-full-session.json`. Example:

```json
{
  "selectedHost": "stock",
  "piCommand": "pi",
  "terminalCommand": ["xterm", "-e"],
  "allowedModels": ["provider/model-id"],
  "allowedThinking": ["off", "low", "medium", "high"],
  "maxRecords": 200
}
```

`terminalCommand` is argv, never a shell snippet. The stock adapter appends the Pi executable and validated argv, and is **launch-only**. It does not claim focus, input, process status, or stop. In particular, `stop` fails with capability unavailable for stock terminals: a launch-only terminal cannot honestly identify or stop its Pi child.

For term-mux use:

```json
{"selectedHost":"term_mux","termMux":{"socketPath":"/path/to/endpoint.sock"}}
```

or configure `termMux.command` as an argv command transport. The adapter sends NDJSON requests, requires a `handshake` response with advertised capabilities before accepting returned workspace/surface IDs, and only enables controls advertised by that server. Native worktree support is used only when advertised; otherwise it runs `git worktree add -b` then asks the host to launch at that cwd.

## Security, lifecycle, and recovery

Launch records are user-owned `0600` JSON files under `~/.pi/agent/pi-full-session/launches` (or `registryDir`), atomically replaced under a bounded lock and retention policy. They contain no API keys or lifecycle signing key. Each launch has a private `0700` artifact directory containing bounded handoffs and a lifecycle verification key.

The included `extensions/lifecycle.ts` receives only explicit `PI_FULL_SESSION_*` environment values from the launcher. It signs local events and writes only inside that private launch directory. It uses Pi official `session_start`, `agent_start`, `agent_settled`, `input`, and `session_shutdown` events. Thus state starts as `launched`; it becomes `ready`, `working`, `idle`, or `ended` only after an event. `agent_settled` truthfully means `idle`; input is not misrepresented as `needs_input`.

Worktrees are intentionally retained on launch failure and marked in recovery metadata. Inspect `status`, recover files manually, and remove a worktree yourself only when safe.

## Handoffs

`handoff.items` accepts bounded `snapshot` or `reference` items. Snapshots are normal fabric invocations, stored in private files and capped at 32 KiB each. Snapshot targets declaring effects/confirmation are rejected unless `handoff.allowEffects` is explicitly set. References are only marked available when permitted by configured `allowedReferenceTargets`; no implementation is copied into the spawned session.

Run `npm test` and `npm run typecheck`. Tests use the injectable `FakeHost`; they never need Pi, term-mux, or a graphical terminal.
