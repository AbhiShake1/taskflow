---
name: taskflow
description: Author and run multi-agent orchestration harnesses with a fluent TypeScript API. Use when the user asks to parallelize a task across AI coding agents, run the same pipeline across multiple models, set up a scraping/ingestion harness, or any time they say "make a harness", "parallelize this", "orchestrate these agents", "multi-agent pipeline", or "build a pipeline with claude-code/pi/codex/cursor/opencode".
---

# Taskflow

A meta-tool for orchestrating parallel/sequential sessions, where each session runs one AI coding agent invocation. The agent and LLM model are chosen per-session, so cheap mechanical work runs on cheap models and stakes-high work runs on frontier models.

## Fluent authoring (primary API)

Author a pipeline as a TypeScript file using the fluent builder:

```ts
import { taskflow } from 'taskflow';

export default taskflow('scrape-don').rules('./rules.md').run(({ phase, session }) => {
  phase('discover').session('discover-urls', {
    with: 'claude-code:sonnet',
    task: 'Discover all business URLs via sitemap',
    write: ['data/urls.json'],
  });

  phase('fetch').parallel(4, i => ({
    id: `shard-${i}`,
    with: 'opencode:groq/llama-3.3-70b',
    task: `Fetch shard ${i} of URLs`,
    write: [`data/shard-${i}/**`],
  }));

  phase('ingest').session('merge', {
    with: 'pi:anthropic/claude-opus-4-7',
    task: 'Merge shard outputs into data/merged.json',
    write: ['data/merged.json'],
  });
});
```

### Surface

- `taskflow(name)` — new pipeline builder.
- `.rules(path)` — attach a rules file, prepended to every session prompt.
- `.env(vars)` — merge env vars before execution.
- `.run(fn, opts?)` — returns `Promise<{ manifest, ctx }>`. `fn(ctx)` is called synchronously to collect the tree; the engine executes after it returns.
- Top-level `ctx` destructures: `{ phase, session, parallel }`.
  - `phase(name)` — returns a chainable `PhaseBuilder`.
  - `phase(name, cb)` — nested form; `cb` gets its own ctx bound to the new phase.
  - `session(id, spec)` — emit a session at the top level.
  - `parallel(thunks)` — top-level fan-out; thunks collected into one parallel group.
- `PhaseBuilder` methods (all chainable):
  - `.session(id, spec)` — attach a session.
  - `.parallel(count, factory)` / `.parallel(items, factory)` — N parallel sessions.
  - `.serial(count, factory)` / `.serial(items, factory)` — N serial sessions.
  - `.phase(name[, cb])` — nested phase.

### SessionSpec fields

| Fluent field | Notes |
|---|---|
| `with: 'agent'` or `'agent:model'` | Split on the **first** `:`. Agent must be `claude-code \| pi \| codex \| cursor \| opencode`. Any further `:` chars stay in `model` (e.g. `'pi:anthropic/claude-opus-4-7:thinking'`). |
| `task: string` | Prompt. Literal string — no template substitution at runtime. |
| `write?: string[]` | Globs of files this session writes. Maps to the engine's `claims`; the runtime enforces literal-prefix disjointness between parallel sessions. |
| `timeoutMs?: number` | Per-session timeout. On expiry, status promotes to `timeout`. |
| `rulesPrefix?: boolean` | Default `true`. Set `false` to opt out of the rules prefix for this session. |
| `id?: string` | Required in `.parallel/.serial` factory form. In `.session(id, spec)` the id comes from the first argument. |

### Running

```bash
# With the Ink TUI (auto-falls back to headless JSONL stdout when no TTY):
npm run run tasks/scrape-don-example.ts

# Headless smoke run against the mock adapter (no tokens, no real CLIs):
HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
  HARNESS_RUNS_DIR=/tmp/tf-smoke npx tsx tasks/scrape-don-example.ts
```

Runs are archived at `data/runs/{runId}/` — `events.jsonl`, `manifest.json`, `leaves/{leafId}/proof.json`.

## Agent + model picking heuristics

| Task shape                                              | Recommended `with:`                                                           |
|---------------------------------------------------------|-------------------------------------------------------------------------------|
| Planning / architecture / code review                   | `claude-code:opus` OR `pi:anthropic/claude-opus-4-7`                          |
| Code gen / refactor (medium stakes)                     | `claude-code:sonnet` OR `pi:anthropic/claude-sonnet-4-6` OR `codex:gpt-5.4`   |
| Mechanical transforms (lint, format, rename, patches)   | `opencode:groq/llama-3.3-70b` OR `pi:cerebras/qwen-...`                       |
| HTTP scraping, parsing, IO-heavy                        | `opencode:groq/*` OR `opencode:cerebras/*`                                    |
| Schema-sensitive / idempotent writes                    | `pi:anthropic/claude-opus-4-7`                                                |
| Cursor-subscription users                               | `cursor:<model from cursor-agent --list-models>`                              |

## Claims and parallelism

- `.parallel(...)` runs children concurrently.
- Before running parallel sessions, the runtime checks no two sessions' `write` globs share a literal prefix. Overlap throws before any session starts.
- Escape hatch for false positives: not yet implemented — when needed, add `exclude: [...]` to the session spec.

## Anti-patterns

- Giving overlapping `write` globs to parallel sessions.
- Using heavy models for mechanical work. Route by task shape.
- Relying on in-memory state across sessions — pass data through files in `write`.
- Omitting `write` on writing sessions — the runtime can't protect you without it.

## Environment

- `ANTHROPIC_API_KEY` — required for `claude-code` sessions and `pi` sessions using `anthropic/*` models.
- `OPENAI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GEMINI_API_KEY` — required for their respective providers (per-session basis).
- `HARNESS_PI_BIN` — override the `pi` binary name (default `pi`). Set to `omp` if you use `@oh-my-pi/pi-coding-agent`.
- `HARNESS_ADAPTER_OVERRIDE=mock` — swap every agent for the mock adapter (for smoke runs).
- `HARNESS_NO_TTY=1` — force headless JSONL output even when a TTY is attached.
- `HARNESS_RUNS_DIR=...` — override the runs archive dir (default `data/runs`).
- `HARNESS_REAL_TESTS=1` — enables integration tests that make real LLM calls (default-skipped).

## Low-level API (power users)

The fluent API is a thin frontend that lowers to four primitives exported from `taskflow/core`:

```ts
import { harness, stage, leaf, parallel } from 'taskflow/core';

await harness('pipeline', { rulesFile: './rules.md' }, async (h) => {
  await stage(h, 'discover', async () => {
    await leaf(h, {
      id: 'discover-urls',
      agent: 'claude-code',
      model: 'sonnet',
      task: 'Discover all URLs',
      claims: ['data/urls.json'],
    });
  });
  await stage(h, 'fetch', async () => {
    await parallel(h, [
      () => leaf(h, { id: 'shard-0', agent: 'opencode', model: 'groq/llama-3.3-70b', task: '...', claims: ['data/shard-0/**'] }),
      () => leaf(h, { id: 'shard-1', agent: 'opencode', model: 'groq/llama-3.3-70b', task: '...', claims: ['data/shard-1/**'] }),
    ]);
  });
});
```

Reach for the low-level form when you need fine-grained control the fluent builder hasn't surfaced yet (custom per-leaf adapters, conditional branches mid-execution, etc.). The fluent API and the core primitives are permanent siblings — the fluent one is the recommended path for new pipelines.

YAML specs + `npm run build` emit the low-level form; optional, not the main path.
