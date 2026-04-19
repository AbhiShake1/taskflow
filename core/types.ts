export type AgentName = 'claude-code' | 'pi' | 'codex' | 'cursor' | 'opencode';

export type LeafSpec = {
  id: string;                                  // already-resolved id (no templates at runtime)
  agent: AgentName;
  model?: string;
  task: string;
  claims?: string[];
  timeoutMs?: number;
  rulesPrefix?: boolean;                       // default true
  todos?: string[];
  /**
   * Opt-in structured-output contract. When set, the adapter must:
   *   - instruct the LLM to emit a value conforming to `jsonSchema`
   *   - capture that value (natively via tool-use where the adapter supports it,
   *     or via prompt-engineered JSON-block fallback otherwise)
   *   - report it on the terminal `done` event via `result.structuredOutputValue`
   *
   * The fluent API (`session(id, { schema: z.object(...), ... })`) derives
   * `jsonSchema` from a zod validator and enforces the type on the returned promise.
   * The engine itself does no validation — that's the API layer's job, because
   * the engine must stay zod-free (core/types has no runtime deps).
   *
   * `_zodSchema` is an opaque adapter-native escape hatch (only claude-code's
   * native tool-use path uses it). Typed as `unknown` so core/types stays zod-free.
   */
  structuredOutput?: {
    jsonSchema: Record<string, unknown>;
    _zodSchema?: unknown;
  };
  /**
   * Explicit DAG edges. When set, the engine waits for every listed leaf id to
   * resolve (via its own in-flight promise) before this leaf runs
   * `checkClaimConflicts` / `beforeSession` / spawn. Promises are registered
   * lazily on `leaf()` entry, so dependers scheduled after dependees still
   * find them. Unknown ids throw; failed dependencies cascade ("dependency
   * failed — <msg>").
   */
  dependsOn?: string[];
};

export type LeafStatus = 'pending' | 'running' | 'done' | 'error' | 'aborted' | 'timeout' | 'plan';

/**
 * Token-usage / cache-hit metadata surfaced by adapters that talk to an LLM API.
 * Field names are camelCase for consistency with the rest of `LeafResult`; adapters
 * normalize provider-native shapes into this. The Anthropic SDK emits these as
 * snake_case on `SDKResultMessage.usage` (input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens) — see
 * `adapters/claude-code.ts` for the mapping.
 *
 * `cacheReadInputTokens > 0` on a run that shares a `rulesPrefix` with an earlier
 * run is the observable proof that prompt-caching is actually live end-to-end.
 */
export type LeafUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

export type LeafResult = {
  leafId: string;
  status: LeafStatus;
  exitCode?: number;
  error?: string;
  startedAt: number;
  endedAt: number;
  proofPath?: string;
  usage?: LeafUsage;
  /**
   * The last `role:'assistant'` message text the adapter observed, regardless of
   * whether a structured-output schema was configured. Populated by every adapter
   * so the fluent API can return it as the default (schema-less) session return
   * value. Absent when no assistant message ever arrived (hard spawn failure).
   */
  finalAssistantText?: string;
  /**
   * Parsed value produced when `LeafSpec.structuredOutput` is set. Adapters that
   * support native tool-use populate this from the captured tool input; others
   * parse the trailing ```json ... ``` block out of the final assistant text.
   * The engine does NOT validate this against the schema — that's the API layer's
   * job. Absent when no schema was configured OR parsing failed (in which case
   * `status === 'error'` and `error` explains why).
   */
  structuredOutputValue?: unknown;
};

export type AgentEvent =
  | { t: 'spawn';    leafId: string; agent: string; model?: string; ts: number }
  | { t: 'message';  leafId: string; role: 'user' | 'assistant'; content: string; ts: number }
  | { t: 'tool';     leafId: string; name: string; args: unknown; ts: number }
  | { t: 'tool-res'; leafId: string; name: string; result: unknown; ts: number }
  | { t: 'edit';     leafId: string; file: string; added: number; removed: number; ts: number }
  | { t: 'steer';    leafId: string; content: string; ts: number }
  | { t: 'error';    leafId: string; error: string; ts: number }
  | { t: 'done';     leafId: string; result: LeafResult; ts: number };

export type StageEvent =
  | { t: 'stage-enter'; stageId: string; parentId?: string; title?: string; ts: number }
  | { t: 'stage-exit';  stageId: string; status: 'done' | 'error'; ts: number }
  | { t: 'stage-title'; stageId: string; title: string; ts: number };

export type RunEvent = AgentEvent | StageEvent;

export type LeafSummary = {
  id: string;
  status: LeafStatus;
  durationMs: number;
  proofPath?: string;
};

export type Manifest = {
  name: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  exitCode: number;
  leaves: LeafSummary[];
  stages: string[];
};

export type Ctx = {
  runId: string;
  runDir: string;                              // data/runs/{runId}
  rules?: string;                              // resolved contents of rulesFile, if any
  bus: import('./events').EventBus;
  stageStack: string[];                        // for nesting
  /** Internal: collected leaf records used to build the run manifest. */
  _leafRecords: LeafSummary[];
  /** Internal: list of stage ids in enter order, used by the manifest. */
  _stageOrder: string[];
  /** Internal: claims of leaves currently in-flight, keyed by leaf id. */
  _activeClaims: Map<string, string[]>;
  /** Internal: adapter override from HarnessOptions, threaded through for tests. */
  _adapterOverride?: (agent: AgentName) => Promise<import('../adapters').AgentAdapter>;
  hooks?: import('./hooks').HookRegistry;
  config?: import('./hooks').ResolvedConfig;
  /** Internal: harness name, used by hook ctx scope.harness. */
  _harnessName?: string;
  /** Internal: plugin ctx builders, applied to every HookCtx so per-session hooks see ctx.plugins.<name>. */
  _pluginCtxBuilders?: import('./plugin').ComposedPluginCtxBuilder[];
  /** Internal: per-leaf promises keyed by spec.id, used for dependsOn wiring. */
  _leafPromises?: Map<string, Promise<LeafResult>>;
  /** Internal: per-leaf dependsOn lists keyed by spec.id, used for cycle detection. */
  _leafDeps?: Map<string, string[]>;
};
