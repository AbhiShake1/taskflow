# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.23] - 2026-04-19

### Changed
- **Simplified the discovery backend** — dropped Cloudflare Browser Rendering + `@cloudflare/puppeteer` entirely. Discovery now uses the official **GitHub Code Search REST API** as its only backend. Same surface (`GET /api/discover?q=&repo=&limit=`), same response shape, but:
  - No headless browser, no Vercel-challenge handling, no page.waitForResponse, no launch cost.
  - Pages Function is now ~100 lines of straightforward `fetch` + KV cache.
  - Sub-second latency, $0 compute at CF Workers' free tier.
- `web/wrangler.toml` — removed `[browser]` binding. Only `DISCOVER_CACHE` KV and `GITHUB_TOKEN` secret remain.
- `web/package.json` — removed `@cloudflare/puppeteer` devDependency.

### Removed
- `normalizeGrepApp` helper + associated fixture tests. grep.app integration can be re-added as a two-line branch if they ever publish an official API key program.

## [0.1.22] - 2026-04-19

### Added
- `taskflow add <user/repo>` now auto-discovers harnesses across the repo. When multiple files match, prompts a multi-select via `@clack/prompts`; with a single match, auto-installs. Discovery skipped if a `registry-item.json` is present at HEAD.
- `taskflow search <query>` folds GitHub-wide discovery results alongside configured-registry matches.
- New Cloudflare Pages Function backend at `web/functions/api/discover.ts`. Calls grep.app through Cloudflare Browser Rendering (no cron, per-request browser). Falls back to GitHub Code Search API on error. Results cached 10 minutes in Workers KV.
- `TASKFLOW_DISCOVER_URL` env var overrides the default proxy endpoint.

### Changed
- Registry deploy artifact moved from `registry/r/` to `web/public/` (Pages project layout). `taskflow build`'s default output (`./r`) is unchanged.

### Internal
- `cli/add/registry/discover.ts`, `synthesize.ts` — new CLI-side modules.
- `web/wrangler.toml`, `web/tsconfig.json`, `web/package.json` — new Pages project config.
- Pipeline and resolver accept an optional `{yes, silent, cwd}` argument to support interactive prompts.

## [0.1.21] - 2026-04-19

### Docs
- Full `taskflow add` reference in README.md — every source format (all 7), full flag table, detection order, file-layout diagram, publishing walkthrough, item-type table, CI usage.
- SKILL.md expanded so AI assistants have a complete decision tree for choosing source forms, wiring registries, and handling `--yes` vs `--overwrite` correctly.
- Both README and SKILL now recommend `npx @taskflow-corp/cli@latest <cmd>` form so consumers get the newest version on every invocation.

### Internal
- `cli.version()` bumped to 0.1.21. MCP server advertises the same version.

## [0.1.20] - 2026-04-19

### Added
- **`taskflow add` — shadcn-style harness distribution.** Drop any harness into any project with a single command. Source forms:
  - Named: `taskflow add ui-harness-trio` (built-in `@taskflow` registry via `TASKFLOW_REGISTRY_URL`, default `https://taskflow.sh/r`)
  - Namespaced: `taskflow add @acme/my-harness` (resolves via `registries` map in `taskflow.json`)
  - Raw URL: `taskflow add https://example.com/r/harness.json`
  - Local file: `taskflow add ./my-harness.json`
  - GitHub shortcut (degit-style): `taskflow add user/repo/path/to/item.json#v1.2.0`, also `github:`, `gitlab:`, `bitbucket:` host prefixes
  - Fully qualified (Terraform grammar): `taskflow add git::ssh://git@host/org/repo.git//sub?ref=v1&sha256=...&depth=1`
- `taskflow init` — scaffolds `taskflow.json` + `.agents/taskflow/config.ts` + harness/rules dirs. Auto-invoked by `add` on first use.
- `taskflow build` — publisher side: reads `registry.json` + source files and emits `r/<item>.json` with file contents inlined (one fetch per install).
- `taskflow view <source>`, `taskflow list`, `taskflow search <query>`, `taskflow update [name...]`, `taskflow remove <name>`, `taskflow apply <preset>` — adjacent lifecycle commands.
- `taskflow mcp` — Model Context Protocol server over stdio. Exposes `list_harnesses`, `search`, `install` tools so Claude Code / Cursor / Codex can discover and install harnesses autonomously.
- `taskflow.lock` — content-addressed lockfile (`source` + `type` + optional `sha256`). `--frozen` errors on drift in CI.
- `${VAR}` env-var interpolation in `registries` URLs, headers, and params. Auto-loads `.env` / `.env.local`.
- `taskflow:config-patch` items are merged into the project's `.agents/taskflow/config.ts` via ts-morph AST rewrite (no more sidecar files).
- Starter registry under `registry/` with two example harnesses — build it with `taskflow build -c registry` and point consumers at the emitted `r/`.

### CLI rewrite
- `cli/index.ts` migrated from hand-rolled argv to `cac`. Existing `run | watch | plan` subcommands behave identically. New commands listed above layer on top.

### Docs
- New design document at `docs/add-command-plan.md` covering the three-tier source grammar, file shapes (`taskflow.json`, `registry.json`, `registry-item.json`, `taskflow.lock`), module layout, scored decisions, and phased rollout.

## [0.1.15] - 2026-04-19

### Added
- TUI: Enter on a stage toggles collapse/expand of its children. Collapsed stages keep their label (with a `▸` prefix so you see grouping still exists) but their descendants are hidden from the flat tree — useful for long-running harnesses where older completed cycles drown out the current work. Enter on a leaf still drills into the DetailView unchanged. New `TuiState.toggleCollapsed(stageId)` action + `TreeNode.collapsed` field; `getFlatTree()` honors the collapse.

## [0.1.14] - 2026-04-19

### Added
- `taskflow` CLI published as the package's `bin`. Subcommands:
  - `taskflow run harness.ts` — execute a harness file; mounts live TUI when stdout is a TTY, otherwise streams events as JSONL.
  - `taskflow watch harness.ts` — alias for `run`.
  - `taskflow plan harness.ts` — static AST preview (no LLM calls).
  Consumers no longer need a per-harness `package.json` scaffold. Write a single `.ts` file anywhere and run it via `npx taskflow run harness/foo.ts`.
- Runner now imports harness files via `jiti` instead of native `import()`, so `.ts` files work under plain node (no tsx peer dep required by the published CLI).

## [0.1.13] - 2026-04-19

### Added
- `phase(name, { title }, body)` overload — static title at phase-creation time. Use when you know the title upfront; cleaner than the runtime `setTitle` path. Runtime `ctx.setTitle(...)` still works and overrides the static title. `stage-enter` event now carries an optional `title` field so the TUI sees the title on its first render.

## [0.1.12] - 2026-04-19

### Added
- Runtime-set phase titles. `phase(name, async (ctx) => { ctx.setTitle('My Title'); ... })` — lets a harness rename a phase after some work runs, so the TUI can show e.g. an AI-generated summary in place of a placeholder id. Backward compat: phase bodies written as `async () => {}` keep working (extra arg is ignored). New `stage-title` event and `TreeNode.title` carry the title end-to-end.

## [0.1.11] - 2026-04-19

### Changed
- TUI TreeView: tree-line connectors (`├─`, `└─`) now render for root-level nodes too. Previously they were suppressed for any node with no parentId, which made multiple top-level siblings appear as a column-aligned plain list. Single-root harnesses still look clean; multi-root or flat-session layouts get the visual structure back.

## [0.1.10] - 2026-04-19

### Changed
- TUI: removed alt-screen buffer mode. Native mouse-wheel scroll, terminal selection, and copy/paste now work as expected. The trade-off is that switching between TreeView and DetailView may leave brief scrollback — preferred over breaking native terminal interactions.
- TUI TreeView: strips trailing `-NN` and `-NN-aM` counter suffixes from the displayed label. `pick-05` reads as `pick`, `lint-05-a0` as `lint`, `iter-05` as `iter`. Internal ids stay unique for the engine; only the rendered label is cleaned up.

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
