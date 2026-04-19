import { log } from '@clack/prompts';
import { discover, type DiscoverHit } from './registry/discover';

const DEFAULT_REGISTRY_URL = 'https://taskflow.sh/r';

interface IndexEntry {
  name: string;
  description?: string;
  homepage?: string;
}

interface Index {
  items: IndexEntry[];
}

export interface SearchOptions {
  query: string;
  cwd: string;
  silent?: boolean;
}

function score(entry: IndexEntry, query: string): number {
  const q = query.toLowerCase();
  let s = 0;
  if (entry.name.toLowerCase().includes(q)) s += 10;
  if (entry.description && entry.description.toLowerCase().includes(q)) s += 3;
  return s;
}

interface RegistrySearchResult {
  kind: 'registry';
  entry: IndexEntry;
}

interface DiscoverSearchResult {
  kind: 'discover';
  hit: DiscoverHit;
}

async function fetchRegistryIndex(
  silent: boolean,
): Promise<IndexEntry[] | null> {
  const base = process.env.TASKFLOW_REGISTRY_URL ?? process.env.REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const url = `${base.replace(/\/$/, '')}/registries.json`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (!silent) log.warn(`No registry index found (fetch failed: ${detail})`);
    return null;
  }
  if (!response.ok) {
    if (!silent) log.info(`No registry index found (HTTP ${response.status})`);
    return null;
  }

  try {
    const text = await response.text();
    const index = JSON.parse(text) as Index;
    return index.items ?? [];
  } catch (err) {
    if (!silent) log.warn(`Registry index is malformed: ${(err as Error).message}`);
    return null;
  }
}

export async function runSearch(opts: SearchOptions): Promise<void> {
  const silent = opts.silent === true;

  const registryPromise = fetchRegistryIndex(silent);
  const discoverPromise = discover({ query: opts.query, limit: 25 }).catch(
    (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      if (!silent) log.warn(`Discovery unavailable: ${detail}`);
      return null;
    },
  );

  const [indexItems, discovered] = await Promise.all([
    registryPromise,
    discoverPromise,
  ]);

  const registryMatches: RegistrySearchResult[] = (indexItems ?? [])
    .map((entry) => ({ entry, score: score(entry, opts.query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => ({ kind: 'registry' as const, entry }));

  const discoverMatches: DiscoverSearchResult[] =
    discovered === null
      ? []
      : discovered.hits.map((hit) => ({ kind: 'discover' as const, hit }));

  if (registryMatches.length === 0 && discoverMatches.length === 0) {
    process.stdout.write(`no matches for "${opts.query}"\n`);
    return;
  }

  if (registryMatches.length > 0) {
    process.stdout.write('from registry index:\n');
    for (const { entry } of registryMatches) {
      const desc = entry.description ? ` — ${entry.description}` : '';
      process.stdout.write(`  ${entry.name}${desc}\n`);
    }
  }

  if (discoverMatches.length > 0) {
    process.stdout.write('from github (discovery):\n');
    for (const { hit } of discoverMatches) {
      const firstMatch = hit.matchLines[0]?.content?.trim() ?? '';
      const suffix = firstMatch.length > 0 ? `   # matched: ${firstMatch}` : '';
      process.stdout.write(`  ${hit.repo} — ${hit.path}${suffix}\n`);
    }
  }
}
