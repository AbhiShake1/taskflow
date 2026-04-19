import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { RunEvent } from '../core/types';
import { EventBus } from '../core/events';
import { createTuiStore } from '../tui/store';
import { TreeView } from '../tui/TreeView';
import { DetailView } from '../tui/DetailView';
import { __App as App, streamHeadless } from '../tui/index';

function seed(): ReturnType<typeof createTuiStore> {
  const store = createTuiStore();
  const evs: RunEvent[] = [
    { t: 'stage-enter', stageId: 'scrape-don', ts: 1000 },
    { t: 'stage-enter', stageId: 'discover', parentId: 'scrape-don', ts: 1010 },
    {
      t: 'spawn',
      leafId: 'a',
      agent: 'claude-code',
      model: 'sonnet',
      ts: 1020,
    },
    {
      t: 'done',
      leafId: 'a',
      ts: 1100,
      result: {
        leafId: 'a',
        status: 'done',
        startedAt: 1020,
        endedAt: 1100,
      },
    },
    { t: 'stage-exit', stageId: 'discover', status: 'done', ts: 1110 },
    { t: 'stage-exit', stageId: 'scrape-don', status: 'done', ts: 1120 },
  ];
  for (const ev of evs) store.getState().ingest(ev);
  return store;
}

describe('store.ingest sequence', () => {
  it('builds the expected nested tree with statuses + progress', () => {
    const store = seed();
    const s = store.getState();

    // Root stage.
    expect(s.rootIds).toEqual(['scrape-don']);
    const scrape = s.nodes['scrape-don'];
    expect(scrape.kind).toBe('stage');
    expect(scrape.status).toBe('done');
    expect(scrape.children).toEqual(['discover']);

    // Nested stage.
    const discover = s.nodes['discover'];
    expect(discover.kind).toBe('stage');
    expect(discover.status).toBe('done');
    expect(discover.parentId).toBe('scrape-don');
    expect(discover.children).toEqual(['a']);
    expect(discover.childProgress).toEqual({ done: 1, total: 1 });

    // Leaf.
    const leafA = s.nodes['a'];
    expect(leafA.kind).toBe('leaf');
    expect(leafA.status).toBe('done');
    expect(leafA.agent).toBe('claude-code');
    expect(leafA.model).toBe('sonnet');
    expect(leafA.parentId).toBe('discover');

    // Stage stack should be drained.
    expect(s._stageStack).toEqual([]);

    // Flat tree preorder.
    const flat = s.getFlatTree().map(n => n.id);
    expect(flat).toEqual(['scrape-don', 'discover', 'a']);
  });
});

describe('TreeView snapshot', () => {
  it('renders root stage, leaf, glyphs, and hint row', () => {
    const store = seed();
    const { lastFrame } = render(<TreeView state={store.getState()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('scrape-don');
    expect(frame).toContain('discover');
    expect(frame).toContain('a');
    expect(frame).toContain('✓');
    expect(frame).toContain('nav');
    expect(frame).toContain('drill-in');
  });
});

describe('DetailView snapshot', () => {
  it('renders message, tool, and edit summaries', () => {
    const store = createTuiStore();
    const evs: RunEvent[] = [
      { t: 'stage-enter', stageId: 'root', ts: 1 },
      { t: 'spawn', leafId: 'x', agent: 'opencode', model: 'groq/llama', ts: 2 },
      { t: 'message', leafId: 'x', role: 'assistant', content: 'hello world', ts: 3 },
      { t: 'tool', leafId: 'x', name: 'fetch', args: { url: 'https://a' }, ts: 4 },
      { t: 'edit', leafId: 'x', file: 'a.ts', added: 3, removed: 1, ts: 5 },
    ];
    for (const ev of evs) store.getState().ingest(ev);

    const { lastFrame } = render(
      <DetailView state={store.getState()} leafId="x" />,
    );
    const frame = lastFrame() ?? '';
    // Claude-Code-style DetailView: per-event rendering without the "Message:"
    // / "Tool:" prefix labels — just the content, bullet-marked. Assert the
    // meaningful content (message body, tool name, file) is present.
    expect(frame).toContain('hello world');
    expect(frame).toContain('fetch');
    expect(frame).toContain('a.ts');
    expect(frame).toContain('opencode');
    expect(frame).toContain('groq/llama');
  });
});

describe('App keyboard input', () => {
  it('moves selection on down-arrow', async () => {
    const store = seed();
    const initialIdx = store.getState().selectedIdx;

    const { stdin, lastFrame, rerender } = render(
      <App bus={new EventBus()} store={store} />,
    );

    // Preconditions: frame rendered.
    expect(lastFrame()).toBeDefined();

    // Press down arrow.
    stdin.write('\u001B[B');
    // Give ink time to schedule + re-render.
    await new Promise(r => setTimeout(r, 30));

    // Force a rerender pass to ensure the store's updated state propagates.
    rerender(<App bus={new EventBus()} store={store} />);
    await new Promise(r => setTimeout(r, 10));

    expect(store.getState().selectedIdx).toBeGreaterThan(initialIdx);
  });

  it('Enter on a leaf focuses it', async () => {
    const store = seed();
    // Bring selection down to the leaf (index 2).
    store.getState().moveSelection(2);

    render(<App bus={new EventBus()} store={store} />);

    process.stdout;
    // Enter
    // eslint-disable-next-line no-empty-pattern
    const { stdin } = render(<App bus={new EventBus()} store={store} />);
    stdin.write('\r');
    await new Promise(r => setTimeout(r, 30));
    expect(store.getState().focusedLeafId).toBe('a');
  });

  it("'a' on selected leaf in tree view calls onAbortLeaf with its id", async () => {
    const store = seed();
    // Selection to leaf 'a' at flat index 2.
    store.getState().moveSelection(2);
    expect(store.getState().selectedNodeId()).toBe('a');

    const onAbortLeaf = vi.fn();
    const { stdin } = render(
      <App bus={new EventBus()} store={store} onAbortLeaf={onAbortLeaf} />,
    );

    stdin.write('a');
    await vi.waitFor(() => {
      expect(onAbortLeaf).toHaveBeenCalledTimes(1);
    });
    expect(onAbortLeaf).toHaveBeenCalledWith('a');
  });

  it("'a' on a stage (non-leaf) does NOT call onAbortLeaf", async () => {
    const store = seed();
    // selectedIdx 0 is root stage 'scrape-don'.
    expect(store.getState().selectedNodeId()).toBe('scrape-don');

    const onAbortLeaf = vi.fn();
    const { stdin } = render(
      <App bus={new EventBus()} store={store} onAbortLeaf={onAbortLeaf} />,
    );

    stdin.write('a');
    await new Promise(r => setTimeout(r, 40));
    expect(onAbortLeaf).not.toHaveBeenCalled();
  });

  it('Esc in detail view clears focusedLeafId', async () => {
    const store = seed();
    store.getState().setFocus('a');
    expect(store.getState().focusedLeafId).toBe('a');

    const { stdin } = render(<App bus={new EventBus()} store={store} />);

    // ESC = ESC byte (0x1B) alone.
    stdin.write('\u001B');
    await vi.waitFor(() => {
      expect(store.getState().focusedLeafId).toBeUndefined();
    });
  });

  it('typing + Enter in detail view fires onSteer with accumulated buffer', async () => {
    const store = seed();
    store.getState().setFocus('a');

    const onSteer = vi.fn();
    const { stdin } = render(
      <App bus={new EventBus()} store={store} onSteer={onSteer} />,
    );

    stdin.write('hello');
    // Small pause so the printable-input useInput callbacks all flush to the
    // useState buffer before Enter.
    await new Promise(r => setTimeout(r, 20));
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(onSteer).toHaveBeenCalledTimes(1);
    });
    expect(onSteer).toHaveBeenCalledWith('a', 'hello');

    // Buffer should reset after Enter: a second Enter with no text should NOT
    // fire onSteer again.
    stdin.write('\r');
    await new Promise(r => setTimeout(r, 30));
    expect(onSteer).toHaveBeenCalledTimes(1);
  });

  it('Enter in detail view with empty buffer does NOT fire onSteer', async () => {
    const store = seed();
    store.getState().setFocus('a');

    const onSteer = vi.fn();
    const { stdin } = render(
      <App bus={new EventBus()} store={store} onSteer={onSteer} />,
    );

    stdin.write('\r');
    await new Promise(r => setTimeout(r, 30));
    expect(onSteer).not.toHaveBeenCalled();
  });

  it("'q' in tree view fires onQuit", async () => {
    const store = seed();
    const onQuit = vi.fn();
    const { stdin } = render(
      <App bus={new EventBus()} store={store} onQuit={onQuit} />,
    );

    stdin.write('q');
    await vi.waitFor(() => {
      expect(onQuit).toHaveBeenCalledTimes(1);
    });
  });
});

describe('streamHeadless', () => {
  it('prints one JSONL line per bus event', () => {
    const bus = new EventBus();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });

    const unsub = streamHeadless(bus);
    const ev: RunEvent = { t: 'stage-enter', stageId: 'root', ts: 1 };
    bus.publish(ev);
    bus.publish({
      t: 'spawn',
      leafId: 'a',
      agent: 'claude-code',
      ts: 2,
    });

    unsub();
    spy.mockRestore();

    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[0])).toEqual(ev);
    expect(JSON.parse(logs[1]).leafId).toBe('a');
  });
});
