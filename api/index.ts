// Async-await fluent API for taskflow.
//
// The authoring surface is two functions exposed via `run(async ({ phase, session }) => ...)`:
//
//   phase(name, async body) → returns the body's return value verbatim.
//     Pure pass-through around the engine's `stage(h, name, async body)`.
//
//   session(id, spec) → Promise<T>
//     T is inferred from `spec.schema`:
//       - `schema: ZodType<X>` → Promise<X>     (validated structured output)
//       - no `schema`          → Promise<string> (the final assistant text)
//     Rejects with a descriptive Error when the session ends in any non-'done'
//     state (adapter failure, claims conflict, validation miss, etc.).
//
// Key behaviour shifts from the previous tree-building API:
//   - Parallelism is just `Promise.all([session(...), session(...)])`.
//   - Fire-and-forget is a session call whose Promise is never awaited. The
//     engine still runs it; errors are the dev's responsibility.
//   - Dependency graphs are plain async/await control flow.
//
// The engine (core/index.ts) is unchanged in its execution contract: every
// `session()` call is one `leaf()` call. We construct the session pipeline on
// the fly inside the `harness()` body.
//
// Implementation notes:
//   - The engine's `leaf()` rejects with a synthetic Error ("leaf failed: X")
//     when status !== 'done'. We trap that at the session() boundary and
//     re-throw a friendlier message that names the status and error string.
//   - Structured output: the fluent API owns the zod→jsonSchema conversion so
//     the engine stays zod-free. We also thread the raw zod schema through
//     LeafSpec.structuredOutput._zodSchema so the claude-code adapter can use
//     native tool-use (SDK requires a zod shape, not a JSON schema).

import { toJSONSchema, type ZodType, type ZodTypeAny } from 'zod';

import {
  harness as engineHarness,
  stage as engineStage,
  leaf as engineLeaf,
  type HarnessOptions,
  type Manifest,
} from '../core';
import type { Ctx, LeafSpec as EngineLeafSpec, LeafResult } from '../core/types';
import { parseWith } from './parseWith';

// Re-export parseWith so consumers importing from 'taskflow' still find it.
export { parseWith } from './parseWith';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single session invocation's declarative spec. `schema` is the typed-output
 * driver — its presence flips the return type from string → z.infer<typeof schema>.
 */
export interface SessionSpec<S extends ZodTypeAny = ZodTypeAny> {
  /** `'agent'` or `'agent:model'` string. */
  with: string;
  /** Task prompt. Literal string — no template substitution at runtime. */
  task: string;
  /** Globs this session writes. Runtime enforces disjointness between concurrent siblings. */
  write?: string[];
  /** Per-session timeout. */
  timeoutMs?: number;
  /** Opt out of the rules prefix for this session. */
  rulesPrefix?: boolean;
  /**
   * Zod schema for structured output. When set, the adapter drives the LLM
   * toward emitting a conforming value, and `session()` returns
   * Promise<z.infer<typeof schema>> (validated). Omit for the default
   * Promise<string> (the final assistant message text).
   */
  schema?: S;
}

/**
 * Return type of `session()` derived from a SessionSpec:
 *   - when `schema` is supplied, `z.infer<typeof schema>`
 *   - otherwise, `string` (the final assistant text)
 *
 * The trick is: `ZodTypeAny` extends `{ _output: unknown }`, so we read `_output`
 * directly rather than going through `z.infer<...>` to keep the generic
 * inference site-independent.
 */
export type SessionReturn<T extends SessionSpec<ZodTypeAny>> = T extends { schema: infer S }
  ? S extends ZodType<infer Out>
    ? Out
    : unknown
  : string;

export interface RunCtx {
  /**
   * Wraps `engineStage()` around the provided async body. The body's return
   * value is returned verbatim, so phases are a pure pass-through for values.
   */
  phase<T>(name: string, body: () => Promise<T>): Promise<T>;

  /**
   * Invoke one agent session. Returns a promise that resolves to the LLM's
   * structured output (when `spec.schema` is set) or to the final assistant
   * message text (otherwise). Rejects with a descriptive Error when the
   * session fails.
   */
  session<S extends ZodTypeAny, T extends SessionSpec<S>>(
    id: string,
    spec: T,
  ): Promise<SessionReturn<T>>;
}

export interface TaskflowBuilder {
  rules(path: string): TaskflowBuilder;
  env(vars: Record<string, string>): TaskflowBuilder;
  run(
    body: (ctx: RunCtx) => Promise<void> | Promise<unknown>,
    opts?: HarnessOptions,
  ): Promise<{ manifest: Manifest; ctx: Ctx }>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function toEngineSpec(
  id: string,
  spec: SessionSpec<ZodTypeAny>,
): EngineLeafSpec {
  const { agent, model } = parseWith(spec.with);
  const out: EngineLeafSpec = {
    id,
    agent,
    task: spec.task,
  };
  if (model !== undefined) out.model = model;
  if (spec.write !== undefined) out.claims = spec.write;
  if (spec.timeoutMs !== undefined) out.timeoutMs = spec.timeoutMs;
  if (spec.rulesPrefix !== undefined) out.rulesPrefix = spec.rulesPrefix;
  if (spec.schema !== undefined) {
    // Zod 4 exposes a native JSON-Schema export — prefer it over the
    // `zod-to-json-schema` package (which lags behind zod 4's internal shape).
    const jsonSchema = toJSONSchema(spec.schema) as Record<string, unknown>;
    out.structuredOutput = {
      jsonSchema,
      _zodSchema: spec.schema,
    };
  }
  return out;
}

/**
 * Run the engine `leaf()` and translate the result into the fluent API's
 * return contract. On failure re-throws a descriptive Error so
 * `await session(...)` gives a useful stack trace.
 */
async function runSession<T>(
  h: Ctx,
  id: string,
  spec: SessionSpec<ZodTypeAny>,
): Promise<T> {
  let result: LeafResult;
  try {
    result = await engineLeaf(h, toEngineSpec(id, spec));
  } catch (engineErr) {
    // engineLeaf throws a generic "leaf failed: <id>" wrapping whatever the
    // adapter reported. We want to surface the adapter's own error text.
    const err = engineErr instanceof Error ? engineErr : new Error(String(engineErr));
    throw new Error(`session "${id}" failed: ${err.message}`);
  }

  if (result.status !== 'done') {
    // Shouldn't normally be reached — engineLeaf throws on non-done. Keep a
    // guard in case of timeout paths that resolve rather than throw.
    const reason = result.error ?? result.status;
    throw new Error(`session "${id}" ended with status=${result.status}: ${reason}`);
  }

  if (spec.schema !== undefined) {
    if (result.structuredOutputValue === undefined) {
      throw new Error(
        `session "${id}" completed but produced no structured output (expected schema-shaped value)`,
      );
    }
    const parsed = spec.schema.safeParse(result.structuredOutputValue);
    if (!parsed.success) {
      // Surface the zod error text — callers need enough info to diagnose.
      throw new Error(
        `session "${id}" structured output failed schema validation: ${parsed.error.message}`,
      );
    }
    return parsed.data as T;
  }

  // Schema-less path: return the final assistant text. Adapters populate
  // finalAssistantText on the result; the engine backfills it from observed
  // events when the adapter doesn't.
  if (typeof result.finalAssistantText !== 'string') {
    // Returning '' rather than throwing — a session can legitimately have no
    // assistant text (e.g. it only performed tool actions). Callers that need
    // strict text can use a schema.
    return '' as T;
  }
  return result.finalAssistantText as T;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function taskflow(name: string): TaskflowBuilder {
  let rulesPath: string | undefined;
  let envVars: Record<string, string> | undefined;

  const api: TaskflowBuilder = {
    rules(path: string) {
      rulesPath = path;
      return api;
    },
    env(vars: Record<string, string>) {
      envVars = { ...(envVars ?? {}), ...vars };
      return api;
    },
    async run(body, opts = {}) {
      // Apply env vars before execution (matches old API behaviour).
      if (envVars) {
        for (const [k, v] of Object.entries(envVars)) {
          process.env[k] = v;
        }
      }

      const harnessOpts: HarnessOptions = { ...opts };
      if (rulesPath !== undefined && harnessOpts.rulesFile === undefined) {
        harnessOpts.rulesFile = rulesPath;
      }

      return engineHarness(name, harnessOpts, async (h) => {
        const ctx: RunCtx = {
          async phase<T>(phaseName: string, phaseBody: () => Promise<T>): Promise<T> {
            let result!: T;
            await engineStage(h, phaseName, async () => {
              result = await phaseBody();
            });
            return result;
          },
          async session<S extends ZodTypeAny, T extends SessionSpec<S>>(
            id: string,
            spec: T,
          ): Promise<SessionReturn<T>> {
            return runSession<SessionReturn<T>>(h, id, spec);
          },
        };

        await body(ctx);
      });
    },
  };

  return api;
}
