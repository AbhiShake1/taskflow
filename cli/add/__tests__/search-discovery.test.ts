import { createServer, type Server } from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { runSearch } from '../search';

interface DiscoverServerPayload {
  source: 'grep.app' | 'github' | 'cache';
  hits: Array<{
    repo: string;
    branch: string;
    path: string;
    matchLines: Array<{ lineNo: number; content: string }>;
    url: string;
    rawUrl: string;
  }>;
}

describe('runSearch with discovery', () => {
  let registryServer: Server;
  let discoverServer: Server;
  let registryPort: number;
  let discoverPort: number;

  let registryResponse: {
    status: number;
    body: string;
  } | null = null;
  let discoverResponse: {
    status: number;
    body: string;
  } | null = null;

  beforeAll(async () => {
    registryServer = createServer((req, res) => {
      if (registryResponse === null) {
        res.writeHead(500);
        res.end('no handler');
        return;
      }
      res.writeHead(registryResponse.status, {
        'content-type': 'application/json',
      });
      res.end(registryResponse.body);
      void req;
    });
    discoverServer = createServer((req, res) => {
      if (discoverResponse === null) {
        res.writeHead(500);
        res.end('no handler');
        return;
      }
      res.writeHead(discoverResponse.status, {
        'content-type': 'application/json',
      });
      res.end(discoverResponse.body);
      void req;
    });
    await new Promise<void>((resolve) => {
      registryServer.listen(0, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => {
      discoverServer.listen(0, '127.0.0.1', () => resolve());
    });
    const rAddr = registryServer.address();
    if (rAddr && typeof rAddr === 'object') registryPort = rAddr.port;
    const dAddr = discoverServer.address();
    if (dAddr && typeof dAddr === 'object') discoverPort = dAddr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => registryServer.close(() => resolve()));
    await new Promise<void>((resolve) => discoverServer.close(() => resolve()));
  });

  beforeEach(() => {
    registryResponse = null;
    discoverResponse = null;
    process.env.TASKFLOW_REGISTRY_URL = `http://127.0.0.1:${registryPort}`;
    process.env.TASKFLOW_DISCOVER_URL = `http://127.0.0.1:${discoverPort}/api/discover`;
  });

  afterEach(() => {
    delete process.env.TASKFLOW_REGISTRY_URL;
    delete process.env.TASKFLOW_DISCOVER_URL;
  });

  function captureStdout(fn: () => Promise<void>): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      const original = process.stdout.write.bind(process.stdout);
      const write = ((...args: unknown[]) => {
        const chunk = args[0];
        if (typeof chunk === 'string') chunks.push(chunk);
        else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stdout.write;
      // Rebind
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = write;
      fn()
        .then(() => {
          (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
          resolve(chunks.join(''));
        })
        .catch((err: unknown) => {
          (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
          reject(err);
        });
    });
  }

  it('renders results from both registry index and discovery', async () => {
    registryResponse = {
      status: 200,
      body: JSON.stringify({
        items: [
          {
            name: '@acme/video',
            description: 'video harness',
            homepage: 'https://acme.dev',
          },
        ],
      }),
    };
    const hit: DiscoverServerPayload = {
      source: 'grep.app',
      hits: [
        {
          repo: 'alice/harnesses',
          branch: 'main',
          path: 'tasks/video.ts',
          matchLines: [
            {
              lineNo: 1,
              content: "import { taskflow } from '@taskflow-corp/cli';",
            },
          ],
          url: 'https://github.com/alice/harnesses/blob/main/tasks/video.ts',
          rawUrl:
            'https://raw.githubusercontent.com/alice/harnesses/main/tasks/video.ts',
        },
      ],
    };
    discoverResponse = { status: 200, body: JSON.stringify(hit) };

    const out = await captureStdout(() =>
      runSearch({ query: 'video', cwd: process.cwd(), silent: true }),
    );

    expect(out).toContain('from registry index:');
    expect(out).toContain('@acme/video');
    expect(out).toContain('from github (discovery):');
    expect(out).toContain('alice/harnesses');
    expect(out).toContain('tasks/video.ts');
  });

  it('falls back gracefully when discovery errors (503)', async () => {
    registryResponse = {
      status: 200,
      body: JSON.stringify({
        items: [
          {
            name: '@acme/video',
            description: 'video harness',
            homepage: 'https://acme.dev',
          },
        ],
      }),
    };
    discoverResponse = {
      status: 503,
      body: JSON.stringify({
        error: 'discover_unavailable',
        detail: 'binding offline',
      }),
    };

    const out = await captureStdout(() =>
      runSearch({ query: 'video', cwd: process.cwd(), silent: true }),
    );

    expect(out).toContain('from registry index:');
    expect(out).toContain('@acme/video');
    expect(out).not.toContain('from github (discovery):');
  });

  it('prints "no matches" when both sections are empty', async () => {
    registryResponse = {
      status: 200,
      body: JSON.stringify({ items: [] }),
    };
    discoverResponse = {
      status: 200,
      body: JSON.stringify({ source: 'grep.app', hits: [] }),
    };

    const out = await captureStdout(() =>
      runSearch({ query: 'nothing', cwd: process.cwd(), silent: true }),
    );

    expect(out).toContain('no matches for "nothing"');
  });

  it('renders only discovery section when registry index is empty', async () => {
    registryResponse = {
      status: 200,
      body: JSON.stringify({ items: [] }),
    };
    discoverResponse = {
      status: 200,
      body: JSON.stringify({
        source: 'grep.app',
        hits: [
          {
            repo: 'bob/flow',
            branch: 'main',
            path: 'harness/index.ts',
            matchLines: [
              {
                lineNo: 1,
                content: "import { taskflow } from 'taskflowjs';",
              },
            ],
            url: 'https://github.com/bob/flow/blob/main/harness/index.ts',
            rawUrl:
              'https://raw.githubusercontent.com/bob/flow/main/harness/index.ts',
          },
        ],
      }),
    };

    const out = await captureStdout(() =>
      runSearch({ query: 'flow', cwd: process.cwd(), silent: true }),
    );
    expect(out).not.toContain('from registry index:');
    expect(out).toContain('from github (discovery):');
    expect(out).toContain('bob/flow');
  });

});
