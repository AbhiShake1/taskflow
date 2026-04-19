import type { EventBus } from '../core/events';
import type { AgentAdapter, AgentHandle } from '../adapters/index';
import type { AgentName } from '../core/types';
import type { HookHandlers, ResolvedConfig } from '../core/hooks';
import type { Plugin } from '../core/plugin';

/**
 * Runtime-wide context the harness runner uses to inject its own bus, runs
 * directory, and a shared live-handle registry into a harness() call that
 * happens at module top-level in an emitted file.
 *
 * When no runner is registered, harness() falls back to owning its own bus
 * and the pre-runner behaviour — this keeps all existing tests green.
 *
 * Optional `adapterOverride` lets the runner substitute any adapter for any
 * agent name — used for mock smoke tests from the CLI without modifying the
 * emitted TS module.
 */
export type RunnerContext = {
  bus: EventBus;
  runsDir: string;
  /**
   * When set, `harness()` uses THIS runId instead of generating its own.
   * Prevents runner/core runId drift that would otherwise split output across
   * two directories (runner writes events.jsonl to its runId, harness writes
   * manifest.json + leaves/ to a second runId).
   */
  runId?: string;
  activeHandles: Map<string, AgentHandle>;
  adapterOverride?: (agent: AgentName) => Promise<AgentAdapter>;
  /**
   * Working directory adapters should use for spawning agents. The runner sets this
   * to `process.cwd()` at startup so adapters target the repo root rather than the
   * runDir (or an SDK/CLI-created temp sandbox).
   */
  cwd?: string;
  /**
   * Pre-loaded taskflow config (events, todos, hooks, plugins) discovered by the
   * runner via loadConfig() once at startup. When set, harness() skips its own
   * loadConfig() call and inherits these.
   */
  config?: ResolvedConfig;
  eventLayers?: Array<Partial<HookHandlers>>;
  plugins?: Plugin[];
};

// Stash the runner context on globalThis instead of a module-scoped var.
// Under the published CLI, jiti loads the runner module while the harness
// loads core via native import — two distinct module instances of this
// file. A module-scoped `current` would split the state across both, so
// setRunner() in one instance wouldn't be visible to getRunner() in the
// other (harness() would fall back to defaultRunId() and create a second
// stray run dir). globalThis is the single source of truth regardless of
// how many times the module gets evaluated.
const KEY = Symbol.for('taskflow.runnerContext');
type GlobalWithRunner = typeof globalThis & { [KEY]?: RunnerContext | undefined };

export function setRunner(ctx: RunnerContext | undefined): void {
  (globalThis as GlobalWithRunner)[KEY] = ctx;
}

export function getRunner(): RunnerContext | undefined {
  return (globalThis as GlobalWithRunner)[KEY];
}
