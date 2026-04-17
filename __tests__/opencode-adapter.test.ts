import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgentEvent, LeafSpec } from '../core/types';
import type { SpawnCtx } from '../adapters/index';
import opencodeAdapter, { __setSpawn, __resetSpawn } from '../adapters/opencode';

const spec: LeafSpec = {
  id: 'leaf-oc',
  agent: 'opencode',
  task: 'write a haiku',
  model: 'anthropic/claude-sonnet-4-5',
};
const ctx: SpawnCtx = { runDir: '/tmp/run-oc', cwd: '/test/repo/root' };

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

describe('opencode adapter', () => {
  it('emits synthetic spawn before any subprocess data', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = opencodeAdapter.spawn(spec, ctx);
    const [first] = await collectN(handle.events, 1);
    expect(first.t).toBe('spawn');
    expect((first as Extract<AgentEvent, { t: 'spawn' }>).agent).toBe('opencode');
    expect((first as Extract<AgentEvent, { t: 'spawn' }>).model).toBe('anthropic/claude-sonnet-4-5');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('normalizes message with role assistant', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = opencodeAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => { for await (const e of handle.events) collected.push(e); })();

    child.stdout.write(JSON.stringify({ kind: 'message', role: 'assistant', content: 'Hello, world' }) + '\n');
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;

    const kinds = collected.map((e) => e.t);
    expect(kinds).toEqual(['spawn', 'message', 'done']);
    const msg = collected[1] as Extract<AgentEvent, { t: 'message' }>;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello, world');
  });

  it('emits tool + tool-res and an edit event when result has file/added/removed', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = opencodeAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => { for await (const e of handle.events) collected.push(e); })();

    child.stdout.write(JSON.stringify({ kind: 'tool', name: 'bash', args: { cmd: 'ls' } }) + '\n');
    child.stdout.write(JSON.stringify({ kind: 'tool_result', name: 'bash', result: { stdout: 'a\nb' } }) + '\n');
    child.stdout.write(JSON.stringify({ kind: 'tool', name: 'edit', args: { file: 'x.ts' } }) + '\n');
    child.stdout.write(JSON.stringify({ kind: 'tool_result', name: 'edit', result: { file: 'x.ts', added: 3, removed: 1 } }) + '\n');
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;

    const toolEvents = collected.filter((e) => e.t === 'tool' || e.t === 'tool-res' || e.t === 'edit');
    expect(toolEvents.map((e) => e.t)).toEqual(['tool', 'tool-res', 'tool', 'tool-res', 'edit']);
    const edit = toolEvents[4] as Extract<AgentEvent, { t: 'edit' }>;
    expect(edit.file).toBe('x.ts');
    expect(edit.added).toBe(3);
    expect(edit.removed).toBe(1);
  });

  it('steer() writes send-message JSON line to stdin', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = opencodeAdapter.spawn(spec, ctx);
    const chunks: string[] = [];
    child.stdin.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    await handle.steer('hi');
    await nextTick(2);
    expect(chunks.join('')).toBe(JSON.stringify({ kind: 'send-message', content: 'hi' }) + '\n');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('abort() sends SIGTERM and wait() resolves with status aborted', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = opencodeAdapter.spawn(spec, ctx);
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
    const handle = opencodeAdapter.spawn(spec, ctx);
    const consumer = collectAll(handle.events);
    const err: NodeJS.ErrnoException = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
    const result = await handle.wait();
    const events = await consumer;
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(127);
    expect(events.some((e) => e.t === 'error' && /not found/.test((e as any).error))).toBe(true);
    expect(events[events.length - 1].t).toBe('done');
  });

  it('malformed JSON lines emit error but do not crash', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = opencodeAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => { for await (const e of handle.events) collected.push(e); })();
    child.stdout.write('not-json-at-all\n');
    child.stdout.write(JSON.stringify({ kind: 'message', role: 'assistant', content: 'ok' }) + '\n');
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;

    const errEvs = collected.filter((e) => e.t === 'error');
    expect(errEvs.length).toBe(1);
    expect((errEvs[0] as any).error).toMatch(/malformed json/);
    // continued after the malformed line
    expect(collected.some((e) => e.t === 'message')).toBe(true);
  });

  it('forwards ctx.cwd to _spawn opts', async () => {
    const child = makeFakeChild();
    const captured: { cwd?: string } = {};
    __setSpawn(((_cmd: string, _args: readonly string[], opts: { cwd?: string }) => {
      captured.cwd = opts?.cwd;
      return child;
    }) as any);
    const handle = opencodeAdapter.spawn(spec, ctx);
    expect(captured.cwd).toBe('/test/repo/root');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('non-zero exit → done with status error and stderr included', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = opencodeAdapter.spawn(spec, ctx);
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
    expect(events.some((e) => e.t === 'error' && /code 2/.test((e as any).error))).toBe(true);
  });
});
