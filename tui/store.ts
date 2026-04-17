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
    default: return '·';
  }
}
