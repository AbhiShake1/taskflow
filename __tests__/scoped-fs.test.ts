import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScopedFs } from '../core/scoped-fs';

let root: string;
let fs: ReturnType<typeof createScopedFs>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scoped-fs-test-'));
  fs = createScopedFs(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveUnderRoot – path escape boundary', () => {
  it('allows a simple relative path', async () => {
    await fs.write('hello.txt', 'world');
    const content = await fs.read('hello.txt');
    expect(content).toBe('world');
  });

  it('allows a nested relative path', async () => {
    await fs.write('a/b/c.txt', 'nested');
    const content = await fs.read('a/b/c.txt');
    expect(content).toBe('nested');
  });

  it('rejects ../ traversal on read', async () => {
    await expect(fs.read('../outside.txt')).rejects.toThrow('scoped-fs: path escapes root');
  });

  it('rejects ../ traversal on write', async () => {
    await expect(fs.write('../outside.txt', 'x')).rejects.toThrow('scoped-fs: path escapes root');
  });

  it('rejects absolute path on read', async () => {
    await expect(fs.read('/etc/passwd')).rejects.toThrow('scoped-fs: path escapes root');
  });

  it('rejects absolute path on write', async () => {
    await expect(fs.write('/tmp/evil.txt', 'x')).rejects.toThrow('scoped-fs: path escapes root');
  });

  it('rejects path that normalises outside root', async () => {
    await expect(fs.read('subdir/../../outside.txt')).rejects.toThrow('scoped-fs: path escapes root');
  });

  it('rejects ../ traversal on mkdir', async () => {
    await expect(fs.mkdir('../outside')).rejects.toThrow('scoped-fs: path escapes root');
  });

  it('rejects ../ traversal on list', async () => {
    await expect(fs.list('../outside')).rejects.toThrow('scoped-fs: path escapes root');
  });
});

describe('createScopedFs – happy-path operations', () => {
  it('mkdir creates a directory', async () => {
    await fs.mkdir('mydir');
    const entries = await fs.list('.');
    expect(entries).toContain('mydir');
  });

  it('list returns files written into a directory', async () => {
    await fs.write('dir/alpha.txt', 'a');
    await fs.write('dir/beta.txt', 'b');
    const entries = await fs.list('dir');
    expect(entries.sort()).toEqual(['alpha.txt', 'beta.txt']);
  });

  it('write then read round-trips content', async () => {
    const data = 'round-trip content';
    await fs.write('data.txt', data);
    expect(await fs.read('data.txt')).toBe(data);
  });
});
