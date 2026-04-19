import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { RunEvent } from '../core/types';
import { EventBus } from '../core/events';
import { createTuiStore, formatElapsed, statusGlyph, statusColor, liveStatusGlyph, latestActivity, type TreeNode } from '../tui/store';
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

// ---------------------------------------------------------------------------
// Display helper unit tests
// ---------------------------------------------------------------------------

function makeNode(leafEvents: RunEvent[]): TreeNode {
  return { id: 'n', kind: 'leaf', status: 'running', children: [], leafEvents };
}

describe('formatElapsed', () => {
  it('returns em-dash when startedAt is absent or zero (falsy guard)', () => {
    expect(formatElapsed()).toBe('—');
    expect(formatElapsed(undefined, 1000, 2000)).toBe('—');
    // The implementation uses !startedAt, so 0 is treated as absent.
    expect(formatElapsed(0, 1000, 0)).toBe('—');
  });

  it('returns seconds when elapsed < 60s', () => {
    expect(formatElapsed(1000, 31_000, 0)).toBe('30s');
    expect(formatElapsed(1000, 1000, 0)).toBe('0s');
    expect(formatElapsed(1000, 60_999, 0)).toBe('59s');
  });

  it('returns minutes+seconds when 60s <= elapsed < 1h', () => {
    expect(formatElapsed(1000, 91_000, 0)).toBe('1m 30s');
    expect(formatElapsed(1000, 3_600_999, 0)).toBe('59m 59s');
    expect(formatElapsed(1000, 61_000, 0)).toBe('1m 0s');
  });

  it('returns hours+minutes (no seconds) when elapsed >= 1h', () => {
    expect(formatElapsed(1000, 3_601_000, 0)).toBe('1h 0m');
    expect(formatElapsed(1000, 3_661_000, 0)).toBe('1h 1m');
    expect(formatElapsed(1000, 7_321_000, 0)).toBe('2h 2m');
  });

  it('uses now as end when endedAt is absent', () => {
    expect(formatElapsed(1000, undefined, 6000)).toBe('5s');
  });
});

describe('statusGlyph', () => {
  it('returns the correct glyph for each status', () => {
    expect(statusGlyph('pending')).toBe('○');
    expect(statusGlyph('running')).toBe('◐');
    expect(statusGlyph('done')).toBe('✓');
    expect(statusGlyph('error')).toBe('✗');
    expect(statusGlyph('aborted')).toBe('⚠');
    expect(statusGlyph('timeout')).toBe('⚠');
    expect(statusGlyph('plan')).toBe('◯');
  });

  it('returns dot for unknown status (default branch)', () => {
    expect(statusGlyph('unknown' as TreeNode['status'])).toBe('·');
  });
});

describe('statusColor', () => {
  it('returns the correct color for colored statuses', () => {
    expect(statusColor('running')).toBe('cyan');
    expect(statusColor('done')).toBe('green');
    expect(statusColor('error')).toBe('red');
    expect(statusColor('aborted')).toBe('yellow');
    expect(statusColor('timeout')).toBe('yellow');
    expect(statusColor('plan')).toBe('cyan');
  });

  it('returns undefined for pending', () => {
    expect(statusColor('pending')).toBeUndefined();
  });

  it('returns undefined for unknown status (default branch)', () => {
    expect(statusColor('unknown' as TreeNode['status'])).toBeUndefined();
  });
});

describe('liveStatusGlyph', () => {
  it('returns a spinner frame for running status, derived from now', () => {
    // SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
    expect(liveStatusGlyph('running', 0)).toBe('⠋');    // frame 0
    expect(liveStatusGlyph('running', 100)).toBe('⠙');  // frame 1
    expect(liveStatusGlyph('running', 950)).toBe('⠏');  // frame 9
    expect(liveStatusGlyph('running', 1000)).toBe('⠋'); // frame 10 % 10 = 0
  });

  it('returns the static glyph for non-running statuses', () => {
    expect(liveStatusGlyph('done', 0)).toBe('✓');
    expect(liveStatusGlyph('error', 0)).toBe('✗');
    expect(liveStatusGlyph('pending', 0)).toBe('○');
    expect(liveStatusGlyph('aborted', 0)).toBe('⚠');
  });
});

describe('latestActivity', () => {
  it('returns undefined when there are no events', () => {
    expect(latestActivity(makeNode([]))).toBeUndefined();
  });

  it('handles tool event without command arg', () => {
    const ev = { t: 'tool', leafId: 'n', name: 'Read', args: { path: '/a' }, ts: 1 } as RunEvent;
    expect(latestActivity(makeNode([ev]))).toBe('▸ Read');
  });

  it('handles tool event with command arg (first line, 50-char cap)', () => {
    const ev = { t: 'tool', leafId: 'n', name: 'Bash', args: { command: 'echo hi\necho bye' }, ts: 1 } as RunEvent;
    expect(latestActivity(makeNode([ev]))).toBe('▸ Bash: echo hi');

    const long = 'x'.repeat(60);
    const ev2 = { t: 'tool', leafId: 'n', name: 'Bash', args: { command: long }, ts: 2 } as RunEvent;
    expect(latestActivity(makeNode([ev2]))).toBe(`▸ Bash: ${'x'.repeat(50)}`);
  });

  it('handles tool-res event', () => {
    const ev = { t: 'tool-res', leafId: 'n', name: 'Read', ts: 2 } as RunEvent;
    expect(latestActivity(makeNode([ev]))).toBe('▹ Read done');
  });

  it('handles assistant message event (first non-empty line, 60-char cap)', () => {
    const ev = { t: 'message', leafId: 'n', role: 'assistant', content: 'hello world', ts: 3 } as RunEvent;
    expect(latestActivity(makeNode([ev]))).toBe('▹ hello world');

    const multiline = { t: 'message', leafId: 'n', role: 'assistant', content: '\nfirst line\nsecond', ts: 4 } as RunEvent;
    expect(latestActivity(makeNode([multiline]))).toBe('▹ first line');

    const longContent = 'a'.repeat(70);
    const ev2 = { t: 'message', leafId: 'n', role: 'assistant', content: longContent, ts: 5 } as RunEvent;
    expect(latestActivity(makeNode([ev2]))).toBe(`▹ ${'a'.repeat(60)}`);
  });

  it('skips user messages and empty assistant messages', () => {
    const user = { t: 'message', leafId: 'n', role: 'user', content: 'hi', ts: 1 } as RunEvent;
    expect(latestActivity(makeNode([user]))).toBeUndefined();

    const empty = { t: 'message', leafId: 'n', role: 'assistant', content: '', ts: 1 } as RunEvent;
    expect(latestActivity(makeNode([empty]))).toBeUndefined();
  });

  it('handles edit event', () => {
    const ev = { t: 'edit', leafId: 'n', file: 'src/a.ts', added: 5, removed: 2, ts: 4 } as RunEvent;
    expect(latestActivity(makeNode([ev]))).toBe('✎ src/a.ts (+5/-2)');
  });

  it('handles error event (60-char cap)', () => {
    const ev = { t: 'error', leafId: 'n', error: 'something broke', ts: 5 } as RunEvent;
    expect(latestActivity(makeNode([ev]))).toBe('✗ something broke');

    const long = { t: 'error', leafId: 'n', error: 'e'.repeat(80), ts: 6 } as RunEvent;
    expect(latestActivity(makeNode([long]))).toBe(`✗ ${'e'.repeat(60)}`);
  });

  it('handles steer event (60-char cap)', () => {
    const ev = { t: 'steer', leafId: 'n', content: 'try again', ts: 6 } as RunEvent;
    expect(latestActivity(makeNode([ev]))).toBe('↻ steer: try again');
  });

  it('returns the most recent meaningful event when multiple events are present', () => {
    const evs = [
      { t: 'tool', leafId: 'n', name: 'Read', args: {}, ts: 1 },
      { t: 'tool-res', leafId: 'n', name: 'Read', ts: 2 },
      { t: 'edit', leafId: 'n', file: 'b.ts', added: 1, removed: 0, ts: 3 },
    ] as RunEvent[];
    expect(latestActivity(makeNode(evs))).toBe('✎ b.ts (+1/-0)');
  });
});
