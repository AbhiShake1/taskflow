# @taskflow-corp/cli

[![npm version](https://img.shields.io/npm/v/@taskflow-corp/cli.svg)](https://www.npmjs.com/package/@taskflow-corp/cli)
[![CI](https://github.com/AbhiShake1/taskflow/actions/workflows/ci.yml/badge.svg)](https://github.com/AbhiShake1/taskflow/actions/workflows/ci.yml)
[![Release](https://github.com/AbhiShake1/taskflow/actions/workflows/release.yml/badge.svg)](https://github.com/AbhiShake1/taskflow/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/node/v/@taskflow-corp/cli.svg)](https://nodejs.org/)

Multi-agent orchestration harness for AI coding agents (claude-code, codex, cursor, opencode, pi). Async-await TypeScript API; lifecycle hooks; auto-todos with verify-loop.

## Install

```sh
npm install @taskflow-corp/cli
```

## Quick start

```ts
import { taskflow } from '@taskflow-corp/cli';

await taskflow('hello').run(async ({ phase, session }) => {
  await phase('greet', async () => {
    await session('say-hi', { with: 'claude-code', task: 'Print hello world' });
  });
});
```

## Install harnesses from anywhere — `taskflow add`

Shadcn-style distribution: drop any harness into any project with a single command. Source forms accepted:

```sh
# named (resolves via built-in @taskflow registry)
npx @taskflow-corp/cli add ui-harness-trio

# namespaced (private or third-party registries configured in taskflow.json)
npx @taskflow-corp/cli add @acme/e2e-video-tests

# GitHub shortcut (degit-style)
npx @taskflow-corp/cli add user/repo
npx @taskflow-corp/cli add user/repo/path/to/item.json#v1.2.0

# raw URL
npx @taskflow-corp/cli add https://example.com/r/harness.json

# local file
npx @taskflow-corp/cli add ./my-harness.json

# fully qualified (Terraform grammar: type::url//subpath?ref=&sha256=&depth=)
npx @taskflow-corp/cli add git::ssh://git@host/org/repo.git//items/foo?ref=main
```

Every form fetches → validates → writes files → patches `.agents/taskflow/config.ts` → updates `taskflow.lock`. The first `add` in a project auto-runs `init` to scaffold `taskflow.json`, config, and dirs.

Adjacent commands:

| Command | Purpose |
|---|---|
| `taskflow init` | Create `taskflow.json` + `.agents/taskflow/config.ts` |
| `taskflow add <source...>` | Install one or more harnesses |
| `taskflow view <source>` | Print the resolved registry item JSON (no write) |
| `taskflow list` | Show installed harnesses from `taskflow.lock` |
| `taskflow search <query>` | Fuzzy-match against the public registry index |
| `taskflow update [name...]` | Re-resolve and refresh installed harnesses |
| `taskflow remove <name>` | Uninstall |
| `taskflow apply <preset>` | Re-install with `--overwrite` (shadcn-style re-skin) |
| `taskflow build [input]` | Publisher: inline file contents, emit `r/*.json` |
| `taskflow mcp` | Start the MCP server over stdio (tools: `list_harnesses`, `search`, `install`) |

Flags on `add`: `-y/--yes`, `-o/--overwrite`, `--dry-run`, `--diff`, `--view`, `-p/--path <dir>`, `-c/--cwd <dir>`, `-s/--silent`, `--frozen`, `--skip-adapter-check`.

### Private registries with auth

Put this in your project's `taskflow.json`:

```jsonc
{
  "$schema": "https://taskflow.sh/schema/taskflow.json",
  "version": "1",
  "registries": {
    "@acme": "https://registry.acme.com/r/{name}.json",
    "@private": {
      "url": "https://api.corp.com/taskflow/{name}.json",
      "headers": { "Authorization": "Bearer ${TASKFLOW_TOKEN}" },
      "params":  { "v": "latest" }
    }
  }
}
```

`${VAR}` tokens are expanded from `process.env` (auto-loaded from `.env.local`). Missing vars fail pre-flight with a clear message.

### Publishing your own registry

1. Create `registry/registry.json` listing your items (see `registry/` in this repo for an example).
2. Store each item as a source `.ts` file referenced by `files[].path`.
3. Run `npx @taskflow-corp/cli build` — emits `r/<item>.json` with file contents inlined plus `r/registry.json`.
4. Host the `r/` directory anywhere (GitHub Pages, S3, your own CDN). Consumers then `taskflow add https://<your-host>/r/my-item.json` or register the namespace in their `taskflow.json`.

Full design notes: [docs/add-command-plan.md](./docs/add-command-plan.md).

## Hooks via `.agents/taskflow/config.ts`

```ts
import { defineConfig } from '@taskflow-corp/cli/config';

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
import type { Plugin } from '@taskflow-corp/cli/core';

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
declare module '@taskflow-corp/cli/core' {
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
