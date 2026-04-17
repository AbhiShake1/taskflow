import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgentEvent, LeafSpec } from '../core/types';
import type { SpawnCtx } from '../adapters/index';
import codexAdapter, { __setSpawn, __resetSpawn } from '../adapters/codex';

const spec: LeafSpec = { id: 'leaf-codex', agent: 'codex', task: 'write a haiku', model: 'gpt-5.4' };
const ctx: SpawnCtx = { runDir: '/tmp/run-codex', cwd: '/test/repo/root' };

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

async function collectN<T>(iter: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) {
    out.push(v);
    if (out.length >= n) break;
  }
  return out;
}

async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

function installSpawn(factory: () => FakeChild): FakeChild {
  const child = factory();
  __setSpawn((() => child) as any);
  return child;
}

afterEach(() => __resetSpawn());

describe('codex adapter', () => {
  it('emits synthetic spawn before any subprocess data', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = codexAdapter.spawn(spec, ctx);
    const [first] = await collectN(handle.events, 1);
    expect(first.t).toBe('spawn');
    expect((first as Extract<AgentEvent, { t: 'spawn' }>).agent).toBe('codex');
    expect((first as Extract<AgentEvent, { t: 'spawn' }>).model).toBe('gpt-5.4');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('buffers turn.delta chunks and emits one message on turn.end', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = codexAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => { for await (const e of handle.events) collected.push(e); })();

    child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.start', turn_id: 1 }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.delta', role: 'assistant', turn_id: 1, delta: 'Hel' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.delta', role: 'assistant', turn_id: 1, delta: 'lo, ' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.delta', role: 'assistant', turn_id: 1, delta: 'world' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.end', turn_id: 1, role: 'assistant' }) + '\n');
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;
    const result = await handle.wait();

    const kinds = collected.map((e) => e.t);
    expect(kinds).toEqual(['spawn', 'message', 'done']);
    const msg = collected[1] as Extract<AgentEvent, { t: 'message' }>;
    expect(msg.content).toBe('Hello, world');
    expect(msg.role).toBe('assistant');
    expect(result.status).toBe('done');
    expect(result.exitCode).toBe(0);
  });

  it('emits tool + tool-res for item.tool_use / item.tool_result', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = codexAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => { for await (const e of handle.events) collected.push(e); })();

    child.stdout.write(JSON.stringify({ type: 'item.tool_use', name: 'bash', args: { cmd: 'ls' } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'item.tool_result', name: 'bash', result: { stdout: 'a\nb' } }) + '\n');
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;

    const toolEvents = collected.filter((e) => e.t === 'tool' || e.t === 'tool-res');
    expect(toolEvents.map((e) => e.t)).toEqual(['tool', 'tool-res']);
    expect((toolEvents[0] as Extract<AgentEvent, { t: 'tool' }>).name).toBe('bash');
    expect((toolEvents[1] as Extract<AgentEvent, { t: 'tool-res' }>).name).toBe('bash');
  });

  it('emits edit event for item.edit with {file, added, removed}', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = codexAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => { for await (const e of handle.events) collected.push(e); })();

    child.stdout.write(JSON.stringify({ type: 'item.edit', file: 'x.ts', added: 3, removed: 1 }) + '\n');
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;

    const edits = collected.filter((e) => e.t === 'edit') as Array<Extract<AgentEvent, { t: 'edit' }>>;
    expect(edits.length).toBe(1);
    expect(edits[0].file).toBe('x.ts');
    expect(edits[0].added).toBe(3);
    expect(edits[0].removed).toBe(1);
  });

  it('steer() writes a plain-text line to stdin', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = codexAdapter.spawn(spec, ctx);
    const chunks: string[] = [];
    child.stdin.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    await handle.steer('continue');
    await nextTick(2);
    expect(chunks.join('')).toBe('continue\n');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('abort() sends SIGTERM and wait() resolves with status aborted', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = codexAdapter.spawn(spec, ctx);
    const consumer = collectAll(handle.events);
    await handle.abort('user');
    expect(child.killCalls).toContain('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    const result = await handle.wait();
    const events = await consumer;
    expect(result.status).toBe('aborted');
    const last = events[events.length - 1] as Extract<AgentEvent, { t: 'done' }>;
    expect(last.t).toBe('done');
    expect(last.result.status).toBe('aborted');
  });

  it('ENOENT on child error → error + done(status:error, exitCode:127)', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = codexAdapter.spawn(spec, ctx);
    const consumer = collectAll(handle.events);
    const err: NodeJS.ErrnoException = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
    const result = await handle.wait();
    const events = await consumer;
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(127);
    expect(events.some((e) => e.t === 'error' && /codex binary not found/.test((e as any).error))).toBe(true);
    expect(events[events.length - 1].t).toBe('done');
  });

  it('malformed JSON lines emit error but do not crash', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = codexAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => { for await (const e of handle.events) collected.push(e); })();
    child.stdout.write('not-json-at-all\n');
    child.stdout.write(JSON.stringify({ type: 'turn.start', turn_id: 1 }) + '\n');
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;
    await handle.wait();
    const errEvs = collected.filter((e) => e.t === 'error');
    expect(errEvs.length).toBe(1);
    expect((errEvs[0] as any).error).toMatch(/malformed json/);
  });

  it('forwards ctx.cwd to _spawn opts', async () => {
    const child = makeFakeChild();
    const captured: { cwd?: string } = {};
    __setSpawn(((_cmd: string, _args: readonly string[], opts: { cwd?: string }) => {
      captured.cwd = opts?.cwd;
      return child;
    }) as any);
    const handle = codexAdapter.spawn(spec, ctx);
    expect(captured.cwd).toBe('/test/repo/root');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('non-zero exit → done with status error and stderr in error', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = codexAdapter.spawn(spec, ctx);
    const consumer = collectAll(handle.events);
    child.stderr.write('boom\n');
    child.stdout.end();
    await nextTick(2);
    child.emit('exit', 2, null);
    const result = await handle.wait();
    const events = await consumer;
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(2);
    expect(result.error).toMatch(/boom/);
    const last = events[events.length - 1] as Extract<AgentEvent, { t: 'done' }>;
    expect(last.result.status).toBe('error');
    expect(events.some((e) => e.t === 'error' && /code 2/.test((e as any).error))).toBe(true);
  });
});
