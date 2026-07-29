# pi-full-session contract

## Purpose

Launch a durable, interactive Pi CLI/TUI process in a new tab of an existing Zellij session without representing it as a protocol agent or proxying its conversation.

## Public API

The node exposes only `launch`.

`launch` validates an existing absolute working directory and optional Pi model, thinking level, name, and initial prompt. It resolves and checks the Pi executable, creates a Zellij tab in the configured or inherited session, runs Pi there with direct argv, and returns the canonical directory and generated Pi session UUID.

A supplied name is used independently for both the Zellij tab and Pi session. The protocol output intentionally does not expose lifecycle controls or promise that Pi remains running after Zellij accepts the tab.

## Zellij boundary

The implementation targets Zellij's subprocess control surface:

```text
zellij --session <SESSION> action new-tab --cwd <CWD> [--name NAME] --close-on-exit -- <PI ARGV...>
```

The configured session takes precedence over inherited `ZELLIJ_SESSION_NAME`. The short-lived Zellij client must exit successfully before `launch` returns. Its output is bounded, nonzero exits are reported, and a bounded timeout kills and reaps the client before being treated as an ambiguous result without automatic retry. Values that Pi or Zellij could reinterpret at an option/file-argument boundary are rejected.

Konsole is only the terminal emulator displaying the existing Zellij session. pi-full-session does not create a separate Konsole window and does not fall back to one after a Zellij failure.

## Boundaries

The package does not:

- create or manage Git worktrees;
- persist a launch registry;
- discover or report Pi process status;
- stop sessions, tabs, or processes;
- inject handoffs;
- load a lifecycle extension;
- scrape terminal output;
- route values through shell source;
- integrate with or retain compatibility for obsolete term-mux configuration.

Terminal and tab lifecycle belong to Zellij. Git workspace decisions belong to the launched agent or its prompt.
