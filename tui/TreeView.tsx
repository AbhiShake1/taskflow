import React from 'react';
import { Box, Text } from 'ink';
import type { TuiState, TreeNode } from './store';
import { formatElapsed, statusGlyph } from './store';

export type TreeViewProps = {
  state: TuiState;
  hintText?: string;
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
  // In plan mode there is no runtime progress — suppress the (done/total) tag.
  if (node.kind === 'stage' && node.childProgress && node.status !== 'plan') {
    return `${node.id} (${node.childProgress.done}/${node.childProgress.total})`;
  }
  return node.id;
}

function nodeTail(node: TreeNode): string {
  const parts: string[] = [];
  if (node.agent && node.agent !== 'unknown') parts.push(node.agent);
  if (node.model) parts.push(node.model);
  // Suppress elapsed for 'plan' status — there is no clock in plan mode.
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
        const glyph = statusGlyph(node.status);
        const label = nodeLabel(node);
        const tail = nodeTail(node);
        const isSelected = idx === selectedIdx;
        const rowText = `${indent}${glyph} ${label}`;
        return (
          <Box key={node.id} flexDirection="row">
            <Box>
              <Text inverse={isSelected}>{rowText}</Text>
            </Box>
            {tail ? (
              <Box marginLeft={2}>
                <Text dimColor>{tail}</Text>
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
