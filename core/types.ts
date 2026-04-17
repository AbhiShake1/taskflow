export type AgentName = 'claude-code' | 'pi' | 'codex' | 'cursor' | 'opencode';

export type LeafSpec = {
  id: string;                                  // already-resolved id (no templates at runtime)
  agent: AgentName;
  model?: string;
  task: string;
  claims?: string[];
  timeoutMs?: number;
  rulesPrefix?: boolean;                       // default true
};

export type LeafStatus = 'pending' | 'running' | 'done' | 'error' | 'aborted' | 'timeout';

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
  | { t: 'stage-enter'; stageId: string; parentId?: string; ts: number }
  | { t: 'stage-exit';  stageId: string; status: 'done' | 'error'; ts: number };

export type RunEvent = AgentEvent | StageEvent;

export type LeafSummary = {
  id: string;
  status: LeafStatus;
  durationMs: number;
  proofPath?: string;
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
};
