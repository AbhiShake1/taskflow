import { log } from '@clack/prompts';

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

export async function runSearch(opts: SearchOptions): Promise<void> {
  const base = process.env.TASKFLOW_REGISTRY_URL ?? process.env.REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
  const url = `${base.replace(/\/$/, '')}/registries.json`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (!opts.silent) log.warn(`No registry index found (fetch failed: ${detail})`);
    return;
  }
  if (!response.ok) {
    if (!opts.silent) log.info(`No registry index found (HTTP ${response.status})`);
    return;
  }

  let index: Index;
  try {
    const text = await response.text();
    index = JSON.parse(text) as Index;
  } catch (err) {
    if (!opts.silent) log.warn(`Registry index is malformed: ${(err as Error).message}`);
    return;
  }

  const matches = (index.items ?? [])
    .map((entry) => ({ entry, score: score(entry, opts.query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (matches.length === 0) {
    process.stdout.write(`no matches for "${opts.query}"\n`);
    return;
  }

  for (const { entry } of matches) {
    const desc = entry.description ? ` — ${entry.description}` : '';
    process.stdout.write(`${entry.name}${desc}\n`);
  }
}
