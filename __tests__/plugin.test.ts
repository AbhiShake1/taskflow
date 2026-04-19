import { describe, it, expect } from 'vitest';
import { applyPluginCtx, composePlugins, type Plugin, type PluginInitApi } from '../core/plugin';
import { createHookCtx, noopLogger } from '../core/hooks';
import type { HookCtx, ResolvedConfig } from '../core/hooks';

function emptyConfig(): ResolvedConfig {
  return {
    todos: { autoExtract: true, maxRetries: 3 },
    hooks: { errorPolicy: 'swallow', timeoutMs: 30_000 },
    events: {},
    plugins: [],
  };
}

function api(): PluginInitApi {
  return { config: emptyConfig() };
}

function makeCtx(): HookCtx {
  return createHookCtx(
    { hookName: 'beforeHarness' },
    {
      scope: { harness: 't', runId: 'r', runDir: '/tmp/none' },
      bus: {} as HookCtx['bus'],
      config: emptyConfig(),
      logger: noopLogger,
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

describe('composePlugins', () => {
  it('compose plugins in declared order; event handlers concatenated', async () => {
    const order: string[] = [];

    const pluginA: Plugin = () => ({
      name: 'a',
      events: {
        beforePhase: async () => { order.push('a:before'); },
        afterPhase:  async () => { order.push('a:after'); },
      },
    });
    const pluginB: Plugin = () => ({
      name: 'b',
      events: {
        beforePhase: async () => { order.push('b:before'); },
      },
    });

    const composed = await composePlugins([pluginA, pluginB], api());
    expect(composed.names).toEqual(['a', 'b']);
    expect(composed.events.beforePhase).toBeDefined();
    expect(composed.events.afterPhase).toBeDefined();

    await composed.events.beforePhase!(makeCtx(), { phaseId: 'p' });
    await composed.events.afterPhase!(makeCtx(), { phaseId: 'p', status: 'done' });
    expect(order).toEqual(['a:before', 'b:before', 'a:after']);
  });

  it('applyPluginCtx populates ctx.plugins[name] for each plugin namespace', async () => {
    const pluginA: Plugin = () => ({
      name: 'alpha',
      ctx: () => ({ greet: 'hello' }),
    });
    const pluginB: Plugin = () => ({
      name: 'beta',
      ctx: (c) => ({ runId: c.scope.runId, count: 7 }),
    });

    const composed = await composePlugins([pluginA, pluginB], api());
    const ctx = makeCtx();
    applyPluginCtx(ctx, composed.ctxBuilders);

    const ns = ctx.plugins as unknown as Record<string, unknown>;
    expect(ns.alpha).toEqual({ greet: 'hello' });
    expect(ns.beta).toEqual({ runId: 'r', count: 7 });
  });

  it('throws on duplicate plugin name', async () => {
    const dup: Plugin = () => ({ name: 'same' });
    await expect(composePlugins([dup, dup], api())).rejects.toThrow(/duplicate plugin name "same"/);
  });

  it('chainHandlers returns the last non-undefined result; undefined returns do not overwrite', async () => {
    const pluginA: Plugin = () => ({
      name: 'a',
      events: {
        onError: async () => ({ swallow: true }),
      },
    });
    const pluginB: Plugin = () => ({
      name: 'b',
      events: {
        onError: async () => undefined,
      },
    });

    const composed = await composePlugins([pluginA, pluginB], api());
    const result = await composed.events.onError!(makeCtx(), { error: new Error('boom') });
    expect(result).toEqual({ swallow: true });
  });

  it('config fragments are collected in declaration order', async () => {
    const a: Plugin = () => ({
      name: 'a',
      config: { todos: { autoExtract: false, maxRetries: 5 } },
    });
    const b: Plugin = () => ({
      name: 'b',
      config: { hooks: { errorPolicy: 'throw', timeoutMs: 100 } },
    });
    const c: Plugin = () => ({ name: 'c' });

    const composed = await composePlugins([a, b, c], api());
    expect(composed.configFragments).toHaveLength(2);
    expect(composed.configFragments[0]).toEqual({
      todos: { autoExtract: false, maxRetries: 5 },
    });
    expect(composed.configFragments[1]).toEqual({
      hooks: { errorPolicy: 'throw', timeoutMs: 100 },
    });
  });
});
