import { RegistryFetchError } from './errors';

export interface DiscoverHit {
  repo: string;
  branch: string;
  path: string;
  sha?: string;
  matchLines: Array<{ lineNo: number; content: string }>;
  url: string;
  rawUrl: string;
}

export interface DiscoverOptions {
  query?: string;
  repo?: string;
  limit?: number;
  baseUrl?: string;
}

export interface DiscoverResponse {
  source: 'grep.app' | 'github' | 'cache';
  hits: DiscoverHit[];
}

export const DEFAULT_DISCOVER_URL = 'https://taskflow-registry.pages.dev/api/discover';

interface FetchLike {
  (input: string, init?: { headers?: Record<string, string> }): Promise<Response>;
}

function resolveBaseUrl(opt?: string): string {
  if (opt) return opt;
  const fromEnv = process.env.TASKFLOW_DISCOVER_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEFAULT_DISCOVER_URL;
}

function buildUrl(base: string, opts: DiscoverOptions): string {
  const params = new URLSearchParams();
  if (typeof opts.query === 'string' && opts.query.length > 0) params.set('q', opts.query);
  if (typeof opts.repo === 'string' && opts.repo.length > 0) params.set('repo', opts.repo);
  const limit = typeof opts.limit === 'number' ? opts.limit : 25;
  params.set('limit', String(limit));
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${params.toString()}`;
}

function isStringArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isMatchLine(v: unknown): v is { lineNo: number; content: string } {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.lineNo === 'number' && typeof r.content === 'string';
}

function isHit(v: unknown): v is DiscoverHit {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.repo !== 'string') return false;
  if (typeof r.branch !== 'string') return false;
  if (typeof r.path !== 'string') return false;
  if (typeof r.url !== 'string') return false;
  if (typeof r.rawUrl !== 'string') return false;
  if (r.sha !== undefined && typeof r.sha !== 'string') return false;
  if (!isStringArray(r.matchLines)) return false;
  for (const m of r.matchLines) {
    if (!isMatchLine(m)) return false;
  }
  return true;
}

function parseResponse(url: string, json: unknown): DiscoverResponse {
  if (!json || typeof json !== 'object') {
    throw new RegistryFetchError(url, undefined, 'discover response was not a JSON object');
  }
  const r = json as Record<string, unknown>;
  const source = r.source;
  if (source !== 'grep.app' && source !== 'github' && source !== 'cache') {
    throw new RegistryFetchError(url, undefined, `discover response has invalid source: ${String(source)}`);
  }
  if (!isStringArray(r.hits)) {
    throw new RegistryFetchError(url, undefined, 'discover response missing hits array');
  }
  const hits: DiscoverHit[] = [];
  for (const h of r.hits) {
    if (!isHit(h)) {
      throw new RegistryFetchError(url, undefined, 'discover response contained a malformed hit');
    }
    hits.push(h);
  }
  return { source, hits };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function discover(opts: DiscoverOptions = {}): Promise<DiscoverResponse> {
  const base = resolveBaseUrl(opts.baseUrl);
  const url = buildUrl(base, opts);
  const fetchImpl = globalThis.fetch as unknown as FetchLike | undefined;
  if (typeof fetchImpl !== 'function') {
    throw new RegistryFetchError(url, undefined, 'globalThis.fetch is not available; use Node.js 20+.');
  }

  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RegistryFetchError(url, undefined, detail);
  }

  if (response.status === 429) {
    const body = (await safeJson(response)) as { retryAfter?: unknown } | null;
    const retryAfter = body && typeof body.retryAfter === 'number' ? body.retryAfter : undefined;
    const suffix = typeof retryAfter === 'number' ? `retryAfter=${retryAfter}s` : 'retryAfter unspecified';
    throw new Error(`discover rate limited (HTTP 429, ${suffix})`);
  }

  if (response.status === 503) {
    const body = (await safeJson(response)) as { detail?: unknown } | null;
    const detail = body && typeof body.detail === 'string' ? body.detail : 'discover_unavailable';
    throw new Error(`discover unavailable (HTTP 503): ${detail}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new RegistryFetchError(url, response.status, text.slice(0, 200));
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RegistryFetchError(url, response.status, detail);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RegistryFetchError(url, response.status, `invalid JSON: ${detail}`);
  }

  return parseResponse(url, json);
}
