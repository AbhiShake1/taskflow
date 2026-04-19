import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  AgentEvent,
  AgentName,
  Ctx,
  LeafResult,
  LeafSpec,
  LeafStatus,
  LeafSummary,
  RunEvent,
} from './types';
import { claimsOverlap } from './claims';
import { EventBus } from './events';
import { resolveAdapter, type AgentAdapter, type AgentHandle, type SpawnCtx } from '../adapters/index';
import { getRunner } from '../runner/context';
import {
  HookRegistry,
  createHookCtx,
  noopLogger,
  type HookCtx,
  type HookHandlers,
  type HookName,
  type ResolvedConfig,
  type Todo,
} from './hooks';
import { createScopedFs } from './scoped-fs';
import { createProofApi } from './proof';
import { createTodoStore, extractTodosFromMarkdown, type TodoStore } from './todos';
import { applyPluginCtx, composePlugins, type Plugin } from './plugin';
import { DEFAULT_CONFIG, loadConfig } from './config';

export type HarnessOptions = {
  rulesFile?: string;
  runId?: string;
  runsDir?: string;
  adapterOverride?: (agent: AgentName) => Promise<AgentAdapter>;
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

function defaultRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function readRulesFile(p: string | undefined): Promise<string | undefined> {
  if (!p) return undefined;
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  try {
    return await readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
}

export async function harness(
  name: string,
  opts: HarnessOptions,
  body: (h: Ctx) => Promise<void>,
): Promise<{ ctx: Ctx; manifest: Manifest }> {
  const runner = getRunner();
  const runId = opts.runId ?? runner?.runId ?? defaultRunId();
  const runsDir = runner?.runsDir ?? opts.runsDir ?? 'data/runs';
  const runDir = join(runsDir, runId);
  const leavesDir = join(runDir, 'leaves');

  await mkdir(leavesDir, { recursive: true });

  const rules = await readRulesFile(opts.rulesFile);
  const ownsBus = !runner;
  const bus = runner?.bus ?? new EventBus();
  if (ownsBus) {
    await bus.attachFile(join(runDir, 'events.jsonl'));
  }

  // Resolve config + plugins. Runner may have pre-loaded these. When neither
  // a runner-supplied config nor a discoverable .agents/taskflow/config.ts is
  // present, we still build a registry off DEFAULT_CONFIG so hook firing is a
  // safe no-op (no handlers registered → has(name) is false → engine skips).
  let resolvedConfig: ResolvedConfig = runner?.config ?? DEFAULT_CONFIG;
  let eventLayers: Array<Partial<HookHandlers>> = runner?.eventLayers ?? [];
  let pluginList: Plugin[] = runner?.plugins ?? [];

  if (!runner?.config) {
    try {
      const loaded = await loadConfig();
      resolvedConfig = loaded.resolved;
      eventLayers = loaded.eventLayers;
      pluginList = loaded.plugins;
    } catch {
      // If config discovery throws (broken project file, etc.) fall back to
      // defaults rather than nuke the whole run. The user's other tooling
      // already surfaces config errors via the test suite's config tests.
    }
  }

  const hooks = new HookRegistry({
    errorPolicy: resolvedConfig.hooks.errorPolicy,
    timeoutMs: resolvedConfig.hooks.timeoutMs,
  });

  // Plugin handlers BEFORE config handlers so project handlers run last and
  // can mutate / observe plugin output (per plan's composition order).
  const composed = await composePlugins(pluginList, { config: resolvedConfig });
  if (Object.keys(composed.events).length > 0) hooks.mount(composed.events);
  for (const layer of eventLayers) hooks.mount(layer);

  const ctx: Ctx = {
    runId,
    runDir,
    rules,
    bus,
    stageStack: [],
    _leafRecords: [],
    _stageOrder: [],
    _activeClaims: new Map(),
    _adapterOverride: opts.adapterOverride,
    hooks,
    config: resolvedConfig,
    _harnessName: name,
    _pluginCtxBuilders: composed.ctxBuilders,
    _leafPromises: new Map<string, Promise<LeafResult>>(),
    _leafDeps: new Map<string, string[]>(),
  };

  // Build a baseline HookCtx for harness/phase scope (no session yet).
  const baseHookCtx = (): HookCtx => {
    const c = createHookCtx(
      { hookName: 'beforeHarness' },
      {
        scope: { harness: name, runId, runDir },
        bus,
        config: resolvedConfig,
        logger: noopLogger,
        fs: createScopedFs(runDir),
        fetch: globalThis.fetch,
        todos: createTodoStore(),
        proof: createProofApi(join(runDir, 'proof')),
        plugins: {} as HookCtx['plugins'],
        state: new Map<string, unknown>(),
        emit: (ev: RunEvent) => { bus.publish(ev); },
        steer: async () => {},
        abort: async () => {},
        session: async (id, spec) => {
          const mod = await import('../api/index');
          return mod.runSessionWithCtx(ctx, id, spec as unknown as Parameters<typeof mod.runSessionWithCtx>[2]);
        },
        phase: async (phaseName, body) => {
          let result!: Awaited<ReturnType<typeof body>>;
          await stage(ctx, phaseName, async () => {
            result = await body();
          });
          return result;
        },
      },
    );
    if (composed.ctxBuilders.length > 0) applyPluginCtx(c, composed.ctxBuilders);
    return c;
  };

  if (hooks.has('beforeHarness')) {
    await hooks.fire('beforeHarness', baseHookCtx(), { name, runId, runDir });
  }

  const startedAt = Date.now();
  let threw: unknown = undefined;
  try {
    await body(ctx);
  } catch (e) {
    threw = e;
    if (hooks.has('onError')) {
      const err = e instanceof Error ? e : new Error(String(e));
      const ret = await hooks.fire('onError', baseHookCtx(), { error: err });
      if (ret && (ret as { swallow?: boolean }).swallow) threw = undefined;
    }
  }
  const endedAt = Date.now();

  const allDone = ctx._leafRecords.length > 0
    && ctx._leafRecords.every(r => r.status === 'done');
  const exitCode = (threw === undefined && allDone) ? 0 : (threw === undefined && ctx._leafRecords.length === 0 ? 0 : 1);

  const manifest: Manifest = {
    name,
    runId,
    startedAt,
    endedAt,
    exitCode,
    leaves: ctx._leafRecords.slice(),
    stages: ctx._stageOrder.slice(),
  };

  try {
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } finally {
    if (ownsBus) await bus.close();
  }

  if (hooks.has('afterHarness')) {
    const payload = threw instanceof Error
      ? { manifest, error: threw }
      : { manifest };
    await hooks.fire('afterHarness', baseHookCtx(), payload);
  }

  if (threw !== undefined) {
    throw threw;
  }

  return { ctx, manifest };
}

export interface StageCtx {
  /**
   * Update this stage's display title at runtime. Useful when the title isn't
   * known until after some work runs (e.g. the AI's improvement summary
   * after a `pick` session). Emits a `stage-title` event the TUI ingests.
   */
  setTitle: (title: string) => void;
}

export async function stage(h: Ctx, id: string, body: (ctx: StageCtx) => Promise<void> | (() => Promise<void>)): Promise<void> {
  const parentId = h.stageStack[h.stageStack.length - 1];
  h.stageStack.push(id);
  h._stageOrder.push(id);

  const hooks = h.hooks;
  const fireBefore = hooks?.has('beforePhase');
  const fireAfter = hooks?.has('afterPhase');

  if (fireBefore) {
    await hooks!.fire('beforePhase', buildHookCtx(h, { hookName: 'beforePhase', phaseScope: { id, stack: h.stageStack.slice() } }), { phaseId: id, parentId });
  }
  h.bus.publish({ t: 'stage-enter', stageId: id, parentId, ts: Date.now() });

  const stageCtx: StageCtx = {
    setTitle: (title: string) => {
      h.bus.publish({ t: 'stage-title', stageId: id, title, ts: Date.now() });
    },
  };

  let status: 'done' | 'error' = 'done';
  let threw: unknown = undefined;
  try {
    // The body's signature was historically `() => Promise<void>`. Passing a
    // context arg is harmless to bodies that ignore it, so this stays
    // backward compatible with every existing harness.
    await (body as (ctx: StageCtx) => Promise<void>)(stageCtx);
  } catch (e) {
    status = 'error';
    threw = e;
    if (hooks?.has('onError')) {
      const err = e instanceof Error ? e : new Error(String(e));
      const ret = await hooks.fire('onError', buildHookCtx(h, { hookName: 'onError', phaseScope: { id, stack: h.stageStack.slice() } }), { error: err });
      if (ret && (ret as { swallow?: boolean }).swallow) {
        threw = undefined;
        status = 'done';
      }
    }
  } finally {
    h.bus.publish({ t: 'stage-exit', stageId: id, status, ts: Date.now() });
    if (fireAfter) {
      const payload: { phaseId: string; status: 'done' | 'error'; error?: Error } = { phaseId: id, status };
      if (threw instanceof Error) payload.error = threw;
      await hooks!.fire('afterPhase', buildHookCtx(h, { hookName: 'afterPhase', phaseScope: { id, stack: h.stageStack.slice() } }), payload);
    }
    h.stageStack.pop();
  }

  if (threw !== undefined) throw threw;
}

function detectCycle(
  startId: string,
  startDeps: string[],
  depsMap: Map<string, string[]> | undefined,
): string[] | null {
  if (!depsMap) return null;
  const deps = depsMap;
  const visited = new Set<string>();
  function walk(nodeId: string, path: string[]): string[] | null {
    if (nodeId === startId) return [...path, startId];
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);
    const next = deps.get(nodeId);
    if (!next) return null;
    for (const d of next) {
      const found = walk(d, [...path, nodeId]);
      if (found) return found;
    }
    return null;
  }
  for (const d of startDeps) {
    const found = walk(d, [startId]);
    if (found) return found;
  }
  return null;
}

function checkClaimConflicts(h: Ctx, spec: LeafSpec): void {
  const mine = spec.claims ?? [];
  if (mine.length === 0) return;
  for (const [otherId, other] of h._activeClaims) {
    if (claimsOverlap(mine, other)) {
      throw new Error(`claim conflict: "${spec.id}" vs "${otherId}"`);
    }
  }
}

// Build a HookCtx anchored to the harness run + (optional) phase/session/event.
// The HookRegistry overwrites `hookName` per-fire so we set it to the partial's
// value if supplied, otherwise to a sentinel.
//
// Note on `session`/`phase`: these are intentionally bound to the SAME `h: Ctx`
// as the parent. A hook handler that calls `ctx.session(...)` spawns a child
// leaf that fires its own beforeSession / collectTodos / afterTaskDone, etc.
// Recursion is bounded only by user code; the engine treats it as another
// `leaf()` invocation (claims, manifest, bus events, hook firing all apply).
function buildHookCtx(
  h: Ctx,
  partial: Partial<HookCtx> & { hookName: HookName },
): HookCtx {
  const harnessName = (h as Ctx & { _harnessName?: string })._harnessName ?? 't';
  const config = h.config ?? DEFAULT_CONFIG;

  // steer/abort proxies fire their before/after hooks around the live handle
  // attached to the current HookCtx (set by sessionHookCtx). No-op when we're
  // not in a session scope (harness/phase scope handlers can still call them,
  // but without a handle there's nothing to steer/abort). The proxies intentionally
  // use partial.handle / partial.sessionScope captured at ctx-build time so each
  // fired hook sees the same handle it was constructed with.
  const steerProxy: HookCtx['steer'] = async (text: string) => {
    const handle = partial.handle;
    const scope = partial.sessionScope;
    if (!handle || !scope) return;
    const ev: RunEvent = { t: 'steer', leafId: scope.id, content: text, ts: Date.now() };
    let finalContent = text;
    if (h.hooks?.has('beforeSteer')) {
      const ret = await h.hooks.fire(
        'beforeSteer',
        buildHookCtx(h, { hookName: 'beforeSteer', sessionScope: scope, handle, event: ev, todos: partial.todos }),
        { leafId: scope.id, content: text },
      );
      if (ret && (ret as { cancel?: boolean }).cancel) return;
      if (ret && typeof (ret as { content?: string }).content === 'string') {
        finalContent = (ret as { content: string }).content;
      }
    }
    await handle.steer(finalContent);
    if (h.hooks?.has('afterSteer')) {
      await h.hooks.fire(
        'afterSteer',
        buildHookCtx(h, { hookName: 'afterSteer', sessionScope: scope, handle, event: ev, todos: partial.todos }),
        { leafId: scope.id, content: finalContent },
      );
    }
  };
  const abortProxy: HookCtx['abort'] = async (reason?: string) => {
    const handle = partial.handle;
    const scope = partial.sessionScope;
    if (!handle || !scope) return;
    if (h.hooks?.has('beforeAbort')) {
      const ret = await h.hooks.fire(
        'beforeAbort',
        buildHookCtx(h, { hookName: 'beforeAbort', sessionScope: scope, handle, todos: partial.todos }),
        { leafId: scope.id, reason },
      );
      if (ret && (ret as { cancel?: boolean }).cancel) return;
    }
    await handle.abort(reason);
    if (h.hooks?.has('afterAbort')) {
      await h.hooks.fire(
        'afterAbort',
        buildHookCtx(h, { hookName: 'afterAbort', sessionScope: scope, handle, todos: partial.todos }),
        { leafId: scope.id, reason },
      );
    }
  };

  const c = createHookCtx(
    partial,
    {
      scope: { harness: harnessName, runId: h.runId, runDir: h.runDir },
      bus: h.bus,
      config,
      logger: noopLogger,
      fs: createScopedFs(h.runDir),
      fetch: globalThis.fetch,
      todos: (partial as { todos?: HookCtx['todos'] }).todos ?? createTodoStore(),
      proof: createProofApi(join(h.runDir, 'proof')),
      plugins: {} as HookCtx['plugins'],
      state: new Map<string, unknown>(),
      emit: (ev: RunEvent) => { h.bus.publish(ev); },
      steer: steerProxy,
      abort: abortProxy,
      session: async (id, spec) => {
        const mod = await import('../api/index');
        return mod.runSessionWithCtx(h, id, spec as unknown as Parameters<typeof mod.runSessionWithCtx>[2]);
      },
      phase: async (name, body) => {
        let result!: Awaited<ReturnType<typeof body>>;
        await stage(h, name, async () => {
          result = await body();
        });
        return result;
      },
    },
  );
  const builders = h._pluginCtxBuilders;
  if (builders && builders.length > 0) applyPluginCtx(c, builders);
  return c;
}

function formatRemaining(items: Array<Todo | string>): string {
  if (items.length === 0) return 'Please complete the remaining work.';
  const lines = items.map((it) => {
    const text = typeof it === 'string' ? it : it.text;
    return `- ${text}`;
  });
  return `Previously left undone:\n${lines.join('\n')}`;
}

type DrainHandle = {
  promise: Promise<void>;
};

// Spawn → drain → wait. Extracted so the verify loop can re-run it after a
// re-spawn fallback. The drain coroutine fires per-event hooks and applies
// before-hook mutations / drops before publishing to the bus.
async function spawnDrainWait(args: {
  h: Ctx;
  spec: LeafSpec;
  spawnCtx: SpawnCtx;
  adapter: AgentAdapter;
  todoStore: TodoStore;
  attempt: number;
}): Promise<{ handle: AgentHandle; result: LeafResult; drain: DrainHandle; lastAssistantText?: string }> {
  const { h, spec, spawnCtx, adapter, todoStore, attempt } = args;
  const hooks = h.hooks;

  if (hooks?.has('beforeSpawn')) {
    const ret = await hooks.fire(
      'beforeSpawn',
      sessionHookCtx(h, spec, attempt, todoStore, undefined, 'beforeSpawn'),
      { spec },
    );
    if (ret && ret.spec) Object.assign(spec, ret.spec);
  }

  const handle = adapter.spawn(spec, spawnCtx);

  const runner = getRunner();
  runner?.activeHandles.set(spec.id, handle);

  if (hooks?.has('afterSpawn')) {
    await hooks.fire(
      'afterSpawn',
      sessionHookCtx(h, spec, attempt, todoStore, handle, 'afterSpawn'),
      { spec, handle },
    );
  }

  let lastAssistantText: string | undefined;
  const drainState: { promise: Promise<void> } = { promise: Promise.resolve() };
  drainState.promise = (async () => {
    for await (const ev of handle.events as AsyncIterable<AgentEvent>) {
      if (ev.t === 'message' && ev.role === 'assistant' && typeof ev.content === 'string' && ev.content.length > 0) {
        lastAssistantText = ev.content;
      }
      const next = await applyEventHooks(h, spec, attempt, todoStore, handle, ev);
      if (next === DROP_EVENT) continue;
      h.bus.publish(next);
      await fireAfterEventHook(h, spec, attempt, todoStore, handle, next);
    }
  })().catch(() => { /* surfaced via handle.wait() */ });

  let result: LeafResult;
  if (spec.timeoutMs && spec.timeoutMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>(res => {
      timer = setTimeout(() => res('timeout'), spec.timeoutMs);
    });
    const winner = await Promise.race([handle.wait(), timedOut]);
    if (timer) clearTimeout(timer);
    if (winner === 'timeout') {
      await handle.abort('timeout');
      const original = await handle.wait();
      result = { ...original, status: 'timeout' as LeafStatus };
      h.bus.publish({ t: 'done', leafId: spec.id, result, ts: Date.now() });
    } else {
      result = winner as LeafResult;
    }
  } else {
    result = await handle.wait();
  }

  await drainState.promise;

  return { handle, result, drain: drainState, lastAssistantText };
}

const DROP_EVENT = Symbol('taskflow.dropEvent');
type DropEvent = typeof DROP_EVENT;

async function applyEventHooks(
  h: Ctx,
  spec: LeafSpec,
  attempt: number,
  todoStore: TodoStore,
  handle: AgentHandle,
  ev: AgentEvent,
): Promise<AgentEvent | DropEvent> {
  const hooks = h.hooks;
  if (!hooks) return ev;

  switch (ev.t) {
    case 'message': {
      if (!hooks.has('beforeMessage')) return ev;
      const ret = await hooks.fire(
        'beforeMessage',
        sessionHookCtx(h, spec, attempt, todoStore, handle, 'beforeMessage', ev),
        { ev },
      );
      if (ret?.drop) return DROP_EVENT;
      if (ret?.content !== undefined) return { ...ev, content: ret.content };
      return ev;
    }
    case 'tool': {
      if (!hooks.has('beforeToolCall')) return ev;
      const ret = await hooks.fire(
        'beforeToolCall',
        sessionHookCtx(h, spec, attempt, todoStore, handle, 'beforeToolCall', ev),
        { ev },
      );
      if (ret?.skip) return DROP_EVENT;
      if (ret?.args !== undefined) return { ...ev, args: ret.args };
      return ev;
    }
    case 'tool-res': {
      if (!hooks.has('beforeToolResult')) return ev;
      const ret = await hooks.fire(
        'beforeToolResult',
        sessionHookCtx(h, spec, attempt, todoStore, handle, 'beforeToolResult', ev),
        { ev },
      );
      if (ret?.result !== undefined) return { ...ev, result: ret.result };
      return ev;
    }
    case 'edit': {
      if (!hooks.has('beforeEdit')) return ev;
      await hooks.fire(
        'beforeEdit',
        sessionHookCtx(h, spec, attempt, todoStore, handle, 'beforeEdit', ev),
        { ev },
      );
      return ev;
    }
    case 'steer': {
      if (!hooks.has('beforeSteer')) return ev;
      const ret = await hooks.fire(
        'beforeSteer',
        sessionHookCtx(h, spec, attempt, todoStore, handle, 'beforeSteer', ev),
        { leafId: ev.leafId, content: ev.content },
      );
      if (ret?.cancel) return DROP_EVENT;
      if (ret?.content !== undefined) return { ...ev, content: ret.content };
      return ev;
    }
    case 'error': {
      if (!hooks.has('onError')) return ev;
      const err = new Error(ev.error);
      const ret = await hooks.fire(
        'onError',
        sessionHookCtx(h, spec, attempt, todoStore, handle, 'onError', ev),
        { leafId: ev.leafId, error: err },
      );
      if (ret?.swallow) return DROP_EVENT;
      return ev;
    }
    default:
      return ev;
  }
}

async function fireAfterEventHook(
  h: Ctx,
  spec: LeafSpec,
  attempt: number,
  todoStore: TodoStore,
  handle: AgentHandle,
  ev: AgentEvent,
): Promise<void> {
  const hooks = h.hooks;
  if (!hooks) return;
  switch (ev.t) {
    case 'message':
      if (hooks.has('afterMessage')) {
        await hooks.fire('afterMessage', sessionHookCtx(h, spec, attempt, todoStore, handle, 'afterMessage', ev), { ev });
      }
      break;
    case 'tool':
      if (hooks.has('afterToolCall')) {
        await hooks.fire('afterToolCall', sessionHookCtx(h, spec, attempt, todoStore, handle, 'afterToolCall', ev), { ev });
      }
      break;
    case 'tool-res':
      if (hooks.has('afterToolResult')) {
        await hooks.fire('afterToolResult', sessionHookCtx(h, spec, attempt, todoStore, handle, 'afterToolResult', ev), { ev });
      }
      break;
    case 'edit':
      if (hooks.has('afterEdit')) {
        await hooks.fire('afterEdit', sessionHookCtx(h, spec, attempt, todoStore, handle, 'afterEdit', ev), { ev });
      }
      break;
    case 'steer':
      if (hooks.has('afterSteer')) {
        await hooks.fire('afterSteer', sessionHookCtx(h, spec, attempt, todoStore, handle, 'afterSteer', ev), { leafId: ev.leafId, content: ev.content });
      }
      break;
    default:
      break;
  }
}

function sessionHookCtx(
  h: Ctx,
  spec: LeafSpec,
  attempt: number,
  todoStore: TodoStore,
  handle: AgentHandle | undefined,
  hookName: HookName,
  ev?: AgentEvent,
): HookCtx {
  return buildHookCtx(h, {
    hookName,
    sessionScope: { id: spec.id, spec, attempt },
    handle,
    event: ev,
    todos: todoStore,
  } as Partial<HookCtx> & { hookName: HookName; todos?: HookCtx['todos'] });
}

async function resolveCurrentAdapter(h: Ctx, agent: LeafSpec['agent']): Promise<AgentAdapter> {
  const runnerOverride = getRunner()?.adapterOverride;
  if (h._adapterOverride) return h._adapterOverride(agent);
  if (runnerOverride) return runnerOverride(agent);
  return resolveAdapter(agent);
}

export async function leaf(h: Ctx, spec: LeafSpec): Promise<LeafResult> {
  // Register this leaf's own promise up-front so late-starting dependers can
  // find it via h._leafPromises.
  let resolveMyPromise!: (r: LeafResult) => void;
  let rejectMyPromise!: (e: unknown) => void;
  let myPromiseSettled = false;
  const myPromise = new Promise<LeafResult>((res, rej) => {
    resolveMyPromise = (r) => { myPromiseSettled = true; res(r); };
    rejectMyPromise = (e) => { myPromiseSettled = true; rej(e); };
  });
  // Suppress unhandled-rejection warning when no depender awaits this promise.
  myPromise.catch(() => {});
  h._leafPromises?.set(spec.id, myPromise);

  // Await declared dependencies BEFORE claim-conflict checks so a dep that
  // releases its claims on completion doesn't collide with us.
  if (spec.dependsOn && spec.dependsOn.length > 0) {
    h._leafDeps?.set(spec.id, spec.dependsOn.slice());
    const cycle = detectCycle(spec.id, spec.dependsOn, h._leafDeps);
    if (cycle) {
      h._leafDeps?.delete(spec.id);
      const err = new Error(`leaf "${spec.id}" dependsOn forms a cycle: ${cycle.join(' → ')}`);
      rejectMyPromise(err);
      throw err;
    }
    const depPromises: Array<Promise<LeafResult>> = [];
    for (const id of spec.dependsOn) {
      const p = h._leafPromises?.get(id);
      if (!p) {
        const err = new Error(`leaf "${spec.id}" dependsOn "${id}" but no leaf with that id has been registered`);
        rejectMyPromise(err);
        throw err;
      }
      depPromises.push(p);
    }
    try {
      await Promise.all(depPromises);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(`leaf "${spec.id}" aborted: dependency failed — ${msg}`);
      rejectMyPromise(wrapped);
      throw wrapped;
    }
  }

  try {
    checkClaimConflicts(h, spec);
  } catch (err) {
    rejectMyPromise(err);
    throw err;
  }
  h._activeClaims.set(spec.id, spec.claims ?? []);

  // Top-level try/catch fires `onError` on any uncaught exception from the
  // leaf body. When a handler returns `{swallow: true}`, we surface a
  // synthetic error-status LeafResult instead of rethrowing.
  const runLeafBody = async (): Promise<LeafResult> => {
    let adapter: AgentAdapter = await resolveCurrentAdapter(h, spec.agent);

    const config = h.config ?? DEFAULT_CONFIG;
    const hooks = h.hooks;

    // Build the per-session todo store, persisted to leaves/<id>/todos.json.
    // Inline + (optional) auto-extracted markdown items both seed it.
    const todoStore = createTodoStore({
      persistPath: join(h.runDir, 'leaves', spec.id, 'todos.json'),
      initial: spec.todos ?? [],
    });
    if (config.todos.autoExtract !== false) {
      for (const t of extractTodosFromMarkdown(spec.task)) todoStore.add(t);
    }

    const mandatoryItems: string[] = [];
    if (hooks?.has('collectTodos')) {
      const ret = await hooks.fire(
        'collectTodos',
        sessionHookCtx(h, spec, 0, todoStore, undefined, 'collectTodos'),
        { spec },
      );
      if (Array.isArray(ret)) {
        for (const it of ret) {
          if (typeof it === 'string' && it.length > 0) {
            mandatoryItems.push(it);
            todoStore.add(it);
          }
        }
      }
    }
    await todoStore.flush();

    const scopeText = (config.scope ?? '').trim();
    const forceGen = config.todos.forceGeneration === true;
    let augmentedTask = spec.task;
    if (forceGen) {
      const formattedItems = mandatoryItems.map((s) => `- [ ] ${s}`).join('\n');
      const preambleTpl = config.todos.generationPreamble;
      let preamble: string;
      if (typeof preambleTpl === 'string') {
        preamble = preambleTpl.replace('{{items}}', formattedItems);
      } else if (mandatoryItems.length > 0) {
        preamble = [
          'Before doing anything else, output your task plan as a markdown checklist (`- [ ] item` lines). Cover ALL the work, then proceed.',
          '',
          'Your plan MUST include these items at minimum (do not omit them):',
          formattedItems,
          '',
          'Once the plan is written, execute it.',
          '',
          '---',
          '',
        ].join('\n');
      } else {
        preamble = [
          'Before doing anything else, output your task plan as a markdown checklist (`- [ ] item` lines). Cover ALL the work, then proceed.',
          '',
          'Once the plan is written, execute it.',
          '',
          '---',
          '',
        ].join('\n');
      }
      augmentedTask = `${preamble}\n${augmentedTask}`;
    }
    if (scopeText.length > 0) {
      const scopeBlock = `Scope and constraints:\n${scopeText}\n\n---\n\n`;
      augmentedTask = `${scopeBlock}${augmentedTask}`;
    }

    let workingSpec: LeafSpec = augmentedTask === spec.task ? spec : { ...spec, task: augmentedTask };

    if (hooks?.has('beforeSession')) {
      const ret = await hooks.fire(
        'beforeSession',
        sessionHookCtx(h, workingSpec, 0, todoStore, undefined, 'beforeSession'),
        { spec: workingSpec },
      );
      if (ret?.skip) {
        const skipResult: LeafResult = {
          leafId: workingSpec.id,
          status: 'done',
          startedAt: Date.now(),
          endedAt: Date.now(),
        };
        const summary: LeafSummary = { id: workingSpec.id, status: 'done', durationMs: 0 };
        h._leafRecords.push(summary);
        if (hooks.has('afterSession')) {
          await hooks.fire('afterSession', sessionHookCtx(h, workingSpec, 0, todoStore, undefined, 'afterSession'), { spec: workingSpec, result: skipResult });
        }
        return skipResult;
      }
      if (ret?.spec) workingSpec = ret.spec;
    }

    const rulesPrefixEnabled = workingSpec.rulesPrefix !== false;
    const spawnCtx: SpawnCtx = {
      runDir: h.runDir,
      rulesPrefix: rulesPrefixEnabled && h.rules
        ? `Rules:\n${h.rules}\n\nTask:\n`
        : undefined,
      cwd: getRunner()?.cwd ?? process.cwd(),
      ...(workingSpec.structuredOutput
        ? {
            structuredOutput: {
              jsonSchema: workingSpec.structuredOutput.jsonSchema,
              ...(workingSpec.structuredOutput._zodSchema !== undefined
                ? { _zodSchema: workingSpec.structuredOutput._zodSchema }
                : {}),
            },
          }
        : {}),
    };

    const startedAt = Date.now();

    let attempt = 0;
    let drainResult = await spawnDrainWait({
      h, spec: workingSpec, spawnCtx, adapter, todoStore, attempt,
    });
    let handle: AgentHandle = drainResult.handle;
    let result: LeafResult = drainResult.result;
    let lastAssistantText: string | undefined = drainResult.lastAssistantText;

    // Engine-side backfill (mirrors pre-loop behavior).
    if (result.finalAssistantText === undefined && lastAssistantText !== undefined) {
      result = { ...result, finalAssistantText: lastAssistantText };
    }

    // ===========================================================================
    // VERIFY LOOP — keystone of the hook system.
    //
    // After the adapter says it's "done", we don't immediately publish a final
    // `done` to the bus. Instead, we let `beforeResponse`, `verifyTaskComplete`,
    // and `beforeTaskDone` inspect the draft result. If ANY of them returns
    // `{retry,steerWith}` (or verify says `{done:false,...}`), we re-arm the
    // session — preferring `handle.continueAfterDone` (preserves context),
    // falling back to a fresh spawn with the steer text appended to the task.
    // The loop is bounded by `config.todos.maxRetries`. On exhaustion we
    // promote status to 'error' and surface the unmet items in the message.
    // ===========================================================================
    const maxRetries = config.todos.maxRetries ?? 3;
    while (true) {
      const retryReasons: string[] = [];

      let resp1: { retry?: boolean; steerWith?: string } | undefined;
      if (hooks?.has('beforeResponse')) {
        resp1 = await hooks.fire(
          'beforeResponse',
          sessionHookCtx(h, workingSpec, attempt, todoStore, handle, 'beforeResponse'),
          { spec: workingSpec, draftResult: result, attempt },
        ) ?? undefined;
      }

      let verify: { done: true } | { done: false; remaining: string[]; steerWith?: string } | undefined;
      if (hooks?.has('verifyTaskComplete')) {
        verify = await hooks.fire(
          'verifyTaskComplete',
          sessionHookCtx(h, workingSpec, attempt, todoStore, handle, 'verifyTaskComplete'),
          { spec: workingSpec, draftResult: result, attempt, todos: todoStore.list() },
        ) ?? undefined;
      }

      let resp2: { retry?: boolean; steerWith?: string } | undefined;
      if (hooks?.has('beforeTaskDone')) {
        resp2 = await hooks.fire(
          'beforeTaskDone',
          sessionHookCtx(h, workingSpec, attempt, todoStore, handle, 'beforeTaskDone'),
          { spec: workingSpec, draftResult: result, attempt },
        ) ?? undefined;
      }

      if (resp1?.retry) retryReasons.push(resp1.steerWith ?? 'Please continue.');
      if (verify && verify.done === false) {
        retryReasons.push(verify.steerWith ?? formatRemaining(verify.remaining ?? todoStore.remaining().map(t => t.text)));
      }
      if (resp2?.retry) retryReasons.push(resp2.steerWith ?? 'Please continue.');

      if (retryReasons.length === 0) break;

      if (attempt >= maxRetries) {
        const unmet = verify && verify.done === false
          ? verify.remaining
          : todoStore.remaining().map(t => t.text);
        const summary = unmet.length > 0
          ? unmet.map(t => `- ${t}`).join('\n')
          : retryReasons.join(' / ');
        result = {
          ...result,
          status: 'error',
          error: `verify-loop exhausted after ${attempt + 1} attempt(s); unmet:\n${summary}`,
        };
        break;
      }

      attempt++;
      const steerText = retryReasons.join('\n\n');

      let resumed = false;
      if (handle.supportsResume && handle.continueAfterDone) {
        try {
          await handle.continueAfterDone(steerText);
          // Re-enter drain on the same handle. The adapter swaps in a fresh
          // EventChannel internally; iterating handle.events picks it up.
          let nextLast: string | undefined;
          const drainNext = (async () => {
            for await (const ev of handle.events as AsyncIterable<AgentEvent>) {
              if (ev.t === 'message' && ev.role === 'assistant' && typeof ev.content === 'string' && ev.content.length > 0) {
                nextLast = ev.content;
              }
              const next = await applyEventHooks(h, workingSpec, attempt, todoStore, handle, ev);
              if (next === DROP_EVENT) continue;
              h.bus.publish(next);
              await fireAfterEventHook(h, workingSpec, attempt, todoStore, handle, next);
            }
          })().catch(() => { /* surfaced via wait() */ });
          result = await handle.wait();
          await drainNext;
          if (result.finalAssistantText === undefined && nextLast !== undefined) {
            result = { ...result, finalAssistantText: nextLast };
          }
          lastAssistantText = nextLast ?? lastAssistantText;
          resumed = true;
        } catch {
          resumed = false;
        }
      }

      if (!resumed) {
        try { await handle.abort?.('verify-loop-respawn'); } catch { /* ignore */ }
        const augmented: LeafSpec = {
          ...workingSpec,
          task: `${workingSpec.task}\n\n${steerText}`,
        };
        // Re-resolve the adapter: a hook may have swapped h._adapterOverride
        // between the original spawn and now, so always use the current
        // resolution path rather than the captured-at-entry `adapter`.
        adapter = await resolveCurrentAdapter(h, augmented.agent);
        const next = await spawnDrainWait({
          h, spec: augmented, spawnCtx, adapter, todoStore, attempt,
        });
        handle = next.handle;
        result = next.result;
        if (result.finalAssistantText === undefined && next.lastAssistantText !== undefined) {
          result = { ...result, finalAssistantText: next.lastAssistantText };
        }
        lastAssistantText = next.lastAssistantText ?? lastAssistantText;
      }
    }

    // Final assistant-text backfill — adapters MAY set it; engine guarantees it
    // when at least one assistant message arrived during any attempt.
    if (result.finalAssistantText === undefined && lastAssistantText !== undefined) {
      result = { ...result, finalAssistantText: lastAssistantText };
    }

    if (hooks?.has('afterResponse')) {
      await hooks.fire('afterResponse', sessionHookCtx(h, workingSpec, attempt, todoStore, handle, 'afterResponse'), { spec: workingSpec, result });
    }
    if (hooks?.has('afterTaskDone')) {
      await hooks.fire('afterTaskDone', sessionHookCtx(h, workingSpec, attempt, todoStore, handle, 'afterTaskDone'), { spec: workingSpec, result });
    }

    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;

    const proofDir = join(h.runDir, 'leaves', workingSpec.id);
    const proofPath = join(proofDir, 'proof.json');
    await mkdir(proofDir, { recursive: true });
    const proof = { result };
    await writeFile(proofPath, JSON.stringify(proof, null, 2), 'utf8');

    const summary: LeafSummary = {
      id: workingSpec.id,
      status: result.status,
      durationMs,
      proofPath,
    };
    h._leafRecords.push(summary);

    if (hooks?.has('afterSession')) {
      await hooks.fire('afterSession', sessionHookCtx(h, workingSpec, attempt, todoStore, handle, 'afterSession'), { spec: workingSpec, result });
    }
    await todoStore.flush();

    if (result.status !== 'done') {
      throw new Error(`leaf failed: ${workingSpec.id} (${result.status})${result.error ? `: ${result.error}` : ''}`);
    }

    return { ...result, proofPath };
  };

  try {
    let leafResult: LeafResult;
    try {
      leafResult = await runLeafBody();
    } catch (err) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      let swallowed = false;
      if (h.hooks?.has('onError')) {
        const ret = await h.hooks.fire(
          'onError',
          buildHookCtx(h, { hookName: 'onError', sessionScope: { id: spec.id, spec, attempt: 0 } }),
          { leafId: spec.id, error: errObj },
        );
        if (ret && (ret as { swallow?: boolean }).swallow) swallowed = true;
      }
      if (swallowed) {
        const synthetic: LeafResult = {
          leafId: spec.id,
          status: 'error',
          startedAt: Date.now(),
          endedAt: Date.now(),
          error: errObj.message,
        };
        resolveMyPromise(synthetic);
        return synthetic;
      }
      rejectMyPromise(errObj);
      throw errObj;
    }
    resolveMyPromise(leafResult);
    return leafResult;
  } finally {
    h._activeClaims.delete(spec.id);
    getRunner()?.activeHandles.delete(spec.id);
    if (!myPromiseSettled) {
      // Defensive: shouldn't happen, but ensure the promise is always settled
      // so dependers don't hang.
      rejectMyPromise(new Error(`leaf "${spec.id}" ended without settling its promise`));
    }
  }
}

export async function parallel(h: Ctx, fns: Array<() => Promise<unknown>>): Promise<void> {
  const hooks = h.hooks;
  if (hooks?.has('beforeParallel')) {
    await hooks.fire('beforeParallel', buildHookCtx(h, { hookName: 'beforeParallel' }), { count: fns.length });
  }

  const settled = await Promise.allSettled(fns.map(fn => fn()));
  const errors = settled
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map(r => (r.reason instanceof Error ? r.reason : new Error(String(r.reason))));

  if (hooks?.has('afterParallel')) {
    await hooks.fire('afterParallel', buildHookCtx(h, { hookName: 'afterParallel' }), { count: fns.length, errors });
  }

  if (errors.length > 0) {
    const AggErr = (globalThis as unknown as { AggregateError: typeof AggregateError }).AggregateError;
    throw new AggErr(errors, `parallel: ${errors.length} branch(es) failed`);
  }
}

export type { Ctx, LeafSpec, LeafResult } from './types';

export async function _ensureRunDir(runDir: string): Promise<void> {
  await mkdir(runDir, { recursive: true });
}

export { dirname };
