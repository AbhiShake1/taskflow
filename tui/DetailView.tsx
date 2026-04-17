import React from 'react';
import { Box, Text, Static } from 'ink';
import type { RunEvent } from '../core/types';
import type { TuiState, TreeNode } from './store';

export type DetailViewProps = {
  state: TuiState;
  leafId: string;
  onSteer?: (text: string) => void;
  onAbort?: () => void;
  onBack?: () => void;
};

const MAX_LIVE_TAIL = 20;

function breadcrumb(nodes: Record<string, TreeNode>, leafId: string): string {
  const chain: string[] = [];
  let cur: TreeNode | undefined = nodes[leafId];
  while (cur) {
    chain.unshift(cur.id);
    cur = cur.parentId ? nodes[cur.parentId] : undefined;
  }
  return chain.join(' / ');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function summarizeArgs(args: unknown): string {
  if (args == null) return '';
  try {
    const j = JSON.stringify(args);
    return truncate(j, 80);
  } catch {
    return String(args);
  }
}

function summarizeResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return truncate(result, 120);
  try {
    return truncate(JSON.stringify(result), 120);
  } catch {
    return String(result);
  }
}

export function eventSummary(ev: RunEvent): string {
  switch (ev.t) {
    case 'message':
      return `• Message: "${truncate(ev.content, 120)}"`;
    case 'tool':
      return `• Tool: ${ev.name}(${summarizeArgs(ev.args)})`;
    case 'tool-res':
      return `• → ${summarizeResult(ev.result)}`;
    case 'edit':
      return `• Edit ${ev.file} (+${ev.added} -${ev.removed})`;
    case 'error':
      return `• ⚠ Error: ${ev.error}`;
    case 'steer':
      return `• → steer: "${truncate(ev.content, 120)}"`;
    case 'spawn':
      return `• spawned ${ev.agent}${ev.model ? ` (${ev.model})` : ''}`;
    case 'done':
      return `• done: ${ev.result.status}`;
    default:
      return `• ${(ev as { t: string }).t}`;
  }
}

export function DetailView(props: DetailViewProps): React.ReactElement {
  const { state, leafId } = props;
  const leaf = state.nodes[leafId];

  if (!leaf) {
    return (
      <Box flexDirection="column">
        <Text color="red">Leaf not found: {leafId}</Text>
      </Box>
    );
  }

  const crumb = breadcrumb(state.nodes, leafId);
  const header = [leaf.agent, leaf.model, leaf.status].filter(Boolean).join(' · ');

  const events = leaf.leafEvents;
  const split = Math.max(0, events.length - MAX_LIVE_TAIL);
  const completed = events.slice(0, split);
  const live = events.slice(split);

  return (
    <Box flexDirection="column">
      <Box>
        <Text>
          {crumb}
          {header ? `    ${header}` : ''}
        </Text>
      </Box>
      <Box marginTop={1} />
      {completed.length > 0 ? (
        <Static items={completed.map((ev, i) => ({ ev, i }))}>
          {item => (
            <Text key={item.i}>{eventSummary(item.ev)}</Text>
          )}
        </Static>
      ) : null}
      <Box flexDirection="column">
        {live.map((ev, i) => (
          <Text key={split + i}>{eventSummary(ev)}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text>{'› steer: _              '}</Text>
        <Text dimColor>[Esc back  ⌘K abort  ⌘R restart]</Text>
      </Box>
    </Box>
  );
}
