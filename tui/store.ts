import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { RunEvent, LeafStatus } from '../core/types';
import type { EventBus } from '../core/events';

export type TreeNodeKind = 'stage' | 'leaf';

export type TreeNodeStatus = LeafStatus | 'running' | 'pending';

export type TreeNode = {
  id: string;
  kind: TreeNodeKind;
  parentId?: string;
  status: TreeNodeStatus;
  startedAt?: number;
  endedAt?: number;
  agent?: string;
  model?: string;
  children: string[];
  leafEvents: RunEvent[];
  childProgress?: { done: number; total: number };
  /**
   * Optional author-time hint text rendered on the node's tail. Currently only
   * populated by plan mode to surface write-claim paths (e.g. "write: data/x.json").
   * Absent at runtime.
   */
  planHint?: string;
  /**
   * Runtime display title set via `stage-title` events. Overrides the id in
   * the TUI label when present. Used by harnesses that discover a good name
   * for a phase only after some work runs (e.g. AI-generated summaries).
   */
  title?: string;
};

export type TuiState = {
  nodes: Record<string, TreeNode>;
  rootIds: string[];
  focusedLeafId?: string;
  selectedIdx: number;

  // internal: we keep the stage stack inside state so tests can drive ingest
  // without a bus.
  _stageStack: string[];

  ingest(ev: RunEvent): void;
  setFocus(leafId: string | undefined): void;
  moveSelection(delta: number): void;
  selectedNodeId(): string | undefined;
  getFlatTree(): TreeNode[];
};

const LEAF_EVENT_CAP = 500;

function flatten(
  nodes: Record<string, TreeNode>,
  rootIds: string[],
): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (id: string) => {
    const node = nodes[id];
    if (!node) return;
    out.push(node);
    for (const c of node.children) walk(c);
  };
  for (const id of rootIds) walk(id);
  return out;
}

function recomputeStageProgress(
  nodes: Record<string, TreeNode>,
  stageId: string,
): void {
  const stage = nodes[stageId];
  if (!stage || stage.kind !== 'stage') return;
  const kids = stage.children.map(id => nodes[id]).filter(Boolean) as TreeNode[];
  if (kids.length === 0 || kids.some(k => k.kind !== 'leaf')) {
    stage.childProgress = undefined;
    return;
  }
  const done = kids.filter(k => k.status === 'done' || k.status === 'error' || k.status === 'aborted' || k.status === 'timeout').length;
  stage.childProgress = { done, total: kids.length };
}

export function createTuiStore(
  bus?: EventBus,
): UseBoundStore<StoreApi<TuiState>> {
  const store = create<TuiState>((set, get) => ({
    nodes: {},
    rootIds: [],
    focusedLeafId: undefined,
    selectedIdx: 0,
    _stageStack: [],

    ingest(ev: RunEvent): void {
      set(state => {
        // shallow-clone containers; mutate node objects in place for speed.
        const nodes = { ...state.nodes };
        let rootIds = state.rootIds;
        let stack = state._stageStack;

        if (ev.t === 'stage-enter') {
          const parentId = ev.parentId ?? stack[stack.length - 1];
          const node: TreeNode = {
            id: ev.stageId,
            kind: 'stage',
            parentId,
            status: 'running',
            startedAt: ev.ts,
            children: [],
            leafEvents: [],
            ...(ev.title !== undefined ? { title: ev.title } : {}),
          };
          nodes[ev.stageId] = node;
          if (parentId && nodes[parentId]) {
            const p = { ...nodes[parentId] };
            p.children = [...p.children, ev.stageId];
            nodes[parentId] = p;
          } else {
            rootIds = [...rootIds, ev.stageId];
          }
          stack = [...stack, ev.stageId];
        } else if (ev.t === 'stage-title') {
          const existing = nodes[ev.stageId];
          if (existing) {
            nodes[ev.stageId] = { ...existing, title: ev.title };
          }
        } else if (ev.t === 'stage-exit') {
          const existing = nodes[ev.stageId];
          if (existing) {
            nodes[ev.stageId] = {
              ...existing,
              status: ev.status === 'done' ? 'done' : 'error',
              endedAt: ev.ts,
            };
          }
          // pop the top of the stack matching this id (defensive).
          const idx = stack.lastIndexOf(ev.stageId);
          if (idx >= 0) stack = stack.slice(0, idx);
        } else if (ev.t === 'spawn') {
          const parentId = stack[stack.length - 1];
          const node: TreeNode = {
            id: ev.leafId,
            kind: 'leaf',
            parentId,
            status: 'running',
            startedAt: ev.ts,
            agent: ev.agent,
            model: ev.model,
            children: [],
            leafEvents: [],
          };
          nodes[ev.leafId] = node;
          if (parentId && nodes[parentId]) {
            const p = { ...nodes[parentId] };
            p.children = [...p.children, ev.leafId];
            nodes[parentId] = p;
            recomputeStageProgress(nodes, parentId);
          } else {
            rootIds = [...rootIds, ev.leafId];
          }
        } else if (ev.t === 'done') {
          const existing = nodes[ev.leafId];
          if (existing) {
            nodes[ev.leafId] = {
              ...existing,
              status: ev.result.status,
              endedAt: ev.ts,
              leafEvents: appendCapped(existing.leafEvents, ev),
            };
            if (existing.parentId) {
              recomputeStageProgress(nodes, existing.parentId);
            }
          }
        } else {
          // message | tool | tool-res | edit | steer | error
          const leafId = (ev as { leafId: string }).leafId;
          const existing = nodes[leafId];
          if (existing) {
            nodes[leafId] = {
              ...existing,
              leafEvents: appendCapped(existing.leafEvents, ev),
            };
          }
        }

        return { ...state, nodes, rootIds, _stageStack: stack };
      });
    },

    setFocus(leafId) {
      set(state => ({ ...state, focusedLeafId: leafId }));
    },

    moveSelection(delta: number) {
      set(state => {
        const flat = flatten(state.nodes, state.rootIds);
        if (flat.length === 0) return state;
        let next = state.selectedIdx + delta;
        if (next < 0) next = 0;
        if (next >= flat.length) next = flat.length - 1;
        return { ...state, selectedIdx: next };
      });
    },

    selectedNodeId(): string | undefined {
      const { nodes, rootIds, selectedIdx } = get();
      const flat = flatten(nodes, rootIds);
      return flat[selectedIdx]?.id;
    },

    getFlatTree(): TreeNode[] {
      const { nodes, rootIds } = get();
      return flatten(nodes, rootIds);
    },
  }));

  if (bus) {
    bus.subscribe(ev => store.getState().ingest(ev));
  }

  return store;
}

function appendCapped(arr: RunEvent[], ev: RunEvent): RunEvent[] {
  if (arr.length < LEAF_EVENT_CAP) return [...arr, ev];
  // drop the oldest
  return [...arr.slice(arr.length - LEAF_EVENT_CAP + 1), ev];
}

export function formatElapsed(startedAt?: number, endedAt?: number, now: number = Date.now()): string {
  if (!startedAt) return '—';
  const end = endedAt ?? now;
  const ms = Math.max(0, end - startedAt);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

export function statusGlyph(status: TreeNodeStatus): string {
  switch (status) {
    case 'pending': return '○';
    case 'running': return '◐';
    case 'done': return '✓';
    case 'error': return '✗';
    case 'aborted':
    case 'timeout': return '⚠';
    case 'plan': return '◯';
    default: return '·';
  }
}

// Color per status. Returns undefined for "use the default terminal color".
export function statusColor(status: TreeNodeStatus): string | undefined {
  switch (status) {
    case 'running': return 'cyan';
    case 'done': return 'green';
    case 'error': return 'red';
    case 'aborted':
    case 'timeout': return 'yellow';
    case 'plan': return 'cyan';
    case 'pending': return undefined;
    default: return undefined;
  }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Live-animated glyph: returns a spinner frame for running nodes (frame index
// derived from `now` so no store state ticks required), otherwise the static
// status glyph.
export function liveStatusGlyph(status: TreeNodeStatus, now: number = Date.now()): string {
  if (status === 'running') {
    const frame = Math.floor(now / 100) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[frame]!;
  }
  return statusGlyph(status);
}

// Summarize the most recent meaningful event on a node so running leaves can
// show "what they're doing" between state transitions. Returns undefined when
// the node has no events yet (fresh spawn) or its events are all
// non-informative — callers can fall back to a "waiting…" placeholder.
export function latestActivity(node: TreeNode): string | undefined {
  for (let i = node.leafEvents.length - 1; i >= 0; i--) {
    const ev = node.leafEvents[i];
    if (!ev) continue;
    if (ev.t === 'tool') {
      const argPreview = typeof ev.args === 'object' && ev.args && 'command' in (ev.args as Record<string, unknown>)
        ? String((ev.args as { command?: unknown }).command ?? '').split('\n')[0]?.slice(0, 50)
        : undefined;
      return argPreview ? `▸ ${ev.name}: ${argPreview}` : `▸ ${ev.name}`;
    }
    if (ev.t === 'tool-res') return `▹ ${ev.name} done`;
    if (ev.t === 'message' && ev.role === 'assistant' && typeof ev.content === 'string' && ev.content.length > 0) {
      const first = ev.content.split('\n').find((l) => l.trim().length > 0) ?? '';
      return `▹ ${first.slice(0, 60)}`;
    }
    if (ev.t === 'edit') return `✎ ${ev.file} (+${ev.added}/-${ev.removed})`;
    if (ev.t === 'error') return `✗ ${ev.error.slice(0, 60)}`;
    if (ev.t === 'steer') return `↻ steer: ${ev.content.slice(0, 60)}`;
  }
  return undefined;
}
