export interface DiscoverHit {
  repo: string;
  branch: string;
  path: string;
  sha?: string;
  matchLines: Array<{ lineNo: number; content: string }>;
  url: string;
  rawUrl: string;
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
