import { describe, it, expect } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../core/events';
import type { RunEvent } from '../core/types';

function mk(ts: number, leafId = 'l1'): RunEvent {
  return { t: 'spawn', leafId, agent: 'claude-code', ts };
}

describe('EventBus pub/sub', () => {
  it('delivers events to multiple subscribers in publish order', () => {
    const bus = new EventBus();
    const a: RunEvent[] = [];
    const b: RunEvent[] = [];
    bus.subscribe(ev => a.push(ev));
    bus.subscribe(ev => b.push(ev));

    const e1 = mk(1);
    const e2 = mk(2);
    const e3 = mk(3);
    bus.publish(e1);
    bus.publish(e2);
    bus.publish(e3);

    expect(a).toEqual([e1, e2, e3]);
    expect(b).toEqual([e1, e2, e3]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const got: RunEvent[] = [];
    const unsub = bus.subscribe(ev => got.push(ev));

    const e1 = mk(1);
    bus.publish(e1);
    unsub();
    bus.publish(mk(2));

    expect(got).toEqual([e1]);
  });

  it('isolates throwing subscribers so others still receive events', () => {
    const bus = new EventBus();
    const good: RunEvent[] = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe(ev => good.push(ev));

    const e1 = mk(1);
    const e2 = mk(2);
    bus.publish(e1);
    bus.publish(e2);

    expect(good).toEqual([e1, e2]);
  });
});

describe('EventBus publish resilience', () => {
  it('does not throw when event contains a non-serializable value', () => {
    const bus = new EventBus();
    const ev = { t: 'tool-res', leafId: 'l1', ts: 1, result: BigInt(1) } as unknown as RunEvent;
    expect(() => bus.publish(ev)).not.toThrow();
  });
});

describe('EventBus file sink', () => {
  it('writes one JSONL line per published event', async () => {
    const path = join(tmpdir(), `events-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const bus = new EventBus();
    await bus.attachFile(path);

    const e1 = mk(1, 'leafA');
    const e2: RunEvent = { t: 'done', leafId: 'leafA', ts: 5, result: {
      leafId: 'leafA',
      status: 'done',
      startedAt: 1,
      endedAt: 5,
    } };
    const e3: RunEvent = { t: 'stage-enter', stageId: 's1', ts: 10 };

    bus.publish(e1);
    bus.publish(e2);
    bus.publish(e3);

    await bus.close();

    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed[0]).toEqual(e1);
    expect(parsed[1]).toEqual(e2);
    expect(parsed[2]).toEqual(e3);

    await rm(path, { force: true });
  });
});
