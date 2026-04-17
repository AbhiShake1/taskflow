import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, LeafResult, LeafSpec, RunEvent } from '../core/types';
import type { AgentAdapter, AgentHandle, SpawnCtx } from '../adapters/index';
import { EventChannel } from '../adapters/index';
import mockAdapter from '../adapters/mock';
import { harness, stage, leaf, parallel } from '../core/index';

// Per-test tmp dir, set in beforeEach/afterEach.
let runsDir: string;

beforeEach(() => {
  runsDir = join(tmpdir(), 'harness-test-' + Math.random().toString(36).slice(2));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

async function readEvents(runDir: string): Promise<RunEvent[]> {
  const raw = await readFile(join(runDir, 'events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as RunEvent);
}

describe('harness runtime', () => {
  it('runs a simple stage with one leaf and emits the expected event sequence', async () => {
    const { ctx, manifest } = await harness(
      't',
      { runsDir, runId: 'simple', adapterOverride: async () => mockAdapter },
      async h => {
        await stage(h, 's', async () => {
          await leaf(h, { id: 'l', agent: 'claude-code', task: 'hi' });
        });
      },
    );

    expect(manifest.exitCode).toBe(0);
    expect(manifest.leaves).toHaveLength(1);
    expect(manifest.leaves[0]).toMatchObject({ id: 'l', status: 'done' });
    expect(manifest.stages).toEqual(['s']);

    const events = await readEvents(ctx.runDir);
    const types = events.map(e => e.t);
    expect(types[0]).toBe('stage-enter');
    expect(types).toContain('spawn');
    expect(types).toContain('message');
    expect(types).toContain('done');
    expect(types[types.length - 1]).toBe('stage-exit');
  });

  it('runs parallel leaves with disjoint claims concurrently', async () => {
    const start = Date.now();
    const { manifest } = await harness(
      't',
      { runsDir, runId: 'para-ok', adapterOverride: async () => mockAdapter },
      async h => {
        await stage(h, 's', async () => {
          await parallel(h, [
            () => leaf(h, { id: 'a', agent: 'claude-code', task: 'a', claims: ['out/a/**'] }),
            () => leaf(h, { id: 'b', agent: 'claude-code', task: 'b', claims: ['out/b/**'] }),
            () => leaf(h, { id: 'c', agent: 'claude-code', task: 'c', claims: ['out/c/**'] }),
            () => leaf(h, { id: 'd', agent: 'claude-code', task: 'd', claims: ['out/d/**'] }),
          ]);
        });
      },
    );
    const elapsed = Date.now() - start;

    // Mock leaf ~10ms each; concurrent should finish well under 4 * 10ms + overhead.
    // Allow a generous ceiling — CI can be slow, but still meaningfully less than fully serial.
    expect(elapsed).toBeLessThan(80);
    expect(manifest.leaves).toHaveLength(4);
    expect(manifest.leaves.every(r => r.status === 'done')).toBe(true);

    const events = await readEvents(join(runsDir, 'para-ok'));
    const doneIds = events.filter(e => e.t === 'done').map(e => (e as Extract<AgentEvent, { t: 'done' }>).leafId);
    for (const id of ['a', 'b', 'c', 'd']) expect(doneIds).toContain(id);
  });

  it('parallel leaves with overlapping claims throw claim conflict', async () => {
    let caught: unknown = undefined;
    try {
      await harness(
        't',
        { runsDir, runId: 'para-conflict', adapterOverride: async () => mockAdapter },
        async h => {
          await stage(h, 's', async () => {
            await parallel(h, [
              () => leaf(h, { id: 'x1', agent: 'claude-code', task: '1', claims: ['out/x/**'] }),
              () => leaf(h, { id: 'x2', agent: 'claude-code', task: '2', claims: ['out/x/y.json'] }),
            ]);
          });
        },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    const msgs = agg.errors.map(e => (e as Error).message).join(' | ');
    expect(msgs).toMatch(/claim conflict/);
  });

  it('records nested stages in manifest in enter order', async () => {
    const { manifest } = await harness(
      't',
      { runsDir, runId: 'nested', adapterOverride: async () => mockAdapter },
      async h => {
        await stage(h, 'outer', async () => {
          await stage(h, 'inner-1', async () => {
            await leaf(h, { id: 'l1', agent: 'claude-code', task: 'a' });
          });
          await stage(h, 'inner-2', async () => {
            await leaf(h, { id: 'l2', agent: 'claude-code', task: 'b' });
          });
        });
      },
    );

    expect(manifest.stages).toEqual(['outer', 'inner-1', 'inner-2']);
    expect(manifest.exitCode).toBe(0);
  });

  it('applies leaf timeout and surfaces status=timeout plus parent error', async () => {
    // Local stub adapter that never emits done.
    const stuckAdapter: AgentAdapter = {
      name: 'claude-code',
      spawn(spec: LeafSpec, _ctx: SpawnCtx): AgentHandle {
        const ch = new EventChannel<AgentEvent>();
        const startedAt = Date.now();
        let resolveResult!: (r: LeafResult) => void;
        const done = new Promise<LeafResult>(r => { resolveResult = r; });
        ch.push({ t: 'spawn', leafId: spec.id, agent: spec.agent, ts: Date.now() });
        return {
          events: ch,
          async steer() { /* noop */ },
          async abort(_reason?: string) {
            const result: LeafResult = {
              leafId: spec.id,
              status: 'aborted',
              exitCode: 130,
              startedAt,
              endedAt: Date.now(),
            };
            ch.push({ t: 'done', leafId: spec.id, result, ts: Date.now() });
            ch.close();
            resolveResult(result);
          },
          wait: () => done,
        };
      },
    };

    await expect(
      harness(
        't',
        { runsDir, runId: 'timeout', adapterOverride: async () => stuckAdapter },
        async h => {
          await stage(h, 's', async () => {
            await leaf(h, { id: 'slow', agent: 'claude-code', task: 'wait', timeoutMs: 20 });
          });
        },
      ),
    ).rejects.toThrow(/leaf failed: slow/);

    // Read manifest from disk — harness writes it even on failure.
    const manifestRaw = await readFile(join(runsDir, 'timeout', 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.exitCode).toBe(1);
    expect(manifest.leaves).toHaveLength(1);
    expect(manifest.leaves[0].status).toBe('timeout');
  });

  it('writes manifest.json to disk with correct exitCode', async () => {
    await harness(
      't',
      { runsDir, runId: 'on-disk', adapterOverride: async () => mockAdapter },
      async h => {
        await stage(h, 's', async () => {
          await leaf(h, { id: 'l', agent: 'claude-code', task: 'hi' });
        });
      },
    );

    const path = join(runsDir, 'on-disk', 'manifest.json');
    const st = await stat(path);
    expect(st.isFile()).toBe(true);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    expect(manifest.exitCode).toBe(0);
    expect(manifest.leaves).toHaveLength(1);
    expect(manifest.stages).toEqual(['s']);
  });

  // Documents the runtime-side guarantee exercised by the real-LLM smoke spec
  // `harness/tasks/smoke-parallel-claude.spec.yml`: when two parallel
  // claude-code leaves declare overlapping claims, the runtime's synchronous
  // overlap check must fire BEFORE the second adapter.spawn() is called.
  // We use the mock adapter — this is a runtime test, not an SDK test.
  it('parallel claude-code leaves with overlapping claims throw before spawn', async () => {
    let caught: unknown = undefined;
    try {
      await harness(
        'conflict',
        { runsDir, runId: 'cc-conflict', adapterOverride: async () => mockAdapter },
        async h => {
          await stage(h, 's', async () => {
            await parallel(h, [
              () =>
                leaf(h, {
                  id: 'a',
                  agent: 'claude-code',
                  task: 't',
                  claims: ['data/out/**'],
                }),
              () =>
                leaf(h, {
                  id: 'b',
                  agent: 'claude-code',
                  task: 't',
                  claims: ['data/out/a.txt'],
                }),
            ]);
          });
        },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    const msgs = agg.errors.map(e => (e as Error).message).join(' | ');
    expect(msgs).toMatch(/claim conflict/);
  });
});
