import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AgentEvent, LeafSpec } from '../core/types';
import type { SpawnCtx } from '../adapters/index';
import piAdapter, { __setSpawn, __resetSpawn } from '../adapters/pi';

const spec: LeafSpec = { id: 'leaf-pi', agent: 'pi', task: 'write a haiku', model: 'anthropic/claude-opus-4-7' };
const ctx: SpawnCtx = { runDir: '/tmp/run-pi', cwd: '/test/repo/root' };

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

const savedPiBin = process.env.HARNESS_PI_BIN;
afterEach(() => {
  __resetSpawn();
  if (savedPiBin === undefined) delete process.env.HARNESS_PI_BIN;
  else process.env.HARNESS_PI_BIN = savedPiBin;
});

describe('pi adapter', () => {
  it('emits synthetic spawn before any subprocess data', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = piAdapter.spawn(spec, ctx);
    const [first] = await collectN(handle.events, 1);
    expect(first.t).toBe('spawn');
    expect((first as Extract<AgentEvent, { t: 'spawn' }>).agent).toBe('pi');
    expect((first as Extract<AgentEvent, { t: 'spawn' }>).model).toBe('anthropic/claude-opus-4-7');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('buffers message_update deltas and emits one message on turn_end', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = piAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => {
      for await (const e of handle.events) collected.push(e);
    })();

    child.stdout.write(JSON.stringify({ type: 'agent_start', session_id: 's1' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn_start', turn_id: 1 }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'message_update', role: 'assistant', turn_id: 1, delta: 'Hel' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'message_update', role: 'assistant', turn_id: 1, delta: 'lo, ' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'message_update', role: 'assistant', turn_id: 1, delta: 'world' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn_end', turn_id: 1, role: 'assistant' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\n');
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

  it('emits tool + tool-res for tool_execution_{start,end}', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = piAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => { for await (const e of handle.events) collected.push(e); })();

    child.stdout.write(JSON.stringify({ type: 'tool_execution_start', name: 'bash', args: { cmd: 'ls' } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'tool_execution_end', name: 'bash', result: { stdout: 'a\nb' } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'tool_execution_start', name: 'edit-file', args: { file: 'x.ts' } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'tool_execution_end', name: 'edit-file', result: { file: 'x.ts', added: 3, removed: 1 } }) + '\n');
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

  it('steer() writes a JSON line to stdin', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = piAdapter.spawn(spec, ctx);
    const chunks: string[] = [];
    child.stdin.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    await handle.steer('next step');
    await nextTick(2);
    expect(chunks.join('')).toBe(JSON.stringify({ type: 'steer', message: 'next step' }) + '\n');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('abort() sends SIGTERM and wait() resolves with status aborted', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = piAdapter.spawn(spec, ctx);
    const consumer = collectAll(handle.events);
    await handle.abort('user');
    expect(child.killCalls).toContain('SIGTERM');
    // simulate process exiting after SIGTERM
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
    const handle = piAdapter.spawn(spec, ctx);
    const consumer = collectAll(handle.events);
    const err: NodeJS.ErrnoException = Object.assign(new Error('spawn pi ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
    const result = await handle.wait();
    const events = await consumer;
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(127);
    expect(events.some((e) => e.t === 'error' && /not found in PATH/.test((e as any).error))).toBe(true);
    expect(events[events.length - 1].t).toBe('done');
  });

  it('malformed JSON lines emit error but do not crash', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = piAdapter.spawn(spec, ctx);
    const collected: AgentEvent[] = [];
    const consumer = (async () => { for await (const e of handle.events) collected.push(e); })();
    child.stdout.write('not-json-at-all\n');
    child.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\n');
    child.stdout.end();
    await nextTick(4);
    child.emit('exit', 0, null);
    await consumer;
    await handle.wait();
    const errEvs = collected.filter((e) => e.t === 'error');
    expect(errEvs.length).toBe(1);
    expect((errEvs[0] as any).error).toMatch(/malformed json/);
  });

  it('HARNESS_PI_BIN=omp causes _spawn to be called with "omp"', async () => {
    const child = makeFakeChild();
    const captured: { cmd?: string } = {};
    __setSpawn(((cmd: string, _args: readonly string[], _opts: unknown) => {
      captured.cmd = cmd;
      return child;
    }) as any);
    process.env.HARNESS_PI_BIN = 'omp';
    const handle = piAdapter.spawn(spec, ctx);
    expect(captured.cmd).toBe('omp');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('passes --allow-home in argv and forwards ctx.cwd to _spawn', async () => {
    const child = makeFakeChild();
    const captured: { args?: readonly string[]; cwd?: string } = {};
    __setSpawn(((_cmd: string, args: readonly string[], opts: { cwd?: string }) => {
      captured.args = args;
      captured.cwd = opts?.cwd;
      return child;
    }) as any);
    const handle = piAdapter.spawn(spec, ctx);
    expect(captured.args).toContain('--allow-home');
    expect(captured.cwd).toBe('/test/repo/root');
    child.emit('exit', 0, null);
    await handle.wait();
  });

  it('non-zero exit → done with status error', async () => {
    const child = installSpawn(makeFakeChild);
    const handle = piAdapter.spawn(spec, ctx);
    const consumer = collectAll(handle.events);
    child.stderr.write('boom\n');
    child.stdout.end();
    await nextTick(2);
    child.emit('exit', 2, null);
    const result = await handle.wait();
    const events = await consumer;
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(2);
    const last = events[events.length - 1] as Extract<AgentEvent, { t: 'done' }>;
    expect(last.result.status).toBe('error');
    expect(events.some((e) => e.t === 'error' && /code 2/.test((e as any).error))).toBe(true);
  });
});
