---
name: taskflow
description: Author and run multi-agent orchestration harnesses with a async-await TypeScript API. Use when the user asks to parallelize a task across AI coding agents, run the same pipeline across multiple models, set up a scraping/ingestion harness, or any time they say "make a harness", "parallelize this", "orchestrate these agents", "multi-agent pipeline", or "build a pipeline with claude-code/pi/codex/cursor/opencode".
---

# Taskflow

A meta-tool for orchestrating parallel/sequential sessions, where each session runs one AI coding agent invocation. The agent and LLM model are chosen per-session, so cheap mechanical work runs on cheap models and stakes-high work runs on frontier models.

## Fluent authoring (primary API)

Author a pipeline as a TypeScript file. `session(...)` is **async-await native** — each call returns a `Promise<T>` where `T` is inferred from an optional zod `schema`. Dependency graphs, fire-and-forget, and parallelism are all just ordinary JS control flow.

```ts
import { taskflow } from 'taskflow';
import { z } from 'zod';

const urlsSchema = z.object({
  urls: z.array(z.string().url()),
  categories: z.array(z.string()),
});

export default taskflow('scrape-don').rules('./rules.md').run(async ({ phase, session }) => {
  // Typed structured output: `discovered` is { urls: string[]; categories: string[] }.
  const discovered = await phase('discover', async () => {
    return session('discover-urls', {
      with: 'claude-code:sonnet',
      task: 'Discover all business URLs via sitemap',
      write: ['data/urls.json'],
      schema: urlsSchema,
    });
  });

  // Parallelism: native Promise.all over a session factory.
  await phase('fetch', async () => {
    await Promise.all(
      discovered.urls.slice(0, 4).map((url, i) =>
        session(`shard-${i}`, {
          with: 'opencode:groq/llama-3.3-70b',
          task: `Fetch ${url}`,
          write: [`data/shard-${i}/**`],
          schema: z.object({ count: z.number() }),
        })
      )
    );
  });

  await phase('ingest', async () => {
    // Fire-and-forget: don't await — the engine still runs it.
    // Errors are the dev's problem; swallow with .catch(...) if you don't care.
    session('telemetry', {
      with: 'claude-code:sonnet',
      task: 'Log shard counts',
    }).catch(() => {});

    // Schema-less session returns Promise<string> (the final assistant text).
    return session('merge', {
      with: 'pi:anthropic/claude-opus-4-7',
      task: 'Merge shards into data/merged.json',
      write: ['data/merged.json'],
    });
  });
});
```

### Surface

- `taskflow(name)` — new pipeline builder.
- `.rules(path)` — attach a rules file, prepended to every session prompt.
- `.env(vars)` — merge env vars before execution.
- `.run(asyncBody, opts?)` — returns `Promise<{ manifest, ctx }>`. `asyncBody(ctx)` is an **async function**: everything it awaits runs inside the harness. Top-level awaits, control flow, and Promise.all all work as you'd expect.
- `ctx` destructures to `{ phase, session }`.
  - `phase(name, asyncBody)` — wraps `engineStage` around `asyncBody`. Returns whatever the body returns, verbatim. Use it to group related work so manifests/TUIs show nested structure.
  - `session(id, spec)` — returns `Promise<T>`:
    - `T = z.infer<typeof spec.schema>` when `schema` is provided.
    - `T = string` (the final assistant message) when no schema is provided.
    - Rejects with a descriptive `Error` on any non-`done` status (adapter crash, timeout, claims conflict, schema validation failure).

### SessionSpec fields

| Field | Notes |
|---|---|
| `with: 'agent'` or `'agent:model'` | Split on the **first** `:`. Agent must be `claude-code \| pi \| codex \| cursor \| opencode`. Any further `:` chars stay in `model` (e.g. `'pi:anthropic/claude-opus-4-7:thinking'`). |
| `task: string` | Prompt. Literal string — no template substitution at runtime. |
| `write?: string[]` | Globs this session writes. Maps to the engine's `claims`; the runtime enforces literal-prefix disjointness between concurrent siblings. |
| `timeoutMs?: number` | Per-session timeout. On expiry, status promotes to `timeout`. |
| `rulesPrefix?: boolean` | Default `true`. Set `false` to opt out of the rules prefix for this session. |
| `schema?: z.ZodType<T>` | Zod schema for structured output. When set, `session()` returns `Promise<T>` (validated). When omitted, returns `Promise<string>`. |

### Structured output — how it really flies

The session promise resolves to typed data; how the harness extracts that data depends on the adapter:

- **claude-code** uses the claude-agent-sdk's MCP tool path. Taskflow registers a `submit_result` tool whose input schema is derived from your zod schema, and instructs the model to call it exactly once at the end. This is the reliable path.
- **codex, cursor, opencode, pi** currently use a **prompt-engineering fallback**: the JSON schema is appended to the task prompt and the adapter parses a ```json``` code block from the final assistant message. Each adapter carries a `// TODO(taskflow): upgrade to <provider>-native structured output` marker for the eventual native-mode upgrade.

Either way the return type you see in TypeScript is `z.infer<typeof schema>`, and zod `.parse()` runs on the value the adapter captured. If the capture fails (no tool call, no JSON block, schema mismatch), the session promise rejects.

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

- `Promise.all([session(...), session(...)])` runs children concurrently.
- Before running concurrent sessions, the runtime checks no two sessions' `write` globs share a literal prefix. Overlap throws before any session starts.
- Escape hatch for false positives: not yet implemented — when needed, add `exclude: [...]` to the session spec.

## Anti-patterns

- Giving overlapping `write` globs to concurrent sessions.
- Using heavy models for mechanical work. Route by task shape.
- Relying on in-memory state across sessions — pass data through typed returns or files in `write`.
- Omitting `write` on writing sessions — the runtime can't protect you without it.
- Forgetting `.catch(() => {})` on a fire-and-forget session — Node.js will log an unhandled rejection.

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
