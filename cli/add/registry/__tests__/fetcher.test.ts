import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { clearRegistryContext } from '../context';
import {
  RegistryForbiddenError,
  RegistryGoneError,
  RegistryLocalFileError,
  RegistryNotFoundError,
  RegistryParseError,
  RegistryUnauthorizedError,
} from '../errors';
import { clearFetchCache, fetchRegistry, fetchRegistryLocal } from '../fetcher';

const VALID_ITEM = {
  $schema: 'https://taskflow.sh/schema/registry-item.json',
  name: 'ok',
  type: 'taskflow:harness',
  description: 'test',
  files: [{ path: 'harness/ok.ts', type: 'taskflow:harness', content: '// ok' }],
};

describe('fetcher HTTP', () => {
  let server: Server;
  let port: number;
  let hitCounter = new Map<string, number>();
  let slowOkResolve: (() => void) | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      hitCounter.set(url, (hitCounter.get(url) ?? 0) + 1);
      if (url === '/ok.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(VALID_ITEM));
        return;
      }
      if (url === '/slow-ok.json') {
        // Only respond once the test releases us; second concurrent request
        // must dedupe and wait on the first promise.
        const send = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(VALID_ITEM));
        };
        if (slowOkResolve) {
          // If a release is pending, respond immediately after a microtask.
          send();
          return;
        }
        setTimeout(send, 50);
        return;
      }
      if (url === '/unauth') {
        res.writeHead(401);
        res.end('nope');
        return;
      }
      if (url === '/forbidden') {
        res.writeHead(403);
        res.end('nope');
        return;
      }
      if (url === '/missing') {
        res.writeHead(404);
        res.end('nope');
        return;
      }
      if (url === '/gone') {
        res.writeHead(410);
        res.end('nope');
        return;
      }
      if (url === '/bad-json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{not valid json');
        return;
      }
      if (url === '/schema-fail') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'x' })); // missing required `type`
        return;
      }
      res.writeHead(500);
      res.end('unknown');
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
    clearFetchCache();
    clearRegistryContext();
    hitCounter = new Map();
  });

  const base = () => `http://127.0.0.1:${port}`;

  it('fetches and parses a valid registry item (200)', async () => {
    const item = await fetchRegistry(`${base()}/ok.json`);
    expect(item.name).toBe('ok');
    expect(item.type).toBe('taskflow:harness');
  });

  it('maps 401 to RegistryUnauthorizedError', async () => {
    await expect(fetchRegistry(`${base()}/unauth`)).rejects.toBeInstanceOf(
      RegistryUnauthorizedError,
    );
  });

  it('maps 403 to RegistryForbiddenError', async () => {
    await expect(fetchRegistry(`${base()}/forbidden`)).rejects.toBeInstanceOf(
      RegistryForbiddenError,
    );
  });

  it('maps 404 to RegistryNotFoundError', async () => {
    await expect(fetchRegistry(`${base()}/missing`)).rejects.toBeInstanceOf(
      RegistryNotFoundError,
    );
  });

  it('maps 410 to RegistryGoneError', async () => {
    await expect(fetchRegistry(`${base()}/gone`)).rejects.toBeInstanceOf(
      RegistryGoneError,
    );
  });

  it('maps malformed JSON to RegistryParseError', async () => {
    await expect(fetchRegistry(`${base()}/bad-json`)).rejects.toBeInstanceOf(
      RegistryParseError,
    );
  });

  it('maps schema-invalid response to RegistryParseError', async () => {
    await expect(fetchRegistry(`${base()}/schema-fail`)).rejects.toBeInstanceOf(
      RegistryParseError,
    );
  });

  it('deduplicates concurrent requests to the same URL (only one server hit)', async () => {
    const url = `${base()}/slow-ok.json`;
    const [a, b] = await Promise.all([fetchRegistry(url), fetchRegistry(url)]);
    expect(a.name).toBe('ok');
    expect(b.name).toBe('ok');
    expect(hitCounter.get('/slow-ok.json')).toBe(1);
  });

  it('clearFetchCache forces a refetch', async () => {
    const url = `${base()}/ok.json`;
    await fetchRegistry(url);
    await fetchRegistry(url);
    expect(hitCounter.get('/ok.json')).toBe(1);
    clearFetchCache();
    await fetchRegistry(url);
    expect(hitCounter.get('/ok.json')).toBe(2);
  });

  it('failed fetch does not poison the cache', async () => {
    await expect(fetchRegistry(`${base()}/missing`)).rejects.toBeInstanceOf(
      RegistryNotFoundError,
    );
    await expect(fetchRegistry(`${base()}/missing`)).rejects.toBeInstanceOf(
      RegistryNotFoundError,
    );
    expect(hitCounter.get('/missing')).toBe(2);
  });
});

describe('fetchRegistryLocal', () => {
  let tmp: string;

  beforeEach(() => {
    clearFetchCache();
    tmp = mkdtempSync(join(tmpdir(), 'taskflow-fetch-local-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('parses a valid local file', async () => {
    const p = join(tmp, 'ok.json');
    writeFileSync(p, JSON.stringify(VALID_ITEM));
    const item = await fetchRegistryLocal(p);
    expect(item.name).toBe('ok');
  });

  it('throws RegistryLocalFileError for a missing file', async () => {
    await expect(
      fetchRegistryLocal(join(tmp, 'does-not-exist.json')),
    ).rejects.toBeInstanceOf(RegistryLocalFileError);
  });

  it('throws RegistryParseError for bad JSON', async () => {
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{not json');
    await expect(fetchRegistryLocal(p)).rejects.toBeInstanceOf(RegistryParseError);
  });

  it('throws RegistryParseError when schema fails', async () => {
    const p = join(tmp, 'schema.json');
    writeFileSync(p, JSON.stringify({ name: 'x' }));
    await expect(fetchRegistryLocal(p)).rejects.toBeInstanceOf(RegistryParseError);
  });

  it('expands ~/ to homedir (error surfaces real resolved path)', async () => {
    // Use a path under tmp that will exist to prove the tilde expansion path is taken.
    // We cannot safely write to the user's homedir, so we verify via the error path:
    // a nonexistent ~/ path must produce LocalFileError with a resolved (not literal ~)
    // path.
    let caught: unknown;
    try {
      await fetchRegistryLocal('~/__taskflow_test_probably_not_here__.json');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RegistryLocalFileError);
    const path = (caught as RegistryLocalFileError).path;
    expect(path.startsWith(homedir())).toBe(true);
    expect(path.includes('~')).toBe(false);
  });
});
