// End-to-end integration test for the layered config + plugin system.
//
// This test scaffolds a real on-disk hierarchy of `.agents/taskflow/config.ts`
// files at three levels (home / intermediate / cwd), invokes the real
// `loadConfig()` walker, threads the resulting layers + plugins into the
// harness via the runner-context plumbing (the same path the CLI runner uses),
// then runs a single mock leaf and asserts that:
//   - all three event layers were discovered, in walk order
//   - todos.maxRetries is the value from the deepest config that set it
//   - scope from the most-specific config wins
//   - both an outer (A) and inner (C) afterSession handler fire (composition,
//     not replacement)
//   - plugin events fire (alpha.afterTaskDone, beta.beforeSession)
//   - plugin ctx namespaces are reachable from inside hook handlers
//   - the scope preamble is prepended to spec.task before the adapter sees it
//   - verifyTaskComplete from the intermediate layer is consulted by the engine
//
// Style mirrors __tests__/lifecycle.test.ts — runner injection via
// `setRunner()`, EventBus owned by the test, and a fresh tmp tree per case.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { harness, leaf } from '../core/index';
import { EventBus } from '../core/events';
import { setRunner } from '../runner/context';
import { clearConfigCache, loadConfig } from '../core/config';
import { createMockAdapter } from '../adapters/mock';

const CONFIG_TS_ABS = resolve(__dirname, '..', 'core', 'config.ts');
const CONFIG_IMPORT_URL = pathToFileURL(CONFIG_TS_ABS).href;

// Shared globals the fixture configs poke from inside hooks. We declare them
// here so the test body can read them back without `any`-laundering everywhere.
type Markers = {
  __a_afterSession?: boolean;
  __c_afterSession?: { scope?: string; gammaPing?: string; alphaPing?: string };
  __alphaAfterTaskDone?: { alphaPing?: string };
  __alphaAfterHarness?: { aPing?: string };
  __cAfterHarness?: { gammaPing?: string; alphaPing?: string };
  __betaBeforeSession?: { specId?: string; gammaPing?: string };
  __b_verifyCalled?: number;
  __observedTask?: string;
};

function getMarkers(): Markers {
  return globalThis as unknown as Markers;
}

function resetMarkers(): void {
  const g = getMarkers();
  delete g.__a_afterSession;
  delete g.__c_afterSession;
  delete g.__alphaAfterTaskDone;
  delete g.__alphaAfterHarness;
  delete g.__cAfterHarness;
  delete g.__betaBeforeSession;
  delete g.__b_verifyCalled;
  delete g.__observedTask;
}

// Each fixture writes a real .ts file the jiti-backed loader can import. We
// intentionally skip `defineConfig` (it's identity) so we don't have to
// resolve the package import inside the temp tree.
const CONFIG_A_BODY = `
// Plugin name is 'alpha' so applyPluginCtx exposes its ctx() output at
// HookCtx.plugins.alpha (the namespace key is the plugin's name).
//
// We register two events to prove plugin namespaces are populated on BOTH
// per-session hook ctxs (afterTaskDone) and harness-scope ones (afterHarness).
const pluginAlpha = () => ({
  name: 'alpha',
  events: {
    afterTaskDone: async (ctx) => {
      const ns = (ctx.plugins ?? {});
      const alphaPing = typeof ns.alpha?.ping === 'function' ? ns.alpha.ping() : undefined;
      globalThis.__alphaAfterTaskDone = { alphaPing };
    },
    afterHarness: async (ctx) => {
      const ns = (ctx.plugins ?? {});
      const aPing = typeof ns.alpha?.ping === 'function' ? ns.alpha.ping() : undefined;
      globalThis.__alphaAfterHarness = { aPing };
    },
  },
  ctx: () => ({ ping: () => 'A' }),
});

export default {
  events: {
    afterSession: async () => {
      globalThis.__a_afterSession = true;
    },
  },
  todos: { maxRetries: 7 },
  plugins: [pluginAlpha],
};
`;

const CONFIG_B_BODY = `
const pluginBeta = () => ({
  name: 'beta',
  events: {
    beforeSession: async (ctx, payload) => {
      const ns = (ctx.plugins ?? {});
      const gammaPing = typeof ns.gamma?.ping === 'function' ? ns.gamma.ping() : undefined;
      globalThis.__betaBeforeSession = { specId: payload.spec.id, gammaPing };
    },
  },
});

export default {
  todos: { maxRetries: 5 },
  events: {
    verifyTaskComplete: async () => {
      globalThis.__b_verifyCalled = (globalThis.__b_verifyCalled ?? 0) + 1;
      return { done: true };
    },
    beforeSpawn: async (_ctx, payload) => {
      globalThis.__observedTask = payload.spec.task;
    },
  },
  plugins: [pluginBeta],
};
`;

const CONFIG_C_BODY = `
const pluginGamma = () => ({
  name: 'gamma',
  ctx: () => ({ ping: () => 'C' }),
});

export default {
  scope: 'No new files.',
  events: {
    afterSession: async (ctx) => {
      // Per-session hook ctxs now get plugin namespaces (engine applies plugin
      // ctx builders inside buildHookCtx, not just the harness-scoped path).
      // We assert both ctx.plugins.alpha.ping() and ctx.plugins.gamma.ping()
      // are reachable from this per-session afterSession handler.
      const ns = (ctx.plugins ?? {});
      const alphaPing = typeof ns.alpha?.ping === 'function' ? ns.alpha.ping() : undefined;
      const gammaPing = typeof ns.gamma?.ping === 'function' ? ns.gamma.ping() : undefined;
      globalThis.__c_afterSession = { scope: ctx.config?.scope, alphaPing, gammaPing };
    },
    afterHarness: async (ctx) => {
      const ns = (ctx.plugins ?? {});
      const alphaPing = typeof ns.alpha?.ping === 'function' ? ns.alpha.ping() : undefined;
      const gammaPing = typeof ns.gamma?.ping === 'function' ? ns.gamma.ping() : undefined;
      globalThis.__cAfterHarness = { alphaPing, gammaPing };
    },
  },
  plugins: [pluginGamma],
};
`;

async function writeConfigAt(dir: string, body: string): Promise<string> {
  const cfgDir = join(dir, '.agents', 'taskflow');
  await mkdir(cfgDir, { recursive: true });
  const file = join(cfgDir, 'config.ts');
  await writeFile(file, body, 'utf8');
  return file;
}

let tmpRoot: string;
let home: string;
let cwd: string;

beforeEach(async () => {
  resetMarkers();
  clearConfigCache();
  tmpRoot = await mkdtemp(join(tmpdir(), `tf-int-layered-${randomUUID()}-`));
  home = join(tmpRoot, 'home');
  cwd = join(home, 'proj', 'sub');
  await mkdir(cwd, { recursive: true });
  await writeConfigAt(home, CONFIG_A_BODY);
  await writeConfigAt(join(home, 'proj'), CONFIG_B_BODY);
  await writeConfigAt(cwd, CONFIG_C_BODY);
});

afterEach(async () => {
  setRunner(undefined);
  resetMarkers();
  clearConfigCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('integration: layered config + plugins end-to-end', () => {
  it('discovers all three layers and applies their merged behavior under the harness', async () => {
    // -----------------------------------------------------------------------
    // 1) Real loadConfig walk over the on-disk fixture tree.
    // -----------------------------------------------------------------------
    const loaded = await loadConfig({ home, cwd });

    expect(loaded.sources).toHaveLength(3);
    expect(loaded.sources[0]).toBe(join(home, '.agents', 'taskflow', 'config.ts'));
    expect(loaded.sources[1]).toBe(join(home, 'proj', '.agents', 'taskflow', 'config.ts'));
    expect(loaded.sources[2]).toBe(join(cwd, '.agents', 'taskflow', 'config.ts'));

    // (a) eventLayers preserved in walk order — A, B, C.
    expect(loaded.eventLayers).toHaveLength(3);
    expect(loaded.eventLayers[0].afterSession).toBeTypeOf('function');           // A
    expect(loaded.eventLayers[1].verifyTaskComplete).toBeTypeOf('function');     // B
    expect(loaded.eventLayers[1].beforeSpawn).toBeTypeOf('function');            // B
    expect(loaded.eventLayers[2].afterSession).toBeTypeOf('function');           // C

    // (b) maxRetries: B set 5; C did not touch it. defu rules: deeper layers
    //     override shallower scalars, so 5 wins over A's 7.
    expect(loaded.resolved.todos.maxRetries).toBe(5);
    expect(loaded.resolved.todos.autoExtract).toBe(true); // default preserved

    // (c) scope from the most-specific (C) layer.
    expect(loaded.resolved.scope).toBe('No new files.');

    // Sanity: 3 plugins discovered across the layers.
    expect(loaded.plugins).toHaveLength(3);

    // -----------------------------------------------------------------------
    // 2) Run the harness with the loaded config injected via the runner.
    //    This is the same wiring the CLI runner uses; harness() picks up
    //    runner.eventLayers + runner.plugins + runner.config and mounts
    //    them BEFORE its own beforeHarness fires.
    // -----------------------------------------------------------------------
    const runsDir = join(tmpRoot, 'runs');
    const runId = 'integration-layered';
    const runDir = join(runsDir, runId);
    await mkdir(runDir, { recursive: true });

    const bus = new EventBus();
    await bus.attachFile(join(runDir, 'events.jsonl'));

    const adapter = createMockAdapter({
      turns: [{ assistantText: 'mock done' }],
    });

    setRunner({
      bus,
      runsDir,
      runId,
      activeHandles: new Map(),
      cwd,
      config: loaded.resolved,
      eventLayers: loaded.eventLayers,
      plugins: loaded.plugins,
    });

    try {
      await harness(
        'integration-layered',
        {
          runsDir,
          runId,
          adapterOverride: async () => adapter,
        },
        async (h) => {
          await leaf(h, {
            id: 'l',
            agent: 'claude-code',
            task: 'do x\n\n- [ ] step a',
          });
        },
      );
    } finally {
      await bus.close();
      setRunner(undefined);
    }

    const m = getMarkers();

    // (d) BOTH afterSession handlers fired (A's and C's). The runner pipes
    //     both layers in via eventLayers; HookRegistry.register appends to
    //     the per-name list so both handlers run.
    expect(m.__a_afterSession).toBe(true);
    expect(m.__c_afterSession).toBeDefined();
    expect(m.__c_afterSession?.scope).toBe('No new files.');
    // Per-session plugin ctx population: ctx.plugins.alpha and ctx.plugins.gamma
    // are reachable from C's per-session afterSession handler.
    expect(m.__c_afterSession?.alphaPing).toBe('A');
    expect(m.__c_afterSession?.gammaPing).toBe('C');

    // (e) pluginAlpha.afterTaskDone fired during the leaf's verify-loop tail
    //     and saw ctx.plugins.alpha populated (per-session ctx).
    expect(m.__alphaAfterTaskDone).toBeDefined();
    expect(m.__alphaAfterTaskDone?.alphaPing).toBe('A');

    // (f) pluginBeta.beforeSession fired with the spec id and saw
    //     ctx.plugins.gamma populated (cross-plugin namespace visibility).
    expect(m.__betaBeforeSession).toBeDefined();
    expect(m.__betaBeforeSession?.specId).toBe('l');
    expect(m.__betaBeforeSession?.gammaPing).toBe('C');

    // (g) ctx.plugins.alpha.ping() returned 'A' from inside alpha's
    //     afterHarness — confirms harness-scope ctx still gets namespaces.
    expect(m.__alphaAfterHarness).toBeDefined();
    expect(m.__alphaAfterHarness?.aPing).toBe('A');

    // (h) ctx.plugins.gamma.ping() returned 'C' from inside C's afterHarness;
    //     and alpha's ns is also reachable there (single shared namespace
    //     object across all harness-scoped fires).
    expect(m.__cAfterHarness).toBeDefined();
    expect(m.__cAfterHarness?.gammaPing).toBe('C');
    expect(m.__cAfterHarness?.alphaPing).toBe('A');

    // (i) The mock adapter saw the spec.task with the scope preamble. We
    //     observe via B's beforeSpawn hook which captures payload.spec.task
    //     AFTER the engine prepended "Scope and constraints:..." to it.
    expect(m.__observedTask).toBeDefined();
    expect(m.__observedTask!.startsWith(
      'Scope and constraints:\nNo new files.\n\n---\n\n',
    )).toBe(true);
    expect(m.__observedTask!).toContain('do x');
    expect(m.__observedTask!).toContain('- [ ] step a');

    // (j) verifyTaskComplete from B was consulted at least once. The mock
    //     reports done on the first turn; verify says {done:true}, so the
    //     engine doesn't re-arm — exactly one call expected.
    expect(m.__b_verifyCalled).toBeGreaterThanOrEqual(1);
  });
});
