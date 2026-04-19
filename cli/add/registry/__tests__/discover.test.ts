import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RegistryFetchError } from '../errors';
import { discover, DEFAULT_DISCOVER_URL } from '../discover';

interface Captured {
  url: string;
  method: string;
}

describe('discover', () => {
  let server: Server;
  let port: number;
  let captured: Captured[] = [];
  let handler: (req: { url?: string; method?: string }, res: import('node:http').ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      captured.push({ url: req.url ?? '/', method: req.method ?? 'GET' });
      handler(req, res);
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
    captured = [];
    delete process.env.TASKFLOW_DISCOVER_URL;
    handler = (_req, res) => {
      res.writeHead(500);
      res.end('no handler');
    };
  });

  const base = () => `http://127.0.0.1:${port}/api/discover`;

  it('exposes the default discover URL constant', () => {
    expect(DEFAULT_DISCOVER_URL).toBe('https://taskflow-registry.pages.dev/api/discover');
  });

  it('sends query, repo, and limit params and returns parsed hits', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          source: 'grep.app',
          hits: [
            {
              repo: 'a/b',
              branch: 'main',
              path: 'tasks/video.ts',
              sha: 'abc',
              matchLines: [{ lineNo: 1, content: "import { taskflow } from '@taskflow-corp/cli';" }],
              url: 'https://github.com/a/b/blob/main/tasks/video.ts',
              rawUrl: 'https://raw.githubusercontent.com/a/b/main/tasks/video.ts',
            },
          ],
        }),
      );
    };

    const result = await discover({ query: 'x', repo: 'a/b', limit: 5, baseUrl: base() });
    expect(result.source).toBe('grep.app');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].repo).toBe('a/b');

    expect(captured).toHaveLength(1);
    const requestUrl = captured[0].url;
    expect(requestUrl).toContain('q=x');
    expect(requestUrl).toContain('repo=a%2Fb');
    expect(requestUrl).toContain('limit=5');
  });

  it('defaults limit to 25 when omitted', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ source: 'github', hits: [] }));
    };
    const result = await discover({ baseUrl: base() });
    expect(result.source).toBe('github');
    expect(result.hits).toEqual([]);
    expect(captured[0].url).toContain('limit=25');
  });

  it('throws with retryAfter on HTTP 429', async () => {
    handler = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_limited', retryAfter: 42 }));
    };
    await expect(discover({ baseUrl: base() })).rejects.toThrow(/retryAfter=42/);
  });

  it('throws with detail on HTTP 503', async () => {
    handler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'discover_unavailable', detail: 'browser binding offline' }));
    };
    await expect(discover({ baseUrl: base() })).rejects.toThrow(/browser binding offline/);
  });

  it('throws RegistryFetchError for malformed response (missing source)', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hits: [] }));
    };
    await expect(discover({ baseUrl: base() })).rejects.toBeInstanceOf(RegistryFetchError);
  });

  it('throws RegistryFetchError for malformed hit shape', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ source: 'grep.app', hits: [{ repo: 'a/b' }] }));
    };
    await expect(discover({ baseUrl: base() })).rejects.toBeInstanceOf(RegistryFetchError);
  });

  it('throws RegistryFetchError for invalid JSON body', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not json');
    };
    await expect(discover({ baseUrl: base() })).rejects.toBeInstanceOf(RegistryFetchError);
  });

  it('baseUrl option overrides TASKFLOW_DISCOVER_URL env var', async () => {
    process.env.TASKFLOW_DISCOVER_URL = 'http://127.0.0.1:1/never/used';
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ source: 'cache', hits: [] }));
    };
    const result = await discover({ baseUrl: base() });
    expect(result.source).toBe('cache');
    expect(captured).toHaveLength(1);
  });
});
