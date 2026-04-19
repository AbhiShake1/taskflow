import type { RegistryItem } from './schema';
import type { DiscoverHit } from './discover';

export interface SynthesizeResult {
  item: RegistryItem;
  sourceUrl: string;
}

export interface RejectedSynthesis {
  reject: true;
  reason: string;
}

interface FetchLike {
  (input: string, init?: { headers?: Record<string, string> }): Promise<Response>;
}

const IMPORT_PKG_RE = /@taskflow-corp\/(?:cli|sdk)|taskflow-cli|taskflowjs/;
const CONFIG_IMPORT_RE = /import\s+[^;]*\bdefineConfig\b[^;]*from\s*['"]@taskflow-corp\/cli\/config['"]/;
const TEST_FILE_RE = /\.(test|spec)\.tsx?$/;
const TASKFLOW_CALL_RE = /\btaskflow\s*\(/;

function lastPathSegment(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function basenameNoExt(path: string): string {
  const base = lastPathSegment(path);
  if (base.endsWith('.tsx')) return base.slice(0, -4);
  if (base.endsWith('.ts')) return base.slice(0, -3);
  return base;
}

export function validateHarnessSource(
  source: string,
  path: string,
): { ok: true } | { ok: false; reason: string } {
  if (!source.includes('import') || !IMPORT_PKG_RE.test(source)) {
    return { ok: false, reason: 'file does not import from a taskflow package' };
  }
  if (CONFIG_IMPORT_RE.test(source)) {
    return { ok: false, reason: 'file imports defineConfig (user config, not a harness)' };
  }
  if (TEST_FILE_RE.test(lastPathSegment(path))) {
    return { ok: false, reason: 'file is a test/spec file' };
  }
  if (!TASKFLOW_CALL_RE.test(source)) {
    return { ok: false, reason: 'file does not contain a taskflow(...) call' };
  }
  return { ok: true };
}

export async function synthesizeFromDiscoverHit(
  hit: DiscoverHit,
): Promise<SynthesizeResult | RejectedSynthesis> {
  const fetchImpl = globalThis.fetch as unknown as FetchLike | undefined;
  if (typeof fetchImpl !== 'function') {
    return { reject: true, reason: 'globalThis.fetch is not available; use Node.js 20+.' };
  }

  let response: Response;
  try {
    response = await fetchImpl(hit.rawUrl, { headers: { accept: 'text/plain' } });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { reject: true, reason: `network error fetching raw source: ${detail}` };
  }

  if (response.status === 404) {
    return { reject: true, reason: 'raw file not found' };
  }
  if (!response.ok) {
    return { reject: true, reason: `raw fetch failed with HTTP ${response.status}` };
  }

  let content: string;
  try {
    content = await response.text();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { reject: true, reason: `failed to read raw body: ${detail}` };
  }

  const verdict = validateHarnessSource(content, hit.path);
  if (!verdict.ok) return { reject: true, reason: verdict.reason };

  const fileBase = lastPathSegment(hit.path);
  const item: RegistryItem = {
    name: basenameNoExt(hit.path),
    type: 'taskflow:harness',
    description: `Discovered: ${hit.repo}/${hit.path}@${hit.branch}`,
    files: [
      {
        path: `harness/${fileBase}`,
        type: 'taskflow:harness',
        content,
      },
    ],
  };

  return { item, sourceUrl: hit.rawUrl };
}
