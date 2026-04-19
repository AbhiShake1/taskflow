import React from 'react';
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import type { RunEvent } from '../core/types';
import type { TuiState, TreeNode } from './store';

export type DetailViewProps = {
  state: TuiState;
  leafId: string;
  onSteer?: (text: string) => void;
  onAbort?: () => void;
  onBack?: () => void;
};

// Max lines of a tool-result body rendered inline before we collapse to a
// "+N lines" footer. Claude Code's value looks roughly in this range too.
const MAX_RESULT_LINES = 3;
// Max rendered events (block-level). Older events fall off the top so the
// DetailView stays skimmable on a long-running leaf.
const MAX_BLOCKS = 80;

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

// Claude-Code-style argument summary per tool. Keeps the one-liner scannable
// — full command for Bash, basename for file tools, pattern for searches —
// instead of dumping the raw JSON blob.
function formatToolArgs(name: string, args: unknown): string {
  if (args == null || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'Bash': {
      const cmd = typeof a.command === 'string' ? a.command : '';
      return truncate(cmd.replace(/\s+/g, ' '), 80);
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const p = typeof a.file_path === 'string' ? a.file_path : '';
      return p ? basename(p) : '';
    }
    case 'Grep': {
      const pat = typeof a.pattern === 'string' ? a.pattern : '';
      const p = typeof a.path === 'string' ? a.path : '';
      const head = truncate(pat, 40);
      return p ? `${head} in ${basename(p)}` : head;
    }
    case 'Glob': {
      return truncate(typeof a.pattern === 'string' ? a.pattern : '', 80);
    }
    default: {
      try {
        return truncate(JSON.stringify(a), 80);
      } catch {
        return '';
      }
    }
  }
}

// Normalize a tool result into lines we can render. Strings split on \n;
// objects get JSON-stringified. Empty result → "(No output)" placeholder.
function resultLines(result: unknown): string[] {
  if (result == null) return ['(No output)'];
  if (typeof result === 'string') {
    if (result.length === 0) return ['(No output)'];
    return result.split('\n');
  }
  if (Array.isArray(result)) {
    // Claude SDK tool-res often comes as array of content blocks.
    const text = result
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return text ? text.split('\n') : ['(No output)'];
  }
  try {
    return JSON.stringify(result, null, 2).split('\n');
  } catch {
    return [String(result)];
  }
}

type ToolBlock = { kind: 'tool'; ev: Extract<RunEvent, { t: 'tool' }>; res?: Extract<RunEvent, { t: 'tool-res' }> };
type MessageBlock = { kind: 'message'; ev: Extract<RunEvent, { t: 'message' }> };
type EditBlock = { kind: 'edit'; ev: Extract<RunEvent, { t: 'edit' }> };
type SteerBlock = { kind: 'steer'; ev: Extract<RunEvent, { t: 'steer' }> };
type ErrorBlock = { kind: 'error'; ev: Extract<RunEvent, { t: 'error' }> };
type SpawnBlock = { kind: 'spawn'; ev: Extract<RunEvent, { t: 'spawn' }> };
type DoneBlock = { kind: 'done'; ev: Extract<RunEvent, { t: 'done' }> };
type Block = ToolBlock | MessageBlock | EditBlock | SteerBlock | ErrorBlock | SpawnBlock | DoneBlock;

// Pair each `tool` event with its subsequent `tool-res` (FIFO per tool name).
// Other event kinds become their own blocks.
function buildBlocks(events: readonly RunEvent[]): Block[] {
  const blocks: Block[] = [];
  const pendingByName = new Map<string, number[]>();
  for (const ev of events) {
    if (ev.t === 'tool') {
      const idx = blocks.length;
      blocks.push({ kind: 'tool', ev });
      const q = pendingByName.get(ev.name) ?? [];
      q.push(idx);
      pendingByName.set(ev.name, q);
    } else if (ev.t === 'tool-res') {
      const q = pendingByName.get(ev.name);
      if (q && q.length > 0) {
        const idx = q.shift()!;
        (blocks[idx] as ToolBlock).res = ev;
      }
    } else if (ev.t === 'message') {
      blocks.push({ kind: 'message', ev });
    } else if (ev.t === 'edit') {
      blocks.push({ kind: 'edit', ev });
    } else if (ev.t === 'steer') {
      blocks.push({ kind: 'steer', ev });
    } else if (ev.t === 'error') {
      blocks.push({ kind: 'error', ev });
    } else if (ev.t === 'spawn') {
      blocks.push({ kind: 'spawn', ev });
    } else if (ev.t === 'done') {
      blocks.push({ kind: 'done', ev });
    }
  }
  return blocks;
}

function ResultBody({ lines }: { lines: string[] }): React.ReactElement {
  const head = lines.slice(0, MAX_RESULT_LINES);
  const overflow = lines.length - head.length;
  return (
    <Box flexDirection="column">
      {head.map((line, i) => (
        <Box key={i}>
          <Text dimColor>{i === 0 ? '  ⎿ ' : '    '}</Text>
          <Text dimColor>{truncate(line, 160)}</Text>
        </Box>
      ))}
      {overflow > 0 ? (
        <Box>
          <Text dimColor>{'    '}</Text>
          <Text dimColor>… +{overflow} {overflow === 1 ? 'line' : 'lines'}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function renderBlock(block: Block, key: number): React.ReactElement {
  switch (block.kind) {
    case 'tool': {
      const argStr = formatToolArgs(block.ev.name, block.ev.args);
      const running = !block.res;
      return (
        <Box key={key} flexDirection="column">
          <Box>
            <Text color="green" bold>● </Text>
            <Text>{block.ev.name}</Text>
            <Text dimColor>({argStr})</Text>
          </Box>
          {running ? (
            <Box>
              <Text color="cyan" dimColor>  ⎿ running…</Text>
            </Box>
          ) : (
            <ResultBody lines={resultLines(block.res!.result)} />
          )}
        </Box>
      );
    }
    case 'message': {
      const role = block.ev.role;
      const color = role === 'assistant' ? undefined : 'cyan';
      const label = role === 'assistant' ? '●' : '◆';
      const firstLine = (block.ev.content ?? '').split('\n').find((l) => l.trim().length > 0) ?? '';
      const body = truncate(firstLine, 200);
      return (
        <Box key={key}>
          <Text color={color} bold>{label} </Text>
          <Text>{body}</Text>
        </Box>
      );
    }
    case 'edit': {
      return (
        <Box key={key}>
          <Text color="yellow" bold>✎ </Text>
          <Text>{basename(block.ev.file)}</Text>
          <Text dimColor> (+{block.ev.added} / -{block.ev.removed})</Text>
        </Box>
      );
    }
    case 'steer': {
      return (
        <Box key={key}>
          <Text color="magenta" bold>↻ </Text>
          <Text>steer: </Text>
          <Text dimColor>{truncate(block.ev.content, 180)}</Text>
        </Box>
      );
    }
    case 'error': {
      return (
        <Box key={key}>
          <Text color="red" bold>✗ </Text>
          <Text color="red">{truncate(block.ev.error, 200)}</Text>
        </Box>
      );
    }
    case 'spawn': {
      return (
        <Box key={key}>
          <Text dimColor>● spawned {block.ev.agent}{block.ev.model ? `:${block.ev.model}` : ''}</Text>
        </Box>
      );
    }
    case 'done': {
      const status = block.ev.result.status;
      const color = status === 'done' ? 'green' : status === 'error' ? 'red' : 'yellow';
      const glyph = status === 'done' ? '✓' : status === 'error' ? '✗' : '⚠';
      const text = block.ev.result.finalAssistantText;
      return (
        <Box key={key} flexDirection="column">
          <Box>
            <Text color={color} bold>{glyph} </Text>
            <Text color={color}>done ({status})</Text>
          </Box>
          {text ? (
            <ResultBody lines={text.split('\n')} />
          ) : null}
        </Box>
      );
    }
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
  const headerParts = [leaf.agent, leaf.model, leaf.status].filter(Boolean);

  const blocks = buildBlocks(leaf.leafEvents);
  const visible = blocks.slice(-MAX_BLOCKS);
  const dropped = blocks.length - visible.length;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{crumb}</Text>
        {headerParts.length > 0 ? (
          <>
            <Text dimColor>{'    '}</Text>
            <Text dimColor>{headerParts.join(' · ')}</Text>
          </>
        ) : null}
      </Box>
      <Box marginTop={1} />
      {dropped > 0 ? (
        <Box>
          <Text dimColor>… {dropped} earlier event{dropped === 1 ? '' : 's'} hidden</Text>
        </Box>
      ) : null}
      <Box flexDirection="column">
        {visible.map((b, i) => renderBlock(b, i))}
      </Box>
      <Box marginTop={1}>
        <Text>{'› steer: _              '}</Text>
        <Text dimColor>[Esc back  ⌘K abort  ⌘R restart]</Text>
      </Box>
    </Box>
  );
}

// Legacy one-liner summary kept for any other caller (plan CLI uses it).
export function eventSummary(ev: RunEvent): string {
  switch (ev.t) {
    case 'message':
      return `• ${truncate(ev.content, 120)}`;
    case 'tool':
      return `● ${ev.name}(${formatToolArgs(ev.name, ev.args)})`;
    case 'tool-res':
      return `  ⎿ ${truncate(resultLines(ev.result)[0] ?? '', 120)}`;
    case 'edit':
      return `✎ ${basename(ev.file)} (+${ev.added} -${ev.removed})`;
    case 'error':
      return `✗ ${truncate(ev.error, 160)}`;
    case 'steer':
      return `↻ steer: ${truncate(ev.content, 120)}`;
    case 'spawn':
      return `● spawned ${ev.agent}${ev.model ? `:${ev.model}` : ''}`;
    case 'done':
      return `${ev.result.status === 'done' ? '✓' : '✗'} done (${ev.result.status})`;
    default:
      return `• ${(ev as { t: string }).t}`;
  }
}
