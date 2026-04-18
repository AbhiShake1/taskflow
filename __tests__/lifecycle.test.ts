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
