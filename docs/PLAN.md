# pi-full-session contract

## Purpose

Launch a durable, interactive Pi CLI/TUI process in a new tab of an existing Zellij session without representing it as a protocol agent or proxying its conversation.

## Public API

The package exposes only the `pi_full_session_launch` ordinary Pi tool.

`launch` validates an existing absolute working directory and optional Pi model, thinking level, name, and initial prompt. It resolves and checks the Pi executable, creates a Zellij tab in the configured or inherited session, runs Pi there with direct argv, and returns a launch receipt containing the canonical directory, generated Pi session UUID, and bounded provenance (launch ID, timestamp, Zellij session, and parent lineage). The parent and child sessions persist matching `pi-full-session.launch` custom entries that are excluded from LLM context.

## Zellij boundary

The implementation targets Zellij's subprocess control surface:

```text
zellij --session <SESSION> action new-tab --cwd <CWD> [--name NAME] --close-on-exit -- <PI ARGV...>
```

The configured session takes precedence over inherited `ZELLIJ_SESSION_NAME`. The short-lived Zellij client must exit successfully before `launch` returns. Its output is bounded, nonzero exits are reported, and a bounded timeout kills and reaps the client before being treated as an ambiguous result without automatic retry. Values that Pi or Zellij could reinterpret at an option/file-argument boundary are rejected. On POSIX, the initial command is a direct `env KEY=value ... pi ...` argv so the Zellij server receives the bounded provenance metadata without a shell.

Konsole is only the terminal emulator displaying the existing Zellij session. pi-full-session does not create a separate Konsole window and does not fall back to one after a Zellij failure.

## Boundaries

The package does not:

- create or manage Git worktrees;
- persist a launch registry;
- discover or report Pi process status;
- stop sessions, tabs, or processes;
- inject prompts or control handoffs; bounded provenance metadata is passed to the child only so the child can record launch lineage;
- load a lifecycle extension;
- scrape terminal output;
- route values through shell source;
- integrate with or retain compatibility for obsolete term-mux configuration.

Terminal and tab lifecycle belong to Zellij. Git workspace decisions belong to the launched agent or its prompt. Provenance entries are session metadata, not monitoring or lifecycle state.
