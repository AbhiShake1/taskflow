# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] - 2026-04-19

### Changed
- TUI DetailView: steer input is now actually typeable. Live `steerBuffer` from the parent App is rendered inside a rounded cyan-bordered box at the bottom of the view, with an inverse-block cursor. The leaf id is punched through the top border as a blue-background badge (claude-code-style); keybinding hint embedded in the bottom border.
- TUI DetailView: bullet+label spacing fixed. Single `<Text>` wrapper around bullet + name prevents Ink from collapsing the inter-element space in flex-row, so `● ToolSearch` renders correctly instead of `●ToolSearch`.

## [0.1.8] - 2026-04-19

### Changed
- TUI DetailView: claude-code-style per-event rendering. Tool calls show as `● ToolName(arg-summary)` with per-tool argument formatting (Bash → command, Read/Write/Edit → basename, Grep → pattern + path, Glob → pattern) instead of raw JSON. Tool results nest under the call with `⎿` and collapse to first 3 lines + `… +N lines` footer. Messages, edits, steers, errors, and the terminal done-marker get distinct bullet glyphs (`●`, `✎`, `↻`, `✗`, `✓/✗/⚠`). Older events fall off the top when a leaf accumulates more than 80 blocks.

## [0.1.7] - 2026-04-19

### Changed
- TUI: enters the terminal alt-screen buffer on mount (and exits on unmount, normal exit, SIGINT, SIGTERM). Drilling into a leaf and back no longer leaves leftover output as scrollback noise — the entire TUI session is isolated, and the user's original terminal state is restored cleanly on quit. Auto-disabled when stdout isn't a TTY.

## [0.1.6] - 2026-04-19

### Changed
- TUI: Unicode box-drawing tree lines (`├─`, `└─`, `│  `) replace plain-space indent so phase/session nesting reads at a glance. Done leaves strike through (claude-code task-list style) and go dim. Activity sub-line hangs under the running leaf with a proper `│` continuation when there are more siblings below.

## [0.1.5] - 2026-04-19

### Changed
- TUI: per-status colors (green=done, red=error, yellow=timeout/aborted, cyan=running), bold emphasis on the active leaf, and a live spinner for running nodes (10fps). Activity sub-line under running leaves surfaces the latest tool call / assistant message snippet so you can see what's happening between state transitions instead of a frozen glyph.
- `store.ts` exposes `statusColor()`, `liveStatusGlyph()`, `latestActivity()` helpers so downstream TUI consumers (e.g. a live `watch` viewer) can reuse the same visual language.

## [0.1.4] - 2026-04-18

### Added
- `SessionSpec.dependsOn?: string[]` — explicit DAG edges between sessions. Engine lazily registers each leaf's result promise on entry; dependers scheduled after dependees still resolve. Unknown ids throw; failed deps cascade.

### Changed
- `ctx.steer(text)` and `ctx.abort(reason)` inside hooks now fire their corresponding `beforeSteer/afterSteer` + `beforeAbort/afterAbort` hooks. Both honor `{ cancel: true }`; `beforeSteer` also honors `{ content: string }` mutation.
- `onError` now fires on any engine-caught exception inside `leaf()` (previously only on stream `error` events). Returning `{ swallow: true }` resolves the leaf with a synthetic error-status `LeafResult` instead of rethrowing.
- Verify-loop re-spawn path now re-resolves the adapter (`resolveCurrentAdapter(h, agent)`) so mid-session `_adapterOverride` swaps are observable on retry. Previously the captured adapter was reused.

## [0.1.3] - 2026-04-18

### Changed
- CI publish switched to classic NPM_TOKEN automation token after
  Trusted Publishing config mismatch. 0.1.1 and 0.1.2 were failed
  release attempts; 0.1.0 was published manually from local.

## [0.1.0] - 2026-04-18

### Added
- Fluent async-await orchestration API: `taskflow(name).run(async ({ phase, session }) => ...)`.
- Six adapters: claude-code, codex, cursor, opencode, pi, mock.
- Lifecycle hook system with 30+ hooks fired across the engine — `beforeSession`, `beforeToolCall`, `verifyTaskComplete`, `afterTaskDone`, etc.
- `defineConfig` with hierarchical `.agents/taskflow/config.ts` discovery (`~/.agents/taskflow/config.ts` walked down to cwd).
- Auto-todo extraction from `- [ ]` markdown checkboxes; verify-loop steers the agent until todos complete.
- `collectTodos` hook + `forceGeneration` config to require the agent to plan first.
- `scope` config field prepended to every session task.
- `ctx.session(id, spec)` and `ctx.phase(name, body)` available inside hooks — same fluent API as the top-level.
- Plugin system: contribute hooks, ctx namespaces, and config fragments.
- TUI for live execution view; `npm run plan` for static AST preview.

### Notes
- Initial public release.
