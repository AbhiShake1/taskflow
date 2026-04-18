---
name: taskflow
description: Author and run multi-agent orchestration harnesses with a async-await TypeScript API. Use when the user asks to parallelize a task across AI coding agents, run the same pipeline across multiple models, set up a scraping/ingestion harness, or any time they say "make a harness", "parallelize this", "orchestrate these agents", "multi-agent pipeline", or "build a pipeline with claude-code/pi/codex/cursor/opencode".
---

# Taskflow

A meta-tool for orchestrating parallel/sequential sessions, where each session runs one AI coding agent invocation. The agent and LLM model are chosen per-session, so cheap mechanical work runs on cheap models and stakes-high work runs on frontier models.

## When authoring or editing tasks/*.ts — ALWAYS plan first

After writing or editing any `.ts` file under `tasks/`, IMMEDIATELY run `npm run plan -- tasks/<name>.ts` and share the rendered phase/session tree back to the user before asking whether to execute. This is a hard rule — do not offer to run, do not assume shape, preview first.

## Previewing before running

```
npm run plan -- tasks/<name>.ts
```

Renders an Ink tree of the phases/sessions the file would execute, without making any LLM calls or running the user's code. It walks the TypeScript AST, matches `taskflow(...).run(...)` → `phase(...)` → `session(...)` patterns, and shows everything in a `◯` (plan) state.

Keys: `↑↓` navigate, `⏎` inspect a session (full task text, schema JSON, write claims, timeout), `q` to quit.

Note the `--` in the npm invocation — it is required for argv to be passed through to the script.

What is visible in each row:
- session id, agent, model, `write: data/...` paths (inline on the tail)
- `schema: <name>` when a zod schema is attached (inspect for the full JSON-Schema expansion)
- `(parallel × N)` on phases that use `Promise.all([...map(...)])` over a literal array
- `(dynamic id)` / `(fire-and-forget)` flags when the authoring pattern implies them

Patterns that downgrade to `?` nodes (shown but flagged as "unknown"):
- helper function calls the walker cannot resolve statically
- `Promise.all([...])` over a non-literal, non-`.map` expression
- object literals where `with:` or `task:` are not string-like

Use plan mode to verify phase names, session ids, agent pairings, and write-disjointness at a glance before committing to a real run.

## Fluent authoring (primary API)

Author a pipeline as a TypeScript file. `session(...)` is **async-await native** — each call returns a `Promise<T>` where `T` is inferred from an optional zod `schema`. Dependency graphs, fire-and-forget, and parallelism are all just ordinary JS control flow.

```ts
import { taskflow } from 'taskflow';
import { z } from 'zod';

const urlsSchema = z.object({
  urls: z.array(z.string().url()),
  categories: z.array(z.string()),
});

export default taskflow('scrape-don').run(async ({ phase, session }) => {
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

## Engine internals

The fluent API is a thin frontend that lowers onto engine primitives in `taskflow/core`
(`harness`, `stage`, `leaf`, `parallel`). Reach for those only when you need
fine-grained control the fluent builder hasn't surfaced yet. The fluent API is
the recommended authoring path.

## Configuration: .agents/taskflow/config.ts

Taskflow auto-discovers a project-local config file at `.agents/taskflow/config.{ts,mjs,js}`. Lookup order: starts at `~/.agents/taskflow/config.ts` and walks **down** the path toward `cwd`, picking up a config in every directory along the way. The cwd config is the most specific. Layers merge via `defu` (deep merge, later layers override earlier). `events` arrays accumulate; scalar `scope` takes the most-specific non-empty value.

`defineConfig({...})` is the entry point — it's a no-op typing helper that surfaces autocompletion.

```ts
// .agents/taskflow/config.ts
import { defineConfig } from 'taskflow-sdk/core/config';

export default defineConfig({
  // Hooks. Any subset of HookHandlers. See "Lifecycle hooks" below.
  events: {
    afterTaskDone: async (ctx, { spec, result }) => {
      ctx.logger.info(`[${spec.id}] finished status=${result.status}`);
    },
  },

  // Todos & verify-loop tuning.
  todos: {
    autoExtract: true,         // default true: parse `- [ ] item` from spec.task
    maxRetries: 3,             // default 3: bound on the verify-loop
    forceGeneration: false,    // default false: prepend "output your plan first" directive
    generationPreamble: undefined, // optional: custom directive text; `{{items}}` is replaced
  },

  // Hook execution policy.
  hooks: {
    errorPolicy: 'swallow',    // 'swallow' | 'warn' | 'throw' — default 'swallow'
    timeoutMs: 30_000,         // per-handler timeout — default 30000
  },

  // Free-form scope/constraints text prepended to every session task.
  scope: 'No new files. No new deps. Edit-only.',

  // Plugins: see "Plugins" below.
  plugins: [],
});
```

Defaults (see `core/config.ts` `DEFAULT_CONFIG`): `autoExtract: true`, `maxRetries: 3`, `errorPolicy: 'swallow'`, `timeoutMs: 30_000`, `forceGeneration: false`. `scope` is undefined.

> **Until published:** `taskflow-sdk` is the upcoming published name. While developing inside this repo, import from relative paths: `import { defineConfig } from '../core/config';` or `import type { HookHandlers } from '../core/hooks';`.

## Lifecycle hooks

Every hook is `(ctx: HookCtx, payload: HookPayloads[N]) => HookReturns[N] | Promise<...>`. Source of truth: `core/hooks.ts`. `before*` returns can mutate the upcoming action; `after*` returns are ignored.

### Harness

| Hook | Fires | Payload | Return |
|---|---|---|---|
| `beforeHarness` | once at top of `harness()`, after config+plugin resolution | `{ name; runId; runDir }` | `void` |
| `afterHarness`  | once after the harness body settles, before throw is rethrown | `{ manifest; error? }` | `void` |

### Phase

| Hook | Fires | Payload | Return |
|---|---|---|---|
| `beforePhase` | entering `stage()` (i.e. `phase(name, body)`) | `{ phaseId; parentId? }` | `void` |
| `afterPhase`  | leaving the stage body (success or throw) | `{ phaseId; status: 'done'\|'error'; error? }` | `void` |

### Session (leaf)

| Hook | Fires | Payload | Return |
|---|---|---|---|
| `beforeSession` | start of `leaf()`, after todos seeded + scope/forceGen applied | `{ spec }` | `{ spec?; skip? } \| void` — replace spec or skip |
| `afterSession`  | after proof.json is written | `{ spec; result }` | `void` |
| `beforeSpawn`   | immediately before `adapter.spawn(...)` | `{ spec }` | `{ spec? } \| void` — last chance to mutate spec |
| `afterSpawn`    | immediately after spawn, with the live `handle` | `{ spec; handle }` | `void` |

### Streaming

Each event the adapter emits flows through one `before*` (mutate/drop) and, if not dropped, one `after*` (observe).

| Hook | Payload | Return |
|---|---|---|
| `beforeMessage` / `afterMessage` | `{ ev: Extract<RunEvent, { t:'message' }> }` | before: `{ content?; drop? } \| void` |
| `beforeToolCall` / `afterToolCall` | `{ ev: Extract<RunEvent, { t:'tool' }> }` | before: `{ args?; skip? } \| void` |
| `beforeToolResult` / `afterToolResult` | `{ ev: Extract<RunEvent, { t:'tool-res' }> }` | before: `{ result? } \| void` |
| `beforeEdit` / `afterEdit` | `{ ev: Extract<RunEvent, { t:'edit' }> }` | `void` |
| `beforeSteer` / `afterSteer` | `{ leafId; content }` | before: `{ content?; cancel? } \| void` |
| `beforeAbort` / `afterAbort` | `{ leafId; reason? }` | before: `{ cancel? } \| void` |

### Errors

| Hook | Payload | Return |
|---|---|---|
| `onError` | `{ leafId?; error }` (fired for `t:'error'` adapter events) | `{ swallow? } \| void` |

### Response & verify

| Hook | Fires | Payload | Return |
|---|---|---|---|
| `beforeResponse`     | after adapter says done, before verify | `{ spec; draftResult; attempt }` | `{ retry?; steerWith? } \| void` |
| `verifyTaskComplete` | between beforeResponse and beforeTaskDone | `{ spec; draftResult; attempt; todos }` | `{ done: true } \| { done: false; remaining: string[]; steerWith? }` |
| `beforeTaskDone`     | after verify | `{ spec; draftResult; attempt }` | `{ retry?; steerWith? } \| void` |
| `afterResponse`      | after the verify-loop settles (final result locked) | `{ spec; result }` | `void` |
| `afterTaskDone`      | last hook before proof.json write | `{ spec; result }` | `void` |

### Todos

| Hook | Fires | Payload | Return |
|---|---|---|---|
| `collectTodos` | once per leaf, before `beforeSession` | `{ spec }` | `string[] \| { items: string[]; required? } \| void` — items merged into the leaf todo store |

### Parallel

| Hook | Fires | Payload | Return |
|---|---|---|---|
| `beforeParallel` | start of `parallel()` (engine primitive) | `{ count }` | `void` |
| `afterParallel`  | after `Promise.allSettled` resolves | `{ count; errors }` | `void` |

## HookCtx

The context object passed to every hook handler. Source: `core/hooks.ts`.

```ts
interface HookCtx {
  // Identity
  scope:        { harness: string; runId: string; runDir: string };
  phaseScope?:  { id: string; stack: string[] };
  sessionScope?:{ id: string; spec: LeafSpec; attempt: number };
  event?:       RunEvent;        // present on streaming hooks
  hookName:     HookName;        // the firing hook's name

  // Bus & live handle
  bus:    EventBus;
  handle?: AgentHandle;          // present from afterSpawn through afterTaskDone

  // Imperative actions
  steer:  (text: string) => Promise<void>;
  abort:  (reason?: string) => Promise<void>;
  emit:   (ev: RunEvent) => void;

  // Capabilities
  logger: HookLogger;            // debug/info/warn/error
  fs:     ScopedFs;              // run-dir-scoped read/write/mkdir/list
  fetch:  typeof globalThis.fetch;
  todos:  TodoApi;               // list/add/complete/remaining/clear/loadFromMarkdown
  proof:  ProofApi;              // captureJson/captureFile under runDir/proof
  config: ResolvedConfig;        // resolved (post-merge) config

  // Composition
  plugins: PluginNamespaces;     // module-augment to type your plugin's surface
  state:   Map<string, unknown>; // per-fire scratch space; not shared across leaves

  // Spawn-from-hook — the keystone for follow-up work
  session: <T extends SessionSpecLike<unknown>>(id: string, spec: T) => Promise<SessionReturn<T>>;
  phase:   <T>(name: string, body: () => Promise<T>) => Promise<T>;
}
```

### `ctx.session(id, spec)` and `ctx.phase(name, body)`

These are the SAME fluent API as the top-level `session(...)` / `phase(...)` you destructure from `taskflow().run(({ phase, session }) => ...)`. A hook handler can spawn follow-up work and the engine treats it identically to a hand-authored leaf:

- It bus-publishes events live → the TUI updates while the hook is running.
- It appears in `manifest.json` alongside hand-authored leaves.
- Claim-conflict checks apply (overlapping `write` globs throw before spawn).
- All hooks (including `beforeSession` / `collectTodos` / verify-loop) fire for the child.
- The child's spawned children fire hooks too — recursion is bounded only by user code.

```ts
// .agents/taskflow/config.ts
import { defineConfig } from 'taskflow-sdk/core/config';

export default defineConfig({
  events: {
    afterTaskDone: async (ctx, { spec, result }) => {
      // GUARD: we're inside a session hook, so check id to avoid infinite recursion.
      if (ctx.sessionScope?.id !== 'parent') return;
      if (result.status !== 'done') return;

      // Spawn a follow-up under a named phase so the TUI shows nesting.
      await ctx.phase('post-parent', async () => {
        await ctx.session('audit', {
          with: 'claude-code:sonnet',
          task: `Audit the output produced by ${spec.id}.`,
          write: [`data/audits/${spec.id}.md`],
        });
      });
    },
  },
});
```

> **Recursion:** `ctx.session` from a hook fires every hook the parent does — including `afterTaskDone` itself. Always gate on `ctx.sessionScope?.id` (or stash a marker in `ctx.state`) before spawning, or you will recurse forever.

## Todos & verify-loop

Taskflow tracks a per-leaf todo list, persisted to `data/runs/<runId>/leaves/<leafId>/todos.json` after every mutation.

Sources, in seeding order:

1. **Auto-extraction** from `- [ ] item` markdown lines in `spec.task`. Default ON; disable with `config.todos.autoExtract: false`.
2. **`SessionSpec.todos: string[]`** — explicit declaration on the session spec.
3. **`collectTodos` hook** — config and plugins return `string[]` (or `{ items, required? }`); items are merged into the todo store and tracked as **mandatory** for the verify-loop.

### The verify-loop

After `handle.wait()` resolves with the adapter's draft result, the engine does NOT immediately publish a final `done`. It runs:

```
beforeResponse  →  verifyTaskComplete  →  beforeTaskDone
```

If any of those returns `{ retry: true, steerWith }` (or verify returns `{ done: false, remaining: [...], steerWith }`), the engine re-arms the session:

- If the adapter exposes `handle.continueAfterDone(steerText)` (claude-code, mock), it resumes with preserved context.
- Otherwise it re-spawns a fresh session with `steerText` appended to the task.

The loop is bounded by `config.todos.maxRetries` (default 3). On exhaustion, the result's `status` is promoted to `'error'` and `error` names the unmet items:

```
verify-loop exhausted after 4 attempt(s); unmet:
- write the migration
- update the changelog
```

```ts
// Example: enforce a "must produce JSON output" rule.
export default defineConfig({
  events: {
    verifyTaskComplete: async (ctx, { draftResult }) => {
      const text = draftResult.finalAssistantText ?? '';
      if (text.includes('```json')) return { done: true };
      return {
        done: false,
        remaining: ['emit a ```json block'],
        steerWith: 'You forgot the JSON block. Emit it now in a ```json fence.',
      };
    },
  },
  todos: { maxRetries: 2 },
});
```

## forceGeneration & scope

Both options inject preamble text into the final task string. Order in the spawned prompt:

```
[scope block]   ← config.scope
[forceGen directive]   ← config.todos.forceGeneration
[original task]
```

### `config.scope`

A free-form text block prepended verbatim under a `Scope and constraints:` header. Use for short, hard rules every session must respect.

```ts
export default defineConfig({
  scope: 'No new files. No new deps. Edit existing modules only.',
});
```

Result: every spawned task starts with

```
Scope and constraints:
No new files. No new deps. Edit existing modules only.

---

<original task>
```

### `config.todos.forceGeneration`

When `true`, the engine prepends a directive instructing the agent to output a `- [ ]` markdown plan **before** doing any other work. The plan must include all mandatory items collected from `collectTodos`.

`config.todos.generationPreamble` (string, optional) overrides the directive. The literal token `{{items}}` is replaced with the formatted item list (`- [ ] x\n- [ ] y\n...`).

```ts
export default defineConfig({
  todos: {
    forceGeneration: true,
    generationPreamble: [
      'Output your plan as a checklist FIRST. Required items:',
      '{{items}}',
      'Then execute.',
    ].join('\n'),
  },
  events: {
    collectTodos: async () => ['ran tests', 'updated changelog'],
  },
});
```

## Plugins

A plugin is a function `(api: PluginInitApi) => PluginContribution | Promise<PluginContribution>`. Plugins compose deterministically in declared order. Their `events` mount alongside config events; their `ctx(...)` builder result lands on `ctx.plugins[name]`; their `config` fragment merges into the resolved config.

```ts
// PluginContribution shape (core/plugin.ts):
interface PluginContribution {
  name: string;                                                // unique, throws on duplicate
  events?: Partial<HookHandlers>;                              // hook handlers
  ctx?: (ctx: HookCtx) => Record<string, unknown>;             // build per-hook ctx surface
  config?: Partial<ResolvedConfig>;                            // contribute config fragments
}
```

### Module-augmentation: typing `ctx.plugins.<name>`

```ts
// my-plugin.ts
import type { Plugin } from 'taskflow-sdk/core/plugin';

export interface AuditApi {
  trail: (msg: string) => Promise<void>;
}

declare module 'taskflow-sdk/core/hooks' {
  interface PluginNamespaces {
    audit: AuditApi;
  }
}

export const auditPlugin: Plugin = () => ({
  name: 'audit',
  ctx: (ctx) => ({
    trail: async (msg: string) => {
      const line = `[${new Date().toISOString()}] ${ctx.sessionScope?.id ?? '-'} ${msg}\n`;
      await ctx.fs.write('audit.log', line);
    },
  } satisfies AuditApi),
  events: {
    afterTaskDone: async (ctx, { spec, result }) => {
      await ctx.plugins.audit.trail(`done ${spec.id} status=${result.status}`);
    },
  },
});
```

Mount it from config:

```ts
// .agents/taskflow/config.ts
import { defineConfig } from 'taskflow-sdk/core/config';
import { auditPlugin } from './plugins/audit';

export default defineConfig({
  plugins: [auditPlugin],
});
```

Composition rules (see `core/plugin.ts`):
- Duplicate `name` throws at compose time.
- Multiple plugins registering the SAME hook chain in declaration order — every handler runs sequentially; only the last non-undefined return is observed.
- Plugin handlers mount BEFORE config handlers, so project-level config code runs LAST and has the final say.

## Authoring loop (when writing config.ts or hooks)

A short workflow when extending a project's hook surface:

1. Edit `.agents/taskflow/config.ts` (or a plugin file under `.agents/taskflow/plugins/`).
2. Run a small smoke task with the mock adapter to validate hooks fire as expected:

   ```bash
   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
     HARNESS_RUNS_DIR=/tmp/tf-smoke npx tsx tasks/<smoke>.ts
   ```

3. Inspect `data/runs/<runId>/events.jsonl` (or `/tmp/tf-smoke/<runId>/events.jsonl`) to confirm the event sequence, hook ordering, and any retries.
4. Inspect `data/runs/<runId>/leaves/<leafId>/todos.json` to confirm what got tracked when relying on the verify-loop.
5. Once the smoke run looks right, run the real harness against live adapters.

The mock adapter is the fastest feedback loop for hook authoring — it costs zero tokens, supports `continueAfterDone`, and emits the same `RunEvent` shape as production adapters.
