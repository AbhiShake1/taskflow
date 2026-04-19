import { normalizeGitHub, type DiscoverHit } from './normalize';

export type { DiscoverHit } from './normalize';

export interface Env {
  DISCOVER_CACHE: KVNamespace;
  GITHUB_TOKEN?: string;
  DEFAULT_QUERY_PATTERN?: string;
}

export interface DiscoverResponse {
  source: 'github' | 'cache';
  hits: DiscoverHit[];
}

const CACHE_TTL_SECONDS = 600;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || env.DEFAULT_QUERY_PATTERN || "from '@taskflow-corp/cli'").trim();
  const repo = url.searchParams.get('repo');
  const limitRaw = Number(url.searchParams.get('limit') || DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
    : DEFAULT_LIMIT;

  const cacheKey = await sha256(`${q}|${repo ?? ''}|${limit}`);

  try {
    const cached = await env.DISCOVER_CACHE.get(cacheKey, 'json');
    if (cached && Array.isArray((cached as { hits?: unknown }).hits)) {
      const hits = (cached as { hits: DiscoverHit[] }).hits.slice(0, limit);
      return json<DiscoverResponse>({ source: 'cache', hits });
    }
  } catch {
    // KV errors are non-fatal — fall through to a live fetch.
  }

  try {
    const result = await fetchGitHub(env, q, repo, limit);
    if (result.kind === 'rate_limited') {
      return json({ error: 'rate_limited', retryAfter: result.retryAfter }, 429);
    }
    const limited = result.hits.slice(0, limit);
    void env.DISCOVER_CACHE
      .put(cacheKey, JSON.stringify({ hits: limited }), { expirationTtl: CACHE_TTL_SECONDS })
      .catch(() => {});
    return json<DiscoverResponse>({ source: 'github', hits: limited });
  } catch (error) {
    return json({ error: 'discover_unavailable', detail: String(error) }, 503);
  }
};

type FetchGitHubResult =
  | { kind: 'ok'; hits: DiscoverHit[] }
  | { kind: 'rate_limited'; retryAfter: number };

async function fetchGitHub(
  env: Env,
  q: string,
  repo: string | null,
  limit: number,
): Promise<FetchGitHubResult> {
  const queryParts = [q, 'language:typescript'];
  if (repo) queryParts.push(`repo:${repo}`);
  const ghQuery = queryParts.join(' ');
  const apiUrl = `https://api.github.com/search/code?q=${encodeURIComponent(ghQuery)}&per_page=${limit}`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3.text-match+json',
    'User-Agent': 'taskflow-discover',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const resp = await fetch(apiUrl, { headers });
  if (resp.status === 403 || resp.status === 429) {
    const retryAfter = Number(resp.headers.get('Retry-After') || '60');
    return { kind: 'rate_limited', retryAfter: Number.isFinite(retryAfter) ? retryAfter : 60 };
  }
  if (!resp.ok) {
    throw new Error(`github ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const body = (await resp.json()) as unknown;
  return { kind: 'ok', hits: normalizeGitHub(body) };
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
