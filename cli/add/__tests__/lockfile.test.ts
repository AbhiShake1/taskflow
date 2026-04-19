import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertFrozen, lockfileHandle } from '../lockfile';
import type { LockItem } from '../registry/schema';

describe('lockfileHandle', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-lock-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns empty default when file does not exist', async () => {
    const lf = lockfileHandle(cwd);
    const lock = await lf.read();
    expect(lock).toEqual({ version: '1', items: {} });
  });

  it('round-trips upsert + read', async () => {
    const lf = lockfileHandle(cwd);
    const entry: LockItem = {
      source: 'https://r.example/a.json',
      type: 'taskflow:harness',
      sha256: 'abc123',
    };
    await lf.upsert('a', entry);
    const lock = await lf.read();
    expect(lock.items.a).toEqual(entry);
  });

  it('upsert preserves prior entries', async () => {
    const lf = lockfileHandle(cwd);
    await lf.upsert('a', { source: 'A', type: 'taskflow:harness' });
    await lf.upsert('b', { source: 'B', type: 'taskflow:harness' });
    const lock = await lf.read();
    expect(Object.keys(lock.items).sort()).toEqual(['a', 'b']);
  });

  it('write pretty-prints JSON (2-space indent, trailing newline)', async () => {
    const lf = lockfileHandle(cwd);
    await lf.write({
      version: '1',
      items: { a: { source: 'A', type: 'taskflow:harness' } },
    });
    const raw = readFileSync(lf.path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "items"');
    // Ensure indent depth is visible
    expect(raw).toContain('    "a"');
  });

  it('remove deletes an entry', async () => {
    const lf = lockfileHandle(cwd);
    await lf.upsert('a', { source: 'A', type: 'taskflow:harness' });
    await lf.upsert('b', { source: 'B', type: 'taskflow:harness' });
    await lf.remove('a');
    const lock = await lf.read();
    expect(Object.keys(lock.items)).toEqual(['b']);
  });
});

describe('assertFrozen', () => {
  it('no-op when source matches and sha matches', () => {
    expect(() =>
      assertFrozen(
        {
          version: '1',
          items: {
            a: { source: 'S', type: 'taskflow:harness', sha256: 'x' },
          },
        },
        { a: { source: 'S', type: 'taskflow:harness', sha256: 'x' } },
      ),
    ).not.toThrow();
  });

  it('no-op when sha256 is missing on either side', () => {
    expect(() =>
      assertFrozen(
        { version: '1', items: { a: { source: 'S', type: 'taskflow:harness' } } },
        { a: { source: 'S', type: 'taskflow:harness', sha256: 'x' } },
      ),
    ).not.toThrow();
    expect(() =>
      assertFrozen(
        {
          version: '1',
          items: { a: { source: 'S', type: 'taskflow:harness', sha256: 'x' } },
        },
        { a: { source: 'S', type: 'taskflow:harness' } },
      ),
    ).not.toThrow();
  });

  it('throws on missing lockfile entry', () => {
    expect(() =>
      assertFrozen(
        { version: '1', items: {} },
        { a: { source: 'S', type: 'taskflow:harness' } },
      ),
    ).toThrow(/missing from lockfile/);
  });

  it('throws on source drift', () => {
    expect(() =>
      assertFrozen(
        { version: '1', items: { a: { source: 'OLD', type: 'taskflow:harness' } } },
        { a: { source: 'NEW', type: 'taskflow:harness' } },
      ),
    ).toThrow(/source drift/);
  });

  it('throws on sha256 drift', () => {
    expect(() =>
      assertFrozen(
        {
          version: '1',
          items: { a: { source: 'S', type: 'taskflow:harness', sha256: 'x' } },
        },
        { a: { source: 'S', type: 'taskflow:harness', sha256: 'y' } },
      ),
    ).toThrow(/sha256 drift/);
  });
});
