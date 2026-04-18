// Render a static PlanRoot tree using the existing TUI components.
//
// Strategy (option A from the spec): synthesize a stream of RunEvents that
// mirrors what a live run would emit — stage-enter for roots/phases, spawn
// for sessions — but omit `done`/`stage-exit` so every node stays in the
// 'plan' state. We inject a synthetic 'plan' leaf status via the store's
// ingest path and extended LeafStatus union.
//
// DetailView re-use: we attach a single synthetic 'message' event per session
// that renders the spec details (task, schema, write claims, timeout). When
// the user presses Enter on a session the existing DetailView surfaces that
// message cleanly.

import React from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import type { RunEvent } from '../core/types';
import { EventBus } from '../core/events';
import { createTuiStore } from '../tui/store';
import { TreeView } from '../tui/TreeView';
import { DetailView } from '../tui/DetailView';
import type { PlanPhase, PlanRoot, PlanSession, PlanUnknown } from './ast';

function formatSessionDetail(s: PlanSession): string {
  const lines: string[] = [];
  lines.push(`task:\n${indent(s.task || '<no task>', '  ')}`);
  const w = [s.agent, s.model].filter(Boolean).join(':');
  if (w) lines.push(`with: ${w}`);
  if (s.write && s.write.length > 0) lines.push(`write: ${s.write.join(', ')}`);
  if (s.dependsOn && s.dependsOn.length > 0) lines.push(`dependsOn: ${s.dependsOn.join(', ')}`);
  if (s.timeoutMs !== undefined) lines.push(`timeoutMs: ${s.timeoutMs}`);
  if (s.schemaName) {
    lines.push(`schema: ${s.schemaName}`);
    if (s.schemaPreview) lines.push(`schema-json:\n${indent(s.schemaPreview, '  ')}`);
  }
  if (s.idIsDynamic) lines.push('(id is dynamic — contains runtime substitutions)');
  if (!s.awaited) lines.push('(fire-and-forget: not awaited)');
  return lines.join('\n');
}

function indent(text: string, pad: string): string {
  return text.split('\n').map(l => pad + l).join('\n');
}

function planToEvents(root: PlanRoot, hints: Map<string, string>): RunEvent[] {
  const evs: RunEvent[] = [];
  let ts = 1;
  const push = (ev: RunEvent): void => { evs.push(ev); };

  push({ t: 'stage-enter', stageId: root.name, ts: ts++ });

  const walkChild = (
    child: PlanPhase | PlanSession | PlanUnknown,
    parentId: string,
  ): void => {
    if (child.kind === 'phase') {
      const displayName = phaseDisplayName(child);
      push({ t: 'stage-enter', stageId: displayName, parentId, ts: ts++ });
      for (const g of child.children) walkChild(g, displayName);
      // Intentionally no stage-exit — keeps phase in 'running'. We override
      // the status at render time below.
    } else if (child.kind === 'session') {
      push({
        t: 'spawn',
        leafId: child.id,
        agent: child.agent,
        model: child.model,
        ts: ts++,
      } as RunEvent);
      // Attach a synthetic message with the spec details so DetailView has
      // something useful to show.
      push({
        t: 'message',
        leafId: child.id,
        role: 'assistant',
        content: formatSessionDetail(child),
        ts: ts++,
      } as RunEvent);
      const parts: string[] = [];
      if (child.write && child.write.length > 0) parts.push(`write: ${child.write.join(', ')}`);
      if (child.dependsOn && child.dependsOn.length > 0) parts.push(`⇠ ${child.dependsOn.join(', ')}`);
      if (child.schemaName) parts.push(`schema: ${child.schemaName}`);
      if (!child.awaited) parts.push('(fire-and-forget)');
      if (child.idIsDynamic) parts.push('(dynamic id)');
      if (parts.length > 0) hints.set(child.id, parts.join('  '));
    } else {
      // PlanUnknown: surface as a pseudo-leaf so it's visible.
      const id = `? ${child.reason}`;
      push({ t: 'spawn', leafId: id, agent: 'unknown', ts: ts++ } as RunEvent);
      push({
        t: 'message',
        leafId: id,
        role: 'assistant',
        content: `unknown pattern:\n${indent(child.sourceExcerpt, '  ')}`,
        ts: ts++,
      } as RunEvent);
    }
  };

  for (const c of root.children) walkChild(c, root.name);
  return evs;
}

function phaseDisplayName(p: PlanPhase): string {
  if (!p.parallel) return p.name;
  const count = p.children.length;
  if (p.expandHint !== undefined && p.expandHint !== count) {
    return `${p.name} (parallel × ${p.expandHint})`;
  }
  return `${p.name} (parallel × ${count})`;
}

/**
 * Post-process the zustand store so every node is in 'plan' state. We also
 * populate `planHint` on session leaves so write-claim paths show inline in
 * the tree (the detail view already has the full spec).
 */
function forceAllToPlan(
  store: ReturnType<typeof createTuiStore>,
  hints: Map<string, string>,
): void {
  store.setState(state => {
    const nodes: typeof state.nodes = {};
    for (const [id, node] of Object.entries(state.nodes)) {
      const hint = hints.get(id);
      nodes[id] = hint ? { ...node, status: 'plan', planHint: hint } : { ...node, status: 'plan' };
    }
    return { ...state, nodes };
  });
}

// ---------------------------------------------------------------------------
// React app: reuses TreeView + DetailView, drops the steer/abort UI
// ---------------------------------------------------------------------------

interface PlanAppProps {
  store: ReturnType<typeof createTuiStore>;
  headerLine: string;
  onQuit?: () => void;
}

export function PlanApp(props: PlanAppProps): React.ReactElement {
  const { store, headerLine, onQuit } = props;
  const state = store();
  const { exit } = useApp();

  // Only wire keyboard input when stdin can support raw mode. This keeps
  // the component testable under ink-testing-library and safe in non-TTY
  // environments (CI snapshots, piped invocations) where useInput would throw.
  const isRawSupported = Boolean(process.stdin.isTTY);
  useInput((input, key) => {
    if (state.focusedLeafId) {
      if (key.escape || input === 'q') {
        if (input === 'q') { onQuit?.(); exit(); return; }
        state.setFocus(undefined);
        return;
      }
      return;
    }
    if (key.upArrow) { state.moveSelection(-1); return; }
    if (key.downArrow) { state.moveSelection(1); return; }
    if (key.return) {
      const id = state.selectedNodeId();
      if (id && state.nodes[id]?.kind === 'leaf') state.setFocus(id);
      return;
    }
    if (input === 'q') { onQuit?.(); exit(); }
  }, { isActive: isRawSupported });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}><Text>{headerLine}</Text></Box>
      {state.focusedLeafId ? (
        <DetailView
          state={state}
          leafId={state.focusedLeafId}
          onBack={() => state.setFocus(undefined)}
        />
      ) : (
        <TreeView state={state} hintText="[↑↓ nav  ⏎ inspect  q quit]" />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build a primed TUI store + header line from a PlanRoot. Exposed for tests. */
export function preparePlanStore(root: PlanRoot): {
  store: ReturnType<typeof createTuiStore>;
  headerLine: string;
} {
  const bus = new EventBus();
  const store = createTuiStore(bus);
  const hints = new Map<string, string>();
  for (const ev of planToEvents(root, hints)) bus.publish(ev);
  forceAllToPlan(store, hints);
  const headerLine = `plan: ${root.name}   (from ${root.sourcePath})`;
  return { store, headerLine };
}

/** Interactive render entry. Mounts Ink, renders until 'q' exits. */
export function renderPlan(root: PlanRoot): () => void {
  const { store, headerLine } = preparePlanStore(root);
  const { unmount } = render(
    <PlanApp store={store} headerLine={headerLine} onQuit={() => { /* caller controls exit via ink */ }} />,
  );
  return () => unmount();
}
