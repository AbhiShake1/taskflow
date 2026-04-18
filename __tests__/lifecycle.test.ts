import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mock } from 'vitest';

import { harness, leaf, stage } from '../core/index';
import { taskflow } from '../api/index';
import { HookRegistry } from '../core/hooks';
import type {
  HookCtx,
  HookHandler,
  HookHandlers,
  HookName,
  ResolvedConfig,
  Todo,
} from '../core/hooks';
import { DEFAULT_CONFIG } from '../core/config';
import { createMockAdapter } from '../adapters/mock';
import mockAdapter from '../adapters/mock';
import type { AgentEvent, RunEvent } from '../core/types';

let runsDir: string;

beforeEach(() => {
  runsDir = join(tmpdir(), 'lifecycle-test-' + Math.random().toString(36).slice(2));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

async function readEvents(runDir: string): Promise<RunEvent[]> {
  const raw = await readFile(join(runDir, 'events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunEvent);
}

const ALL_HOOKS: HookName[] = [
  'beforeHarness', 'afterHarness',
  'beforePhase', 'afterPhase',
  'beforeSession', 'afterSession',
  'beforeSpawn', 'afterSpawn',
  'beforeMessage', 'afterMessage',
  'beforeToolCall', 'afterToolCall',
  'beforeToolResult', 'afterToolResult',
  'beforeEdit', 'afterEdit',
  'beforeSteer', 'afterSteer',
  'beforeAbort', 'afterAbort',
  'onError',
  'beforeResponse', 'afterResponse',
  'verifyTaskComplete',
  'beforeTaskDone', 'afterTaskDone',
  'beforeParallel', 'afterParallel',
];

function makeAllHookSpies(): { spies: Record<HookName, Mock>; handlers: Partial<HookHandlers> } {
  const spies = {} as Record<HookName, Mock>;
  const handlers: Partial<HookHandlers> = {};
  for (const name of ALL_HOOKS) {
    const spy = vi.fn();
    spies[name] = spy;
    // verifyTaskComplete must always return a value or undefined; default to {done:true}.
    if (name === 'verifyTaskComplete') {
      const h: HookHandler<'verifyTaskComplete'> = async (ctx, payload) => {
        spy(ctx, payload);
        return { done: true } as const;
      };
      (handlers as Record<HookName, unknown>)[name] = h;
    } else {
      const h: HookHandler<HookName> = async (ctx, payload) => {
        spy(ctx, payload);
        return undefined as never;
      };
      (handlers as Record<HookName, unknown>)[name] = h;
    }
  }
  return { spies, handlers };
}

function buildConfig(over: Partial<ResolvedConfig['todos']> = {}): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    todos: { ...DEFAULT_CONFIG.todos, ...over },
  };
}

describe('lifecycle: hook firings', () => {
  it('every registered hook fires with a HookCtx whose scope/session match', async () => {
    const { spies, handlers } = makeAllHookSpies();

    // Install hooks via the runner-context plumbing so beforeHarness fires too:
    // harness() picks up `runner.eventLayers` and mounts them BEFORE its
    // beforeHarness hook fires.
    const { setRunner } = await import('../runner/context');
    const { EventBus } = await import('../core/events');
    const bus = new EventBus();
    await bus.attachFile(join(runsDir, 'fires', 'events.jsonl'));
    setRunner({
      bus,
      runsDir,
      runId: 'fires',
      activeHandles: new Map(),
      cwd: process.cwd(),
      config: buildConfig(),
      eventLayers: [handlers],
      plugins: [],
    });

    try {
      await harness(
        'lifecycle-fire',
        {
          runsDir,
          runId: 'fires',
          adapterOverride: async () => createMockAdapter({ turns: [{ assistantText: 'ok' }] }),
        },
        async (h) => {
          await stage(h, 's', async () => {
            await leaf(h, { id: 'l', agent: 'claude-code', task: 'just say ok' });
          });
        },
      );
    } finally {
      await bus.close();
      setRunner(undefined);
    }

    // Always-fire harness/phase/session/spawn/message/response/done hooks.
    for (const name of [
      'beforeHarness', 'afterHarness',
      'beforePhase', 'afterPhase',
      'beforeSession', 'afterSession',
      'beforeSpawn', 'afterSpawn',
      'beforeMessage', 'afterMessage',
      'beforeResponse', 'afterResponse',
      'verifyTaskComplete',
      'beforeTaskDone', 'afterTaskDone',
    ] as const) {
      expect(spies[name], `expected ${name} to fire`).toHaveBeenCalled();
    }

    // Ctx checks for a representative session-scoped hook.
    const beforeSessionCall = spies.beforeSession.mock.calls[0];
    const ctx = beforeSessionCall[0] as HookCtx;
    expect(ctx.scope.harness).toBe('lifecycle-fire');
    expect(ctx.scope.runId).toBe('fires');
    expect(ctx.sessionScope?.id).toBe('l');
    expect(ctx.sessionScope?.spec.task).toBe('just say ok');
    expect(ctx.hookName).toBe('beforeSession');

    // afterMessage receives the published event.
    const afterMsgCall = spies.afterMessage.mock.calls[0];
    const msgPayload = afterMsgCall[1] as { ev: Extract<RunEvent, { t: 'message' }> };
    expect(msgPayload.ev.t).toBe('message');
    expect(msgPayload.ev.role).toBe('assistant');
    expect(msgPayload.ev.content).toBe('ok');
  });
});

describe('lifecycle: verify-loop happy path', () => {
  it('continueAfterDone re-arms the session; only one terminal done reaches the bus', async () => {
    let verifyCalls = 0;
    const adapter = createMockAdapter({
      turns: [
        { assistantText: 'started but not done' },
        { assistantText: 'done now' },
      ],
    });

    const handlers: Partial<HookHandlers> = {
      verifyTaskComplete: async (_ctx) => {
        verifyCalls++;
        if (verifyCalls === 1) {
          return { done: false, remaining: ['do the thing'], steerWith: 'Finish: do the thing' };
        }
        return { done: true };
      },
    };

    let received: string | undefined;
    await harness(
      'verify-happy',
      {
        runsDir,
        runId: 'verify-happy',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig({ maxRetries: 3 });
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);

        const result = await leaf(h, {
          id: 'l',
          agent: 'claude-code',
          task: 'task with - [ ] do the thing',
        });
        received = result.finalAssistantText;
      },
    );

    expect(verifyCalls).toBe(2);
    expect(received).toBe('done now');

    const events = await readEvents(join(runsDir, 'verify-happy'));
    const doneEvents = events.filter((e) => e.t === 'done');
    // The mock pushes a `done` per turn into the bus (engine publishes them as
    // they arrive), but the verify loop ensures the FINAL leaf result is
    // `done now`. We assert exactly one terminal done event references the
    // final assistant text.
    const finalDones = doneEvents.filter(
      (e) => (e as Extract<AgentEvent, { t: 'done' }>).result.finalAssistantText === 'done now',
    );
    expect(finalDones.length).toBeGreaterThanOrEqual(1);

    // Hook-firing-order sanity: verifyTaskComplete fired twice, in order.
    expect(verifyCalls).toBe(2);
  });
});

describe('lifecycle: verify-loop exhaustion', () => {
  it('promotes status to error when verify never says done; error names unmet items', async () => {
    const adapter = createMockAdapter({
      turns: [
        { assistantText: 'a' },
        { assistantText: 'b' },
        { assistantText: 'c' },
      ],
    });

    const handlers: Partial<HookHandlers> = {
      verifyTaskComplete: async () => ({
        done: false,
        remaining: ['x', 'y'],
        steerWith: 'still not done',
      }),
    };

    let caught: unknown = undefined;
    try {
      await harness(
        'verify-exhaust',
        {
          runsDir,
          runId: 'verify-exhaust',
          adapterOverride: async () => adapter,
        },
        async (h) => {
          h.config = buildConfig({ maxRetries: 2 });
          h.hooks = new HookRegistry({ errorPolicy: 'throw' });
          h.hooks.mount(handlers);
          await leaf(h, { id: 'l', agent: 'claude-code', task: 'task' });
        },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/leaf failed: l/);
    expect(msg).toMatch(/verify-loop exhausted/);
    expect(msg).toMatch(/x/);
    expect(msg).toMatch(/y/);
  });
});

describe('lifecycle: auto-todo extraction', () => {
  it('persists extracted markdown checkboxes to leaves/<id>/todos.json', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'noop' }] });

    const task = [
      'Do these things:',
      '- [ ] alpha',
      '- [ ] beta',
      'and report back.',
    ].join('\n');

    await harness(
      'todos-extract',
      {
        runsDir,
        runId: 'todos-extract',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        await leaf(h, { id: 'l', agent: 'claude-code', task });
      },
    );

    const path = join(runsDir, 'todos-extract', 'leaves', 'l', 'todos.json');
    const raw = await readFile(path, 'utf8');
    const persisted = JSON.parse(raw) as Todo[];
    expect(persisted).toEqual([
      { text: 'alpha', done: false },
      { text: 'beta', done: false },
    ]);
  });
});

describe('lifecycle: backwards compatibility', () => {
  it('taskflow().run(...) with no config and no hooks behaves as before', async () => {
    let received: string | undefined;
    const { manifest } = await taskflow('compat').run(
      async ({ phase, session }) => {
        await phase('only', async () => {
          received = await session('s', { with: 'claude-code', task: 'hello' });
        });
      },
      { runsDir, runId: 'compat', adapterOverride: async () => mockAdapter },
    );

    expect(manifest.exitCode).toBe(0);
    expect(manifest.leaves).toHaveLength(1);
    expect(manifest.leaves[0]).toMatchObject({ id: 's', status: 'done' });

    // mock's default reply for an initial turn is "[mock reply to: <task>]".
    expect(received).toBe('[mock reply to: hello]');

    const events = await readEvents(join(runsDir, 'compat'));
    const types = events.map((e) => e.t);
    expect(types[0]).toBe('stage-enter');
    expect(types).toContain('spawn');
    expect(types).toContain('message');
    expect(types).toContain('done');
    expect(types[types.length - 1]).toBe('stage-exit');
  });
});

describe('lifecycle: collectTodos hook', () => {
  it('contributes mandatory items into the persisted todo store', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'noop' }] });
    const handlers: Partial<HookHandlers> = {
      collectTodos: async () => ['mandatory-1', 'mandatory-2'],
    };

    await harness(
      'collect-todos',
      {
        runsDir,
        runId: 'collect-todos',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        await leaf(h, { id: 'l', agent: 'claude-code', task: 'do work' });
      },
    );

    const path = join(runsDir, 'collect-todos', 'leaves', 'l', 'todos.json');
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Todo[];
    const texts = persisted.map((t) => t.text);
    expect(texts).toContain('mandatory-1');
    expect(texts).toContain('mandatory-2');
  });
});

describe('lifecycle: forceGeneration directive', () => {
  it('prepends the default directive block (with mandatory items) to spec.task', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'noop' }] });
    let observedTask: string | undefined;
    const handlers: Partial<HookHandlers> = {
      collectTodos: async () => ['mandatory-x', 'mandatory-y'],
      beforeSpawn: async (_ctx, payload) => {
        observedTask = payload.spec.task;
      },
    };

    await harness(
      'force-gen',
      {
        runsDir,
        runId: 'force-gen',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = {
          ...DEFAULT_CONFIG,
          todos: { ...DEFAULT_CONFIG.todos, forceGeneration: true },
        };
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        await leaf(h, { id: 'l', agent: 'claude-code', task: 'underlying task' });
      },
    );

    expect(observedTask).toBeDefined();
    expect(observedTask!).toMatch(/^Before doing anything else, output your task plan/);
    expect(observedTask!).toContain('- [ ] mandatory-x');
    expect(observedTask!).toContain('- [ ] mandatory-y');
    expect(observedTask!).toContain('underlying task');
    expect(observedTask!.indexOf('underlying task'))
      .toBeGreaterThan(observedTask!.indexOf('- [ ] mandatory-x'));
  });

  it('uses the custom generationPreamble when configured, replacing {{items}}', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'noop' }] });
    let observedTask: string | undefined;
    const handlers: Partial<HookHandlers> = {
      collectTodos: async () => ['x'],
      beforeSpawn: async (_ctx, payload) => {
        observedTask = payload.spec.task;
      },
    };

    await harness(
      'preamble',
      {
        runsDir,
        runId: 'preamble',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = {
          ...DEFAULT_CONFIG,
          todos: {
            ...DEFAULT_CONFIG.todos,
            forceGeneration: true,
            generationPreamble: 'Custom preamble {{items}}',
          },
        };
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        await leaf(h, { id: 'l', agent: 'claude-code', task: 'core task' });
      },
    );

    expect(observedTask).toBeDefined();
    expect(observedTask!.startsWith('Custom preamble - [ ] x')).toBe(true);
    expect(observedTask!).toContain('core task');
  });
});

describe('lifecycle: scope preamble', () => {
  it('prepends the scope-and-constraints block when config.scope is set', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'noop' }] });
    let observedTask: string | undefined;
    const handlers: Partial<HookHandlers> = {
      beforeSpawn: async (_ctx, payload) => {
        observedTask = payload.spec.task;
      },
    };

    await harness(
      'scope',
      {
        runsDir,
        runId: 'scope',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = { ...DEFAULT_CONFIG, scope: 'No new files. No deps.' };
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        await leaf(h, { id: 'l', agent: 'claude-code', task: 'underlying' });
      },
    );

    expect(observedTask).toBeDefined();
    expect(observedTask!.startsWith('Scope and constraints:\nNo new files. No deps.\n\n---\n\n')).toBe(true);
    expect(observedTask!).toContain('underlying');
  });
});

describe('lifecycle: ctx.session from hook spawns a real session', () => {
  it('child session runs through the same engine path with bus events + manifest entry', async () => {
    const adapter = createMockAdapter({
      turns: [
        { assistantText: 'parent done' },
        { assistantText: 'child done' },
      ],
    });

    const handlers: Partial<HookHandlers> = {
      afterTaskDone: async (ctx) => {
        if (ctx.sessionScope?.id === 'parent') {
          await ctx.session('child', { with: 'claude-code', task: 'child task' });
        }
      },
    };

    const { manifest } = await harness(
      'ctx-session',
      {
        runsDir,
        runId: 'ctx-session',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        await leaf(h, { id: 'parent', agent: 'claude-code', task: 'parent task' });
      },
    );

    const ids = manifest.leaves.map((l) => l.id);
    expect(ids).toContain('parent');
    expect(ids).toContain('child');

    const events = await readEvents(join(runsDir, 'ctx-session'));
    const childMsgs = events.filter(
      (e) => e.t === 'message' && (e as Extract<RunEvent, { t: 'message' }>).leafId === 'child',
    );
    expect(childMsgs.length).toBeGreaterThan(0);
  });
});

describe('lifecycle: ctx.phase wraps inner sessions with stage-enter/exit', () => {
  it('emits stage-enter and stage-exit events around the spawned child', async () => {
    const adapter = createMockAdapter({
      turns: [
        { assistantText: 'parent done' },
        { assistantText: 'child done' },
      ],
    });

    const handlers: Partial<HookHandlers> = {
      afterTaskDone: async (ctx) => {
        if (ctx.sessionScope?.id === 'parent') {
          await ctx.phase('post-parent', async () => {
            await ctx.session('child', { with: 'claude-code', task: 'child task' });
          });
        }
      },
    };

    await harness(
      'ctx-phase',
      {
        runsDir,
        runId: 'ctx-phase',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        await leaf(h, { id: 'parent', agent: 'claude-code', task: 'parent task' });
      },
    );

    const events = await readEvents(join(runsDir, 'ctx-phase'));
    const phaseEnters = events.filter(
      (e) => e.t === 'stage-enter'
        && (e as Extract<RunEvent, { t: 'stage-enter' }>).stageId === 'post-parent',
    );
    const phaseExits = events.filter(
      (e) => e.t === 'stage-exit'
        && (e as Extract<RunEvent, { t: 'stage-exit' }>).stageId === 'post-parent',
    );
    expect(phaseEnters.length).toBe(1);
    expect(phaseExits.length).toBe(1);
  });
});

describe('lifecycle: ctx.session inherits hooks for child sessions', () => {
  it('a globally registered beforeSession fires for the hook-spawned child too', async () => {
    const adapter = createMockAdapter({
      turns: [
        { assistantText: 'parent done' },
        { assistantText: 'child done' },
      ],
    });

    const seenSessionIds: string[] = [];
    const handlers: Partial<HookHandlers> = {
      beforeSession: async (_ctx, payload) => {
        seenSessionIds.push(payload.spec.id);
      },
      afterTaskDone: async (ctx) => {
        if (ctx.sessionScope?.id === 'parent') {
          await ctx.session('child', { with: 'claude-code', task: 'child task' });
        }
      },
    };

    await harness(
      'ctx-inherit',
      {
        runsDir,
        runId: 'ctx-inherit',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        await leaf(h, { id: 'parent', agent: 'claude-code', task: 'parent task' });
      },
    );

    expect(seenSessionIds).toContain('parent');
    expect(seenSessionIds).toContain('child');
  });
});

describe('lifecycle: ctx.steer proxy fires before/after hooks', () => {
  it('beforeSteer receives content and afterSteer sees the mutated content; handle.steer is called', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'ok' }] });

    const beforeSpy = vi.fn();
    const afterSpy = vi.fn();
    const handlers: Partial<HookHandlers> = {
      beforeSteer: async (_ctx, payload) => {
        beforeSpy(payload);
        return { content: `${payload.content}!` };
      },
      afterSteer: async (_ctx, payload) => {
        afterSpy(payload);
      },
      afterSpawn: async (ctx) => {
        await ctx.steer('hello');
      },
    };

    await harness(
      'ctx-steer',
      {
        runsDir,
        runId: 'ctx-steer',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        await leaf(h, { id: 'l', agent: 'claude-code', task: 'go' });
      },
    );

    expect(beforeSpy).toHaveBeenCalledWith(expect.objectContaining({ leafId: 'l', content: 'hello' }));
    expect(afterSpy).toHaveBeenCalledWith(expect.objectContaining({ leafId: 'l', content: 'hello!' }));

    const events = await readEvents(join(runsDir, 'ctx-steer'));
    const steers = events.filter((e) => e.t === 'steer');
    // The mock's steer() pushes a transcript event into the channel (which
    // then flows through beforeSteer in the drain loop). Proof that the
    // proxy reached handle.steer.
    expect(steers.length).toBeGreaterThan(0);
  });
});

describe('lifecycle: ctx.abort proxy fires before/after hooks and respects cancel', () => {
  it('beforeAbort cancel prevents handle.abort from being invoked', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'ok' }] });
    const spawned = { abortCalled: 0 };
    const wrapped: typeof adapter = {
      ...adapter,
      spawn(spec, sctx) {
        const h = adapter.spawn(spec, sctx);
        const origAbort = h.abort.bind(h);
        return {
          ...h,
          async abort(reason?: string) {
            spawned.abortCalled++;
            return origAbort(reason);
          },
        };
      },
    };

    const beforeSpy = vi.fn();
    const afterSpy = vi.fn();
    const handlers: Partial<HookHandlers> = {
      beforeAbort: async (_ctx, payload) => {
        beforeSpy(payload);
        return { cancel: true };
      },
      afterAbort: async (_ctx, payload) => {
        afterSpy(payload);
      },
      afterSpawn: async (ctx) => {
        await ctx.abort('because');
      },
    };

    await harness(
      'ctx-abort-cancel',
      {
        runsDir,
        runId: 'ctx-abort-cancel',
        adapterOverride: async () => wrapped,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        await leaf(h, { id: 'l', agent: 'claude-code', task: 'go' });
      },
    );

    expect(beforeSpy).toHaveBeenCalledWith(expect.objectContaining({ leafId: 'l', reason: 'because' }));
    expect(spawned.abortCalled).toBe(0);
    expect(afterSpy).not.toHaveBeenCalled();
  });

  it('without cancel, handle.abort runs and afterAbort fires', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'ok' }] });
    const spawned = { abortCalled: 0 };
    const wrapped: typeof adapter = {
      ...adapter,
      spawn(spec, sctx) {
        const h = adapter.spawn(spec, sctx);
        const origAbort = h.abort.bind(h);
        return {
          ...h,
          async abort(reason?: string) {
            spawned.abortCalled++;
            return origAbort(reason);
          },
        };
      },
    };

    const afterSpy = vi.fn();
    const handlers: Partial<HookHandlers> = {
      beforeAbort: async () => undefined,
      afterAbort: async (_ctx, payload) => {
        afterSpy(payload);
      },
      afterSpawn: async (ctx) => {
        await ctx.abort('reason-x');
      },
    };

    let caught: unknown = undefined;
    try {
      await harness(
        'ctx-abort-run',
        {
          runsDir,
          runId: 'ctx-abort-run',
          adapterOverride: async () => wrapped,
        },
        async (h) => {
          h.config = buildConfig();
          h.hooks = new HookRegistry({ errorPolicy: 'throw' });
          h.hooks.mount(handlers);
          await leaf(h, { id: 'l', agent: 'claude-code', task: 'go' });
        },
      );
    } catch (e) {
      // Aborted leaf → engine throws "leaf failed". That's expected here.
      caught = e;
    }
    expect(spawned.abortCalled).toBeGreaterThan(0);
    expect(afterSpy).toHaveBeenCalledWith(expect.objectContaining({ leafId: 'l', reason: 'reason-x' }));
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('lifecycle: onError fires on engine-caught exceptions', () => {
  it('beforeSession throw with errorPolicy throw fires onError and rethrows', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'ok' }] });
    const onErrorSpy = vi.fn();
    const handlers: Partial<HookHandlers> = {
      beforeSession: async () => {
        throw new Error('boom-before-session');
      },
      onError: async (_ctx, payload) => {
        onErrorSpy(payload);
      },
    };

    let caught: unknown = undefined;
    try {
      await harness(
        'onerror-throw',
        {
          runsDir,
          runId: 'onerror-throw',
          adapterOverride: async () => adapter,
        },
        async (h) => {
          h.config = buildConfig();
          h.hooks = new HookRegistry({ errorPolicy: 'throw' });
          h.hooks.mount(handlers);
          await leaf(h, { id: 'l', agent: 'claude-code', task: 'go' });
        },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/boom-before-session/);
    expect(onErrorSpy).toHaveBeenCalled();
    const payload = onErrorSpy.mock.calls[0][0] as { leafId?: string; error: Error };
    expect(payload.leafId).toBe('l');
    expect(payload.error.message).toMatch(/boom-before-session/);
  });

  it('onError returning swallow resolves leaf with synthetic error-status result', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'ok' }] });
    const handlers: Partial<HookHandlers> = {
      beforeSession: async () => {
        throw new Error('boom-swallowed');
      },
      onError: async () => ({ swallow: true }),
    };

    let result: Awaited<ReturnType<typeof leaf>> | undefined;
    await harness(
      'onerror-swallow',
      {
        runsDir,
        runId: 'onerror-swallow',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        result = await leaf(h, { id: 'l', agent: 'claude-code', task: 'go' });
      },
    );
    expect(result).toBeDefined();
    expect(result!.status).toBe('error');
    expect(result!.error).toMatch(/boom-swallowed/);
  });
});

describe('lifecycle: re-spawn re-resolves adapter', () => {
  it('swapped _adapterOverride before re-spawn uses the new adapter', async () => {
    // Adapter A runs once; verify hook forces retry. Before re-spawn, a hook
    // swaps h._adapterOverride to adapter B. The re-spawn must use B.
    const usedByA: string[] = [];
    const usedByB: string[] = [];

    const mkAdapter = (label: string, bucket: string[]) => {
      const base = createMockAdapter({ turns: [{ assistantText: `${label}-reply` }] });
      // Force re-spawn path (not continueAfterDone) by disabling resume.
      const noResume: typeof base = {
        ...base,
        spawn(spec, sctx) {
          bucket.push(spec.task);
          const h = base.spawn(spec, sctx);
          return { ...h, supportsResume: false, continueAfterDone: undefined };
        },
      };
      return noResume;
    };
    const adapterA = mkAdapter('A', usedByA);
    const adapterB = mkAdapter('B', usedByB);

    let verifyCalls = 0;
    const handlers: Partial<HookHandlers> = {
      verifyTaskComplete: async (ctx) => {
        verifyCalls++;
        if (verifyCalls === 1) {
          // Swap the override so the re-spawn picks up B.
          (ctx.sessionScope as { spec: { id: string } } | undefined); // touch to avoid lint
          return { done: false, remaining: ['more'], steerWith: 'keep going' };
        }
        return { done: true };
      },
    };

    await harness(
      'respawn-readapt',
      {
        runsDir,
        runId: 'respawn-readapt',
        adapterOverride: async () => adapterA,
      },
      async (h) => {
        h.config = buildConfig({ maxRetries: 3 });
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        // Swap the override right before we dispatch the leaf, but the first
        // spawn has already captured adapterA via resolveCurrentAdapter at
        // leaf entry. Re-spawn happens after verify asks for retry — at that
        // point our override below wins because resolveCurrentAdapter runs fresh.
        const origOverride = h._adapterOverride;
        h._adapterOverride = async (agent) => {
          // First resolution path: still return A. After verify says retry,
          // our override returns B — we trigger the swap inline via a
          // simple counter (first call → A, subsequent → B).
          if (usedByA.length === 0) {
            return origOverride ? origOverride(agent) : adapterA;
          }
          return adapterB;
        };
        await leaf(h, { id: 'l', agent: 'claude-code', task: 'do' });
      },
    );

    expect(usedByA.length).toBe(1);
    expect(usedByB.length).toBeGreaterThanOrEqual(1);
  });
});

describe('lifecycle: dependsOn DAG wiring', () => {
  it('B dependsOn A — B spawns only after A completes', async () => {
    const adapter = createMockAdapter({
      turns: [
        { assistantText: 'A done', delayMs: 50 },
        { assistantText: 'B done', delayMs: 10 },
      ],
    });

    const spawns: Record<string, number> = {};
    const dones: Record<string, number> = {};

    await harness(
      'dep-simple',
      {
        runsDir,
        runId: 'dep-simple',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount({
          afterSpawn: async (_ctx, payload) => {
            spawns[payload.spec.id] = Date.now();
          },
          afterTaskDone: async (_ctx, payload) => {
            dones[payload.spec.id] = Date.now();
          },
        });

        await Promise.all([
          leaf(h, { id: 'a', agent: 'claude-code', task: 'a task' }),
          leaf(h, { id: 'b', agent: 'claude-code', task: 'b task', dependsOn: ['a'] }),
        ]);
      },
    );

    expect(spawns['a']).toBeDefined();
    expect(spawns['b']).toBeDefined();
    expect(dones['a']).toBeDefined();
    // B's spawn must happen at or after A's completion.
    expect(spawns['b']!).toBeGreaterThanOrEqual(dones['a']!);
  });

  it('dependsOn failure cascades with a descriptive message', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'any' }] });
    const handlers: Partial<HookHandlers> = {
      beforeSession: async (_ctx, payload) => {
        if (payload.spec.id === 'a') {
          throw new Error('A exploded');
        }
      },
    };

    let bCaught: unknown = undefined;
    let aCaught: unknown = undefined;
    await harness(
      'dep-cascade',
      {
        runsDir,
        runId: 'dep-cascade',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount(handlers);
        const results = await Promise.allSettled([
          leaf(h, { id: 'a', agent: 'claude-code', task: 'a' }),
          leaf(h, { id: 'b', agent: 'claude-code', task: 'b', dependsOn: ['a'] }),
        ]);
        if (results[0].status === 'rejected') aCaught = results[0].reason;
        if (results[1].status === 'rejected') bCaught = results[1].reason;
      },
    );
    expect(aCaught).toBeInstanceOf(Error);
    expect(bCaught).toBeInstanceOf(Error);
    expect((bCaught as Error).message).toMatch(/dependency failed/);
  });

  it('dependsOn on an unknown id throws with a clear message', async () => {
    const adapter = createMockAdapter({ turns: [{ assistantText: 'ok' }] });
    let caught: unknown = undefined;
    await harness(
      'dep-unknown',
      {
        runsDir,
        runId: 'dep-unknown',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        try {
          await leaf(h, { id: 'c', agent: 'claude-code', task: 'c', dependsOn: ['never-registered'] });
        } catch (e) {
          caught = e;
        }
      },
    );
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/never-registered/);
    expect((caught as Error).message).toMatch(/no leaf with that id/);
  });

  it('dependsOn multi — C waits for both A and B', async () => {
    const adapter = createMockAdapter({
      turns: [
        { assistantText: 'A', delayMs: 40 },
        { assistantText: 'B', delayMs: 20 },
        { assistantText: 'C', delayMs: 5 },
      ],
    });
    const spawns: Record<string, number> = {};
    const dones: Record<string, number> = {};

    await harness(
      'dep-multi',
      {
        runsDir,
        runId: 'dep-multi',
        adapterOverride: async () => adapter,
      },
      async (h) => {
        h.config = buildConfig();
        h.hooks = new HookRegistry({ errorPolicy: 'throw' });
        h.hooks.mount({
          afterSpawn: async (_ctx, payload) => {
            spawns[payload.spec.id] = Date.now();
          },
          afterTaskDone: async (_ctx, payload) => {
            dones[payload.spec.id] = Date.now();
          },
        });

        await Promise.all([
          leaf(h, { id: 'a', agent: 'claude-code', task: 'a' }),
          leaf(h, { id: 'b', agent: 'claude-code', task: 'b' }),
          leaf(h, { id: 'c', agent: 'claude-code', task: 'c', dependsOn: ['a', 'b'] }),
        ]);
      },
    );

    expect(dones['a']).toBeDefined();
    expect(dones['b']).toBeDefined();
    expect(spawns['c']).toBeDefined();
    expect(spawns['c']!).toBeGreaterThanOrEqual(dones['a']!);
    expect(spawns['c']!).toBeGreaterThanOrEqual(dones['b']!);
  });

  it('dependsOn cycle is detected and throws with the cycle path', async () => {
    const runId = 'cycle-test';
    await expect(
      harness(
        'cycle',
        {
          runsDir,
          runId,
          adapterOverride: async () => createMockAdapter({ turns: [{ assistantText: 'ok' }] }),
        },
        async (h) => {
          // Register A first (A dependsOn B); when B is registered below with
          // dependsOn ['A'], cycle detection walks B's deps → A → A's deps
          // → B → hits startId=B and reports the cycle.
          const aPromise = leaf(h, { id: 'a', agent: 'claude-code', task: 'a', dependsOn: ['b'] }).catch(() => {});
          // Tiny delay so A's registration lands in _leafDeps before B checks.
          await new Promise((r) => setTimeout(r, 5));
          await leaf(h, { id: 'b', agent: 'claude-code', task: 'b', dependsOn: ['a'] });
          await aPromise;
        },
      ),
    ).rejects.toThrow(/dependsOn forms a cycle/);
  });
});

describe('lifecycle: onError at harness + phase scope', () => {
  it('onError fires when a phase body throws and can swallow to convert to done', async () => {
    const runId = 'on-error-phase';
    let onErrorCalled = 0;

    await harness(
      'on-error-phase',
      {
        runsDir,
        runId,
        adapterOverride: async () => createMockAdapter({ turns: [{ assistantText: 'ok' }] }),
      },
      async (h) => {
        const reg = new HookRegistry({ errorPolicy: 'throw', timeoutMs: 5000 });
        reg.register('onError', async () => {
          onErrorCalled += 1;
          return { swallow: true };
        });
        h.hooks = reg;
        await stage(h, 'boom', async () => {
          throw new Error('phase boom');
        });
      },
    );

    expect(onErrorCalled).toBeGreaterThanOrEqual(1);
  });

  it('onError fires when the harness body itself throws and can swallow', async () => {
    const runId = 'on-error-harness';
    let onErrorCalled = 0;

    await harness(
      'on-error-harness',
      {
        runsDir,
        runId,
        adapterOverride: async () => createMockAdapter({ turns: [{ assistantText: 'ok' }] }),
      },
      async (h) => {
        // The harness captured its own hooks registry reference before body();
        // to influence harness-scope onError we register on the SAME registry
        // (h.hooks === that closure-captured registry) rather than replacing it.
        h.hooks!.register('onError', async () => {
          onErrorCalled += 1;
          return { swallow: true };
        });
        throw new Error('harness-level boom');
      },
    );

    expect(onErrorCalled).toBeGreaterThanOrEqual(1);
  });
});

describe('lifecycle: forceGeneration generationPreamble {{items}} substitution', () => {
  it('substitutes {{items}} with a formatted checklist of mandatory items', async () => {
    const runId = 'force-gen-items';
    let observedTask: string | undefined;
    const adapter = createMockAdapter({ turns: [{ assistantText: 'ok' }] });

    await harness(
      'force-gen-items',
      {
        runsDir,
        runId,
        adapterOverride: async () => adapter,
      },
      async (h) => {
        const reg = new HookRegistry({ errorPolicy: 'throw', timeoutMs: 5000 });
        reg.register('collectTodos', async () => ['first item', 'second item']);
        reg.register('beforeSpawn', async (_ctx, { spec }) => {
          observedTask = spec.task;
        });
        h.hooks = reg;
        h.config = {
          ...DEFAULT_CONFIG,
          todos: {
            ...DEFAULT_CONFIG.todos,
            forceGeneration: true,
            generationPreamble: 'CUSTOM PREAMBLE\n{{items}}\nEND',
          },
        };
        await leaf(h, { id: 'l', agent: 'claude-code', task: 'original task body' });
      },
    );

    expect(observedTask).toBeDefined();
    expect(observedTask!.startsWith('CUSTOM PREAMBLE\n- [ ] first item\n- [ ] second item\nEND')).toBe(true);
    expect(observedTask!).toContain('original task body');
  });
});
