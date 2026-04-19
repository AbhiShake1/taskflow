import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
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
import { runAdd } from '../pipeline';
import { clearRegistryContext } from '../registry/context';
import { clearFetchCache } from '../registry/fetcher';

const OK_ITEM = {
  $schema: 'https://taskflow.sh/schema/registry-item.json',
  name: 'ok',
  type: 'taskflow:harness',
  description: 'smoke test harness',
  files: [
    {
      path: 'harness/ok.ts',
      type: 'taskflow:harness',
      content: "export const ok = () => 'ok';\n",
    },
  ],
};


describe('taskflow add (e2e smoke)', () => {
  let server: Server;
  let port: number;
  let cwd: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(OK_ITEM));
        return;
      }
      res.writeHead(404);
      res.end();
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
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-add-e2e-'));
    envBackup.TASKFLOW_REGISTRY_URL = process.env.TASKFLOW_REGISTRY_URL;
    envBackup.REGISTRY_URL = process.env.REGISTRY_URL;
    process.env.TASKFLOW_REGISTRY_URL = `http://127.0.0.1:${port}`;
    delete process.env.REGISTRY_URL;
    clearFetchCache();
    clearRegistryContext();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    if (envBackup.TASKFLOW_REGISTRY_URL === undefined)
      delete process.env.TASKFLOW_REGISTRY_URL;
    else process.env.TASKFLOW_REGISTRY_URL = envBackup.TASKFLOW_REGISTRY_URL;
    if (envBackup.REGISTRY_URL === undefined) delete process.env.REGISTRY_URL;
    else process.env.REGISTRY_URL = envBackup.REGISTRY_URL;
  });

  it('installs a harness from a local HTTP fixture: taskflow.json, harness file, lockfile', async () => {
    await runAdd({
      cwd,
      inputs: ['ok'],
      overwrite: false,
      yes: true,
      silent: true,
      dryRun: false,
      frozen: false,
      skipAdapterCheck: true,
    });

    // taskflow.json was created
    const taskflowJsonPath = join(cwd, 'taskflow.json');
    expect(existsSync(taskflowJsonPath)).toBe(true);

    // harness file landed at the expected path
    const harnessPath = join(cwd, '.agents/taskflow/harness/ok.ts');
    expect(existsSync(harnessPath)).toBe(true);
    expect(readFileSync(harnessPath, 'utf8')).toContain("export const ok");

    // lockfile has the entry pointing at our fixture URL
    const lockRaw = JSON.parse(readFileSync(join(cwd, 'taskflow.lock'), 'utf8'));
    expect(lockRaw.version).toBe('1');
    expect(lockRaw.items.ok).toBeTruthy();
    expect(lockRaw.items.ok.type).toBe('taskflow:harness');
    expect(String(lockRaw.items.ok.source)).toContain(`127.0.0.1:${port}`);
  });
});
