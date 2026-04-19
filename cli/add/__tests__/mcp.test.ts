import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpListHarnesses, mcpSearch, runMcp } from '../mcp';

describe('runMcp', () => {
  it('exports runMcp as a function', () => {
    expect(typeof runMcp).toBe('function');
  });
});

describe('mcpListHarnesses', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-mcp-list-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns [] when no lockfile exists', async () => {
    const result = await mcpListHarnesses({ cwd });
    expect(result).toEqual([]);
  });

  it('returns installed entries from taskflow.lock', async () => {
    const lock = {
      version: '1',
      items: {
        alpha: { source: 'https://r.example/alpha.json', type: 'taskflow:harness' },
        beta: { source: 'https://r.example/beta.json', type: 'taskflow:plugin' },
      },
    };
    writeFileSync(join(cwd, 'taskflow.lock'), JSON.stringify(lock), 'utf8');
    const result = await mcpListHarnesses({ cwd });
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.name === 'alpha')).toEqual({
      name: 'alpha',
      type: 'taskflow:harness',
      source: 'https://r.example/alpha.json',
    });
  });
});

describe('mcpSearch', () => {
  let cwd: string;
  let server: HttpServer;
  let baseUrl: string;
  const originalEnv = process.env.TASKFLOW_REGISTRY_URL;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-mcp-search-'));
    mkdirSync(cwd, { recursive: true });
    server = createServer((req, res) => {
      if (req.url === '/registries.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [
              { name: 'ui-harness-trio', description: 'Three agents for UI' },
              { name: 'video-tests', description: 'E2E video recording' },
              { name: 'ui-plan', description: 'Static plan preview' },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    process.env.TASKFLOW_REGISTRY_URL = baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(cwd, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.TASKFLOW_REGISTRY_URL;
    else process.env.TASKFLOW_REGISTRY_URL = originalEnv;
  });

  it('returns fuzzy matches by registry name', async () => {
    const result = await mcpSearch({ cwd, query: 'ui' });
    expect(result.message).toBeUndefined();
    expect(result.matches.map((m) => m.name)).toEqual(
      expect.arrayContaining(['ui-harness-trio', 'ui-plan']),
    );
    expect(result.matches.find((m) => m.name === 'video-tests')).toBeUndefined();
  });

  it('returns empty matches with a message when the index is unreachable', async () => {
    process.env.TASKFLOW_REGISTRY_URL = 'http://127.0.0.1:1';
    const result = await mcpSearch({ cwd, query: 'ui' });
    expect(result.matches).toEqual([]);
    expect(result.message).toBeDefined();
  });
});
