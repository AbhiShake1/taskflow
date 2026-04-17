import type { AgentEvent, AgentName, LeafResult, LeafSpec } from '../core/types';

export type SpawnCtx = {
  runDir: string;                // data/runs/{runId}
  rulesPrefix?: string;          // resolved rules to prepend to task prompt (already prefixed with "Rules:\n...\n\nTask:\n")
  signal?: AbortSignal;
  /**
   * Working directory the adapter should run the agent in. When set, subprocess adapters
   * pass this through to child_process.spawn's `cwd` option, and in-process adapters
   * (claude-code SDK) pass it to the SDK's `cwd` option. Defaults to the adapter's own
   * fallback (typically `runDir` or `process.cwd()`).
   *
   * Needed because several CLIs (claude-agent-sdk, omp via `pi`) auto-sandbox to a
   * temp dir unless an explicit cwd + opt-out flag are provided — which means files
   * they write land in the sandbox, not the repo.
   */
  cwd?: string;
  /**
   * Contract for structured output. When set, the adapter must drive the LLM
   * toward emitting a value that conforms to `jsonSchema` and surface it via
   * the terminal `done` event's `result.structuredOutputValue`. See LeafSpec's
   * `structuredOutput` doc for the full picture. Wire path:
   *   fluent API → LeafSpec.structuredOutput → core/index.ts plumbs into
   *   SpawnCtx.structuredOutput → adapter consumes.
   *
   * `_zodSchema` is an optional adapter-native handle carrying the original
   * zod schema. Only claude-code uses it today (the claude-agent-sdk's MCP
   * tool path expects a zod raw shape, not a pre-built JSON schema). Other
   * adapters ignore it and rely on `jsonSchema` for their prompt-engineered
   * fallback. Typed as `unknown` so this file keeps no zod dependency.
   */
  structuredOutput?: {
    jsonSchema: Record<string, unknown>;
    _zodSchema?: unknown;
  };
};

export interface AgentHandle {
  readonly events: AsyncIterable<AgentEvent>;
  steer(input: string): Promise<void>;
  abort(reason?: string): Promise<void>;
  wait(): Promise<LeafResult>;
}

export interface AgentAdapter {
  readonly name: AgentName;
  spawn(spec: LeafSpec, ctx: SpawnCtx): AgentHandle;
}

/**
 * Dynamic resolver — imports the adapter lazily so unused adapters don't pull their deps.
 * Each adapter module default-exports an AgentAdapter instance.
 */
export async function resolveAdapter(agent: AgentName): Promise<AgentAdapter> {
  switch (agent) {
    case 'claude-code': return (await import('./claude-code')).default;
    case 'pi':          return (await import('./pi')).default;
    case 'codex':       return (await import('./codex')).default;
    case 'cursor':      return (await import('./cursor')).default;
    case 'opencode':    return (await import('./opencode')).default;
    default:            throw new Error(`unknown agent: ${agent satisfies never}`);
  }
}

/**
 * Tiny async-iterator helper used by every adapter to produce an AsyncIterable<AgentEvent>
 * while internally pushing events from callbacks/subprocess parsing. Back-pressure is a
 * bounded queue; if a consumer falls behind, we drop oldest events and emit an 'error'.
 */
export class EventChannel<T> {
  private queue: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  private readonly maxBuffer: number;

  constructor(opts: { maxBuffer?: number } = {}) {
    this.maxBuffer = opts.maxBuffer ?? 10_000;
  }

  push(item: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) { r({ value: item, done: false }); return; }
    this.queue.push(item);
    if (this.queue.length > this.maxBuffer) this.queue.shift(); // oldest-drop
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.resolvers) r({ value: undefined as any, done: true });
    this.resolvers.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.closed)       return Promise.resolve({ value: undefined as any, done: true });
        return new Promise(res => this.resolvers.push(res));
      },
    };
  }
}
