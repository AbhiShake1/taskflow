import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CONFIG,
  clearConfigCache,
  defineConfig,
  loadConfig,
  type TaskflowConfig,
} from '../core/config';

const CONFIG_TS_ABS = resolve(__dirname, '..', 'core', 'config.ts');
const CONFIG_IMPORT_URL = pathToFileURL(CONFIG_TS_ABS).href;

let tmpRoot: string;
const cleanup: string[] = [];

beforeEach(async () => {
  clearConfigCache();
  tmpRoot = await mkdtemp(join(tmpdir(), 'taskflow-config-'));
  cleanup.push(tmpRoot);
});

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  clearConfigCache();
});

async function writeConfig(dir: string, body: string): Promise<string> {
  const cfgDir = join(dir, '.agents', 'taskflow');
  await mkdir(cfgDir, { recursive: true });
  const file = join(cfgDir, 'config.ts');
  await writeFile(file, body, 'utf8');
  return file;
}

function configWithMaxRetries(n: number, extra = ''): string {
  return `import { defineConfig } from '${CONFIG_IMPORT_URL}';
export default defineConfig({ todos: { maxRetries: ${n} }${extra ? ', ' + extra : ''} });
`;
}

describe('defineConfig', () => {
  it('is identity', () => {
    const input: TaskflowConfig = { todos: { maxRetries: 7 } };
    expect(defineConfig(input)).toBe(input);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('has expected shape', () => {
    expect(DEFAULT_CONFIG.todos.autoExtract).toBe(true);
    expect(DEFAULT_CONFIG.todos.maxRetries).toBe(3);
    expect(DEFAULT_CONFIG.todos.forceGeneration).toBe(false);
    expect(DEFAULT_CONFIG.hooks.errorPolicy).toBe('swallow');
    expect(DEFAULT_CONFIG.hooks.timeoutMs).toBe(30_000);
    expect(DEFAULT_CONFIG.events).toEqual({});
    expect(DEFAULT_CONFIG.plugins).toEqual([]);
  });
});

describe('loadConfig', () => {
  it('returns defaults when no files exist anywhere', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tf-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'tf-cwd-'));
    cleanup.push(home, cwd);

    const r = await loadConfig({ home, cwd });
    expect(r.sources).toEqual([]);
    expect(r.eventLayers).toEqual([]);
    expect(r.plugins).toEqual([]);
    expect(r.resolved).toEqual({
      events: {},
      todos: { autoExtract: true, maxRetries: 3, forceGeneration: false },
      hooks: { errorPolicy: 'swallow', timeoutMs: 30_000 },
      plugins: [],
    });
  });

  it('picks up a single global file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tf-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'tf-cwd-'));
    cleanup.push(home, cwd);

    const body = `import { defineConfig } from '${CONFIG_IMPORT_URL}';
export default defineConfig({
  todos: { maxRetries: 9 },
  events: { beforeHarness: async () => {} },
});
`;
    const file = await writeConfig(home, body);

    const r = await loadConfig({ home, cwd });
    expect(r.sources).toEqual([file]);
    expect(r.resolved.todos.maxRetries).toBe(9);
    expect(r.resolved.todos.autoExtract).toBe(true);
    expect(r.eventLayers).toHaveLength(1);
    expect(r.eventLayers[0].beforeHarness).toBeTypeOf('function');
  });

  it('project file overrides global for scalars; preserves both event layers in order', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tf-home-'));
    const cwd = join(home, 'proj');
    await mkdir(cwd, { recursive: true });
    cleanup.push(home);

    const globalFile = await writeConfig(
      home,
      `import { defineConfig } from '${CONFIG_IMPORT_URL}';
const tag = 'global';
export default defineConfig({
  todos: { maxRetries: 2 },
  hooks: { timeoutMs: 100 },
  events: { beforeHarness: async () => { (globalThis as any).__tag = tag; } },
});
`,
    );
    const projFile = await writeConfig(
      cwd,
      `import { defineConfig } from '${CONFIG_IMPORT_URL}';
const tag = 'project';
export default defineConfig({
  todos: { maxRetries: 11 },
  events: { afterHarness: async () => { (globalThis as any).__tag = tag; } },
});
`,
    );

    const r = await loadConfig({ home, cwd });
    expect(r.sources).toEqual([globalFile, projFile]);
    expect(r.resolved.todos.maxRetries).toBe(11);
    expect(r.resolved.hooks.timeoutMs).toBe(100);
    expect(r.eventLayers).toHaveLength(2);
    expect(r.eventLayers[0].beforeHarness).toBeTypeOf('function');
    expect(r.eventLayers[1].afterHarness).toBeTypeOf('function');
  });

  it('walks the hierarchy from home down to cwd', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tf-walk-'));
    const a = home;
    const b = join(a, 'B');
    const c = join(b, 'C');
    const d = join(c, 'D');
    await mkdir(d, { recursive: true });
    cleanup.push(home);

    const fA = await writeConfig(a, configWithMaxRetries(1));
    const fB = await writeConfig(b, configWithMaxRetries(2));
    const fC = await writeConfig(c, configWithMaxRetries(3));
    const fD = await writeConfig(d, configWithMaxRetries(4));

    const r = await loadConfig({ home: a, cwd: d });
    expect(r.sources).toEqual([fA, fB, fC, fD]);
    expect(r.resolved.todos.maxRetries).toBe(4);
  });

  it('cwd not under home: only home + cwd files load, no walk', async () => {
    const homeRoot = await mkdtemp(join(tmpdir(), 'tf-home-iso-'));
    const cwdRoot = await mkdtemp(join(tmpdir(), 'tf-cwd-iso-'));
    cleanup.push(homeRoot, cwdRoot);

    const intermediate = join(cwdRoot, 'mid');
    await mkdir(intermediate, { recursive: true });
    await writeConfig(intermediate, configWithMaxRetries(99));

    const fHome = await writeConfig(homeRoot, configWithMaxRetries(7));
    const fCwd = await writeConfig(cwdRoot, configWithMaxRetries(8));

    const r = await loadConfig({ home: homeRoot, cwd: cwdRoot });
    expect(r.sources).toEqual([fHome, fCwd]);
    expect(r.resolved.todos.maxRetries).toBe(8);
  });

  it('throws an Error mentioning the path on invalid config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tf-bad-'));
    const cwd = home;
    cleanup.push(home);

    const file = await writeConfig(
      home,
      `export default 42;
`,
    );

    await expect(loadConfig({ home, cwd })).rejects.toThrow(file);
  });

  it('throws when default export is an object with none of the known keys', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tf-nokeys-'));
    const cwd = home;
    cleanup.push(home);

    const file = await writeConfig(
      home,
      `export default {};
`,
    );

    await expect(loadConfig({ home, cwd })).rejects.toThrow(
      'config object contains none of the expected keys – must include at least one of: events, todos, hooks, plugins, scope',
    );
    await expect(loadConfig({ home, cwd })).rejects.toThrow(file);
  });

  it('plugins concatenate across files in walk order', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tf-plug-'));
    const cwd = join(home, 'proj');
    await mkdir(cwd, { recursive: true });
    cleanup.push(home);

    await writeConfig(
      home,
      `import { defineConfig } from '${CONFIG_IMPORT_URL}';
const pA = () => ({ name: 'a' });
const pB = () => ({ name: 'b' });
export default defineConfig({ plugins: [pA, pB] });
`,
    );
    await writeConfig(
      cwd,
      `import { defineConfig } from '${CONFIG_IMPORT_URL}';
const pC = () => ({ name: 'c' });
export default defineConfig({ plugins: [pC] });
`,
    );

    const r = await loadConfig({ home, cwd });
    expect(r.plugins).toHaveLength(3);
    const names = await Promise.all(r.plugins.map(async (p) => (await p({ config: r.resolved })).name));
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('clearConfigCache lets a freshly added file be picked up', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tf-cache-'));
    const cwd = home;
    cleanup.push(home);

    const r1 = await loadConfig({ home, cwd });
    expect(r1.sources).toEqual([]);

    const r2 = await loadConfig({ home, cwd });
    expect(r2).toBe(r1.constructor === r2.constructor ? r2 : r2);

    await writeConfig(home, configWithMaxRetries(42));

    const stillCached = await loadConfig({ home, cwd });
    expect(stillCached.sources).toEqual([]);

    clearConfigCache();
    const r3 = await loadConfig({ home, cwd });
    expect(r3.sources).toHaveLength(1);
    expect(r3.resolved.todos.maxRetries).toBe(42);
  });

  it('caches per (home, cwd) pair within a process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tf-cache2-'));
    const cwd = home;
    cleanup.push(home);

    const a = loadConfig({ home, cwd });
    const b = loadConfig({ home, cwd });
    expect(a).toBe(b);
  });
});
