import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentEvent, LeafSpec } from '../core/types';
import type { SpawnCtx } from '../adapters/index';
import codexAdapter, { __setSpawn, __resetSpawn } from '../adapters/codex';

// ----- fake child + helpers (mirrors codex-adapter.test.ts) -----

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: (sig?: NodeJS.Signals | number) => boolean;
  killed: boolean;
  killCalls: Array<NodeJS.Signals | number | undefined>;
};

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.stdin = new PassThrough();
  ee.killed = false;
  ee.killCalls = [];
  ee.kill = (sig?: NodeJS.Signals | number) => {
    ee.killCalls.push(sig);
    ee.killed = true;
    return true;
  };
  return ee;
}

async function nextTick(n = 2): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

type SpawnSpy = {
  child: FakeChild;
  argv: readonly string[];
};

/** Install a spawn fn that records argv and returns a fresh fake child. */
function installSpawnSpy(): SpawnSpy {
  const child = makeFakeChild();
  const spy: SpawnSpy = { child, argv: [] };
  __setSpawn(((_cmd: string, args: readonly string[]) => {
    spy.argv = args;
    return child;
  }) as any);
  return spy;
}

// ----- env + tmpdir lifecycle -----

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { x: { type: 'number' } },
  required: ['x'],
  additionalProperties: false,
};

let runDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-'));
  savedEnv = process.env.HARNESS_CODEX_SCHEMA;
  delete process.env.HARNESS_CODEX_SCHEMA;
});

afterEach(() => {
  __resetSpawn();
  if (savedEnv === undefined) delete process.env.HARNESS_CODEX_SCHEMA;
  else process.env.HARNESS_CODEX_SCHEMA = savedEnv;
  fs.rmSync(runDir, { recursive: true, force: true });
});

// ----- helpers for asserting on argv -----

function indexAfter(argv: readonly string[], flag: string): number {
  return argv.indexOf(flag);
}

function promptArg(argv: readonly string[]): string {
  const i = argv.indexOf('-p');
  expect(i).toBeGreaterThanOrEqual(0);
  expect(i + 1).toBeLessThan(argv.length);
  return argv[i + 1];
}

// ----- tests -----

describe('codex adapter — native --output-schema', () => {
  it('happy path: writes schema file, passes flags, reads result, populates structuredOutputValue', async () => {
    const spec: LeafSpec = { id: 'leaf-native', agent: 'codex', task: 'compute x', model: 'gpt-5.4' };
    const ctx: SpawnCtx = { runDir, structuredOutput: { jsonSchema: SCHEMA } };
    const spy = installSpawnSpy();

    const handle = codexAdapter.spawn(spec, ctx);

    // Argv assertions
    expect(spy.argv).toContain('--output-schema');
    expect(spy.argv).toContain('-o');
    const schemaPath = spy.argv[indexAfter(spy.argv, '--output-schema') + 1];
    const outPath = spy.argv[indexAfter(spy.argv, '-o') + 1];
    expect(schemaPath.endsWith(path.join('leaves', 'leaf-native', 'codex-schema.json'))).toBe(true);
    expect(outPath.endsWith(path.join('leaves', 'leaf-native', 'codex-result.json'))).toBe(true);

    // Schema file exists with content
    expect(fs.existsSync(schemaPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(schemaPath, 'utf8'))).toEqual(SCHEMA);

    // Prompt argv must NOT contain the fallback "JSON Schema:" tag
    expect(promptArg(spy.argv)).not.toContain('JSON Schema:');

    // Simulate codex writing the result file then exiting cleanly.
    fs.writeFileSync(outPath, JSON.stringify({ x: 42 }));
    spy.child.stdout.end();
    await nextTick(2);
    spy.child.emit('exit', 0, null);
    const result = await handle.wait();

    expect(result.status).toBe('done');
    expect(result.structuredOutputValue).toEqual({ x: 42 });
  });

  it('gated off by broken model gpt-5-codex: falls back to prompt-engineered JSON', async () => {
    const spec: LeafSpec = {
      id: 'leaf-broken',
      agent: 'codex',
      task: 'compute x',
      model: 'gpt-5-codex',
    };
    const ctx: SpawnCtx = { runDir, structuredOutput: { jsonSchema: SCHEMA } };
    const spy = installSpawnSpy();

    const handle = codexAdapter.spawn(spec, ctx);

    // No native flags, prompt has the fallback marker
    expect(spy.argv).not.toContain('--output-schema');
    expect(spy.argv).not.toContain('-o');
    expect(promptArg(spy.argv)).toContain('JSON Schema:');

    // Schema file should NOT have been written
    expect(fs.existsSync(path.join(runDir, 'leaves', 'leaf-broken', 'codex-schema.json'))).toBe(
      false,
    );

    // Emit assistant message containing a fenced json block, then exit cleanly.
    const final =
      'sure, here you go:\n```json\n{"x": 7}\n```\n';
    spy.child.stdout.write(
      JSON.stringify({ type: 'item.message', role: 'assistant', content: final }) + '\n',
    );
    spy.child.stdout.end();
    await nextTick(4);
    spy.child.emit('exit', 0, null);
    const result = await handle.wait();

    expect(result.status).toBe('done');
    expect(result.structuredOutputValue).toEqual({ x: 7 });
  });

  it('native: outfile missing → status:error with "missing or malformed" message', async () => {
    const spec: LeafSpec = { id: 'leaf-miss', agent: 'codex', task: 'compute x', model: 'gpt-5.4' };
    const ctx: SpawnCtx = { runDir, structuredOutput: { jsonSchema: SCHEMA } };
    const spy = installSpawnSpy();

    const handle = codexAdapter.spawn(spec, ctx);
    expect(spy.argv).toContain('--output-schema');

    // Don't write the outfile. Just exit clean.
    spy.child.stdout.end();
    await nextTick(2);
    spy.child.emit('exit', 0, null);
    const result = await handle.wait();

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/native schema result missing or malformed/);
  });

  it('native: outfile malformed → status:error with "missing or malformed" message', async () => {
    const spec: LeafSpec = { id: 'leaf-bad', agent: 'codex', task: 'compute x', model: 'gpt-5.4' };
    const ctx: SpawnCtx = { runDir, structuredOutput: { jsonSchema: SCHEMA } };
    const spy = installSpawnSpy();

    const handle = codexAdapter.spawn(spec, ctx);
    const outPath = spy.argv[indexAfter(spy.argv, '-o') + 1];
    fs.writeFileSync(outPath, 'not json {{{');

    spy.child.stdout.end();
    await nextTick(2);
    spy.child.emit('exit', 0, null);
    const result = await handle.wait();

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/missing or malformed/);
  });

  it('HARNESS_CODEX_SCHEMA=0 forces fallback even on a good model', async () => {
    process.env.HARNESS_CODEX_SCHEMA = '0';
    const spec: LeafSpec = { id: 'leaf-env-off', agent: 'codex', task: 'compute x', model: 'gpt-5.4' };
    const ctx: SpawnCtx = { runDir, structuredOutput: { jsonSchema: SCHEMA } };
    const spy = installSpawnSpy();

    const handle = codexAdapter.spawn(spec, ctx);
    expect(spy.argv).not.toContain('--output-schema');
    expect(spy.argv).not.toContain('-o');
    expect(promptArg(spy.argv)).toContain('JSON Schema:');

    // Drain to keep wait() resolving cleanly.
    const consumer = collectAll(handle.events);
    spy.child.stdout.end();
    await nextTick(2);
    spy.child.emit('exit', 0, null);
    await handle.wait();
    await consumer;
  });

  it('HARNESS_CODEX_SCHEMA=1 forces native even on broken model', async () => {
    process.env.HARNESS_CODEX_SCHEMA = '1';
    const spec: LeafSpec = {
      id: 'leaf-env-on',
      agent: 'codex',
      task: 'compute x',
      model: 'gpt-5-codex',
    };
    const ctx: SpawnCtx = { runDir, structuredOutput: { jsonSchema: SCHEMA } };
    const spy = installSpawnSpy();

    const handle = codexAdapter.spawn(spec, ctx);
    expect(spy.argv).toContain('--output-schema');
    expect(spy.argv).toContain('-o');

    // Write a valid result so wait() resolves green.
    const outPath = spy.argv[indexAfter(spy.argv, '-o') + 1];
    fs.writeFileSync(outPath, JSON.stringify({ x: 1 }));
    spy.child.stdout.end();
    await nextTick(2);
    spy.child.emit('exit', 0, null);
    const result = await handle.wait();
    expect(result.status).toBe('done');
    expect(result.structuredOutputValue).toEqual({ x: 1 });
  });

  it('no structuredOutput: no native flags, no schema files written', async () => {
    const spec: LeafSpec = { id: 'leaf-none', agent: 'codex', task: 'just chat', model: 'gpt-5.4' };
    const ctx: SpawnCtx = { runDir };
    const spy = installSpawnSpy();

    const handle = codexAdapter.spawn(spec, ctx);
    expect(spy.argv).not.toContain('--output-schema');
    expect(spy.argv).not.toContain('-o');
    expect(promptArg(spy.argv)).not.toContain('JSON Schema:');
    expect(fs.existsSync(path.join(runDir, 'leaves', 'leaf-none'))).toBe(false);

    spy.child.stdout.end();
    await nextTick(2);
    spy.child.emit('exit', 0, null);
    await handle.wait();
  });
});
