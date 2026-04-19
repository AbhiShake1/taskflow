import type { AgentHandle } from '../adapters';
import type { EventBus } from './events';
import type { Plugin } from './plugin';
import type { LeafResult, LeafSpec, Manifest, RunEvent } from './types';

export type HookName =
  | 'beforeHarness' | 'afterHarness'
  | 'beforePhase'   | 'afterPhase'
  | 'beforeSession' | 'afterSession'
  | 'collectTodos'
  | 'beforeSpawn'   | 'afterSpawn'
  | 'beforeMessage' | 'afterMessage'
  | 'beforeToolCall'| 'afterToolCall'
  | 'beforeToolResult' | 'afterToolResult'
  | 'beforeEdit'    | 'afterEdit'
  | 'beforeSteer'   | 'afterSteer'
  | 'beforeAbort'   | 'afterAbort'
  | 'onError'
  | 'beforeResponse'| 'afterResponse'
  | 'verifyTaskComplete'
  | 'beforeTaskDone'| 'afterTaskDone'
  | 'beforeParallel'| 'afterParallel';

export type Todo = { text: string; done: boolean };

export interface TodoApi {
  list(): Todo[];
  add(item: string | Todo): void;
  complete(item: string): void;
  remaining(): Todo[];
  clear(): void;
  loadFromMarkdown(text: string): void;
}

export interface ScopedFs {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
}

export interface ProofApi {
  captureJson(name: string, value: unknown): Promise<string>;
  captureFile(name: string, srcPath: string): Promise<string>;
}

export interface PluginNamespaces {}

export interface ResolvedConfig {
  todos: {
    autoExtract: boolean;
    maxRetries: number;
    forceGeneration?: boolean;
    generationPreamble?: string;
  };
  hooks: { errorPolicy: 'swallow' | 'warn' | 'throw'; timeoutMs: number };
  events: HookHandlers;
  plugins: Plugin[];
  scope?: string;
}

export interface SessionSpecLike<S = unknown> {
  with: string;
  task: string;
  write?: string[];
  timeoutMs?: number;
  rulesPrefix?: boolean;
  schema?: S;
  todos?: string[];
}

export type SessionReturn<T extends SessionSpecLike<unknown>> =
  T extends { schema: unknown } ? unknown : string;

export interface HookLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface HookCtx {
  scope:    { harness: string; runId: string; runDir: string };
  phaseScope?:   { id: string; stack: string[] };
  sessionScope?: { id: string; spec: LeafSpec; attempt: number };
  event?:   RunEvent;
  hookName: HookName;

  bus: EventBus;
  handle?: AgentHandle;

  steer:  (text: string) => Promise<void>;
  abort:  (reason?: string) => Promise<void>;
  emit:   (ev: RunEvent) => void;
  logger: HookLogger;
  fs:     ScopedFs;
  fetch:  typeof globalThis.fetch;
  todos:  TodoApi;
  proof:  ProofApi;
  config: ResolvedConfig;

  plugins: PluginNamespaces;
  state:   Map<string, unknown>;

  session: <T extends SessionSpecLike<unknown>>(id: string, spec: T) => Promise<SessionReturn<T>>;
  phase:   <T>(name: string, body: () => Promise<T>) => Promise<T>;
}

export type HookPayloads = {
  beforeHarness: { name: string; runId: string; runDir: string };
  afterHarness:  { manifest: Manifest; error?: Error };

  beforePhase:   { phaseId: string; parentId?: string };
  afterPhase:    { phaseId: string; status: 'done' | 'error'; error?: Error };

  beforeSession: { spec: LeafSpec };
  afterSession:  { spec: LeafSpec; result: LeafResult };

  collectTodos:  { spec: LeafSpec };

  beforeSpawn:   { spec: LeafSpec };
  afterSpawn:    { spec: LeafSpec; handle: AgentHandle };

  beforeMessage:    { ev: Extract<RunEvent, { t: 'message' }> };
  afterMessage:     { ev: Extract<RunEvent, { t: 'message' }> };
  beforeToolCall:   { ev: Extract<RunEvent, { t: 'tool' }> };
  afterToolCall:    { ev: Extract<RunEvent, { t: 'tool' }> };
  beforeToolResult: { ev: Extract<RunEvent, { t: 'tool-res' }> };
  afterToolResult:  { ev: Extract<RunEvent, { t: 'tool-res' }> };
  beforeEdit:       { ev: Extract<RunEvent, { t: 'edit' }> };
  afterEdit:        { ev: Extract<RunEvent, { t: 'edit' }> };
  beforeSteer:      { leafId: string; content: string };
  afterSteer:       { leafId: string; content: string };
  beforeAbort:      { leafId: string; reason?: string };
  afterAbort:       { leafId: string; reason?: string };
  onError:          { leafId?: string; error: Error };

  beforeResponse:     { spec: LeafSpec; draftResult: LeafResult; attempt: number };
  verifyTaskComplete: { spec: LeafSpec; draftResult: LeafResult; attempt: number; todos: Todo[] };
  beforeTaskDone:     { spec: LeafSpec; draftResult: LeafResult; attempt: number };
  afterResponse:      { spec: LeafSpec; result: LeafResult };
  afterTaskDone:      { spec: LeafSpec; result: LeafResult };

  beforeParallel: { count: number };
  afterParallel:  { count: number; errors: Error[] };
};

export type HookReturns = {
  beforeHarness: void;
  afterHarness:  void;
  beforePhase:   void;
  afterPhase:    void;
  beforeSession: { spec?: LeafSpec; skip?: boolean } | void;
  afterSession:  void;
  collectTodos:  string[] | { items: string[]; required?: boolean } | void;
  beforeSpawn:   { spec?: LeafSpec } | void;
  afterSpawn:    void;

  beforeMessage:    { content?: string; drop?: boolean } | void;
  afterMessage:     void;
  beforeToolCall:   { args?: unknown; skip?: boolean } | void;
  afterToolCall:    void;
  beforeToolResult: { result?: unknown } | void;
  afterToolResult:  void;
  beforeEdit:       void;
  afterEdit:        void;
  beforeSteer:      { content?: string; cancel?: boolean } | void;
  afterSteer:       void;
  beforeAbort:      { cancel?: boolean } | void;
  afterAbort:       void;
  onError:          { swallow?: boolean } | void;

  beforeResponse:     { retry?: boolean; steerWith?: string } | void;
  verifyTaskComplete: { done: true } | { done: false; remaining: string[]; steerWith?: string };
  beforeTaskDone:     { retry?: boolean; steerWith?: string } | void;
  afterResponse:      void;
  afterTaskDone:      void;

  beforeParallel: void;
  afterParallel:  void;
};

export type HookHandler<N extends HookName> =
  (ctx: HookCtx, payload: HookPayloads[N]) => HookReturns[N] | Promise<HookReturns[N]>;

export type HookHandlers = {
  [N in HookName]?: HookHandler<N>;
};

type HookErrorPolicy = 'swallow' | 'warn' | 'throw';

const DEFAULT_TIMEOUT_MS = 30_000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Merges successive `before*` hook handler return values into a single object.
 *
 * Rules applied in order:
 * 1. If `next` is `undefined`, `acc` is returned unchanged (handler opted out).
 * 2. If either value is not a plain object, `next` wins outright (last-wins scalar).
 * 3. For plain-object pairs, keys are merged shallowly — except when **both** the
 *    accumulated value and the incoming value for a key are arrays, in which case the
 *    arrays are **concatenated** rather than the later one replacing the earlier one.
 *    This preserves contributions from every plugin that appends to a shared list
 *    (e.g. `headers`, `tags`). Replacing with last-wins would silently discard earlier
 *    plugins' additions in multi-plugin scenarios.
 */
function mergeBeforeReturns(acc: unknown, next: unknown): unknown {
  if (next === undefined) return acc;
  if (acc === undefined) return next;
  if (!isObj(acc) || !isObj(next)) return next;
  const out: Record<string, unknown> = { ...acc };
  for (const [k, v] of Object.entries(next)) {
    const prev = out[k];
    if (Array.isArray(prev) && Array.isArray(v)) out[k] = [...prev, ...v];
    else out[k] = v;
  }
  return out;
}

export class HookRegistry {
  private handlers = new Map<HookName, Array<HookHandler<HookName>>>();
  private readonly errorPolicy: HookErrorPolicy;
  private readonly timeoutMs: number;

  constructor(opts: { errorPolicy?: HookErrorPolicy; timeoutMs?: number } = {}) {
    this.errorPolicy = opts.errorPolicy ?? 'swallow';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  register<N extends HookName>(name: N, handler: HookHandler<N>): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler as unknown as HookHandler<HookName>);
    this.handlers.set(name, list);
  }

  mount(handlers: Partial<HookHandlers>): void {
    for (const key of Object.keys(handlers) as HookName[]) {
      const h = handlers[key];
      if (h) this.register(key, h as unknown as HookHandler<typeof key>);
    }
  }

  has(name: HookName): boolean {
    const list = this.handlers.get(name);
    return !!list && list.length > 0;
  }

  async fire<N extends HookName>(
    name: N,
    ctx: HookCtx,
    payload: HookPayloads[N],
  ): Promise<HookReturns[N] | undefined> {
    const list = this.handlers.get(name);
    if (!list || list.length === 0) return undefined;

    const isAfter = name.startsWith('after');
    const isVerify = name === 'verifyTaskComplete';
    const isCollect = name === 'collectTodos';
    const scopedCtx: HookCtx = { ...ctx, hookName: name };

    let merged: unknown = undefined;
    let verifyNotDone: { done: false; remaining: string[]; steerWith?: string } | undefined;
    let verifySawAny = false;
    const collectAcc: string[] = [];

    for (const handler of list) {
      const ret = await this.invokeOne(name, handler, scopedCtx, payload);
      if (ret === undefined) continue;
      if (isAfter) continue;

      if (isVerify) {
        verifySawAny = true;
        const r = ret as HookReturns['verifyTaskComplete'];
        if (r && (r as { done: boolean }).done === false) {
          verifyNotDone = r as { done: false; remaining: string[]; steerWith?: string };
        }
        continue;
      }

      if (isCollect) {
        if (Array.isArray(ret)) {
          for (const it of ret as string[]) if (typeof it === 'string') collectAcc.push(it);
        } else if (isObj(ret) && Array.isArray((ret as { items?: unknown }).items)) {
          for (const it of (ret as { items: unknown[] }).items) if (typeof it === 'string') collectAcc.push(it);
        }
        continue;
      }

      merged = mergeBeforeReturns(merged, ret);
    }

    if (isAfter) return undefined;
    if (isVerify) {
      if (verifyNotDone) return verifyNotDone as HookReturns[N];
      if (verifySawAny) return { done: true } as HookReturns[N];
      return undefined;
    }
    if (isCollect) {
      return collectAcc as unknown as HookReturns[N];
    }
    return merged as HookReturns[N] | undefined;
  }

  private async invokeOne<N extends HookName>(
    name: N,
    handler: HookHandler<HookName>,
    ctx: HookCtx,
    payload: HookPayloads[N],
  ): Promise<HookReturns[N] | undefined> {
    const timeoutMs = this.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => handler(ctx, payload as never)),
        timeout,
      ]);
      if (result === TIMEOUT_SENTINEL) {
        ctx.logger.warn(`[taskflow:hook:${name}] handler exceeded ${timeoutMs}ms; skipping result`);
        return undefined;
      }
      return result as HookReturns[N];
    } catch (err) {
      const policy = this.errorPolicy;
      if (policy === 'throw') throw err;
      if (policy === 'warn') ctx.logger.warn(`[taskflow:hook:${name}] handler threw`, err);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

const TIMEOUT_SENTINEL: unique symbol = Symbol('taskflow.hook.timeout');

export const noopLogger: HookLogger = {
  debug() {},
  info() {},
  warn(...args) { console.warn(...args); },
  error(...args) { console.error(...args); },
};

type HookCtxDefaults =
  & Pick<
    HookCtx,
    'scope' | 'bus' | 'config' | 'logger' | 'fs' | 'fetch' | 'todos' | 'proof' | 'plugins' | 'state' | 'emit' | 'steer' | 'abort'
  >
  & Partial<Pick<HookCtx, 'session' | 'phase'>>;

const noopSession: HookCtx['session'] = async () => {
  throw new Error('ctx.session is unavailable in this scope');
};
const noopPhase: HookCtx['phase'] = async (_n, body) => body();

export function createHookCtx(
  partial: Partial<HookCtx> & { hookName?: HookName },
  defaults: HookCtxDefaults,
): HookCtx {
  return {
    scope: defaults.scope,
    bus: defaults.bus,
    config: defaults.config,
    logger: defaults.logger,
    fs: defaults.fs,
    fetch: defaults.fetch,
    todos: defaults.todos,
    proof: defaults.proof,
    plugins: defaults.plugins,
    state: defaults.state,
    emit: defaults.emit,
    steer: defaults.steer,
    abort: defaults.abort,
    session: defaults.session ?? noopSession,
    phase: defaults.phase ?? noopPhase,
    phaseScope: partial.phaseScope,
    sessionScope: partial.sessionScope,
    event: partial.event,
    handle: partial.handle,
    hookName: partial.hookName ?? 'beforeHarness',
  };
}
