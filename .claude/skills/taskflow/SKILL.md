---
name: taskflow
description: Author and run multi-agent orchestration harnesses via a YAML spec -> TypeScript emitter. Use when the user asks to parallelize a task across AI coding agents, run the same pipeline across multiple models, set up a scraping/ingestion harness, or any time they say "make a harness", "parallelize this", "orchestrate these agents", "multi-agent pipeline", or "build a pipeline with claude-code/pi/codex/cursor/opencode".
---

# Taskflow

A meta-tool that turns a YAML spec into an executable TypeScript harness that orchestrates parallel/sequential leaves. Each leaf runs one AI coding agent session — the agent and LLM model are chosen per-leaf so cheap mechanical work runs on cheap models and stakes-high work runs on frontier models.

## CLI

- `npm run build tasks/<name>.spec.yml` — emits `tasks/<name>.ts`
- `npm run run tasks/<name>.ts` — runs with Ink TUI (auto-detects no-TTY and falls back to JSONL stdout)
- `npm run test` — run all unit/integration tests (skips real-LLM tests)
- `HARNESS_REAL_TESTS=1 npm run test:real` — include real-LLM integration tests (costs tokens; requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)

## Workflow

1. Draft a spec at `tasks/<name>.spec.yml`.
2. `npm run build tasks/<name>.spec.yml` to emit TypeScript. Review the diff.
3. `npm run run tasks/<name>.ts` to execute.
4. Drill into failing leaves from the TUI (up/down navigate, enter to drill in, type to steer, Cmd+K to abort).
5. Runs are archived at `data/runs/{runId}/` — `events.jsonl`, `manifest.json`, `leaves/{leafId}/proof.json`.

## Spec schema

Every node is a `leaf` (terminal, runs one agent session) or a `stage` (container, recursively holds more nodes).

### Leaf

```yaml
- leaf: <id>                           # string, template-interpolated
  agent: claude-code | pi | codex | cursor | opencode
  model: <provider-native model id>    # optional; see agent+model table below
  task: "<prompt>"                     # template-interpolated
  claims: ["<glob>", ...]              # files this leaf writes (for overlap detection)
  timeoutMs: 600000                    # optional
  rulesPrefix: true                    # default true; prepends Rules from rulesFile to task
```

### Stage

```yaml
- stage: <id>
  parallel: true                       # default false — run children concurrently
  steps: [<nodes>]                     # required, non-empty
  # At most one of expand/foreach/repeat (fan-out mechanism):
  expand:  { count: <N>, as: <varname> }        # loop i=0..N-1
  foreach: { items: [...], as: <varname> }      # loop over values
  repeat:  <N>                                  # sugar: expand with _ var, serial
```

### Template variables

Any `{var}` inside `leaf`/`stage` id, `task`, or `claims` is substituted at **build time** (emitted TS has literal strings). Variables come from enclosing `expand`/`foreach`/`repeat`.

The `{cwd}` variable is reserved and pre-populated by `npm run build` with the build-machine's `process.cwd()` (the repo root). Use it when a leaf needs an **absolute path** — e.g. when the underlying SDK sandboxes the process away from the real repo. Inner `expand`/`foreach`/`repeat` loops may not rebind `cwd`; there's no enforcement, but doing so confuses tooling that assumes `{cwd}` is the repo root.

```yaml
- leaf: write-file
  agent: claude-code
  task: "Write to absolute path {cwd}/data/out/result.json"
```

Because `{cwd}` resolves at build time on the invoking machine, committed emitted TS is not byte-stable across clones of the repo. If you need machine-portable emitted TS, prefer relative paths; use `{cwd}` only when an absolute path is mandatory (e.g. for the `claude-code` adapter, whose SDK has historically remapped writes via relative cwds).

### Rules file

Top-level `rulesFile: ./path/to/rules.md` — prepended to every leaf prompt as `"Rules:\n${rules}\n\nTask:\n${task}"`. Keep the file byte-stable across a run so Anthropic prompt caching (TTL 1h) works across parallel leaves.

## Agent + model picking heuristics

| Task shape                                              | Recommended agent + model                                                     |
|---------------------------------------------------------|-------------------------------------------------------------------------------|
| Planning / architecture / code review                   | `claude-code` + `opus` OR `pi` + `anthropic/claude-opus-4-7`                  |
| Code gen / refactor (medium stakes)                     | `claude-code` + `sonnet` OR `pi` + `anthropic/claude-sonnet-4-6` OR `codex` + `gpt-5.4` |
| Mechanical transforms (lint, format, rename, patches)   | `opencode` + `groq/llama-3.3-70b` OR `pi` + `cerebras/qwen-...`               |
| HTTP scraping, parsing, IO-heavy                        | `opencode` + cheap provider (`groq/*`, `cerebras/*`)                          |
| Schema-sensitive / idempotent writes                    | `pi` + `anthropic/claude-opus-4-7`                                            |
| Cursor-subscription users                               | `cursor` + a model from `cursor-agent --list-models`                          |

## Claims and parallelism

- `parallel: true` runs children concurrently.
- The runtime enforces **literal-prefix disjointness**: before running parallel leaves, it checks no two leaves' `claims` globs share a prefix. Overlap throws before any leaf starts.
- Escape hatch for false positives: (not yet implemented — when needed, add `exclude: [...]` to the leaf spec).

## Anti-patterns

- Editing emitted TS by hand. Always regenerate from the spec.
- Giving overlapping `claims` to parallel leaves.
- Using heavy models for mechanical work. Route by task shape.
- Relying on in-memory state across leaves — pass data through files in `claims`.
- Omitting `claims` on writing leaves — the runtime can't protect you without them.

## Environment

- `ANTHROPIC_API_KEY` — required for `claude-code` leaves and `pi` leaves using `anthropic/*` models.
- `OPENAI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `GEMINI_API_KEY` — required for their respective providers (per-leaf basis).
- `HARNESS_PI_BIN` — override the `pi` binary name (default `pi`). Set to `omp` if you use `@oh-my-pi/pi-coding-agent`.
- `HARNESS_RUNS_DIR` — override the output dir (default `data/runs`).
- `HARNESS_NO_TTY=1` — force headless JSONL streaming even with a TTY attached.
- `HARNESS_ADAPTER_OVERRIDE=mock` — force all adapters to the in-process mock (for smoke-testing plumbing).
- `HARNESS_REAL_TESTS=1` — enables integration tests that make real LLM calls (default-skipped).

## Example

See `tasks/pipeline.spec.yml` for a canonical example — a multi-stage discover → parallel compute → aggregate pipeline with template-interpolated expand fan-out.
