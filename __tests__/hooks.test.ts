import { describe, it, expect, vi } from 'vitest';
import { createHookCtx, HookRegistry, noopLogger } from '../core/hooks';
import type { HookCtx, HookLogger, ResolvedConfig } from '../core/hooks';
import type { LeafResult, LeafSpec } from '../core/types';

function emptyConfig(): ResolvedConfig {
  return {
    todos: { autoExtract: true, maxRetries: 3 },
    hooks: { errorPolicy: 'swallow', timeoutMs: 30_000 },
    events: {},
    plugins: [],
  };
}

function makeCtx(opts: { logger?: HookLogger } = {}): HookCtx {
  return createHookCtx(
    { hookName: 'beforeHarness' },
    {
      scope: { harness: 't', runId: 'r', runDir: '/tmp/none' },
      bus: {} as HookCtx['bus'],
      config: emptyConfig(),
      logger: opts.logger ?? noopLogger,
      fs: {} as HookCtx['fs'],
      fetch: globalThis.fetch,
      todos: {} as HookCtx['todos'],
      proof: {} as HookCtx['proof'],
      plugins: {} as HookCtx['plugins'],
      state: new Map<string, unknown>(),
      emit: () => {},
      steer: async () => {},
      abort: async () => {},
    },
  );
}

const sampleSpec: LeafSpec = { id: 'l', agent: 'claude-code', task: 't' };
const sampleResult: LeafResult = {
  leafId: 'l',
  status: 'done',
  startedAt: 0,
  endedAt: 0,
};

describe('HookRegistry', () => {
  it('register + fire runs handlers in registration order, awaited', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    reg.register('beforePhase', async () => { order.push('a'); });
    reg.register('beforePhase', async () => {
      await new Promise(r => setTimeout(r, 5));
      order.push('b');
    });
    reg.register('beforePhase', async () => { order.push('c'); });

    await reg.fire('beforePhase', makeCtx(), { phaseId: 'p' });
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('mount registers from a partial handlers object', async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.mount({
      beforePhase: async (_ctx, p) => { seen.push(`bp:${p.phaseId}`); },
      afterPhase:  async (_ctx, p) => { seen.push(`ap:${p.phaseId}:${p.status}`); },
    });
    await reg.fire('beforePhase', makeCtx(), { phaseId: 'x' });
    await reg.fire('afterPhase',  makeCtx(), { phaseId: 'x', status: 'done' });
    expect(seen).toEqual(['bp:x', 'ap:x:done']);
  });

  it('before* mutation merge: later handler wins on scalars; drop propagates', async () => {
    const reg = new HookRegistry();

    reg.register('beforeSession', async () => ({ spec: { ...sampleSpec, task: 'first' } }));
    reg.register('beforeSession', async () => ({ spec: { ...sampleSpec, task: 'second' } }));
    const sessionRet = await reg.fire('beforeSession', makeCtx(), { spec: sampleSpec });
    expect(sessionRet).toBeDefined();
    expect((sessionRet as { spec: LeafSpec }).spec.task).toBe('second');

    const reg2 = new HookRegistry();
    reg2.register('beforeMessage', async () => ({ content: 'rewritten' }));
    reg2.register('beforeMessage', async () => ({ drop: true }));
    const msgRet = await reg2.fire('beforeMessage', makeCtx(), {
      ev: { t: 'message', leafId: 'l', role: 'assistant', content: 'orig', ts: 0 },
    });
    expect(msgRet).toEqual({ content: 'rewritten', drop: true });
  });

  it('before* mutation merge: array-valued keys are concatenated across handlers', async () => {
    const reg = new HookRegistry();
    reg.register('beforeToolCall', async () => ({ args: ['a', 'b'] }));
    reg.register('beforeToolCall', async () => ({ args: ['c'] }));
    const ret = await reg.fire('beforeToolCall', makeCtx(), {
      ev: { t: 'tool', leafId: 'l', name: 'bash', args: {}, ts: 0 },
    });
    expect((ret as { args: string[] }).args).toEqual(['a', 'b', 'c']);
  });

  it('error policy "swallow": throwing handler does not break the chain', async () => {
    const reg = new HookRegistry({ errorPolicy: 'swallow' });
    const order: string[] = [];
    reg.register('beforePhase', async () => { order.push('a'); });
    reg.register('beforePhase', async () => { throw new Error('boom'); });
    reg.register('beforePhase', async () => { order.push('c'); });

    await expect(
      reg.fire('beforePhase', makeCtx(), { phaseId: 'p' }),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['a', 'c']);
  });

  it('error policy "warn": same as swallow plus a console.warn', async () => {
    const warn = vi.fn();
    const ctx = makeCtx({
      logger: { debug() {}, info() {}, warn, error() {} },
    });
    const reg = new HookRegistry({ errorPolicy: 'warn' });
    const order: string[] = [];
    reg.register('beforePhase', async () => { order.push('a'); });
    reg.register('beforePhase', async () => { throw new Error('boom'); });
    reg.register('beforePhase', async () => { order.push('c'); });

    await reg.fire('beforePhase', ctx, { phaseId: 'p' });
    expect(order).toEqual(['a', 'c']);
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toMatch(/beforePhase/);
    expect(msg).toMatch(/threw/);
  });

  it('error policy "throw": fire rejects', async () => {
    const reg = new HookRegistry({ errorPolicy: 'throw' });
    reg.register('beforePhase', async () => { throw new Error('boom'); });
    await expect(
      reg.fire('beforePhase', makeCtx(), { phaseId: 'p' }),
    ).rejects.toThrow(/boom/);
  });

  it('timeout: long handler is skipped, warning logged, later handlers still run', async () => {
    const warn = vi.fn();
    const ctx = makeCtx({
      logger: { debug() {}, info() {}, warn, error() {} },
    });
    const reg = new HookRegistry({ timeoutMs: 20 });
    const order: string[] = [];

    reg.register('beforePhase', async () => { order.push('a'); });
    reg.register('beforePhase', async () => {
      await new Promise(r => setTimeout(r, 200));
      order.push('hung');
    });
    reg.register('beforePhase', async () => { order.push('c'); });

    await reg.fire('beforePhase', ctx, { phaseId: 'p' });

    expect(order).toEqual(['a', 'c']);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/exceeded 20ms/);
  });

  it('verifyTaskComplete: any {done:false} wins; all {done:true} returns done; none → undefined', async () => {
    const draftResult = sampleResult;

    const regNotDone = new HookRegistry();
    regNotDone.register('verifyTaskComplete', async () => ({ done: true } as const));
    regNotDone.register('verifyTaskComplete', async () => ({
      done: false,
      remaining: ['todo-1'],
    } as const));
    regNotDone.register('verifyTaskComplete', async () => ({ done: true } as const));
    const r1 = await regNotDone.fire('verifyTaskComplete', makeCtx(), {
      spec: sampleSpec, draftResult, attempt: 0, todos: [],
    });
    expect(r1).toEqual({ done: false, remaining: ['todo-1'] });

    const regAllDone = new HookRegistry();
    regAllDone.register('verifyTaskComplete', async () => ({ done: true } as const));
    regAllDone.register('verifyTaskComplete', async () => ({ done: true } as const));
    const r2 = await regAllDone.fire('verifyTaskComplete', makeCtx(), {
      spec: sampleSpec, draftResult, attempt: 0, todos: [],
    });
    expect(r2).toEqual({ done: true });

    const regNone = new HookRegistry();
    const r3 = await regNone.fire('verifyTaskComplete', makeCtx(), {
      spec: sampleSpec, draftResult, attempt: 0, todos: [],
    });
    expect(r3).toBeUndefined();
  });

  it('collectTodos: accumulates items from both string[] and { items } return shapes', async () => {
    const reg = new HookRegistry();
    reg.register('collectTodos', async () => ['a', 'b']);
    reg.register('collectTodos', async () => ({ items: ['c', 'd'] }));
    const result = await reg.fire('collectTodos', makeCtx(), { spec: sampleSpec });
    expect(result).toEqual(['a', 'b', 'c', 'd']);
  });

  it('has(name): true after register, false otherwise', () => {
    const reg = new HookRegistry();
    expect(reg.has('beforePhase')).toBe(false);
    reg.register('beforePhase', async () => {});
    expect(reg.has('beforePhase')).toBe(true);
    expect(reg.has('afterPhase')).toBe(false);
  });
});
