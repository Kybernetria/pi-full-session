# pi-full-session

`@kybernetria/pi-full-session` registers the `pi_full_session_launch` ordinary Pi tool. It launches a real interactive Pi CLI/TUI process in a new tab of an existing Zellij session.

It does not create an SDK agent, proxy or monitor the conversation, manage Git worktrees, discover sessions, or stop tabs or Pi processes. Konsole can host the Zellij client, but no new Konsole window is created for each launch.

## Tool

```json
{
  "cwd": "/absolute/project/path",
  "name": "Investigate failure",
  "initialPrompt": "Inspect the failing tests"
}
```

Only `cwd` is required. `name`, when supplied, names both the Zellij tab and Pi session. The tool returns a clear launch receipt containing the canonical working directory, exact Pi session UUID supplied to the CLI, and bounded provenance:

```json
{
  "launched": true,
  "piSessionId": "...",
  "cwd": "/absolute/project/path",
  "provenance": {
    "schemaVersion": 1,
    "launchId": "...",
    "launchedAt": "2026-09-06T12:00:00.000Z",
    "piSessionId": "...",
    "cwd": "/absolute/project/path",
    "zellijSession": "...",
    "originatingSessionId": "...",
    "originatingSessionFile": "...",
    "originatingParentSessionFile": "...",
    "originatingToolCallId": "..."
  }
}
```

After a successful launch, the parent session records the same receipt as the non-context `pi-full-session.launch` custom entry. The child receives only bounded environment metadata and records that handoff in its own session once. These records are provenance, not a launch registry, monitor, or control channel; a receipt persistence failure does not turn an acknowledged launch into a failed launch.

The tool performs process and system configuration effects. Model input cannot self-confirm or choose model policy.

## Zellij launch

The launcher invokes Zellij directly with argv and waits for the short-lived action client to acknowledge the new tab:

```text
zellij --session <SESSION> action new-tab \
  --cwd <CWD> [--name NAME] --close-on-exit -- \
  pi --session-id <UUID> [--name NAME] [--model MODEL] [--thinking LEVEL] [initial prompt]
```

No shell command string is constructed. On POSIX, the tab command is a direct `env KEY=value ... pi ...` argv so provenance reaches the Zellij server's child even when the server predates this launcher; Windows uses the inherited process environment. Zellij runs Pi as the tab's process, and the tab closes when Pi exits. The child receives provenance through direct environment variables, not through a prompt.

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
- `allowedModels` and `allowedThinking` restrict trusted direct service calls. They are not tool input fields; callers cannot choose deployment model policy.

The obsolete `selectedHost`, `termMux`, and `terminalCommand` settings are rejected with migration errors. term-mux is not supported or referenced as a future backend.

## Failure semantics

The tool returns `launched: true` only after the Pi executable passes preflight and the Zellij action client exits successfully. Missing executables, nonexistent sessions, nonzero action exits, and timeouts are returned to the caller. Action success acknowledges tab creation; it does not guarantee that Pi remains healthy afterward. A timeout is reported as ambiguous because Zellij may have accepted the tab immediately before the client was killed; the launcher never retries automatically. The parent and child provenance entries are best-effort persistence records and do not change that launch-only result.

An `initialPrompt` beginning with `-` or `@` is rejected because Pi would parse it as a CLI option or local file argument rather than a literal message. Names and Zellij session names beginning with `-` are also rejected so they cannot cross an option-parser boundary.

## Verification

```text
npm test
npm run typecheck
git diff --check
```
