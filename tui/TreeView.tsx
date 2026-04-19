import React from 'react';
import { Box, Text } from 'ink';
import type { TreeNode, TuiState } from './store';
import { formatElapsed, latestActivity, liveStatusGlyph, statusColor } from './store';

export type TreeViewProps = {
  state: TuiState;
  hintText?: string;
  /**
   * Monotonically-increasing tick from the parent App. Not read directly — its
   * mere presence re-renders this component, so elapsed clocks and the
   * running-status spinner advance without needing incoming events.
   */
  tick?: number;
};

function depth(node: TreeNode, nodes: Record<string, TreeNode>): number {
  let d = 0;
  let cur: TreeNode | undefined = node;
  while (cur?.parentId && nodes[cur.parentId]) {
    d += 1;
    cur = nodes[cur.parentId];
  }
  return d;
}

function nodeLabel(node: TreeNode): string {
  if (node.kind === 'stage' && node.childProgress && node.status !== 'plan') {
    return `${node.id} (${node.childProgress.done}/${node.childProgress.total})`;
  }
  return node.id;
}

function nodeTail(node: TreeNode): string {
  const parts: string[] = [];
  if (node.agent && node.agent !== 'unknown') parts.push(node.agent);
  if (node.model) parts.push(node.model);
  if (node.status !== 'plan') {
    parts.push(formatElapsed(node.startedAt, node.endedAt));
  }
  if (node.planHint) parts.push(node.planHint);
  return parts.join('  ');
}

export function TreeView({ state, hintText }: TreeViewProps): React.ReactElement {
  const flat = state.getFlatTree();
  const selectedIdx = Math.min(state.selectedIdx, Math.max(0, flat.length - 1));
  const hint = hintText ?? '[↑↓ nav  ⏎ drill-in  a abort-leaf  q quit]';

  return (
    <Box flexDirection="column">
      {flat.map((node, idx) => {
        const d = depth(node, state.nodes);
        const indent = '  '.repeat(d);
        const glyph = liveStatusGlyph(node.status);
        const label = nodeLabel(node);
        const tail = nodeTail(node);
        const isSelected = idx === selectedIdx;
        const color = statusColor(node.status);
        const bold = node.status === 'running';
        const dim = node.status === 'pending';
        const activity =
          node.status === 'running' && node.kind === 'leaf'
            ? latestActivity(node) ?? '⟳ waiting for first response'
            : undefined;

        return (
          <Box key={node.id} flexDirection="column">
            <Box flexDirection="row">
              <Box>
                <Text color={color} bold={bold} dimColor={dim} inverse={isSelected}>
                  {`${indent}${glyph} ${label}`}
                </Text>
              </Box>
              {tail ? (
                <Box marginLeft={2}>
                  <Text dimColor>{tail}</Text>
                </Box>
              ) : null}
            </Box>
            {activity ? (
              <Box marginLeft={d * 2 + 4}>
                <Text color="cyan" dimColor>{activity}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}
