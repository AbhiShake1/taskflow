# taskflow-sdk

[![npm version](https://img.shields.io/npm/v/taskflow-sdk.svg)](https://www.npmjs.com/package/taskflow-sdk)
[![CI](https://github.com/AbhiShake1/taskflow/actions/workflows/ci.yml/badge.svg)](https://github.com/AbhiShake1/taskflow/actions/workflows/ci.yml)
[![Release](https://github.com/AbhiShake1/taskflow/actions/workflows/release.yml/badge.svg)](https://github.com/AbhiShake1/taskflow/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/node/v/taskflow-sdk.svg)](https://nodejs.org/)

Multi-agent orchestration harness for AI coding agents (claude-code, codex, cursor, opencode, pi). Async-await TypeScript API; lifecycle hooks; auto-todos with verify-loop.

## Install

```sh
npm install taskflow-sdk
```

## Quick start

```ts
import { taskflow } from 'taskflow-sdk';

await taskflow('hello').run(async ({ phase, session }) => {
  await phase('greet', async () => {
    await session('say-hi', { with: 'claude-code', task: 'Print hello world' });
  });
});
```

## Hooks via `.agents/taskflow/config.ts`

```ts
import { defineConfig } from 'taskflow-sdk/config';

export default defineConfig({
  events: {
    afterTaskDone: async (ctx, { spec, result }) => {
      // post-task hook
    },
  },
  todos: { autoExtract: true, maxRetries: 3 },
});
```

## Structured output

Sessions with a zod `schema` return typed results. `claude-code` uses native tool-use. `codex` (on `gpt-5` / `gpt-5.4` models) uses `--output-schema`; `gpt-5-codex` variants fall back to prompt-engineered JSON pending [openai/codex#4181](https://github.com/openai/codex/issues/4181). Other adapters (`cursor`, `opencode`, `pi`) use prompt-engineered JSON. Override codex behavior with `HARNESS_CODEX_SCHEMA=0|1`.

```ts
import { z } from 'zod';

const result = await session('summary', {
  with: 'codex:gpt-5.4',
  task: 'Summarize the repo',
  schema: z.object({ title: z.string(), bullets: z.array(z.string()) }),
});
// result is typed: { title: string; bullets: string[] }
```

## Plugins

A plugin contributes hooks, a `ctx.plugins.<name>` namespace, and optional config fragments:

```ts
import type { Plugin } from 'taskflow-sdk/core';

export const myPlugin: Plugin = () => ({
  name: 'my-plugin',
  events: {
    afterTaskDone: async (ctx, { spec }) => { /* ... */ },
  },
  ctx: () => ({ hello: () => 'world' }),
});
```

To get typed access to `ctx.plugins.myPlugin.hello()` in downstream hooks, module-augment the plugin namespace registry:

```ts
declare module 'taskflow-sdk/core' {
  interface PluginNamespaces {
    'my-plugin': { hello: () => string };
  }
}
```

See [`examples/omai-plugin-starter/`](./examples/omai-plugin-starter/) for a fuller scaffold (screen capture + UI-TARS wiring stubs).

## Environment variables

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required for `claude-code` sessions and `pi:anthropic/*`. |
| `OPENAI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GEMINI_API_KEY` | Required per-session for the respective providers. |
| `HARNESS_PI_BIN` | Override the `pi` binary name (default `pi`). Use `omp` with `@oh-my-pi/pi-coding-agent`. |
| `HARNESS_CODEX_SCHEMA` | `0` forces prompt-engineered JSON for codex; `1` forces native `--output-schema`. |
| `HARNESS_ADAPTER_OVERRIDE=mock` | Swap every agent for the mock adapter — smoke runs with zero token cost. |
| `HARNESS_NO_TTY=1` | Force headless JSONL output even when a TTY is attached. |
| `HARNESS_RUNS_DIR=...` | Override the runs archive directory (default `data/runs`). |
| `HARNESS_REAL_TESTS=1` | Enable integration tests that make real LLM calls (default-skipped). |

## Docs

See [.claude/skills/taskflow/SKILL.md](./.claude/skills/taskflow/SKILL.md) for the authoring guide.
