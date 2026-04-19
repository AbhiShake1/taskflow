import { createHash } from 'node:crypto';

import { log, multiselect, isCancel } from '@clack/prompts';

import { buildUrlAndHeadersForRegistryItem } from './builder';
import { setRegistryHeaders } from './context';
import { discover, type DiscoverHit } from './discover';
import { RegistryFetchError } from './errors';
import { fetchRegistry, fetchRegistryLocal } from './fetcher';
import {
  fetchFromGitQualified,
  fetchFromGitShortcut,
  readRegistryItemFromCache,
} from './git';
import { parseSource, type SourceSpec } from './parser';
import type { RegistryConfig, RegistryItem } from './schema';
import { synthesizeFromDiscoverHit } from './synthesize';

export interface ResolvedItem {
  source: SourceSpec;
  item: RegistryItem;
  sourceUrl: string;
}

export interface ResolverOptions {
  yes?: boolean;
  silent?: boolean;
  cwd?: string;
}

type ResolverConfig = { registries?: RegistryConfig; style?: string } | null;

export function isBareRepoShortcut(spec: SourceSpec): boolean {
  return (
    spec.kind === 'shortcut' &&
    (spec.subpath === undefined || spec.subpath === '')
  );
}

function shortcutSourceString(
  host: string,
  user: string,
  repo: string,
  path: string,
  branch: string,
): string {
  return `${host}:${user}/${repo}/${path}#${branch}`;
}

export async function discoverAndSynthesize(
  spec: Extract<SourceSpec, { kind: 'shortcut' }>,
  opts: ResolverOptions,
): Promise<ResolvedItem[]> {
  const repoRef = `${spec.user}/${spec.repo}`;
  const response = await discover({ repo: repoRef, limit: 50 });
  const hits = response.hits;

  if (hits.length === 0) {
    throw new Error(
      `No taskflow harnesses found in ${repoRef}. If this repo ships a registry-item.json, pass the path explicitly.`,
    );
  }

  const chosen: DiscoverHit[] =
    hits.length === 1
      ? [hits[0]]
      : await pickHits(hits, spec, opts);

  const resolved: ResolvedItem[] = [];
  for (const hit of chosen) {
    const result = await synthesizeFromDiscoverHit(hit);
    if ('reject' in result) {
      if (opts.silent !== true) {
        log.warn(`Skipping ${hit.repo}/${hit.path}: ${result.reason}`);
      }
      continue;
    }
    const derivedSpec: SourceSpec = {
      kind: 'shortcut',
      host: spec.host,
      user: spec.user,
      repo: spec.repo,
      subpath: hit.path,
      ref: hit.branch,
    };
    resolved.push({
      source: derivedSpec,
      item: result.item,
      sourceUrl: shortcutSourceString(
        spec.host,
        spec.user,
        spec.repo,
        hit.path,
        hit.branch,
      ),
    });
  }
  return resolved;
}

async function pickHits(
  hits: DiscoverHit[],
  spec: Extract<SourceSpec, { kind: 'shortcut' }>,
  opts: ResolverOptions,
): Promise<DiscoverHit[]> {
  const repoRef = `${spec.user}/${spec.repo}`;
  if (opts.yes === true) {
    throw new Error(
      `Multiple harnesses discovered in ${repoRef}; re-run without --yes and pick which to install, or pass a specific path (user/repo/path/to/file.ts).`,
    );
  }
  const choices = hits.map((hit) => {
    const firstLine = hit.matchLines[0]?.content ?? '';
    const hint = firstLine.slice(0, 60);
    return { value: hit, label: hit.path, hint };
  });
  const picked = await multiselect<DiscoverHit>({
    message: `Discovered ${hits.length} harnesses in ${repoRef}. Pick which to install:`,
    options: choices,
    required: true,
  });
  if (isCancel(picked)) {
    throw new Error('taskflow add: discovery selection cancelled');
  }
  return picked as DiscoverHit[];
}

function normalizeSourceKey(input: string): string {
  return input.trim();
}

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function fetchHttpsWithIntegrity(
  url: string,
  sha256?: string,
): Promise<RegistryItem> {
  if (!sha256) return fetchRegistry(url);
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new RegistryFetchError(url, undefined, 'globalThis.fetch is not available; use Node.js 20+.');
  }
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RegistryFetchError(url, undefined, detail);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new RegistryFetchError(url, response.status, body.slice(0, 200));
  }
  const raw = new Uint8Array(await response.arrayBuffer());
  const actual = sha256Hex(raw);
  if (actual !== sha256) {
    throw new RegistryFetchError(url, response.status, `sha256 mismatch: expected ${sha256}, got ${actual}`);
  }
  const text = new TextDecoder('utf-8').decode(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RegistryFetchError(url, response.status, `invalid JSON: ${detail}`);
  }
  const { registryItemSchema } = await import('./schema');
  const parsed = registryItemSchema.safeParse(json);
  if (!parsed.success) {
    const { RegistryParseError } = await import('./errors');
    throw new RegistryParseError(url, parsed.error);
  }
  return parsed.data;
}

async function resolveOne(
  input: string,
  config: ResolverConfig,
  opts: ResolverOptions,
): Promise<ResolvedItem[]> {
  const source = parseSource(input);

  if (source.kind === 'local') {
    const item = await fetchRegistryLocal(source.path);
    return [{ source, item, sourceUrl: source.path }];
  }

  if (source.kind === 'url') {
    const item = await fetchRegistry(source.url);
    return [{ source, item, sourceUrl: source.url }];
  }

  if (source.kind === 'qualified') {
    if (source.type === 'file') {
      const item = await fetchRegistryLocal(source.url);
      return [{ source, item, sourceUrl: source.url }];
    }
    if (source.type === 'https') {
      const item = await fetchHttpsWithIntegrity(source.url, source.sha256);
      return [{ source, item, sourceUrl: source.url }];
    }
    const gitOpts: { ref?: string; sha256?: string; depth?: number; subpath?: string } = {};
    if (source.ref !== undefined) gitOpts.ref = source.ref;
    if (source.sha256 !== undefined) gitOpts.sha256 = source.sha256;
    if (source.depth !== undefined) gitOpts.depth = source.depth;
    if (source.subpath !== undefined) gitOpts.subpath = source.subpath;
    const fetched = await fetchFromGitQualified(source.url, gitOpts);
    const item = await readRegistryItemFromCache(fetched.cacheDir, source.subpath);
    return [{ source, item, sourceUrl: source.url }];
  }

  if (source.kind === 'shortcut') {
    if (isBareRepoShortcut(source)) {
      // Try conventional registry-item.json at repo root first; if that
      // fails, fall back to discovery.
      try {
        const probeSource = { ...source, subpath: 'registry-item.json' };
        const gitSource = {
          host: probeSource.host,
          user: probeSource.user,
          repo: probeSource.repo,
          ...(probeSource.ref !== undefined ? { ref: probeSource.ref } : {}),
          subpath: 'registry-item.json',
        };
        const fetched = await fetchFromGitShortcut(gitSource);
        const item = await readRegistryItemFromCache(
          fetched.cacheDir,
          'registry-item.json',
        );
        const sourceUrl = `${source.host}:${source.user}/${source.repo}/registry-item.json${source.ref ? `#${source.ref}` : ''}`;
        return [{ source, item, sourceUrl }];
      } catch {
        // Fall through to discovery.
      }
      return discoverAndSynthesize(source, opts);
    }
    const gitSource = {
      host: source.host,
      user: source.user,
      repo: source.repo,
      ...(source.ref !== undefined ? { ref: source.ref } : {}),
      ...(source.subpath !== undefined ? { subpath: source.subpath } : {}),
    };
    const fetched = await fetchFromGitShortcut(gitSource);
    const item = await readRegistryItemFromCache(fetched.cacheDir, source.subpath);
    const sourceUrl = `${source.host}:${source.user}/${source.repo}${source.subpath ? `/${source.subpath}` : ''}${source.ref ? `#${source.ref}` : ''}`;
    return [{ source, item, sourceUrl }];
  }

  if (source.kind === 'namespace') {
    const key = `${source.namespace}/${source.item}`;
    const built = buildUrlAndHeadersForRegistryItem(key, config);
    if (!built) throw new RegistryFetchError(key, undefined, 'Failed to build registry URL.');
    setRegistryHeaders({ [built.url]: built.headers });
    const item = await fetchRegistry(built.url, built.headers);
    return [{ source, item, sourceUrl: built.url }];
  }

  const built = buildUrlAndHeadersForRegistryItem(source.name, config);
  if (!built) throw new RegistryFetchError(source.name, undefined, 'Failed to build registry URL.');
  setRegistryHeaders({ [built.url]: built.headers });
  const item = await fetchRegistry(built.url, built.headers);
  return [{ source, item, sourceUrl: built.url }];
}

export async function fetchRegistryItems(
  inputs: string[],
  config: ResolverConfig,
  opts: ResolverOptions = {},
): Promise<ResolvedItem[]> {
  const batches = await Promise.all(
    inputs.map((input) => resolveOne(input, config, opts)),
  );
  return batches.flat();
}

export async function resolveRegistryTree(
  inputs: string[],
  config: ResolverConfig,
  opts: ResolverOptions = {},
): Promise<ResolvedItem[]> {
  const resolvedByName = new Map<string, ResolvedItem>();
  const insertionOrder: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const input of inputs) {
    const key = normalizeSourceKey(input);
    if (visited.has(key)) continue;
    visited.add(key);
    queue.push(input);
  }

  while (queue.length > 0) {
    const input = queue.shift() as string;
    const resolvedBatch = await resolveOne(input, config, opts);
    for (const resolved of resolvedBatch) {
      const name = resolved.item.name;
      if (!resolvedByName.has(name)) {
        resolvedByName.set(name, resolved);
        insertionOrder.push(name);
      }
      const deps = resolved.item.registryDependencies ?? [];
      for (const dep of deps) {
        const depKey = normalizeSourceKey(dep);
        if (visited.has(depKey)) continue;
        visited.add(depKey);
        queue.push(dep);
      }
    }
  }

  const itemsByName = new Map<string, ResolvedItem>();
  for (const name of insertionOrder) {
    const item = resolvedByName.get(name);
    if (item) itemsByName.set(name, item);
  }

  const nameSet = new Set(itemsByName.keys());
  const adjacency = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const name of itemsByName.keys()) {
    adjacency.set(name, new Set());
    inDegree.set(name, 0);
  }
  for (const [name, resolved] of itemsByName) {
    const deps = resolved.item.registryDependencies ?? [];
    for (const dep of deps) {
      let depName: string | null = null;
      for (const candidate of nameSet) {
        if (dep === candidate || dep.endsWith(`/${candidate}`) || dep === `./${candidate}.json`) {
          depName = candidate;
          break;
        }
      }
      if (!depName) continue;
      if (depName === name) continue;
      const depEdges = adjacency.get(depName) as Set<string>;
      if (!depEdges.has(name)) {
        depEdges.add(name);
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
      }
    }
  }

  const sorted: string[] = [];
  const ready: string[] = [];
  for (const name of insertionOrder) {
    if ((inDegree.get(name) ?? 0) === 0) ready.push(name);
  }
  while (ready.length > 0) {
    const name = ready.shift() as string;
    sorted.push(name);
    const edges = adjacency.get(name) ?? new Set<string>();
    for (const next of edges) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  if (sorted.length !== itemsByName.size) {
    const leftover = insertionOrder.filter((n) => !sorted.includes(n));
    console.warn(
      `taskflow: cycle detected in registry dependencies: ${leftover.join(', ')}. Installing in insertion order.`,
    );
    for (const name of leftover) sorted.push(name);
  }

  const out: ResolvedItem[] = [];
  for (const name of sorted) {
    const item = itemsByName.get(name);
    if (item) out.push(item);
  }
  return out;
}
