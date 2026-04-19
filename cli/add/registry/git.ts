import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve as resolvePath } from 'node:path';

import {
  RegistryFetchError,
  RegistryLocalFileError,
  RegistryParseError,
} from './errors';
import { registryItemSchema, type RegistryItem } from './schema';

export interface GitSource {
  host: 'github' | 'gitlab' | 'bitbucket';
  user: string;
  repo: string;
  ref?: string;
  subpath?: string;
}

export interface GitFetchResult {
  cacheDir: string;
  resolvedRef: string;
  sha256: string;
}

const SENTINEL = '.taskflow.fetched';
const SHA_RE = /^[0-9a-f]{40}$/i;

function cacheRoot(): string {
  return join(homedir(), '.taskflow', 'cache');
}

function cacheDirFor(url: string, ref: string): string {
  const h = createHash('sha256').update(`${url}\0${ref}`).digest('hex');
  return join(cacheRoot(), h);
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

async function hashFile(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

async function hashTree(root: string): Promise<string> {
  const files = await walkFiles(root);
  const entries: string[] = [];
  for (const file of files) {
    const rel = relative(root, file).split('\\').join('/');
    if (rel === SENTINEL) continue;
    const fileHash = await hashFile(file);
    entries.push(`${rel}\0${fileHash}`);
  }
  entries.sort();
  const h = createHash('sha256');
  for (const e of entries) {
    h.update(e);
    h.update('\n');
  }
  return h.digest('hex');
}

function ensureBinary(binary: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): void {
  const result = spawnSync(binary, args, { stdio: 'pipe', encoding: 'utf8', ...options });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(`taskflow: '${binary}' not found on PATH`);
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const detail = stderr || stdout || `exit code ${result.status}`;
    throw new Error(`taskflow: '${binary} ${args.join(' ')}' failed: ${detail}`);
  }
}

async function writeSentinel(dir: string, payload: Record<string, string>): Promise<void> {
  await writeFile(join(dir, SENTINEL), JSON.stringify(payload, null, 2), 'utf8');
}

async function readSentinel(dir: string): Promise<Record<string, string> | null> {
  try {
    const raw = await readFile(join(dir, SENTINEL), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

function shortcutTarballUrl(src: GitSource): { url: string; ref: string } {
  const ref = src.ref ?? 'HEAD';
  if (src.host === 'github') {
    return { url: `https://codeload.github.com/${src.user}/${src.repo}/tar.gz/${ref}`, ref };
  }
  if (src.host === 'gitlab') {
    const effectiveRef = src.ref ?? 'HEAD';
    return {
      url: `https://gitlab.com/${src.user}/${src.repo}/-/archive/${effectiveRef}/${src.repo}-${effectiveRef}.tar.gz`,
      ref: effectiveRef,
    };
  }
  return { url: `https://bitbucket.org/${src.user}/${src.repo}/get/${ref}.tar.gz`, ref };
}

async function downloadToFile(url: string, destFile: string, headers: Record<string, string>): Promise<void> {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new RegistryFetchError(url, undefined, 'globalThis.fetch is not available; use Node.js 20+.');
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { headers });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RegistryFetchError(url, undefined, detail);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new RegistryFetchError(url, response.status, body.slice(0, 200));
  }
  const buf = Buffer.from(await response.arrayBuffer());
  await writeFile(destFile, buf);
}

async function extractTarball(archive: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  ensureBinary('tar', ['-xzf', archive, '-C', destDir, '--strip-components=1']);
}

export async function fetchFromGitShortcut(src: GitSource): Promise<GitFetchResult> {
  const { url, ref } = shortcutTarballUrl(src);
  const dir = cacheDirFor(url, ref);
  if (existsSync(join(dir, SENTINEL))) {
    const meta = await readSentinel(dir);
    if (meta && meta.sha256 && meta.resolvedRef) {
      return { cacheDir: dir, resolvedRef: meta.resolvedRef, sha256: meta.sha256 };
    }
  }

  const headers: Record<string, string> = {};
  if (src.host === 'github' && process.env.GH_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), 'taskflow-tar-'));
  const archive = join(tmp, 'archive.tar.gz');
  try {
    await downloadToFile(url, archive, headers);
    await extractTarball(archive, dir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const sha256 = await hashTree(dir);
  await writeSentinel(dir, { url, resolvedRef: ref, sha256 });
  return { cacheDir: dir, resolvedRef: ref, sha256 };
}

export async function fetchFromGitQualified(
  url: string,
  opts: { ref?: string; sha256?: string; depth?: number; subpath?: string },
): Promise<GitFetchResult> {
  void opts.subpath;
  const ref = opts.ref ?? 'HEAD';
  const dir = cacheDirFor(url, ref);
  if (existsSync(join(dir, SENTINEL))) {
    const meta = await readSentinel(dir);
    if (meta && meta.sha256 && meta.resolvedRef) {
      if (!opts.sha256 || opts.sha256 === meta.sha256) {
        return { cacheDir: dir, resolvedRef: meta.resolvedRef, sha256: meta.sha256 };
      }
    }
  }

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const isSha = opts.ref !== undefined && SHA_RE.test(opts.ref);
  const depth = Math.max(1, opts.depth ?? 1);

  if (isSha) {
    ensureBinary('git', ['clone', '--no-checkout', url, dir]);
    ensureBinary('git', ['checkout', opts.ref as string], { cwd: dir });
  } else {
    const cloneArgs = ['clone', `--depth=${depth}`];
    if (opts.ref) cloneArgs.push('--branch', opts.ref);
    cloneArgs.push(url, dir);
    ensureBinary('git', cloneArgs);
  }

  let resolvedRef = opts.ref ?? 'HEAD';
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  if (headResult.status === 0 && typeof headResult.stdout === 'string') {
    resolvedRef = headResult.stdout.trim() || resolvedRef;
  }

  await rm(join(dir, '.git'), { recursive: true, force: true });

  const sha256 = await hashTree(dir);
  if (opts.sha256 && opts.sha256 !== sha256) {
    await rm(dir, { recursive: true, force: true });
    throw new RegistryFetchError(
      url,
      undefined,
      `sha256 mismatch: expected ${opts.sha256}, got ${sha256}`,
    );
  }
  await writeSentinel(dir, { url, resolvedRef, sha256 });
  return { cacheDir: dir, resolvedRef, sha256 };
}

export async function readRegistryItemFromCache(
  cacheDir: string,
  subpath?: string,
): Promise<RegistryItem> {
  const base = resolvePath(cacheDir, subpath ?? '');
  let filePath: string;
  if (subpath && subpath.endsWith('.json')) {
    filePath = base;
  } else {
    let isDir = false;
    try {
      const s = await stat(base);
      isDir = s.isDirectory();
    } catch {
      isDir = false;
    }
    filePath = isDir ? join(base, 'registry-item.json') : base;
  }

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new RegistryLocalFileError(filePath, err);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new RegistryParseError(filePath, err);
  }
  const parsed = registryItemSchema.safeParse(json);
  if (!parsed.success) throw new RegistryParseError(filePath, parsed.error);
  return parsed.data;
}
