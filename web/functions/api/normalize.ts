/**
 * Pure helpers for turning grep.app / GitHub Code Search responses into
 * `DiscoverHit[]`. Split out of `discover.ts` so unit tests can import them
 * without dragging in `@cloudflare/puppeteer` (which requires the Workers
 * runtime).
 */

export interface DiscoverHit {
  repo: string;
  branch: string;
  path: string;
  sha?: string;
  matchLines: Array<{ lineNo: number; content: string }>;
  url: string;
  rawUrl: string;
}

export function normalizeGrepApp(raw: unknown): DiscoverHit[] {
  if (!isObject(raw)) return [];
  // grep.app's shape is undocumented — try several plausible roots so minor
  // API drift doesn't break discovery.
  const candidates: unknown[] = [];
  if (Array.isArray((raw as { hits?: unknown }).hits)) {
    candidates.push(...(raw as { hits: unknown[] }).hits);
  }
  const nested = (raw as { hits?: { hits?: unknown } }).hits;
  if (isObject(nested) && Array.isArray(nested.hits)) {
    candidates.push(...(nested.hits as unknown[]));
  }
  if (Array.isArray((raw as { results?: unknown }).results)) {
    candidates.push(...(raw as { results: unknown[] }).results);
  }

  const out: DiscoverHit[] = [];
  for (const item of candidates) {
    const hit = grepAppItemToHit(item);
    if (hit) out.push(hit);
  }
  return out;
}

function grepAppItemToHit(item: unknown): DiscoverHit | null {
  if (!isObject(item)) return null;
  const repoField = (item as { repo?: unknown }).repo;
  const repoRaw =
    typeof repoField === 'string'
      ? repoField
      : isObject(repoField)
        ? (getStr(repoField, 'raw') ?? getStr(repoField, 'name'))
        : undefined;
  const branch = getStr(item, 'branch') ?? getStr(item, 'ref') ?? 'main';
  const pathField = (item as { path?: unknown }).path;
  const path =
    typeof pathField === 'string'
      ? pathField
      : isObject(pathField)
        ? getStr(pathField, 'raw')
        : undefined;
  if (!repoRaw || !path) return null;

  const sha = getStr(item, 'sha') ?? getStr(item, 'commit');
  const matchLines = extractGrepAppMatchLines(item);

  return {
    repo: repoRaw,
    branch,
    path,
    sha: sha ?? undefined,
    matchLines,
    url: `https://github.com/${repoRaw}/blob/${branch}/${path}`,
    rawUrl: `https://raw.githubusercontent.com/${repoRaw}/${branch}/${path}`,
  };
}

function extractGrepAppMatchLines(item: Record<string, unknown>): DiscoverHit['matchLines'] {
  const out: DiscoverHit['matchLines'] = [];
  const content = (item as { content?: unknown }).content;
  if (isObject(content)) {
    const lines = (content as { lines?: unknown }).lines;
    if (Array.isArray(lines)) {
      for (const line of lines) {
        if (!isObject(line)) continue;
        const lineNoRaw =
          (line as { number?: unknown }).number ?? (line as { lineNo?: unknown }).lineNo;
        const lineNo = Number(lineNoRaw);
        const text = getStr(line, 'text') ?? getStr(line, 'content');
        if (Number.isFinite(lineNo) && text != null) {
          out.push({ lineNo, content: text });
        }
      }
    }
    if (out.length === 0) {
      const snippet = getStr(content, 'snippet');
      if (snippet) out.push({ lineNo: 1, content: stripHtml(snippet) });
    }
  }
  return out;
}

export function normalizeGitHub(raw: unknown): DiscoverHit[] {
  if (!isObject(raw)) return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: DiscoverHit[] = [];
  for (const item of items) {
    const hit = githubItemToHit(item);
    if (hit) out.push(hit);
  }
  return out;
}

function githubItemToHit(item: unknown): DiscoverHit | null {
  if (!isObject(item)) return null;
  const path = getStr(item, 'path');
  const sha = getStr(item, 'sha');
  const htmlUrl = getStr(item, 'html_url');
  const repoObj = (item as { repository?: unknown }).repository;
  if (!isObject(repoObj)) return null;
  const fullName = getStr(repoObj, 'full_name');
  const defaultBranch = getStr(repoObj, 'default_branch') ?? 'main';
  if (!path || !fullName) return null;

  // Prefer the branch/ref encoded in html_url when present.
  let branch = defaultBranch;
  if (htmlUrl) {
    const m = htmlUrl.match(/\/blob\/([^/]+)\//);
    if (m) branch = m[1];
  }

  const matchLines: DiscoverHit['matchLines'] = [];
  const textMatches = (item as { text_matches?: unknown }).text_matches;
  if (Array.isArray(textMatches)) {
    for (const tm of textMatches) {
      if (!isObject(tm)) continue;
      const fragment = getStr(tm, 'fragment');
      if (fragment) matchLines.push({ lineNo: 1, content: fragment });
    }
  }

  return {
    repo: fullName,
    branch,
    path,
    sha: sha ?? undefined,
    matchLines,
    url: htmlUrl ?? `https://github.com/${fullName}/blob/${branch}/${path}`,
    rawUrl: `https://raw.githubusercontent.com/${fullName}/${branch}/${path}`,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getStr(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}
