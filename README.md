# pi-full-session

`@kybernetria/pi-full-session` is a canonical Pi Protocol schemaVersion 1 node that launches a real interactive Pi CLI/TUI process in a new tab of an existing Zellij session.

It does not create an SDK agent, proxy or monitor the conversation, manage Git worktrees, discover sessions, or stop tabs or Pi processes. Konsole can host the Zellij client, but no new Konsole window is created for each launch.

## Provide

### `pi_full_session.launch`

```json
{
  "op": "call",
  "target": "pi_full_session.launch",
  "input": {
    "cwd": "/absolute/project/path",
    "name": "Investigate failure",
    "initialPrompt": "Inspect the failing tests"
  }
}
```

Only `cwd` is required. `name`, when supplied, names both the Zellij tab and Pi session. The result contains the canonical working directory and exact Pi session UUID supplied to the CLI:

```json
{
  "launched": true,
  "piSessionId": "...",
  "cwd": "/absolute/project/path"
}
```

The contract declares `process.spawn` and `system.configure`, so launch requires approval from the host confirmation broker. Model input cannot self-confirm or choose model policy.

## Zellij launch

The launcher invokes Zellij directly with argv and waits for the short-lived action client to acknowledge the new tab:

```text
zellij --session <SESSION> action new-tab \
  --cwd <CWD> [--name NAME] --close-on-exit -- \
  pi --session-id <UUID> [--name NAME] [--model MODEL] [--thinking LEVEL] [initial prompt]
```

No shell command string is constructed. Zellij runs Pi as the tab's process. The tab closes when Pi exits.

The target session is selected as follows:

1. configured `zellijSession`, when present;
2. otherwise inherited `ZELLIJ_SESSION_NAME` from the current Zellij session;
3. otherwise launch fails before spawning anything.

There is deliberately no automatic Konsole fallback. Retrying through another terminal after an ambiguous Zellij timeout could create duplicate sessions, and a Konsole window would not satisfy the requested tab placement.

## Configuration

Configuration is read from `PI_FULL_SESSION_CONFIG`, otherwise `~/.pi/agent/pi-full-session.json`.

When Pi itself runs inside the desired Zellij session, the minimal configuration is:

```json
{}
```

Optional settings:

```json
{
  "piCommand": "pi",
  "zellijCommand": "zellij",
  "zellijSession": "explicit-session-name",
  "zellijTimeoutMs": 10000,
  "allowedModels": ["provider/model-id"],
  "allowedThinking": ["off", "low", "medium", "high"]
}
```

- `piCommand` and `zellijCommand` default to `pi` and `zellij`. Each must be an executable name found through an absolute `PATH` entry or an absolute path; relative paths are rejected. Both are resolved and checked before launch.
- `zellijSession` explicitly targets a session and overrides the inherited session name.
- `zellijTimeoutMs` controls how long to wait for the Zellij action acknowledgement (100–60000 ms).
- `allowedModels` and `allowedThinking` restrict trusted direct service calls. They are not public protocol input fields; protocol callers cannot choose deployment model policy.

The obsolete `selectedHost`, `termMux`, and `terminalCommand` settings are rejected with migration errors. term-mux is not supported or referenced as a future backend.

## Failure semantics

The service returns `launched: true` only after the Pi executable passes preflight and the Zellij action client exits successfully. Missing executables, nonexistent sessions, nonzero action exits, and timeouts are returned to the protocol caller. Action success acknowledges tab creation; it does not guarantee that Pi remains healthy afterward. A timeout is reported as ambiguous because Zellij may have accepted the tab immediately before the client was killed; the launcher never retries automatically.

An `initialPrompt` beginning with `-` or `@` is rejected because Pi would parse it as a CLI option or local file argument rather than a literal message. Names and Zellij session names beginning with `-` are also rejected so they cannot cross an option-parser boundary.

## Verification

```text
npm run protocol:generate
npm run protocol:check
npm test
npm run typecheck
git diff --check
```
