/**
 * Wire-level tests for the runner's TUI callbacks.
 *
 * The runner builds two closures and hands them to mountTui:
 *
 *   onSteer:     (leafId, text) => activeHandles.get(leafId)?.steer(text)
 *   onAbortLeaf: (leafId)       => activeHandles.get(leafId)?.abort('user-abort')
 *
 * These tests reconstruct the exact closures in isolation (no Ink, no real
 * adapter) and prove they route to the handle in `activeHandles` — and silently
 * no-op when the leafId is unknown.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent, LeafResult } from '../core/types';
import { EventChannel } from '../adapters/index';
import type { AgentHandle } from '../adapters/index';

function makeFakeHandle(): AgentHandle & {
  steer: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  wait: ReturnType<typeof vi.fn>;
} {
  const ch = new EventChannel<AgentEvent>();
  const resolvedResult: LeafResult = {
    leafId: 'x',
    status: 'done',
    startedAt: 0,
    endedAt: 0,
  };
  return {
    events: ch,
    steer: vi.fn(async (_input: string) => {
      /* noop */
    }),
    abort: vi.fn(async (_reason?: string) => {
      /* noop */
    }),
    wait: vi.fn(async () => resolvedResult),
  };
}

describe('runner TUI-callback wire', () => {
  it('onSteer routes to activeHandles.get(leafId)?.steer(text)', async () => {
    const activeHandles = new Map<string, AgentHandle>();
    const h = makeFakeHandle();
    activeHandles.set('x', h);

    const onSteer = (leafId: string, text: string): void => {
      void activeHandles.get(leafId)?.steer(text);
    };

    onSteer('x', 'more info');

    // steer is async but called synchronously; await a microtask so any
    // promise-chained assertions still work.
    await Promise.resolve();

    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.steer).toHaveBeenCalledWith('more info');
  });

  it("onAbortLeaf routes to activeHandles.get(leafId)?.abort('user-abort')", async () => {
    const activeHandles = new Map<string, AgentHandle>();
    const h = makeFakeHandle();
    activeHandles.set('x', h);

    const onAbortLeaf = (leafId: string): void => {
      void activeHandles.get(leafId)?.abort('user-abort');
    };

    onAbortLeaf('x');
    await Promise.resolve();

    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.abort).toHaveBeenCalledWith('user-abort');
  });

  it('onSteer with unknown leafId is a silent no-op', async () => {
    const activeHandles = new Map<string, AgentHandle>();
    const h = makeFakeHandle();
    activeHandles.set('x', h);

    const onSteer = (leafId: string, text: string): void => {
      void activeHandles.get(leafId)?.steer(text);
    };

    expect(() => onSteer('nonexistent', 'foo')).not.toThrow();
    await Promise.resolve();
    expect(h.steer).not.toHaveBeenCalled();
  });

  it('onAbortLeaf with unknown leafId is a silent no-op', async () => {
    const activeHandles = new Map<string, AgentHandle>();
    const h = makeFakeHandle();
    activeHandles.set('x', h);

    const onAbortLeaf = (leafId: string): void => {
      void activeHandles.get(leafId)?.abort('user-abort');
    };

    expect(() => onAbortLeaf('nobody')).not.toThrow();
    await Promise.resolve();
    expect(h.abort).not.toHaveBeenCalled();
  });

  it('routes to the correct handle when multiple leaves are live', async () => {
    const activeHandles = new Map<string, AgentHandle>();
    const hA = makeFakeHandle();
    const hB = makeFakeHandle();
    activeHandles.set('a', hA);
    activeHandles.set('b', hB);

    const onSteer = (leafId: string, text: string): void => {
      void activeHandles.get(leafId)?.steer(text);
    };
    const onAbortLeaf = (leafId: string): void => {
      void activeHandles.get(leafId)?.abort('user-abort');
    };

    onSteer('a', 'for-a');
    onSteer('b', 'for-b');
    onAbortLeaf('b');
    await Promise.resolve();

    expect(hA.steer).toHaveBeenCalledWith('for-a');
    expect(hA.abort).not.toHaveBeenCalled();
    expect(hB.steer).toHaveBeenCalledWith('for-b');
    expect(hB.abort).toHaveBeenCalledWith('user-abort');
  });

  it('removing a handle from the map stops future routing', async () => {
    const activeHandles = new Map<string, AgentHandle>();
    const h = makeFakeHandle();
    activeHandles.set('x', h);

    const onSteer = (leafId: string, text: string): void => {
      void activeHandles.get(leafId)?.steer(text);
    };

    onSteer('x', 'first');
    activeHandles.delete('x');
    onSteer('x', 'second');
    await Promise.resolve();

    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.steer).toHaveBeenCalledWith('first');
  });
});
