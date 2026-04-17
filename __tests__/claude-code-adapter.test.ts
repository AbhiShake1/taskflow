import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Wait until a predicate returns a truthy value (or a non-undefined value).
 * Used to paper over the fact that the adapter's SDK bootstrap happens on
 * next microtask after spawn() returns.
 */
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v as T;
    await new Promise(r => setTimeout(r, 1));
  }
  throw new Error('waitFor: timed out');
}
import type { AgentEvent, LeafSpec } from '../core/types';
import type { SpawnCtx } from '../adapters/index';

/**
 * Mock `@anthropic-ai/claude-agent-sdk`.
 *
 * The real API (v0.2.111):
 *   - `query({ prompt, options })` returns a `Query` object that is
 *     `AsyncGenerator<SDKMessage, void>` PLUS control methods
 *     (`interrupt`, `streamInput`, `close`, `setPermissionMode`, ...).
 *
 * Our mock mirrors only the bits the adapter exercises.
 */

type PushOp = { kind: 'push'; msg: any } | { kind: 'end' } | { kind: 'throw'; err: any };

function makeMockSdk() {
  const ops: PushOp[] = [];
  const waiters: Array<(op: PushOp) => void> = [];

  const pushOp = (op: PushOp) => {
    const w = waiters.shift();
    if (w) w(op);
    else ops.push(op);
  };

  const nextOp = (): Promise<PushOp> =>
    new Promise(res => {
      const op = ops.shift();
      if (op) res(op);
      else waiters.push(res);
    });

  let closed = false;

  const interrupt = vi.fn(async () => { pushOp({ kind: 'end' }); });
  const streamInput = vi.fn(async (_stream: AsyncIterable<any>) => { /* noop */ });
  const setPermissionMode = vi.fn(async (_m: string) => { /* noop */ });
  const close = vi.fn(() => { closed = true; pushOp({ kind: 'end' }); });
  const rewindFiles = vi.fn(async () => ({ canRewind: true } as any));

  async function* gen(): AsyncGenerator<any, void> {
    while (true) {
      if (closed) return;
      const op = await nextOp();
      if (op.kind === 'end') return;
      if (op.kind === 'throw') throw op.err;
      yield op.msg;
    }
  }

  const query = vi.fn((_params: { prompt: any; options?: any }) => {
    const iter = gen();
    // Attach control methods to the iterator just like the real `Query`.
    (iter as any).interrupt = interrupt;
    (iter as any).streamInput = streamInput;
    (iter as any).setPermissionMode = setPermissionMode;
    (iter as any).close = close;
    (iter as any).rewindFiles = rewindFiles;
    return iter as any;
  });

  return {
    query, interrupt, streamInput, setPermissionMode, close, rewindFiles,
    // Test-side controls:
    emit: (msg: any) => pushOp({ kind: 'push', msg }),
    end:  ()          => pushOp({ kind: 'end' }),
    fail: (err: any)  => pushOp({ kind: 'throw', err }),
  };
}

// Hoist-safe mock handle: vi.mock is hoisted, so we need a factory that reads
// from a mutable object available at call time.
const mockState: { sdk: ReturnType<typeof makeMockSdk> | null } = { sdk: null };

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: any) => {
    if (!mockState.sdk) throw new Error('mock sdk not initialized');
    return mockState.sdk.query(params);
  },
}));

const baseSpec: LeafSpec = {
  id: 'leaf-cc-1',
  agent: 'claude-code',
  task: 'say hi',
};

const ctx: SpawnCtx = { runDir: '/tmp/run-cc-test', cwd: '/test/repo/root' };

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('claude-code adapter', () => {
  beforeEach(() => {
    mockState.sdk = makeMockSdk();
  });

  it('returns a handle with events, steer, abort, wait', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);
    expect(handle.events).toBeDefined();
    expect(typeof handle.steer).toBe('function');
    expect(typeof handle.abort).toBe('function');
    expect(typeof handle.wait).toBe('function');
    // End immediately so the test doesn't hang.
    mockState.sdk!.end();
    await handle.wait();
  });

  it('normalizes an assistant message + end into spawn → user-message → assistant-message → done', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);

    mockState.sdk!.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello world' }],
      },
      parent_tool_use_id: null,
      uuid: 'u1',
      session_id: 's1',
    });
    mockState.sdk!.end();

    const events = await collect(handle.events);
    const result = await handle.wait();

    const types = events.map(e => e.t);
    expect(types[0]).toBe('spawn');
    expect(types).toContain('message');
    expect(types[types.length - 1]).toBe('done');

    const assistantMsg = events.find(
      e => e.t === 'message' && (e as any).role === 'assistant',
    ) as Extract<AgentEvent, { t: 'message' }> | undefined;
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe('hello world');

    const userEcho = events.find(
      e => e.t === 'message' && (e as any).role === 'user',
    ) as Extract<AgentEvent, { t: 'message' }> | undefined;
    expect(userEcho).toBeDefined();
    expect(userEcho!.content).toBe('say hi');

    expect(result.status).toBe('done');
    expect(result.exitCode).toBe(0);
    expect(result.leafId).toBe('leaf-cc-1');
  });

  it('passes rulesPrefix to the SDK as a cacheable content block', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const rules = 'Rules:\nBe concise.\n\nTask:\n';
    const handle = adapter.spawn(baseSpec, { ...ctx, rulesPrefix: rules });

    // The prompt AsyncIterable was passed to query(). Drain it once to inspect the payload.
    const call = await waitFor(() => mockState.sdk!.query.mock.calls[0]);
    expect(call).toBeDefined();
    const prompt = call[0].prompt as AsyncIterable<any>;
    const it = prompt[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    const initial = first.value;
    expect(initial.type).toBe('user');
    const content = initial.message.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].text).toBe(rules);
    expect(content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(content[1].text).toBe('say hi');

    mockState.sdk!.end();
    await handle.wait();
  });

  it('skips rulesPrefix when spec.rulesPrefix === false', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(
      { ...baseSpec, rulesPrefix: false },
      { ...ctx, rulesPrefix: 'Rules:\nignored.\n\nTask:\n' },
    );

    const call = await waitFor(() => mockState.sdk!.query.mock.calls[0]);
    const prompt = call[0].prompt as AsyncIterable<any>;
    const first = await prompt[Symbol.asyncIterator]().next();
    expect(first.value.message.content).toBe('say hi');

    mockState.sdk!.end();
    await handle.wait();
  });

  it('sends plain-string content (not a block array) when ctx.rulesPrefix is unset', async () => {
    // Fallback shape: no rules prefix in ctx, so the adapter should send a plain
    // string body — no content-block array, no cache_control. This matches what
    // the adapter historically did before the cacheable-prefix change.
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx); // ctx has no rulesPrefix

    const call = await waitFor(() => mockState.sdk!.query.mock.calls[0]);
    const prompt = call[0].prompt as AsyncIterable<any>;
    const first = await prompt[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe('user');
    expect(typeof first.value.message.content).toBe('string');
    expect(first.value.message.content).toBe('say hi');

    mockState.sdk!.end();
    await handle.wait();
  });

  it('extracts usage from SDKResultMessage and attaches it to LeafResult.usage', async () => {
    // SDKResultSuccess.usage is NonNullableUsage (snake_case fields derived from
    // BetaUsage: input_tokens, output_tokens, cache_creation_input_tokens,
    // cache_read_input_tokens). The adapter must translate those into the
    // camelCase LeafUsage shape and attach them to the terminal `done` event.
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);

    mockState.sdk!.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      parent_tool_use_id: null,
      uuid: 'u1',
      session_id: 's1',
    });
    mockState.sdk!.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      duration_api_ms: 5,
      is_error: false,
      num_turns: 1,
      result: 'done',
      session_id: 's1',
      total_cost_usd: 0,
      usage: {
        input_tokens: 42,
        output_tokens: 7,
        cache_creation_input_tokens: 2048,
        cache_read_input_tokens: 0,
      },
    });
    mockState.sdk!.end();

    const events = await collect(handle.events);
    const result = await handle.wait();

    expect(result.status).toBe('done');
    expect(result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 7,
      cacheCreationInputTokens: 2048,
      cacheReadInputTokens: 0,
    });

    const doneEv = events[events.length - 1] as Extract<AgentEvent, { t: 'done' }>;
    expect(doneEv.t).toBe('done');
    expect(doneEv.result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 7,
      cacheCreationInputTokens: 2048,
      cacheReadInputTokens: 0,
    });
  });

  it('omits usage field when SDKResultMessage carries no usage shape', async () => {
    // Defensive: if the SDK message has no `usage` (or an empty object), don't
    // emit a zeroed-out LeafUsage — leave the field absent so consumers can
    // distinguish "no data" from "zero tokens".
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);

    mockState.sdk!.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 1,
      result: 'done',
      session_id: 's1',
      total_cost_usd: 0,
      usage: {},
    });
    mockState.sdk!.end();

    const result = await handle.wait();
    expect(result.status).toBe('done');
    expect(result.usage).toBeUndefined();
  });

  it('steer(input) pushes a user message into the SDK input stream', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);

    const call = await waitFor(() => mockState.sdk!.query.mock.calls[0]);
    const prompt = call[0].prompt as AsyncIterable<any>;
    const it = prompt[Symbol.asyncIterator]();

    // Drain the initial task message.
    await it.next();

    await handle.steer('more details please');

    // Next message on the input stream should be the steered user message.
    const next = await it.next();
    expect(next.done).toBe(false);
    expect(next.value.type).toBe('user');
    expect(next.value.message.content).toBe('more details please');

    mockState.sdk!.end();
    const events = await collect(handle.events);
    await handle.wait();

    const steerEv = events.find(e => e.t === 'steer');
    expect(steerEv).toBeDefined();
    expect((steerEv as any).content).toBe('more details please');
  });

  it('abort() calls interrupt() and resolves wait() with status aborted', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);

    await handle.abort('test');

    const result = await handle.wait();
    expect(mockState.sdk!.interrupt).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('aborted');
    expect(result.exitCode).toBe(130);

    const events = await collect(handle.events);
    const last = events[events.length - 1] as Extract<AgentEvent, { t: 'done' }>;
    expect(last.t).toBe('done');
    expect(last.result.status).toBe('aborted');
  });

  it('surfaces SDK errors as error + done(status=error)', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);

    mockState.sdk!.fail(new Error('boom from sdk'));

    const result = await handle.wait();
    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('boom from sdk');

    const events = await collect(handle.events);
    const errEv = events.find(e => e.t === 'error') as Extract<AgentEvent, { t: 'error' }> | undefined;
    expect(errEv).toBeDefined();
    expect(errEv!.error).toContain('boom from sdk');

    const last = events[events.length - 1] as Extract<AgentEvent, { t: 'done' }>;
    expect(last.t).toBe('done');
    expect(last.result.status).toBe('error');
  });

  it('passes ctx.cwd to query() options', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);
    const call = await waitFor(() => mockState.sdk!.query.mock.calls[0]);
    expect(call).toBeDefined();
    expect(call[0].options).toBeDefined();
    expect(call[0].options.cwd).toBe('/test/repo/root');
    mockState.sdk!.end();
    await handle.wait();
  });

  it('also passes ctx.cwd via additionalDirectories (belt+suspenders)', async () => {
    // Even with `cwd` set, the underlying claude-code CLI has historically
    // remapped writes to a dash-flattened shadow dir (flance/biswaas ->
    // flance-biswaas). Declaring the repo as an `additionalDirectories` entry
    // is the SDK-supported way to say "absolute paths under here are OK".
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);
    const call = await waitFor(() => mockState.sdk!.query.mock.calls[0]);
    expect(call[0].options.additionalDirectories).toEqual(['/test/repo/root']);
    mockState.sdk!.end();
    await handle.wait();
  });

  it('closes input stream when SDKResultMessage arrives and finalizes cleanly', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);

    // Capture the prompt iterator so we can prove it eventually returns done:true —
    // that is the end-of-session signal that lets the real SDK subprocess exit.
    const call = await waitFor(() => mockState.sdk!.query.mock.calls[0]);
    const prompt = call[0].prompt as AsyncIterable<any>;
    const it = prompt[Symbol.asyncIterator]();
    // Consume the initial task message already queued at spawn.
    await it.next();

    // Drive the SDK: one assistant message then the terminal `SDKResultMessage`
    // (discriminator type:'result', subtype:'success'). The real-LLM bug was that
    // the adapter never closed its input iterable after this message, so the SDK
    // CLI subprocess stayed alive forever.
    mockState.sdk!.emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      parent_tool_use_id: null,
      uuid: 'u1',
      session_id: 's1',
    });
    mockState.sdk!.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 10,
      duration_api_ms: 5,
      is_error: false,
      num_turns: 1,
      result: 'done',
      session_id: 's1',
      total_cost_usd: 0,
      usage: {},
    });

    // Within 100ms of the terminal message, the adapter must have closed the input
    // iterable. The real SDK observes this and exits its output generator; our mock
    // does not model that coupling, so we verify the *input-side* close here and
    // then simulate the SDK exit ourselves.
    const nextP = it.next();
    const timeoutP = new Promise<'timeout'>(res => setTimeout(() => res('timeout'), 100));
    const winner = await Promise.race([nextP, timeoutP]);
    expect(winner).not.toBe('timeout');
    expect((winner as IteratorResult<any>).done).toBe(true);

    // Real SDK now exits its generator because input returned done:true. Simulate that.
    mockState.sdk!.end();

    const result = await handle.wait();
    expect(result.status).toBe('done');
    expect(result.exitCode).toBe(0);

    // steer() after session end is a graceful no-op, not a crash.
    await expect(handle.steer('late')).resolves.toBeUndefined();

    const events = await collect(handle.events);
    const last = events[events.length - 1] as Extract<AgentEvent, { t: 'done' }>;
    expect(last.t).toBe('done');
    expect(last.result.status).toBe('done');
  });

  it('maps assistant tool_use blocks into tool events', async () => {
    const { default: adapter } = await import('../adapters/claude-code');
    const handle = adapter.spawn(baseSpec, ctx);

    mockState.sdk!.emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running a tool' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } },
        ],
      },
      parent_tool_use_id: null,
      uuid: 'u2',
      session_id: 's1',
    });
    mockState.sdk!.end();

    const events = await collect(handle.events);
    await handle.wait();

    const toolEv = events.find(e => e.t === 'tool') as Extract<AgentEvent, { t: 'tool' }> | undefined;
    expect(toolEv).toBeDefined();
    expect(toolEv!.name).toBe('Bash');
    expect(toolEv!.args).toEqual({ cmd: 'ls' });
  });
});
