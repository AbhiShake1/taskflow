import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs/promises')>();
  return { ...mod, mkdir: vi.fn(mod.mkdir) };
});

import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createProofApi } from '../core/proof';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proof-test-'));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('sanitize – empty name guard', () => {
  it('captureJson rejects an empty name', async () => {
    const api = createProofApi(dir);
    await expect(api.captureJson('', { x: 1 })).rejects.toThrow('proof: name must be non-empty');
  });

  it('captureFile rejects an empty name', async () => {
    const src = join(dir, 'src.txt');
    await writeFile(src, 'data', 'utf8');
    const api = createProofApi(dir);
    await expect(api.captureFile('', src)).rejects.toThrow('proof: name must be non-empty');
  });
});

describe('sanitize – SAFE_NAME substitution', () => {
  it('replaces unsafe characters with underscores in the output filename', async () => {
    const api = createProofApi(dir);
    const out = await api.captureJson('hello world/foo:bar', { v: 1 });
    expect(out).toMatch(/hello_world_foo_bar\.json$/);
  });
});

describe('ensureDir – idempotency', () => {
  it('calls mkdir exactly once across multiple capture calls', async () => {
    const api = createProofApi(dir);
    await api.captureJson('first', { a: 1 });
    await api.captureJson('second', { b: 2 });
    expect(vi.mocked(mkdir)).toHaveBeenCalledTimes(1);
  });
});

describe('captureJson – happy path', () => {
  it('writes valid JSON and returns the resolved output path', async () => {
    const api = createProofApi(dir);
    const value = { hello: 'world', n: 42 };
    const out = await api.captureJson('result', value);
    expect(out).toMatch(/result\.json$/);
    const raw = await readFile(out, 'utf8');
    expect(JSON.parse(raw)).toEqual(value);
  });
});

describe('captureFile – happy path', () => {
  it('copies the source file and returns the resolved output path', async () => {
    const src = join(dir, 'source.bin');
    await writeFile(src, 'payload', 'utf8');
    const api = createProofApi(join(dir, 'out'));
    const out = await api.captureFile('source.bin', src);
    expect(out).toMatch(/source\.bin$/);
    expect(await readFile(out, 'utf8')).toBe('payload');
  });
});
