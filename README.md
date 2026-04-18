# taskflow-sdk

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

## Docs

See [.claude/skills/taskflow/SKILL.md](./.claude/skills/taskflow/SKILL.md) for the authoring guide.
