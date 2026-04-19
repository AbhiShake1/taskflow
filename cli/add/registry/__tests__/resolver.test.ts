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
import { resolveRegistryTree } from '../resolver';

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
