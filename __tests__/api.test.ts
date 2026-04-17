import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskflow, parseWith, _buildTree } from '../api';
import mockAdapter from '../adapters/mock';

let runsDir: string;

beforeEach(() => {
  runsDir = join(tmpdir(), 'api-test-' + Math.random().toString(36).slice(2));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

describe('parseWith', () => {
  it('splits agent and model on the first colon', () => {
    expect(parseWith('claude-code:sonnet')).toEqual({ agent: 'claude-code', model: 'sonnet' });
  });

  it('returns no model when there is no colon', () => {
    expect(parseWith('pi')).toEqual({ agent: 'pi', model: undefined });
  });

  it('keeps remaining colons inside the model portion', () => {
    expect(parseWith('pi:anthropic/claude-opus-4-7:thinking')).toEqual({
      agent: 'pi',
      model: 'anthropic/claude-opus-4-7:thinking',
    });
  });

  it('throws a clear error for unknown agents', () => {
    expect(() => parseWith('gpt-4')).toThrowError(/unknown agent/);
    expect(() => parseWith('gpt-4:something')).toThrowError(/claude-code\|pi\|codex\|cursor\|opencode/);
  });
});

describe('tree construction', () => {
  it('single phase with a single session maps with/task correctly', () => {
    const root = _buildTree('t', ({ phase }) => {
      phase('s').session('l', { with: 'claude-code:sonnet', task: 't' });
    });

    expect(root.children).toHaveLength(1);
    const s = root.children[0] as any;
    expect(s.kind).toBe('phase');
    expect(s.name).toBe('s');
    expect(s.children).toHaveLength(1);

    const session = s.children[0];
    expect(session.kind).toBe('session');
    expect(session.spec).toMatchObject({
      id: 'l',
      agent: 'claude-code',
      model: 'sonnet',
      task: 't',
    });
    expect(session.spec.claims).toBeUndefined();
  });

  it('.parallel(count, factory) creates N parallel-marked sessions', () => {
    const root = _buildTree('t', ({ phase }) => {
      phase('f').parallel(3, (i) => ({
        id: `shard-${i}`,
        with: 'opencode:x',
        task: `t${i}`,
      }));
    });

    const s = root.children[0] as any;
    expect(s.children).toHaveLength(1);
    const group = s.children[0];
    expect(group.kind).toBe('group');
    expect(group.mode).toBe('parallel');
    expect(group.children.map((c: any) => c.id)).toEqual(['shard-0', 'shard-1', 'shard-2']);
    expect(group.children.every((c: any) => c.spec.agent === 'opencode' && c.spec.model === 'x')).toBe(true);
  });

  it('.parallel(items, factory) iterates over the provided array', () => {
    const root = _buildTree('t', ({ phase }) => {
      phase('f').parallel(['a', 'b'], (item, i) => ({
        id: `x-${item}-${i}`,
        with: 'claude-code',
        task: `handle ${item}`,
      }));
    });

    const group = (root.children[0] as any).children[0];
    expect(group.mode).toBe('parallel');
    expect(group.children.map((c: any) => c.id)).toEqual(['x-a-0', 'x-b-1']);
    // 'claude-code' with no colon → no model
    expect(group.children[0].spec.model).toBeUndefined();
  });

  it('.serial(count, factory) creates a serial group', () => {
    const root = _buildTree('t', ({ phase }) => {
      phase('f').serial(2, (i) => ({ id: `step-${i}`, with: 'pi', task: `t${i}` }));
    });
    const group = (root.children[0] as any).children[0];
    expect(group.mode).toBe('serial');
    expect(group.children).toHaveLength(2);
  });

  it('nested phase(name, cb) attaches children to the inner phase', () => {
    const root = _buildTree('t', ({ phase }) => {
      phase('outer', ({ phase: innerPhase }) => {
        innerPhase('inner').session('l', { with: 'claude-code:sonnet', task: 't' });
      });
    });

    const outer = root.children[0] as any;
    expect(outer.name).toBe('outer');
    expect(outer.children).toHaveLength(1);
    const inner = outer.children[0];
    expect(inner.kind).toBe('phase');
    expect(inner.name).toBe('inner');
    expect(inner.children[0].kind).toBe('session');
    expect(inner.children[0].id).toBe('l');
  });

  it('write is translated to claims on the engine spec', () => {
    const root = _buildTree('t', ({ phase }) => {
      phase('s').session('x', {
        with: 'claude-code:sonnet',
        task: 't',
        write: ['out/a/**'],
      });
    });
    const session = (root.children[0] as any).children[0];
    expect(session.spec.claims).toEqual(['out/a/**']);
  });

  it('throws on unknown agent during build', () => {
    expect(() =>
      _buildTree('t', ({ phase }) => {
        phase('s').session('x', { with: 'gpt-4:foo', task: 't' } as any);
      }),
    ).toThrowError(/unknown agent/);
  });

  it('parallel/serial factory must return an id', () => {
    expect(() =>
      _buildTree('t', ({ phase }) => {
        phase('f').parallel(2, (_i) => ({ with: 'pi', task: 't' } as any));
      }),
    ).toThrowError(/must return a spec with an "id"/);
  });
});

describe('end-to-end via mock adapter', () => {
  it('executes the full fluent syntax and produces a clean manifest', async () => {
    const { manifest } = await taskflow('scrape-don-smoke')
      .run(
        ({ phase }) => {
          phase('discover').session('discover-urls', {
            with: 'claude-code:sonnet',
            task: 'Discover all URLs',
            write: ['data/urls.json'],
          });

          phase('fetch').parallel(3, (i) => ({
            id: `shard-${i}`,
            with: 'opencode:groq/llama-3.3-70b',
            task: `Fetch shard ${i}`,
            write: [`data/shard-${i}/**`],
          }));

          phase('ingest').session('merge', {
            with: 'pi:anthropic/claude-opus-4-7',
            task: 'Merge',
            write: ['data/merged.json'],
          });
        },
        {
          runsDir,
          runId: 'e2e',
          adapterOverride: async () => mockAdapter,
        },
      );

    expect(manifest.exitCode).toBe(0);
    expect(manifest.leaves).toHaveLength(1 + 3 + 1);
    expect(manifest.leaves.every((l) => l.status === 'done')).toBe(true);
    expect(manifest.stages).toEqual(['discover', 'fetch', 'ingest']);
    const ids = manifest.leaves.map((l) => l.id).sort();
    expect(ids).toEqual(['discover-urls', 'merge', 'shard-0', 'shard-1', 'shard-2']);
  });

  it('nested phase(name, cb) executes children in the correct parent', async () => {
    const { manifest } = await taskflow('nested')
      .run(
        ({ phase }) => {
          phase('outer', ({ phase: inner }) => {
            inner('inner').session('l', { with: 'claude-code:sonnet', task: 't' });
          });
        },
        { runsDir, runId: 'nested', adapterOverride: async () => mockAdapter },
      );

    expect(manifest.exitCode).toBe(0);
    expect(manifest.stages).toEqual(['outer', 'inner']);
    expect(manifest.leaves).toHaveLength(1);
    expect(manifest.leaves[0].id).toBe('l');
  });
});
