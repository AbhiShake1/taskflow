import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

import { getRegistryHeadersFromContext } from './context';
import {
  RegistryFetchError,
  RegistryForbiddenError,
  RegistryGoneError,
  RegistryLocalFileError,
  RegistryNotFoundError,
  RegistryParseError,
  RegistryUnauthorizedError,
} from './errors';
import { registryItemSchema, type RegistryItem } from './schema';

interface FetchLike {
  (input: string, init?: { headers?: Record<string, string>; dispatcher?: unknown }): Promise<Response>;
}

const cache = new Map<string, Promise<RegistryItem>>();
let proxyWarned = false;
let proxyDispatcher: unknown | null | undefined;

function hashHeaders(headers: Record<string, string>): string {
  const keys = Object.keys(headers).sort();
  const h = createHash('sha256');
  for (const k of keys) {
    h.update(k);
    h.update('\0');
    h.update(headers[k]);
    h.update('\0');
  }
  return h.digest('hex');
}

async function getProxyDispatcher(): Promise<unknown | null> {
  if (proxyDispatcher !== undefined) return proxyDispatcher;
  const proxyUrl =
    process.env.https_proxy ??
    process.env.HTTPS_PROXY ??
    process.env.http_proxy ??
    process.env.HTTP_PROXY;
  if (!proxyUrl) {
    proxyDispatcher = null;
    return null;
  }
  try {
    const moduleName = 'undici';
    const undici = (await import(moduleName)) as unknown as {
      ProxyAgent: new (url: string) => unknown;
    };
    proxyDispatcher = new undici.ProxyAgent(proxyUrl);
    return proxyDispatcher;
  } catch (err) {
    if (!proxyWarned) {
      proxyWarned = true;
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `taskflow: ${proxyUrl} proxy requested but undici.ProxyAgent is unavailable (${detail}); falling back to unproxied fetch.`,
      );
    }
    proxyDispatcher = null;
    return null;
  }
}

function mapStatus(url: string, status: number, body: string): Error {
  if (status === 401) return new RegistryUnauthorizedError(url);
  if (status === 403) return new RegistryForbiddenError(url);
  if (status === 404) return new RegistryNotFoundError(url);
  if (status === 410) return new RegistryGoneError(url);
  return new RegistryFetchError(url, status, body.slice(0, 200));
}

async function doFetch(url: string, headers: Record<string, string>): Promise<RegistryItem> {
  const fetchImpl = globalThis.fetch as unknown as FetchLike | undefined;
  if (typeof fetchImpl !== 'function') {
    throw new RegistryFetchError(url, undefined, 'globalThis.fetch is not available; use Node.js 20+.');
  }
  const dispatcher = await getProxyDispatcher();
  let response: Response;
  try {
    const init: { headers?: Record<string, string>; dispatcher?: unknown } = { headers };
    if (dispatcher) init.dispatcher = dispatcher;
    response = await fetchImpl(url, init);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RegistryFetchError(url, undefined, detail);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw mapStatus(url, response.status, text);
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
    throw new RegistryParseError(url, err);
  }

  const parsed = registryItemSchema.safeParse(json);
  if (!parsed.success) throw new RegistryParseError(url, parsed.error);
  return parsed.data;
}

export function fetchRegistry(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<RegistryItem> {
  const contextHeaders = getRegistryHeadersFromContext(url);
  const headers: Record<string, string> = { ...(extraHeaders ?? {}), ...contextHeaders };
  const key = `${url}\0${hashHeaders(headers)}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = doFetch(url, headers).catch((err: unknown) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, pending);
  return pending;
}

export function clearFetchCache(): void {
  cache.clear();
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolvePath(homedir(), p.slice(2));
  return p;
}

export async function fetchRegistryLocal(path: string): Promise<RegistryItem> {
  const resolved = resolvePath(expandHome(path));
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (err) {
    throw new RegistryLocalFileError(resolved, err);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new RegistryParseError(resolved, err);
  }
  const parsed = registryItemSchema.safeParse(json);
  if (!parsed.success) throw new RegistryParseError(resolved, parsed.error);
  return parsed.data;
}
