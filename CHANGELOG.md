# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
