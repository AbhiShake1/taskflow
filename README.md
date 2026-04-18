# @onfire/taskflow

Multi-agent orchestration harness for AI coding agents (claude-code, codex, cursor, opencode, pi). Async-await TypeScript API; lifecycle hooks; auto-todos with verify-loop.

## Install

```sh
npm install @onfire/taskflow
```

## Quick start

```ts
import { taskflow } from '@onfire/taskflow';

await taskflow('hello').run(async ({ phase, session }) => {
  await phase('greet', async () => {
    await session('say-hi', { with: 'claude-code', task: 'Print hello world' });
  });
});
```

## Hooks via `.agents/taskflow/config.ts`

```ts
import { defineConfig } from '@onfire/taskflow/config';

export default defineConfig({
  events: {
    afterTaskDone: async (ctx, { spec, result }) => {
      // post-task hook
    },
  },
  todos: { autoExtract: true, maxRetries: 3 },
});
```

## Docs

See [.claude/skills/taskflow/SKILL.md](./.claude/skills/taskflow/SKILL.md) for the authoring guide.
