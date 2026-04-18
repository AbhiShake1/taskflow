# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
