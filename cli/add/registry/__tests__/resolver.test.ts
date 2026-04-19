import { createServer, type Server } from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { clearRegistryContext } from '../context';
import { clearFetchCache } from '../fetcher';
import {
  discoverAndSynthesize,
  isBareRepoShortcut,
  resolveRegistryTree,
} from '../resolver';
import type { SourceSpec } from '../parser';

vi.mock('@clack/prompts', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    multiselect: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
      error: vi.fn(),
    },
    isCancel: (v: unknown) => typeof v === 'symbol',
  };
});

type Item = {
  name: string;
  type: string;
  registryDependencies?: string[];
  files?: unknown[];
};

describe('resolveRegistryTree', () => {
  let server: Server;
  let port: number;
  let store: Map<string, Item>;
  let hitCounter: Map<string, number>;

  function base(): string {
    return `http://127.0.0.1:${port}`;
  }

  // Note: the resolver's dep-to-item matcher recognizes a dep string if it
  // equals a resolved item name, ends with `/<name>`, or equals
  // `./<name>.json`. We use URLs ending in `/<name>` (no `.json`) so both the
  // fetcher can resolve them AND the topo matcher sees the edges.
  function urlFor(name: string): string {
    return `${base()}/r/${name}`;
  }

  beforeAll(async () => {
    store = new Map();
    hitCounter = new Map();
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      hitCounter.set(url, (hitCounter.get(url) ?? 0) + 1);
      const m = url.match(/^\/r\/(.+?)(?:\.json)?$/);
      if (!m) {
        res.writeHead(404);
        res.end();
        return;
      }
      const name = m[1];
      const item = store.get(name);
      if (!item) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(item));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === 'object') port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    store.clear();
    hitCounter.clear();
    clearFetchCache();
    clearRegistryContext();
  });

  it('discovers transitive registryDependencies via BFS', async () => {
    store.set('a', { name: 'a', type: 'taskflow:harness' });
    store.set('b', {
      name: 'b',
      type: 'taskflow:harness',
      registryDependencies: [urlFor('a')],
    });
    store.set('c', {
      name: 'c',
      type: 'taskflow:harness',
      registryDependencies: [urlFor('b')],
    });
    const result = await resolveRegistryTree([urlFor('c')], null);
    const names = result.map((r) => r.item.name);
    expect(new Set(names)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('topologically sorts so deps come before dependents', async () => {
    store.set('a', { name: 'a', type: 'taskflow:harness' });
    store.set('b', {
      name: 'b',
      type: 'taskflow:harness',
      registryDependencies: [urlFor('a')],
    });
    const result = await resolveRegistryTree([urlFor('b')], null);
    const names = result.map((r) => r.item.name);
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('b'));
  });

  it('tolerates cycles: warns, includes all items', async () => {
    store.set('a', {
      name: 'a',
      type: 'taskflow:harness',
      registryDependencies: [urlFor('b')],
    });
    store.set('b', {
      name: 'b',
      type: 'taskflow:harness',
      registryDependencies: [urlFor('a')],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await resolveRegistryTree([urlFor('a')], null);
      const names = result.map((r) => r.item.name);
      expect(new Set(names)).toEqual(new Set(['a', 'b']));
      expect(warn).toHaveBeenCalled();
      const joined = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(joined).toMatch(/cycle/i);
    } finally {
      warn.mockRestore();
    }
  });

  it('deduplicates when the same dep is referenced from two items (fetched once)', async () => {
    store.set('shared', { name: 'shared', type: 'taskflow:harness' });
    store.set('a', {
      name: 'a',
      type: 'taskflow:harness',
      registryDependencies: [urlFor('shared')],
    });
    store.set('b', {
      name: 'b',
      type: 'taskflow:harness',
      registryDependencies: [urlFor('shared')],
    });
    const result = await resolveRegistryTree([urlFor('a'), urlFor('b')], null);
    const names = result.map((r) => r.item.name);
    expect(new Set(names)).toEqual(new Set(['a', 'b', 'shared']));
    expect(hitCounter.get('/r/shared')).toBe(1);
  });
});

describe('isBareRepoShortcut', () => {
  it('returns true for shortcuts with no subpath', () => {
    const spec: SourceSpec = {
      kind: 'shortcut',
      host: 'github',
      user: 'a',
      repo: 'b',
    };
    expect(isBareRepoShortcut(spec)).toBe(true);
  });

  it('returns true for shortcuts with empty subpath', () => {
    const spec: SourceSpec = {
      kind: 'shortcut',
      host: 'github',
      user: 'a',
      repo: 'b',
      subpath: '',
    };
    expect(isBareRepoShortcut(spec)).toBe(true);
  });

  it('returns false for shortcuts with a subpath', () => {
    const spec: SourceSpec = {
      kind: 'shortcut',
      host: 'github',
      user: 'a',
      repo: 'b',
      subpath: 'tasks/foo.ts',
    };
    expect(isBareRepoShortcut(spec)).toBe(false);
  });

  it('returns false for non-shortcut kinds', () => {
    expect(isBareRepoShortcut({ kind: 'url', url: 'https://x' })).toBe(false);
    expect(isBareRepoShortcut({ kind: 'named', name: 'x' })).toBe(false);
  });
});

describe('discoverAndSynthesize', () => {
  let discoverServer: Server;
  let rawServer: Server;
  let discoverPort: number;
  let rawPort: number;

  // Keyed by repo, e.g. `alice/harnesses`
  const discoverResponses = new Map<
    string,
    {
      source: 'grep.app' | 'github' | 'cache';
      hits: Array<{
        repo: string;
        branch: string;
        path: string;
        sha?: string;
        matchLines: Array<{ lineNo: number; content: string }>;
        url: string;
        rawUrl: string;
      }>;
    }
  >();

  // Keyed by path segment (e.g. `/alice/harnesses/main/tasks/video.ts`)
  const rawFiles = new Map<string, { status: number; body: string }>();

  function makeDiscoverHit(
    repo: string,
    path: string,
    line: string,
  ): {
    repo: string;
    branch: string;
    path: string;
    matchLines: Array<{ lineNo: number; content: string }>;
    url: string;
    rawUrl: string;
  } {
    const [user, name] = repo.split('/');
    const branch = 'main';
    const pathAndQuery = `/${user}/${name}/${branch}/${path}`;
    return {
      repo,
      branch,
      path,
      matchLines: [{ lineNo: 1, content: line }],
      url: `https://github.com/${repo}/blob/${branch}/${path}`,
      rawUrl: `http://127.0.0.1:${rawPort}${pathAndQuery}`,
    };
  }

  beforeAll(async () => {
    discoverServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const repo = url.searchParams.get('repo') ?? '';
      const payload = discoverResponses.get(repo);
      if (!payload) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ source: 'grep.app', hits: [] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    rawServer = createServer((req, res) => {
      const key = req.url ?? '/';
      const entry = rawFiles.get(key);
      if (!entry) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(entry.status, { 'content-type': 'text/plain' });
      res.end(entry.body);
    });
    await new Promise<void>((resolve) => {
      discoverServer.listen(0, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => {
      rawServer.listen(0, '127.0.0.1', () => resolve());
    });
    const dAddr = discoverServer.address();
    if (dAddr && typeof dAddr === 'object') discoverPort = dAddr.port;
    const rAddr = rawServer.address();
    if (rAddr && typeof rAddr === 'object') rawPort = rAddr.port;
    process.env.TASKFLOW_DISCOVER_URL = `http://127.0.0.1:${discoverPort}/api/discover`;
  });

  afterAll(async () => {
    delete process.env.TASKFLOW_DISCOVER_URL;
    await new Promise<void>((resolve) => discoverServer.close(() => resolve()));
    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
  });

  beforeEach(() => {
    discoverResponses.clear();
    rawFiles.clear();
  });

  afterEach(async () => {
    const prompts = await import('@clack/prompts');
    const multi = prompts.multiselect as unknown as ReturnType<typeof vi.fn>;
    multi.mockReset();
    clearFetchCache();
    clearRegistryContext();
  });

  const bareSpec: Extract<SourceSpec, { kind: 'shortcut' }> = {
    kind: 'shortcut',
    host: 'github',
    user: 'alice',
    repo: 'harnesses',
  };

  const HARNESS_SRC =
    "import { taskflow } from '@taskflow-corp/cli';\nawait taskflow('x').run({});";

  it('auto-installs when discovery returns exactly 1 hit', async () => {
    const hit = makeDiscoverHit(
      'alice/harnesses',
      'tasks/video.ts',
      "import { taskflow } from '@taskflow-corp/cli';",
    );
    discoverResponses.set('alice/harnesses', { source: 'grep.app', hits: [hit] });
    rawFiles.set('/alice/harnesses/main/tasks/video.ts', {
      status: 200,
      body: HARNESS_SRC,
    });

    const result = await discoverAndSynthesize(bareSpec, { yes: false, silent: true });
    expect(result).toHaveLength(1);
    expect(result[0].item.name).toBe('video');
    expect(result[0].item.type).toBe('taskflow:harness');
    expect(result[0].sourceUrl).toBe(
      'github:alice/harnesses/tasks/video.ts#main',
    );
  });

  it('throws a clear error when discovery returns 0 hits', async () => {
    discoverResponses.set('alice/harnesses', { source: 'grep.app', hits: [] });
    await expect(
      discoverAndSynthesize(bareSpec, { yes: false, silent: true }),
    ).rejects.toThrow(/No taskflow harnesses found in alice\/harnesses/);
  });

  it('throws on >1 hits when yes=true', async () => {
    const h1 = makeDiscoverHit(
      'alice/harnesses',
      'a.ts',
      "import { taskflow } from '@taskflow-corp/cli';",
    );
    const h2 = makeDiscoverHit(
      'alice/harnesses',
      'b.ts',
      "import { taskflow } from '@taskflow-corp/cli';",
    );
    discoverResponses.set('alice/harnesses', { source: 'grep.app', hits: [h1, h2] });
    await expect(
      discoverAndSynthesize(bareSpec, { yes: true, silent: true }),
    ).rejects.toThrow(/Multiple harnesses discovered/);
  });

  it('uses multiselect and returns chosen subset on >1 hits + interactive', async () => {
    const h1 = makeDiscoverHit(
      'alice/harnesses',
      'a.ts',
      "import { taskflow } from '@taskflow-corp/cli';",
    );
    const h2 = makeDiscoverHit(
      'alice/harnesses',
      'b.ts',
      "import { taskflow } from '@taskflow-corp/cli';",
    );
    const h3 = makeDiscoverHit(
      'alice/harnesses',
      'c.ts',
      "import { taskflow } from '@taskflow-corp/cli';",
    );
    discoverResponses.set('alice/harnesses', {
      source: 'grep.app',
      hits: [h1, h2, h3],
    });
    rawFiles.set('/alice/harnesses/main/a.ts', { status: 200, body: HARNESS_SRC });
    rawFiles.set('/alice/harnesses/main/c.ts', { status: 200, body: HARNESS_SRC });

    const prompts = await import('@clack/prompts');
    const multi = prompts.multiselect as unknown as ReturnType<typeof vi.fn>;
    multi.mockResolvedValueOnce([h1, h3]);

    const result = await discoverAndSynthesize(bareSpec, { yes: false, silent: true });
    expect(multi).toHaveBeenCalledTimes(1);
    const names = result.map((r) => r.item.name).sort();
    expect(names).toEqual(['a', 'c']);
  });

  it('skips hits whose synthesis rejects and returns the rest', async () => {
    const valid = makeDiscoverHit(
      'alice/harnesses',
      'good.ts',
      "import { taskflow } from '@taskflow-corp/cli';",
    );
    const invalid = makeDiscoverHit(
      'alice/harnesses',
      'bad.ts',
      "import fs from 'node:fs';",
    );
    discoverResponses.set('alice/harnesses', {
      source: 'grep.app',
      hits: [valid, invalid],
    });
    rawFiles.set('/alice/harnesses/main/good.ts', {
      status: 200,
      body: HARNESS_SRC,
    });
    rawFiles.set('/alice/harnesses/main/bad.ts', {
      status: 200,
      body: "import fs from 'node:fs';\nconsole.log(fs);",
    });

    const prompts = await import('@clack/prompts');
    const multi = prompts.multiselect as unknown as ReturnType<typeof vi.fn>;
    multi.mockResolvedValueOnce([valid, invalid]);

    const result = await discoverAndSynthesize(bareSpec, { yes: false, silent: true });
    expect(result).toHaveLength(1);
    expect(result[0].item.name).toBe('good');
  });
});
