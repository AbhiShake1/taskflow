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

Shadcn-style distribution: drop any harness into any project with a single command. You never need to install the package locally — `npx @taskflow-corp/cli@latest <command>` works from any directory and always pulls the newest version.

### Source formats (every form accepted by `add`)

```sh
# 1. Bare name — built-in @taskflow registry
#    resolves against TASKFLOW_REGISTRY_URL (default https://taskflow.sh/r/{name}.json)
npx @taskflow-corp/cli@latest add example-hello

# 2. Namespaced — @ns/name, looked up in taskflow.json `registries` map
npx @taskflow-corp/cli@latest add @acme/e2e-video-tests
npx @taskflow-corp/cli@latest add @acme/e2e-video-tests@^1.2.0        # optional semver tail

# 3. Raw URL — any server returning a valid registry-item.json
npx @taskflow-corp/cli@latest add https://example.com/r/harness.json
npx @taskflow-corp/cli@latest add https://raw.githubusercontent.com/you/repo/main/r/x.json

# 4. Local file — absolute, relative, or ~/-prefixed
npx @taskflow-corp/cli@latest add ./my-harness.json
npx @taskflow-corp/cli@latest add /abs/path/harness.json
npx @taskflow-corp/cli@latest add ~/shared/harness.json

# 5. Bare GitHub shortcut (degit-style) — defaults to github.com
npx @taskflow-corp/cli@latest add user/repo
npx @taskflow-corp/cli@latest add user/repo/path/to/item.json         # subpath
npx @taskflow-corp/cli@latest add user/repo/path/to/item.json#v1.2.0  # branch | tag | sha

# 6. Explicit host shortcut — github: / gitlab: / bitbucket:
npx @taskflow-corp/cli@latest add github:user/repo/items/foo.json#main
npx @taskflow-corp/cli@latest add gitlab:user/repo/items/foo.json#v1
npx @taskflow-corp/cli@latest add bitbucket:user/repo/items/foo.json

# 7. Fully qualified (Terraform grammar, for private SSH, integrity pinning, etc.)
#    Format: <type>::<url>[//<subpath>][?ref=<ref>&sha256=<hex>&depth=<n>]
npx @taskflow-corp/cli@latest add git::https://host/org/repo.git//items/foo.json?ref=v1
npx @taskflow-corp/cli@latest add git::ssh://git@github.com/you/priv.git//items/foo.json?ref=main
npx @taskflow-corp/cli@latest add https::https://example.com/bundle.json?sha256=abc123
npx @taskflow-corp/cli@latest add file::./local/harness.json
```

**Detection order** (first match wins, mirrors shadcn's resolver):

1. ends with `.json` and not a URL → **local file**
2. `git::` / `https::` / `file::` prefix → **fully qualified**
3. `github:` / `gitlab:` / `bitbucket:` prefix → **host shortcut**
4. parses as a URL → **raw URL**
5. `@ns/name` → **namespace lookup**
6. `user/repo[/subpath][#ref]` → **bare GitHub shortcut**
7. otherwise → **bare name** (built-in `@taskflow` registry)

Every form resolves to: fetch → validate (Zod) → write files → patch `.agents/taskflow/config.ts` (ts-morph AST merge) → merge `.env.local` → upsert `taskflow.lock`.

### Multiple sources in one call

```sh
npx @taskflow-corp/cli@latest add example-hello @acme/video-tests ./local.json
```

`registryDependencies` from each item are resolved transitively (BFS + Kahn topo sort with cycle tolerance), so one command can pull a whole dependency graph.

### Lifecycle commands

| Command | Purpose |
|---|---|
| `taskflow init` | Scaffold `taskflow.json` + `.agents/taskflow/config.ts` + harness/rules dirs (auto-invoked by `add` on first use) |
| `taskflow add <source...>` | Install one or more harnesses |
| `taskflow view <source>` | Print the resolved registry-item JSON (no write, no install) |
| `taskflow list` | List installed harnesses from `taskflow.lock` |
| `taskflow search <query>` | Fuzzy-match local registries + auto-discover taskflow harnesses on GitHub |
| `taskflow update [name...]` | Re-resolve; rewrite files + lockfile (`--all` implied if no names) |
| `taskflow remove <name>` | Delete installed files + lockfile entry |
| `taskflow apply <preset>` | `add --overwrite` alias (shadcn-style re-skin) |
| `taskflow build [input]` | **Publisher**: inline source file contents, emit `r/*.json` + `r/registry.json` |
| `taskflow mcp` | Start MCP server over stdio (tools: `list_harnesses`, `search`, `install`) |
| `taskflow run <harness.ts>` | Execute an installed harness (TUI if TTY else JSONL) |
| `taskflow watch <harness.ts>` | Alias for `run` |
| `taskflow plan <harness.ts>` | Static AST preview — no LLM calls |

### Flag reference for `add`

| Flag | Default | Effect |
|---|---|---|
| `-y, --yes` | `false` | Skip all confirmation prompts. On existing-file conflicts, **skips** the file (does NOT auto-overwrite — use `--overwrite` for that). |
| `-o, --overwrite` | `false` | Replace existing files without prompt. Orthogonal to `--yes`. |
| `--dry-run` | `false` | Resolve + validate, print what would change, do not write. |
| `--diff` | `false` | Like `--dry-run` with a diff. Implies `--dry-run`. |
| `--view` | `false` | Resolve and print the registry-item JSON to stdout. Do not write, do not preflight. |
| `-p, --path <dir>` | `harnessDir` from `taskflow.json` | Override install directory for this run. |
| `-c, --cwd <dir>` | `process.cwd()` | Run as if invoked from `<dir>`. |
| `-s, --silent` | `false` | Mute all `@clack/prompts` output. On conflicts, skips like `--yes`. |
| `--frozen` | `false` | CI mode: error if resolved items don't match `taskflow.lock`. |
| `--skip-adapter-check` | `false` | Skip the `requiredAdapters` preflight check. |

### Getting started in any project (30 seconds)

```sh
# From any repo on your machine:
cd /path/to/some/project

# First add auto-scaffolds taskflow.json + .agents/taskflow/config.ts + dirs
npx @taskflow-corp/cli@latest add <your-source> -y --skip-adapter-check

# See what was installed
npx @taskflow-corp/cli@latest list

# Run it
npx @taskflow-corp/cli@latest run .agents/taskflow/harness/<name>.ts
```

### File layout after `init` + `add`

```
project/
├── taskflow.json                     # config + registries map
├── taskflow.lock                     # content-addressed install manifest
├── .env.local                        # auto-loaded; ${VAR} expansion for registries
└── .agents/
    └── taskflow/
        ├── config.ts                 # hooks, plugins, scope
        ├── harness/<name>.ts         # installed harness files
        ├── harness/plugins/<name>.ts # installed plugins
        ├── harness/utils/<name>.ts   # installed utilities
        ├── harness/examples/<name>.ts
        └── rules/<name>.md           # installed rules files
```

### Private registries with auth

`taskflow.json`:
```jsonc
{
  "$schema": "https://taskflow.sh/schema/taskflow.json",
  "version": "1",
  "registries": {
    // simple form — string URL template
    "@acme": "https://registry.acme.com/r/{name}.json",

    // advanced form — per-registry headers and query params
    "@private": {
      "url": "https://api.corp.com/taskflow/{name}.json",
      "headers": { "Authorization": "Bearer ${TASKFLOW_TOKEN}" },
      "params":  { "v": "latest" }
    }
  }
}
```

- `{name}` placeholder is **mandatory**; `{style}` is reserved for future use.
- `${VAR_NAME}` (braces required, no `$VAR` form) interpolates from `process.env`.
- `.env` and `.env.local` are auto-loaded before resolution.
- Missing env vars fail pre-flight with a clear `RegistryMissingEnvironmentVariablesError`.
- HTTP 401/403/404/410 map to specific typed errors with actionable hints.

### Publishing your own registry

1. Author `registry/registry.json`:
   ```jsonc
   {
     "$schema": "https://taskflow.sh/schema/registry.json",
     "name": "@yourname",
     "homepage": "https://yourname.dev",
     "items": [
       {
         "$schema": "https://taskflow.sh/schema/registry-item.json",
         "name": "my-harness",
         "type": "taskflow:harness",
         "files": [
           { "path": "items/my-harness.ts", "type": "taskflow:harness" }
         ]
       }
     ]
   }
   ```
2. Write the source `.ts` files referenced by `files[].path`.
3. Run `npx @taskflow-corp/cli@latest build -c ./registry --output ./registry/r`.
4. Host the emitted `r/` directory (GitHub Pages, S3, your CDN).
5. Consumers then:
   ```sh
   npx @taskflow-corp/cli@latest add https://<your-host>/r/my-harness.json
   ```

See `registry/` in this repo for a worked example.

### Auto-discovery — zero-config installs from any GitHub repo

Typing `taskflow add <user>/<repo>` with no subpath and no `registry-item.json` at the repo root now triggers **auto-discovery**: the CLI searches the target repo for files that look like taskflow harnesses (i.e. import `@taskflow-corp/cli` / `taskflow-cli` / `taskflowjs` / `taskflow-sdk` and top-level-call `taskflow(...).run(...)`), then prompts a multi-select so you pick exactly which harnesses to install.

```sh
$ npx @taskflow-corp/cli@latest add AbhiShake1/taskflow

◇  Discovered 4 taskflow harnesses in AbhiShake1/taskflow:

◇  Select harnesses to install: (space to toggle, enter to confirm)
   ◼  examples/ui-plan.ts        (matched: import from '@taskflow-corp/cli')
   ◻  examples/ui-execute.ts
   ◼  examples/ui-harness-trio/index.ts
   ◻  harness/self-evolve.ts

◇  Installing 2 harnesses…
   ✔ .agents/taskflow/harness/ui-plan.ts
   ✔ .agents/taskflow/harness/index.ts
✔  Done. 2 written, 0 skipped, 0 overwritten.
```

Rules:
- **0 matches** → error with a clear message ("no taskflow harnesses found in `<repo>`").
- **1 match** → auto-install, no prompt.
- **>1 matches** → interactive `@clack/prompts` `multiselect`. Default nothing selected; pick what you want.
- **`--yes` with >1 matches** → **errors** ("multiple harnesses found; re-run without `--yes`, or pass the full path e.g. `user/repo/path/file.ts` to target one file"). Auto-discovery never silently installs everything just because `--yes` was passed.

If the target repo ships a `registry-item.json` at HEAD on the default branch, the original Tier 2 shortcut behaviour wins (fetch the registry item directly) and discovery is skipped. If you type the full path (`user/repo/sub/path.ts`), the tarball-fetch path is used and discovery is also skipped.

**How it works.** The CLI hits a small Cloudflare Pages Function (`/api/discover`) which uses Cloudflare Browser Rendering to call grep.app on demand (no polling, no cron — per-request headless browser). Results are cached 10 minutes in Workers KV. On any grep.app error the Function transparently falls back to the **GitHub Code Search API** so discovery stays up during rate limits or outages. Set `TASKFLOW_DISCOVER_URL` to point the CLI at a private proxy (useful for enterprise mirrors or local `wrangler pages dev`):

```sh
TASKFLOW_DISCOVER_URL=https://my-proxy.example.com/api/discover \
  npx @taskflow-corp/cli@latest add AbhiShake1/taskflow
```

**`taskflow search` uses discovery too.** Results from a `taskflow search <query>` now fold GitHub-wide discovery hits in alongside the configured-registry fuzzy-matches, so you can grep the whole GitHub index for a harness by keyword without targeting a specific repo.

Full design notes for discovery live in [docs/add-command-plan.md §15](./docs/add-command-plan.md#15-auto-discovery).

### Item types (`registry-item.json` → `type`)

| Type | Default destination | Notes |
|---|---|---|
| `taskflow:harness` | `<harnessDir>/<basename>` | Main `.ts` the user runs |
| `taskflow:plugin` | `<harnessDir>/plugins/<basename>` | Imported from `config.ts` |
| `taskflow:utils` | `<harnessDir>/utils/<basename>` | Shared TS |
| `taskflow:example` | `<harnessDir>/examples/<basename>` | Sample invocation |
| `taskflow:rules` | `<rulesDir>/<basename>` or `target` | Markdown rules |
| `taskflow:config-patch` | Merged into `config.ts` via ts-morph AST | Not a file |
| `taskflow:file` | `target` **(required)** | Arbitrary path incl. `~/` |

### MCP integration (Claude Code / Cursor / Codex)

```sh
npx @taskflow-corp/cli@latest mcp
```

Exposes three tools over stdio:
- `list_harnesses` — return installed harnesses from `taskflow.lock`
- `search` — fuzzy-match local registries + GitHub-wide auto-discovery
- `install` — delegate to `runAdd`

Wire it into your MCP client config and the model can discover and install harnesses autonomously.

### CI usage

```sh
# Reproducible — errors on lockfile drift
npx @taskflow-corp/cli@latest add <source> --yes --silent --frozen
```

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

## Examples

Single-file harnesses live in `examples/`. Install the SDK globally first (`npm i -g @taskflow-corp/sdk`), then run any file directly with `tsx`:

- `examples/ui-plan.ts` — scans a project, injects missing `data-testid`s, emits a YAML test plan.
- `examples/ui-execute.ts` — consumes the YAML and generates a standalone Playwright project.
- `examples/ui-execute.test.ts` — unit tests for the YAML → Playwright codegen.
- `examples/ui-content.ts` — stitches media into a video, generates narratives, and publishes to YouTube / Facebook / Instagram / LinkedIn / Twitter / Medium / Reddit (stubs — swap in real OAuth before production).

Each is ~400–600 LOC with zero build step: `tsx examples/ui-plan.ts`.

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
