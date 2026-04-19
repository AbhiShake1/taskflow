# `taskflow add` — Shadcn-Style Harness Distribution

**Status**: Fully implemented (M1–M4). See §14 for explicitly out-of-scope items.
**Owner**: abhi
**Date**: 2026-04-19

## 1. Goal

One command, anywhere, any source: drop a taskflow harness into any project and run it.

```bash
npx @taskflow-corp/cli add example-hello                              # named (default registry)
npx @taskflow-corp/cli add @acme/e2e-video-tests                      # namespaced
npx @taskflow-corp/cli add user/repo                                  # GitHub shortcut
npx @taskflow-corp/cli add user/repo/examples/ui-plan#v1.2.0          # with subpath + ref
npx @taskflow-corp/cli add https://example.com/r/harness.json         # raw URL
npx @taskflow-corp/cli add ./my-harness.json                          # local file
npx @taskflow-corp/cli add git::https://host/org/repo.git//sub?ref=v1 # fully qualified
```

Every form resolves to: `fetch → validate → write files → patch config → done`.

---

## 2. Why this architecture

- A harness is one or two `.ts` files plus optional `.agents/taskflow/config.ts` snippets. That's exactly the shape shadcn items ship in (files + config patches).
- End users already run `npx @taskflow-corp/cli ...`. Adding a subcommand keeps the bin surface identical.
- Harnesses are inherently shareable — "video-generating e2e harness" should propagate across repos without vendoring or copy-pasting.
- The runner already loads `.ts` via jiti (no compile step). Install is literally "write the file to disk."

---

## 3. Source-string grammar (three tiers)

Scored against shadcn, degit, Terraform, Deno, JSR, pnpm, gh-extension, Homebrew, Ansible Galaxy, VSCode. Terraform wins expressiveness (10/10), shadcn wins UX (9/10), JSR wins security (10/10). We compose all three.

### Tier 1 — named (registry lookup, 80% of invocations)

```
taskflow add <name>                # -> @taskflow registry (built-in)
taskflow add @ns/<name>            # -> registries[@ns] in taskflow.json
taskflow add @ns/<name>@^1.2.0     # semver (optional; registry must support versions)
```

### Tier 2 — shortcut (degit-style, 15%)

```
taskflow add user/repo                       # github.com default
taskflow add user/repo#v1.2.0                # #ref (branch | tag | sha)
taskflow add user/repo/examples/foo          # subpath = path tail
taskflow add github:user/repo                # explicit host
taskflow add gitlab:user/repo
taskflow add bitbucket:user/repo
```

`#ref` is sugar for `?ref=`. Parser canonicalizes to Tier 3 before hitting the fetcher. The lockfile always records Tier 3.

### Tier 3 — fully qualified (Terraform grammar, 5%)

```
<type>::<url>[//<subpath>][?ref=<gitref>&sha256=<hex>&depth=<n>]

taskflow add git::https://host/org/repo.git//examples/harness?ref=v1.2.0
taskflow add git::ssh://git@host/org/repo.git//sub?ref=main
taskflow add https::https://example.com/bundle.tar.gz?sha256=abc123
taskflow add file::./local/harness
```

Rules:
- `//` always delimits subpath (Terraform semantics). Segments before identify the package; after identify the item.
- Query keys are a closed set: `ref`, `sha256`, `depth`. Unknown keys are a hard error.
- `#fragment` only valid in Tier 2 and is a pure alias for `?ref=`.

**Detection order (first match wins)** — mirrors shadcn's `fetchRegistryItems` dispatcher:

1. `*.json` and not a URL → local file (`fs` read).
2. `<type>::...` → Tier 3 resolver.
3. `new URL()` parses → raw URL fetch.
4. `@<ns>/*` → namespace lookup in `taskflow.json` `registries`.
5. `<host>:<user>/<repo>` (e.g. `github:`, `gitlab:`) → Tier 2 git shortcut.
6. `<a>/<b>` or `<a>/<b>/<path>` → Tier 2 github-default shortcut.
7. Otherwise → Tier 1 named lookup in built-in `@taskflow` registry.

---

## 4. File & config shapes

### 4.1 `taskflow.json` (project-root, shadcn parity)

```jsonc
{
  "$schema": "https://taskflow.sh/schema/taskflow.json",
  "version": "1",
  "harnessDir": ".agents/taskflow/harness",      // where new harnesses land
  "rulesDir": ".agents/taskflow/rules",
  "aliases": {
    "harness": "@harness",                        // tsconfig paths-style (future)
    "utils": "@taskflow/utils"
  },
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

- `${VAR}` interpolation in URL, headers, params. Unset vars are pre-flight errors (shadcn's model). `$VAR` form is NOT supported — mandatory braces.
- Built-in `@taskflow` namespace resolves via `TASKFLOW_REGISTRY_URL` env (default `https://taskflow.sh/r`). Override lets us point tests at `http://localhost:3000/r`.
- Keys MUST start with `@`. URLs MUST contain `{name}`. `{style}` placeholder is reserved for future use.

### 4.2 `registry.json` (publisher, index)

```jsonc
{
  "$schema": "https://taskflow.sh/schema/registry.json",
  "name": "@acme",
  "homepage": "https://acme.example",
  "items": [ /* registry-item objects, see below */ ]
}
```

### 4.3 `registry-item.json` (one per harness)

```jsonc
{
  "$schema": "https://taskflow.sh/schema/registry-item.json",
  "name": "acme-harness",
  "type": "taskflow:harness",
  "description": "Example harness",
  "version": "1.2.0",
  "author": "acme",
  "license": "MIT",

  "requiredAdapters": ["claude-code", "pi"],
  "requiredEnv":     ["ANTHROPIC_API_KEY"],

  "dependencies":        { "zod": "^4.0.0" },
  "devDependencies":     {},
  "registryDependencies": ["@acme/utils-fs", "./local/shared.json"],

  "files": [
    { "path": "harness/acme-harness.ts", "type": "taskflow:harness", "content": "..." },
    { "path": "harness/utils/playwright.ts", "type": "taskflow:utils",   "content": "..." },
    { "path": ".agents/taskflow/rules/ui.md", "type": "taskflow:rules", "target": ".agents/taskflow/rules/ui.md", "content": "..." }
  ],

  "config": {
    "scope": "No new files.",
    "plugins": ["@acme/verify-loop-plugin"]
  },

  "envVars": { "TASKFLOW_DEFAULT_ADAPTER": "claude-code" },

  "docs": "https://acme.example/docs/acme-harness"
}
```

**Type enum** (discriminated union):

| Type | Where it lands | Notes |
|---|---|---|
| `taskflow:harness` | `harnessDir` | The main `.ts` file the user runs |
| `taskflow:plugin`  | `harnessDir/plugins` | Imported by config.ts |
| `taskflow:rules`   | `rulesDir` (or `target`) | Markdown rules file |
| `taskflow:config-patch` | merges into `config.ts` | Structured patch, not a file |
| `taskflow:utils`   | `harnessDir/utils` | Shared TS utilities |
| `taskflow:example` | `harnessDir/examples` | Sample invocation |
| `taskflow:file`    | `target` (required) | Arbitrary path, incl. `~/`, for escape hatches |

`target` is REQUIRED for `taskflow:file` and `taskflow:rules`; INFERRED from `aliases`/`harnessDir` otherwise (mirrors shadcn's file-type → destination rule).

### 4.4 `taskflow.lock` (consumer, reproducibility)

```jsonc
{
  "version": "1",
  "items": {
    "acme-harness": {
      "source": "git::https://github.com/acme/harnesses.git//items/acme-harness?ref=v1.2.0",
      "resolvedCommit": "a1b2c3d...",
      "sha256": "ff00...",
      "type": "taskflow:harness",
      "dependencies": ["@acme/utils-fs"]
    }
  }
}
```

- Written on every `add` / `update`.
- `taskflow add --frozen` (CI) errors on any drift from the lockfile.
- Borrowed wholesale from Deno/JSR integrity model.

---

## 5. CLI surface

Existing: `run | watch | plan`. New subcommands mirror shadcn 3.0 where they make sense.

| Command | Purpose |
|---|---|
| `taskflow add <source...>` | Fetch + install one or more harnesses |
| `taskflow init` | Create `taskflow.json` + `.agents/taskflow/config.ts` (auto-invoked by `add` if missing, shadcn-style) |
| `taskflow build [registry.json]` | Publisher: inline file contents, emit `./r/*.json` |
| `taskflow search <query>` | Hit `registries.json` index, fuzzy match |
| `taskflow view <source>` | Print resolved item JSON (no write) — debug |
| `taskflow list` | Show installed harnesses from `taskflow.lock` |
| `taskflow update [name...]` | Re-resolve + rewrite lockfile; `--all` for bulk |
| `taskflow remove <name>` | Delete files, update lockfile |

Flags on `add` (shadcn-aligned): `-y/--yes`, `-o/--overwrite`, `--dry-run`, `--diff [path]`, `--view [path]`, `-p/--path <dir>`, `-c/--cwd <dir>`, `-s/--silent`, `--frozen`.

---

## 6. Module layout (where code lands)

All new code under `cli/add/` to keep the existing `cli/index.ts` dispatcher untouched except for one case arm.

```
cli/
  index.ts                       # + case 'add' | 'init' | 'build' | 'search' | 'view' | 'list' | 'update' | 'remove'
  add/
    command.ts                   # action handler, option parsing (stay hand-rolled or introduce cac/commander — see §9)
    pipeline.ts                  # orchestrator: env → config → ensureRegistries → probe → preflight → resolve → write
    registry/
      parser.ts                  # tier detection (the 7-step dispatcher)
      builder.ts                 # build URL+headers from (registry, name) with {name}/{style}/${ENV}
      fetcher.ts                 # HTTP (globalThis.fetch + https_proxy agent), local file reader, typed errors
      resolver.ts                # BFS walk + Kahn topo sort with cycle tolerance
      namespaces.ts              # pre-pass to discover new @ns references for ensureRegistriesInConfig
      context.ts                 # mutable auth-header map per run (shadcn's pattern)
      schema.ts                  # Zod: registrySchema, registryItemSchema, registryConfigSchema, lockSchema
      env.ts                     # expandEnvVars(`${FOO}` only, braces mandatory)
      validator.ts               # extract ${ENV} tokens, validate presence pre-flight
      errors.ts                  # typed errors: NotFound / Unauthorized / Forbidden / Parse / LocalFile / MissingEnvVars
      git.ts                     # NEW vs shadcn: degit-like tarball fetch for Tier 2/3 git sources
    source-forms/
      tier1-named.ts
      tier2-shortcut.ts          # `user/repo[#ref]`, `github:`, `gitlab:`, `bitbucket:` -> Tier 3
      tier3-qualified.ts         # `type::url[//subpath][?ref=...&sha256=...]`
    writers/
      write-files.ts             # smart merge + prompt-on-conflict (unless --overwrite)
      patch-config.ts            # AST-level merge for `taskflow:config-patch` items
      patch-env.ts               # append/merge envVars into .env.local
    preflight.ts                 # check adapters available, env vars present, dirs writable
    lockfile.ts                  # read/write taskflow.lock, --frozen enforcement
    init.ts                      # generate taskflow.json, .agents/taskflow/config.ts, package.json patch
    build.ts                     # publisher-side: inline file contents into per-item JSONs
  search.ts                      # thin: fetch registries.json, fuzzy match
  view.ts                        # thin: resolve + print
  list.ts                        # thin: read lockfile
  update.ts                      # re-resolve + diff
  remove.ts                      # delete files + unlock
```

---

## 7. What we copy from shadcn wholesale

1. **Three-input normalizer** (local / URL / namespace) — extended to seven inputs (our three tiers).
2. **`registries` map** in config — string-or-object shape with `${ENV}` interpolation and pre-flight validation.
3. **Mandatory `{name}` placeholder**, optional `{style}`. Enforced via Zod `.refine`.
4. **Inline file contents at build time**. One fetch per item. Local files and hosted JSONs are interchangeable.
5. **Kahn topo sort with cycle tolerance** — warn and proceed, don't error. Matches shadcn's pragmatism.
6. **Probe-first type branching** — fetch item #1 metadata before running preflight so `taskflow:rules`-only installs skip the "need an initialized project" check.
7. **Auto-invoke `init` on missing config** inside `add`, with a single confirm prompt.
8. **Mutable `context` module for auth headers** — set before fetch, `clearRegistryContext()` in a `finally`. Prevents namespace auth leaking across calls.
9. **Typed HTTP errors** mapped from status (401/403/404/410 → specific classes) with actionable hints.
10. **`REGISTRY_URL` env override** (named `TASKFLOW_REGISTRY_URL`) for local testing.

---

## 8. What we extend beyond shadcn

Shadcn does not support git-hosted registries natively — users must use `raw.githubusercontent.com` URLs. We do, because a taskflow harness in a GitHub repo is the 80% case:

- **Tier 2 shortcut parser** → rewrite `user/repo[/subpath][#ref]` into a tarball URL for the host. GitHub: `https://codeload.github.com/<u>/<r>/tar.gz/<ref>`. GitLab/Bitbucket have analogous endpoints. Cache extracted tarballs at `~/.taskflow/cache/<sha256>/`.
- **Tier 3 `git::` scheme** → when the repo is private or SSH, fall back to `git archive` over `git clone --depth 1 --filter=blob:none`. Reuses the user's SSH agent and credential helper — no second auth story (gh-extension principle).
- **Lockfile with SHA-256** → every install records the hash of the extracted tree. `--frozen` enforces, borrowed from JSR/Deno.
- **`sha256=` query param** for HTTPS tarball sources — lets unknown hosts be trust-on-first-fetch safely.
- **`depth=1` query param** — shallow clone hint for CI.

---

## 9. Decisions (score-based, user asked not to be consulted)

**CLI framework** — stay hand-rolled (7) vs. commander (8) vs. cac (9, tiny, ESM, help generation). Pick **cac**. Reason: adding 7 subcommands makes hand-rolled a liability; cac is 3kb gzipped and Vercel's favorite.

**HTTP client** — `globalThis.fetch` (8, zero deps) vs. `undici` (7) vs. `node-fetch` (5). Pick **`globalThis.fetch`** + `https-proxy-agent` (only dep). Node 18+ is already a given.

**Prompt library** — `prompts` (7) vs. `@clack/prompts` (9, nicer UX, active). Pick **`@clack/prompts`**. Reason: shadcn recently switched to it too; aligns with modern CLI feel.

**Git tarball client** — shell out to `git` (8) vs. `isomorphic-git` (6) vs. reimplement degit's tarball fetch (7). Pick **shell out to `git`** for `git::` scheme, **native `fetch` against host tarball endpoints** for Tier 2 GitHub/GitLab/Bitbucket shortcuts. No `isomorphic-git` dep.

**Where harness files land** — `harness/` (7) vs. `tasks/` (6) vs. `.agents/taskflow/harness/` (9, namespaced, discoverable by config loader). Pick **`.agents/taskflow/harness/`** with `taskflow.json#harnessDir` override.

**Lockfile format** — JSON (8) vs. TOML (7) vs. none (5). Pick **JSON** (`taskflow.lock`). Aligns with `taskflow.json`, trivial to diff.

**Versioning in registry items** — single `version` string (8) vs. full semver history served by registry (6, requires server smarts). Pick **single `version`** per item JSON. Registries that want multiple versions can serve them at distinct URLs via `{name}` templating (or later, via `{version}` placeholder — reserved).

**Integrity for Tier 1/2 without explicit sha** — trust-on-first-fetch with lockfile pinning (8) vs. require `sha256=` always (4, hostile UX). Pick **TOFU + lockfile**. `--frozen` becomes the CI guard.

**Built-in registry location** — npm-style `registry.taskflow.sh` (8, needs hosting) vs. GitHub-Pages JSON blob (9, zero infra, cacheable) vs. skip for M1 (7). Pick **GitHub-Pages JSON blob** at `https://taskflow.sh/r` served from repo `taskflow-corp/registry`. Ship empty in M1, populate in M2.

**Dependency on adapters** — enforce at install (`requiredAdapters`) by checking adapter installed (8) or at runtime (5). Pick **install-time check** with `--skip-adapter-check` escape. Better error UX.

**Do we support npm: or jsr: schemes?** — shadcn doesn't (deliberately). Score: add npm/jsr (5, niche, complex) vs. skip (9). **Skip.** Users who want that can publish a registry-item.json that points at their npm package's tarball URL (Tier 3 `https::`).

---

## 10. Phased rollout

### M1 — Local + URL + GitHub shortcut (MVP) — **done**
- ✅ `cli/add/` skeleton, cac wiring
- ✅ Tier 1 named (against built-in `TASKFLOW_REGISTRY_URL`, defaults to `https://taskflow.sh/r`)
- ✅ Tier 2 GitHub shortcut via tarball fetch (`GH_TOKEN` pass-through)
- ✅ Local file + raw URL sources
- ✅ `registry-item.json` schema + Zod validator
- ✅ `write-files.ts` with `--overwrite` semantics (yes/silent → skip conflicts; overwrite → replace)
- ✅ `taskflow init`
- ✅ Minimal preflight
- ✅ Tests: mock HTTP fixture + fs fixtures + compiled-bin integration

### M2 — Namespaces, auth, lockfile — **done**
- ✅ `registries` map in `taskflow.json` + `${ENV}` interpolation
- ✅ Private HTTPS with header/param auth (bearer / API key / basic / custom)
- ✅ `taskflow.lock` read/write, `--frozen`, `--dry-run`, `--diff`, `--view`
- ✅ `taskflow search`, `taskflow view`, `taskflow list`
- ✅ Auto-discover unknown `@ns` via `TASKFLOW_REGISTRY_URL/registries.json`
- ✅ Kahn sort with cycle tolerance + topo install order

### M3 — Git, publisher, update, config patches — **done**
- ✅ Tier 3 full grammar (`git::`, `https::`, `file::`, `//subpath`, `?ref=&sha256=&depth=`)
- ✅ Private git via SSH / credential helper (shell out to `git`)
- ✅ `taskflow build` (publisher side — inline file contents, emit `r/*.json`, `r/registry.json`)
- ✅ `taskflow:config-patch` uses ts-morph AST merge (`cli/add/writers/patch-config.ts`) — replaces/adds `scope` literal and appends identifier refs into `plugins: [...]` on a `defineConfig({...})` or `export default {...}` object literal. Missing config is a silent no-op.
- ✅ `taskflow update [name] --all`
- ✅ `taskflow remove <name>`
- ✅ Starter registry at repo root `registry/` with `example-hello` and `example-plan` items; `taskflow build` inlines and emits to `r/`.

### M4 — Discoverability & re-skin — **done**
- ✅ MCP server (`taskflow mcp`) exposing `list_harnesses` / `search` / `install` over stdio (`cli/add/mcp.ts`). Handlers also exported (`mcpListHarnesses`, `mcpSearch`, `mcpInstall`) for direct use and testing.
- ✅ `taskflow apply <preset>` — thin wrapper around `runAdd` with `overwrite: true`. Re-installs a preset on top of existing files (shadcn `apply` semantic).

---

## 14. Explicitly out of scope

- **Sigstore / SLSA provenance signing.** Requires external publishing infrastructure (GitHub Actions OIDC, Rekor transparency log) that is not available from a pure consumer-side implementation, and has no signed items in the wild yet. Revisit when the first registry opts in.
- **Populating `taskflow-corp/registry` with a hosted built-in registry index.** This is a publishing activity, not a code deliverable; the repo already ships `registry/` as a reference implementation and `taskflow build` produces the consumable shape.
- **`{version}` placeholder in `registries` map URLs** for multi-semver registries. Users can emulate this today by serving distinct `{name}` values per version. Open question from §12; intentionally deferred.
- **Monorepo `taskflow.json` resolution** (sub-package vs. root). Open question from §12; intentionally deferred.

---

## 11. Testing strategy

- **Parser unit tests**: 7-step dispatcher table — one row per detection rule, happy + unhappy paths.
- **Fetcher integration tests**: local mock HTTP (`msw` or native `http.createServer`) with a fixture registry. Must cover 200 / 401 / 403 / 404 / 410 / malformed JSON / schema fail.
- **Git source e2e**: spin up a local git repo in a temp dir; verify tarball fetch + `git archive` both resolve correctly with ref + subpath + sha pin.
- **Resolver property tests**: generate random DAGs with optional cycles; Kahn sort must always produce a topologically valid prefix and append cycle remainders at the end.
- **Write tests**: fs-fixture + `memfs`. Cover overwrite prompt, `--overwrite`, `.env` merge-not-overwrite.
- **Lockfile tests**: add → update → remove round-trip; `--frozen` must error on drift.
- **Snapshot tests** for `--dry-run` output (reviewer-friendly).
- **Real-world smoke**: actually add one of the registry items under `registry/items/` from a mocked `@taskflow` registry into a throwaway project and run it.

---

## 12. Open questions (not blockers for M1)

1. Do we want a `{version}` placeholder in `registries` map URLs so a single namespace can serve multiple semvers? Shadcn doesn't; pnpm/npm do via different mechanism. Defer to M3.
2. Should `taskflow add` auto-run `taskflow plan` on the installed harness as a final sanity check? Probably yes, behind `--plan` flag. M2.
3. Monorepo story: do we support `taskflow.json` in a sub-package vs. root? Shadcn 3.0 added monorepo support — we can copy their resolver. M3.
4. Do `registry:style` / theme equivalents even make sense for taskflow? Probably not; harnesses are not themable. Skip.

---

## 13. References

- Shadcn CLI implementation (`packages/shadcn/src/commands/add.ts`, `src/registry/*`)
- Shadcn docs: `ui.shadcn.com/docs/cli`, `/docs/registry`, `/docs/registry/authentication`, `/docs/registry/namespace`
- Shadcn changelog CLI 3.0 + MCP (Aug 2025): `ui.shadcn.com/docs/changelog/2025-08-cli-3-mcp`
- Terraform module sources: `developer.hashicorp.com/terraform/language/modules/sources`
- Degit source parser: `github.com/Rich-Harris/degit`
- JSR trust model: `jsr.io/docs/trust`
- Deno lockfile + `DENO_AUTH_TOKENS`: `docs.deno.com/runtime/fundamentals/modules`
- pnpm source specifiers: `pnpm.io/cli/add`
- gh extension install: `cli.github.com/manual/gh_extension_install`

---

## 15. Auto-discovery

**Problem solved.** Tier 2's shortcut (`user/repo`) only works when the target repo publishes a `registry-item.json`. But the 80% case is a taskflow harness living in a random GitHub repo with no registry metadata — an `examples/foo.ts` that imports `@taskflow-corp/cli` and `taskflow(...).run(...)`. Consumers shouldn't have to hunt for the path and type `user/repo/examples/foo.ts`; they should be able to type `user/repo` and get a multi-select of every harness the repo contains. This section covers that zero-config discovery flow (landed in 0.1.22).

**Trigger & scope.**
- Typing `taskflow add <user>/<repo>` with NO subpath, AFTER the existing Tier 2 `registry-item.json` fetch returns 404.
- Also folded into `taskflow search <query>` so keyword search spans the whole GitHub index, not just configured registries.
- Never triggers for any other source form (local file, URL, namespace, fully qualified, or Tier 2 WITH a subpath).

**Architecture.**

```
CLI (cli/add/registry/discover.ts)
  └─► HTTP GET ${TASKFLOW_DISCOVER_URL:-https://<pages>/api/discover}?repo=<u/r>&q=<...>&limit=25
        └─► Cloudflare Pages Function (web/functions/api/discover.ts)
              ├─ KV cache hit (10 min) → return { source: 'cache', hits }
              └─ GitHub Code Search API (bearer PAT) → { source: 'github', hits }
        ◄── 200 { source, hits: [{ repo, branch, path, sha, matchLines, url, rawUrl }] }

CLI (cli/add/registry/synthesize.ts)
  └─► validate each hit (regex: imports taskflow pkg, not test, not config, contains taskflow(...) call)
        └─► fetch rawUrl, synthesize RegistryItem { type: 'taskflow:harness', files: [{ content }] }
              └─► existing pipeline (preflight → write → lockfile)
```

See the overall design context in `.claude/plans/curious-wobbling-stearns.md`.

**Decision log.**

- **grep.app vs GitHub Code Search (revised in 0.1.23).** Initial design layered Cloudflare Browser Rendering on top of grep.app for ~10× speed. Shipped in 0.1.22 and immediately simplified: Browser Rendering added a heavy dependency, $0.0001/req + compute cost, 500-2000 ms cold-start, and fragility around grep.app's Vercel challenge. GitHub Code Search is ~500-1500 ms, has an authenticated 30 req/min ceiling, zero moving parts, and sits behind one `fetch()` call. Pick **GitHub Code Search as the sole backend**. If grep.app later publishes an API key program we add them back as a two-line branch — the CLI surface doesn't change.
- **Synthesis: regex vs AST.** Full ts-morph AST would eliminate false positives but doubles CLI cold-start time for every discovered file. Pick **regex-based validator** for v1 (imports + `taskflow(...)` call + path-not-test-or-config). False-positive risk is low because we only match files that import the taskflow package in the first place. Tighten with AST later if noise shows up.
- **`--yes` with >1 hits → error, not auto-install.** Score: auto-install everything (3, surprising), install first hit (4, arbitrary), error with actionable hint (9, safe). Pick **error**. `taskflow add` already walks public GitHub code; silently installing N files a user never saw is a step too far.
- **Results cached 10 min in Workers KV.** Long enough to absorb `add` + re-run retries, short enough that a freshly-pushed harness is discoverable within the same coffee break.

**Out of scope for this iteration.**
- Inferring `registryDependencies` / `requiredAdapters` / `requiredEnv` from the synthesized source. Conservative defaults only for v1.
- Non-GitHub hosts (GitLab, Bitbucket). Add a provider in the Pages Function.
- Authenticated private-repo discovery. GitHub Code Search can do it with user tokens; defer.
