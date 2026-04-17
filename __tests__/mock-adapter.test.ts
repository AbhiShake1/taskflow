import { describe, it, expect } from 'vitest';
import type { AgentEvent, LeafSpec } from '../core/types';
import { EventChannel, type SpawnCtx } from '../adapters/index';
import mockAdapter from '../adapters/mock';

const baseSpec: LeafSpec = {
  id: 'leaf-1',
  agent: 'claude-code',
  task: 'say hi',
};

const ctx: SpawnCtx = { runDir: '/tmp/run-test' };

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('mock adapter', () => {
  it('emits spawn, message, done in order and wait() resolves done', async () => {
    const handle = mockAdapter.spawn(baseSpec, ctx);
    const events = await collect(handle.events);
    const result = await handle.wait();

    expect(events.map(e => e.t)).toEqual(['spawn', 'message', 'done']);

    const msg = events[1] as Extract<AgentEvent, { t: 'message' }>;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('[mock reply to: say hi]');

    const doneEv = events[2] as Extract<AgentEvent, { t: 'done' }>;
    expect(doneEv.result.status).toBe('done');

    expect(result.status).toBe('done');
    expect(result.leafId).toBe('leaf-1');
    expect(result.exitCode).toBe(0);
  });

  it('abort() before completion resolves wait() with status aborted', async () => {
    const handle = mockAdapter.spawn(baseSpec, ctx);
    const eventsPromise = collect(handle.events);

    // Abort right away, before the 10ms timer fires
    await handle.abort('test');

    const events = await eventsPromise;
    const result = await handle.wait();

    expect(result.status).toBe('aborted');
    expect(result.exitCode).toBe(130);

    const last = events[events.length - 1] as Extract<AgentEvent, { t: 'done' }>;
    expect(last.t).toBe('done');
    expect(last.result.status).toBe('aborted');
    // message event should never have been emitted
    expect(events.some(e => e.t === 'message')).toBe(false);
  });

  it('steer() emits a steer event with the provided input', async () => {
    const handle = mockAdapter.spawn(baseSpec, ctx);
    await handle.steer('hi');
    const events = await collect(handle.events);
    await handle.wait();

    const steer = events.find(e => e.t === 'steer') as Extract<AgentEvent, { t: 'steer' }> | undefined;
    expect(steer).toBeDefined();
    expect(steer!.content).toBe('hi');
    expect(steer!.leafId).toBe('leaf-1');
  });
});

describe('EventChannel', () => {
  it('push after close is a no-op', async () => {
    const ch = new EventChannel<number>();
    ch.push(1);
    ch.close();
    ch.push(2);
    ch.push(3);

    const out: number[] = [];
    for await (const v of ch) out.push(v);

    expect(out).toEqual([1]);
  });

  it('drops oldest when buffer overflow exceeded', async () => {
    const ch = new EventChannel<number>({ maxBuffer: 3 });
    // Push maxBuffer + 1 items without consuming
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.push(4); // pushes 4 in, drops 1
    ch.close();

    const out: number[] = [];
    for await (const v of ch) out.push(v);

    // First item (1) should have been dropped
    expect(out).toEqual([2, 3, 4]);
    expect(out).not.toContain(1);
  });
});
