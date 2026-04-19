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

// Strip trailing counter suffixes so the tree reads as a stream of actions
// rather than a wall of noise. `pick-05` → `pick`, `lint-05-a0` → `lint`,
// `iter-05` → `iter`. Ids without a numeric tail are returned unchanged.
function stripCounter(id: string): string {
  return id.replace(/-\d{2,}(-[a-z]\d+)?$/, '');
}

function nodeLabel(node: TreeNode): string {
  // Prefer runtime-set title over the stripped id. Harnesses can call
  // setTitle() from a phase body to give a cycle a meaningful label after
  // the title is discovered (e.g. an AI-generated improvement summary).
  const display = node.title ?? stripCounter(node.id);
  // Collapsed stages: prefix with ▸ so the user sees grouping exists even
  // when children are hidden. Expanded stages have the natural indent tell.
  const collapsedMark = node.kind === 'stage' && node.collapsed ? '▸ ' : '';
  if (node.kind === 'stage' && node.childProgress && node.status !== 'plan') {
    return `${collapsedMark}${display} (${node.childProgress.done}/${node.childProgress.total})`;
  }
  return `${collapsedMark}${display}`;
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

// Whether `node` is the last among its siblings (root-level nodes count
// rootIds as siblings; other nodes look at their parent's children).
function isLastSibling(
  node: TreeNode,
  nodes: Record<string, TreeNode>,
  rootIds: string[],
): boolean {
  const sibs = node.parentId ? nodes[node.parentId]?.children ?? [] : rootIds;
  return sibs[sibs.length - 1] === node.id;
}

// Build the Unicode box-drawing prefix for a node. For each ancestor the
// prefix contributes either "│  " (ancestor has later siblings, so the line
// continues underneath us) or "   " (ancestor was the last child of its own
// parent, so the line has terminated). At the node's own level, the
// connector is "└─ " for last-child or "├─ " for a mid-list child.
function treePrefix(
  node: TreeNode,
  nodes: Record<string, TreeNode>,
  rootIds: string[],
): string {
  const chain: TreeNode[] = [];
  let cur: TreeNode | undefined = node;
  while (cur?.parentId) {
    const parent: TreeNode | undefined = nodes[cur.parentId];
    if (!parent) break;
    chain.unshift(parent);
    cur = parent;
  }
  let prefix = '';
  for (const anc of chain) {
    prefix += isLastSibling(anc, nodes, rootIds) ? '   ' : '│  ';
  }
  // Connector at the node's own level — applies to every node, including
  // roots. Without this, sibling top-level nodes lose their visual grouping.
  prefix += isLastSibling(node, nodes, rootIds) ? '└─ ' : '├─ ';
  return prefix;
}

// Prefix used for the activity sub-line that hangs under a running leaf.
// We want it aligned with the row's label, not its connector — so we replace
// the node's own `├─ ` / `└─ ` with `│  ` / `   ` respectively.
function subLinePrefix(
  node: TreeNode,
  nodes: Record<string, TreeNode>,
  rootIds: string[],
): string {
  const base = treePrefix(node, nodes, rootIds);
  if (base.length === 0) return '   ';
  if (base.endsWith('├─ ')) return base.slice(0, -3) + '│  ';
  if (base.endsWith('└─ ')) return base.slice(0, -3) + '   ';
  return base;
}

export function TreeView({ state, hintText }: TreeViewProps): React.ReactElement {
  const flat = state.getFlatTree();
  const selectedIdx = Math.min(state.selectedIdx, Math.max(0, flat.length - 1));
  const hint = hintText ?? '[↑↓ nav  ⏎ drill-in  a abort-leaf  q quit]';

  return (
    <Box flexDirection="column">
      {flat.map((node, idx) => {
        const prefix = treePrefix(node, state.nodes, state.rootIds);
        const glyph = liveStatusGlyph(node.status);
        const label = nodeLabel(node);
        const tail = nodeTail(node);
        const isSelected = idx === selectedIdx;
        const color = statusColor(node.status);
        const bold = node.status === 'running';
        const dim = node.status === 'pending' || node.status === 'done';
        const strike = node.status === 'done';
        const activity =
          node.status === 'running' && node.kind === 'leaf'
            ? latestActivity(node) ?? '⟳ waiting for first response'
            : undefined;
        const subPrefix = activity ? subLinePrefix(node, state.nodes, state.rootIds) : '';

        return (
          <Box key={node.id} flexDirection="column">
            <Box flexDirection="row">
              {prefix ? (
                <Box>
                  <Text dimColor>{prefix}</Text>
                </Box>
              ) : null}
              <Box>
                <Text color={color} bold={bold} dimColor={dim} strikethrough={strike} inverse={isSelected}>
                  {`${glyph} ${label}`}
                </Text>
              </Box>
              {tail ? (
                <Box marginLeft={2}>
                  <Text dimColor>{tail}</Text>
                </Box>
              ) : null}
            </Box>
            {activity ? (
              <Box flexDirection="row">
                <Box>
                  <Text dimColor>{subPrefix}</Text>
                </Box>
                <Box>
                  <Text color="cyan" dimColor>{activity}</Text>
                </Box>
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
