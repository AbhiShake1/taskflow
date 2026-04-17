import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgentEvent, LeafSpec } from '../core/types';
import type { SpawnCtx } from '../adapters/index';
import cursorAdapter, { __setSpawn, __resetSpawn, WATCHDOG_MS } from '../adapters/cursor';

const spec: LeafSpec = {
  id: 'leaf-cursor',
  agent: 'cursor',
  task: 'refactor utils',
  model: 'claude-opus-4-7',
};
const ctx: SpawnCtx = { runDir: '/tmp/run-cursor', cwd: '/test/repo/root' };

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

async function collectN<T>(iter: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) {
    out.push(v);
    if (out.length >= n) break;
  }
  return out;
}

function installSpawn(factory: () => FakeChild): FakeChild {
  const child = factory();
  __setSpawn((() => child) as any);
  return child;
}

afterEach(() => {
  __resetSpawn();
  vi.useRealTimers();
});

describe('cursor adapter', () => {
  it('emits synthetic spawn before any subprocess data', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = cursorAdapter.spawn(spec, ctx);
    const [first] = await collectN(handle.events, 1);
    expect(first.t).toBe('spawn');
    expect((first as Extract<AgentEvent, { t: 'spawn' }>).agent).toBe('cursor');
    expect((first as Extract<AgentEvent, { t: 'spawn' }>).model).toBe('claude-opus-4-7');
    child.stdout.end();
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('normalizes a message line into a message event', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = cursorAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => {
      for await (const e of handle.events) collected.push(e);
    })();
    child.stdout.write(
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello from cursor' }) + '\n',
    );
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;
    const kinds = collected.map((e) => e.t);
    expect(kinds).toEqual(['spawn', 'message', 'done']);
    const msg = collected[1] as Extract<AgentEvent, { t: 'message' }>;
    expect(msg.content).toBe('Hello from cursor');
    expect(msg.role).toBe('assistant');
  });

  it('emits tool + tool-res for tool_call/tool_result', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = cursorAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => {
      for await (const e of handle.events) collected.push(e);
    })();
    child.stdout.write(
      JSON.stringify({ type: 'tool_call', name: 'bash', input: { cmd: 'ls' } }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({ type: 'tool_result', name: 'bash', output: { stdout: 'a\nb' } }) + '\n',
    );
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;
    const kinds = collected.filter((e) => e.t === 'tool' || e.t === 'tool-res').map((e) => e.t);
    expect(kinds).toEqual(['tool', 'tool-res']);
    const tool = collected.find((e) => e.t === 'tool') as Extract<AgentEvent, { t: 'tool' }>;
    expect(tool.name).toBe('bash');
    expect(tool.args).toEqual({ cmd: 'ls' });
  });

  it('emits edit event from tool_result for edit tool', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = cursorAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => {
      for await (const e of handle.events) collected.push(e);
    })();
    child.stdout.write(
      JSON.stringify({
        type: 'tool_result',
        name: 'edit',
        result: { file: 'a.ts', added: 5, removed: 2 },
      }) + '\n',
    );
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;
    const edit = collected.find((e) => e.t === 'edit') as Extract<AgentEvent, { t: 'edit' }>;
    expect(edit).toBeDefined();
    expect(edit.file).toBe('a.ts');
    expect(edit.added).toBe(5);
    expect(edit.removed).toBe(2);
  });

  it('steer() writes line to stdin', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = cursorAdapter.spawn(spec, ctx);
    const chunks: string[] = [];
    child.stdin.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    await handle.steer('hello');
    await nextTick(2);
    expect(chunks.join('')).toBe('hello\n');
    child.stdout.end();
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('abort() sends SIGTERM and resolves status aborted', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = cursorAdapter.spawn(spec, ctx);
    const consumer = collectAll(handle.events);
    await handle.abort('user');
    expect(child.killCalls).toContain('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    const result = await handle.wait();
    const events = await consumer;
    expect(result.status).toBe('aborted');
    const last = events[events.length - 1] as Extract<AgentEvent, { t: 'done' }>;
    expect(last.result.status).toBe('aborted');
  });

  it('ENOENT → error + done(error, 127)', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = cursorAdapter.spawn(spec, ctx);
    const consumer = collectAll(handle.events);
    const err: NodeJS.ErrnoException = Object.assign(new Error('spawn cursor-agent ENOENT'), {
      code: 'ENOENT',
    });
    child.emit('error', err);
    const result = await handle.wait();
    const events = await consumer;
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(127);
    expect(
      events.some(
        (e) => e.t === 'error' && /cursor-agent binary not found/.test((e as any).error),
      ),
    ).toBe(true);
  });

  it('malformed JSON → error event; stream continues', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = cursorAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => {
      for await (const e of handle.events) collected.push(e);
    })();
    child.stdout.write('not-json\n');
    child.stdout.write(
      JSON.stringify({ type: 'message', role: 'assistant', content: 'after garbage' }) + '\n',
    );
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;
    const errs = collected.filter((e) => e.t === 'error');
    expect(errs.length).toBe(1);
    expect((errs[0] as any).error).toMatch(/malformed json/);
    const msg = collected.find((e) => e.t === 'message') as Extract<AgentEvent, { t: 'message' }>;
    expect(msg.content).toBe('after garbage');
  });

  it('forwards ctx.cwd to _spawn opts', async () => {
    const child = makeFakeChild();
    const captured: { cwd?: string } = {};
    __setSpawn(((_cmd: string, _args: readonly string[], opts: { cwd?: string }) => {
      captured.cwd = opts?.cwd;
      return child;
    }) as any);
    const handle = cursorAdapter.spawn(spec, ctx);
    expect(captured.cwd).toBe('/test/repo/root');
    child.stdout.end();
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('watchdog fires after 30s of silence → error + abort', async () => {
    vi.useFakeTimers();
    const child = installSpawn(makeFakeChild);
    const handle = cursorAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => {
      for await (const e of handle.events) collected.push(e);
    })();
    // advance past watchdog
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1);
    expect(child.killCalls).toContain('SIGTERM');
    expect(collected.some((e) => e.t === 'error' && /cursor-agent stall/.test((e as any).error)))
      .toBe(true);
    const result = await handle.wait();
    expect(result.status).toBe('error');
    // Drain remaining scheduled timers (the 2s SIGKILL delay) then close consumer.
    await vi.advanceTimersByTimeAsync(3_000);
    await consumer;
  });
});
