import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { taskflow, parseWith } from '../api';
import mockAdapter from '../adapters/mock';
import type { AgentEvent, LeafResult, LeafSpec } from '../core/types';
import type { AgentAdapter, AgentHandle, SpawnCtx } from '../adapters';
import { EventChannel } from '../adapters';

let runsDir: string;

beforeEach(() => {
  runsDir = join(tmpdir(), 'api-test-' + Math.random().toString(36).slice(2));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseWith — unchanged from the previous API, kept as-is.
// ---------------------------------------------------------------------------

describe('parseWith', () => {
  it('splits agent and model on the first colon', () => {
    expect(parseWith('claude-code:sonnet')).toEqual({ agent: 'claude-code', model: 'sonnet' });
  });

  it('returns no model when there is no colon', () => {
    expect(parseWith('pi')).toEqual({ agent: 'pi', model: undefined });
  });

  it('keeps remaining colons inside the model portion', () => {
    expect(parseWith('pi:anthropic/claude-opus-4-7:thinking')).toEqual({
      agent: 'pi',
      model: 'anthropic/claude-opus-4-7:thinking',
    });
  });

  it('throws a clear error for unknown agents', () => {
    expect(() => parseWith('gpt-4')).toThrowError(/unknown agent/);
    expect(() => parseWith('gpt-4:something')).toThrowError(/claude-code\|pi\|codex\|cursor\|opencode/);
  });
});

// ---------------------------------------------------------------------------
// Test fixtures — controllable fake adapter that echoes whatever we tell it
// to. Lets us drive finalAssistantText + structuredOutputValue deterministically.
// ---------------------------------------------------------------------------

type ScriptedResponse = {
  finalAssistantText?: string;
  structuredOutputValue?: unknown;
  status?: 'done' | 'error';
  error?: string;
  delayMs?: number;
};

function makeScriptedAdapter(
  scripts: Record<string, ScriptedResponse>,
): AgentAdapter {
  return {
    name: 'claude-code',
    spawn(spec: LeafSpec, _ctx: SpawnCtx): AgentHandle {
      const ch = new EventChannel<AgentEvent>();
      const startedAt = Date.now();
      let resolveResult!: (r: LeafResult) => void;
      const done = new Promise<LeafResult>((r) => { resolveResult = r; });
      const script = scripts[spec.id] ?? { finalAssistantText: `[mock reply to ${spec.id}]` };

      ch.push({ t: 'spawn', leafId: spec.id, agent: spec.agent, model: spec.model, ts: Date.now() });

      const timer = setTimeout(() => {
        if (script.finalAssistantText) {
          ch.push({
            t: 'message',
            leafId: spec.id,
            role: 'assistant',
            content: script.finalAssistantText,
            ts: Date.now(),
          });
        }
        const status = script.status ?? 'done';
        const result: LeafResult = {
          leafId: spec.id,
          status,
          exitCode: status === 'done' ? 0 : 1,
          startedAt,
          endedAt: Date.now(),
          ...(script.error ? { error: script.error } : {}),
          ...(script.finalAssistantText !== undefined
            ? { finalAssistantText: script.finalAssistantText }
            : {}),
          ...(script.structuredOutputValue !== undefined
            ? { structuredOutputValue: script.structuredOutputValue }
            : {}),
        };
        ch.push({ t: 'done', leafId: spec.id, result, ts: Date.now() });
        ch.close();
        resolveResult(result);
      }, script.delayMs ?? 5);

      return {
        events: ch,
        async steer() { /* no-op */ },
        async abort() {
          clearTimeout(timer);
          const result: LeafResult = {
            leafId: spec.id,
            status: 'aborted',
            exitCode: 130,
            startedAt,
            endedAt: Date.now(),
          };
          ch.push({ t: 'done', leafId: spec.id, result, ts: Date.now() });
          ch.close();
          resolveResult(result);
        },
        wait: () => done,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// End-to-end async-await behaviour (via mock adapter).
// ---------------------------------------------------------------------------

describe('async-await fluent API', () => {
  it('session() with no schema resolves to the final assistant text', async () => {
    const adapter = makeScriptedAdapter({
      one: { finalAssistantText: 'hello world' },
    });

    let received: string | undefined;
    const { manifest } = await taskflow('schemaless').run(
      async ({ phase, session }) => {
        await phase('only', async () => {
          received = await session('one', { with: 'claude-code:sonnet', task: 't' });
        });
      },
      { runsDir, runId: 'schemaless', adapterOverride: async () => adapter },
    );

    expect(received).toBe('hello world');
    expect(manifest.exitCode).toBe(0);
    expect(manifest.leaves).toHaveLength(1);
    expect(manifest.leaves[0].status).toBe('done');
  });

  it('session() with a zod schema resolves to the parsed structured value', async () => {
    const schema = z.object({ count: z.number(), tag: z.string() });
    const adapter = makeScriptedAdapter({
      typed: { structuredOutputValue: { count: 3, tag: 'ok' } },
    });

    let received: { count: number; tag: string } | undefined;
    await taskflow('typed').run(
      async ({ phase, session }) => {
        await phase('only', async () => {
          received = await session('typed', {
            with: 'claude-code:sonnet',
            task: 't',
            schema,
          });
        });
      },
      { runsDir, runId: 'typed', adapterOverride: async () => adapter },
    );

    expect(received).toEqual({ count: 3, tag: 'ok' });
    // Compile-time typing probe: assigning to an explicit typed shape must work.
    const probe: { count: number; tag: string } = received!;
    expect(probe.count).toBe(3);
  });

  it('Promise.all parallelizes sessions', async () => {
    const adapter = makeScriptedAdapter({
      a: { finalAssistantText: 'A', delayMs: 40 },
      b: { finalAssistantText: 'B', delayMs: 40 },
      c: { finalAssistantText: 'C', delayMs: 40 },
    });

    const t0 = Date.now();
    const out = await new Promise<string[]>((resolve, reject) => {
      taskflow('parallel')
        .run(
          async ({ phase, session }) => {
            const results = await phase('parallel', async () =>
              Promise.all([
                session('a', { with: 'claude-code', task: 't' }),
                session('b', { with: 'claude-code', task: 't' }),
                session('c', { with: 'claude-code', task: 't' }),
              ]),
            );
            resolve(results);
          },
          { runsDir, runId: 'parallel', adapterOverride: async () => adapter },
        )
        .catch(reject);
    });
    const elapsed = Date.now() - t0;

    expect(out).toEqual(['A', 'B', 'C']);
    // If they ran sequentially it'd be ~120ms; parallel should be < 90ms.
    expect(elapsed).toBeLessThan(90);
  });

  it('phase() is a pure pass-through for return values', async () => {
    const adapter = makeScriptedAdapter({
      x: { finalAssistantText: 'payload' },
    });

    let passed: unknown;
    await taskflow('phase-passthrough').run(
      async ({ phase, session }) => {
        const v = await phase('stageA', async () => {
          const text = await session('x', { with: 'claude-code', task: 't' });
          return { wrapped: text, extra: 42 };
        });
        passed = v;
      },
      { runsDir, runId: 'phase-passthrough', adapterOverride: async () => adapter },
    );

    expect(passed).toEqual({ wrapped: 'payload', extra: 42 });
  });

  it('fire-and-forget: un-awaited session still runs; error is dev-owned', async () => {
    const adapter = makeScriptedAdapter({
      bg: { status: 'error', error: 'simulated', delayMs: 10 },
      main: { finalAssistantText: 'main-done' },
    });

    let mainText: string | undefined;
    let bgCaught: unknown;

    await taskflow('fire-and-forget').run(
      async ({ phase, session }) => {
        await phase('stage', async () => {
          // Not awaited — explicit .catch() per the contract.
          session('bg', { with: 'claude-code', task: 'bg' }).catch((e) => {
            bgCaught = e;
          });
          mainText = await session('main', { with: 'claude-code', task: 'main' });
        });
      },
      {
        runsDir,
        runId: 'fire-and-forget',
        adapterOverride: async () => adapter,
      },
    );

    expect(mainText).toBe('main-done');
    // Allow the fire-and-forget session to finish resolving.
    await new Promise((r) => setTimeout(r, 30));
    expect(bgCaught).toBeInstanceOf(Error);
    expect((bgCaught as Error).message).toMatch(/session "bg" failed/);
  });

  it('schema validation failure rejects the session promise', async () => {
    const schema = z.object({ count: z.number() });
    const adapter = makeScriptedAdapter({
      bad: { structuredOutputValue: { count: 'not-a-number' } },
    });

    let caught: unknown;
    await taskflow('schema-fail')
      .run(
        async ({ phase, session }) => {
          await phase('only', async () => {
            try {
              await session('bad', {
                with: 'claude-code',
                task: 't',
                schema,
              });
            } catch (e) {
              caught = e;
            }
          });
        },
        { runsDir, runId: 'schema-fail', adapterOverride: async () => adapter },
      )
      // phase() surfaces the throw, which the engine treats as a stage error —
      // harness will re-throw. Catch it so the test itself doesn't fail on the
      // top-level .run().
      .catch(() => { /* expected */ });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/structured output failed schema validation/);
  });

  it('missing structured output rejects the session promise', async () => {
    const schema = z.object({ x: z.string() });
    const adapter = makeScriptedAdapter({
      // No structuredOutputValue set → adapter reports done but no value.
      nope: { finalAssistantText: 'no json here' },
    });

    let caught: unknown;
    await taskflow('no-struct')
      .run(
        async ({ phase, session }) => {
          await phase('only', async () => {
            try {
              await session('nope', {
                with: 'claude-code',
                task: 't',
                schema,
              });
            } catch (e) {
              caught = e;
            }
          });
        },
        { runsDir, runId: 'no-struct', adapterOverride: async () => adapter },
      )
      .catch(() => { /* expected */ });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/produced no structured output/);
  });

  it('adapter failure rejects session() with a descriptive Error', async () => {
    const adapter = makeScriptedAdapter({
      boom: { status: 'error', error: 'adapter said no' },
    });

    let caught: unknown;
    await taskflow('adapter-fail')
      .run(
        async ({ phase, session }) => {
          await phase('only', async () => {
            try {
              await session('boom', { with: 'claude-code', task: 't' });
            } catch (e) {
              caught = e;
            }
          });
        },
        { runsDir, runId: 'adapter-fail', adapterOverride: async () => adapter },
      )
      .catch(() => { /* expected */ });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/session "boom" failed/);
  });

  it('.rules(path) attaches rules to the harness', async () => {
    // Lightweight smoke: the option plumbs through opts.rulesFile. We can't
    // easily observe the content without spinning up real adapters; just
    // verify .rules() is chainable and .run() still resolves cleanly.
    const { manifest } = await taskflow('rules-smoke')
      .rules('./rules.md')
      .run(
        async ({ phase, session }) => {
          await phase('s', async () => {
            await session('l', { with: 'claude-code', task: 't' });
          });
        },
        { runsDir, runId: 'rules-smoke', adapterOverride: async () => mockAdapter },
      );

    expect(manifest.exitCode).toBe(0);
  });

  it('.env(vars) merges env vars before execution', async () => {
    const before = process.env.TASKFLOW_TEST_ENV;
    await taskflow('env-smoke')
      .env({ TASKFLOW_TEST_ENV: 'ok' })
      .run(
        async ({ phase, session }) => {
          expect(process.env.TASKFLOW_TEST_ENV).toBe('ok');
          await phase('s', async () =>
            session('l', { with: 'claude-code', task: 't' }),
          );
        },
        { runsDir, runId: 'env-smoke', adapterOverride: async () => mockAdapter },
      );
    // Clean up so we don't leak into other tests.
    if (before === undefined) delete process.env.TASKFLOW_TEST_ENV;
    else process.env.TASKFLOW_TEST_ENV = before;
  });

  it('manifest records all sessions with correct stages', async () => {
    const { manifest } = await taskflow('manifest-smoke').run(
      async ({ phase, session }) => {
        await phase('discover', async () => {
          await session('d', { with: 'claude-code:sonnet', task: 't' });
        });
        await phase('fetch', async () => {
          await Promise.all([
            session('s0', { with: 'claude-code', task: 't' }),
            session('s1', { with: 'claude-code', task: 't' }),
          ]);
        });
      },
      { runsDir, runId: 'manifest-smoke', adapterOverride: async () => mockAdapter },
    );

    expect(manifest.exitCode).toBe(0);
    expect(manifest.stages).toEqual(['discover', 'fetch']);
    expect(manifest.leaves.map((l) => l.id).sort()).toEqual(['d', 's0', 's1']);
    expect(manifest.leaves.every((l) => l.status === 'done')).toBe(true);
  });

  it('structuredOutput.jsonSchema is derived from the zod schema and plumbed to the adapter', async () => {
    // Capture what the engine passed into SpawnCtx.structuredOutput to confirm
    // the zod→JSON-Schema conversion and _zodSchema pass-through both work.
    let captured: SpawnCtx['structuredOutput'];

    const captureAdapter: AgentAdapter = {
      name: 'claude-code',
      spawn(spec: LeafSpec, ctx: SpawnCtx): AgentHandle {
        captured = ctx.structuredOutput;
        const ch = new EventChannel<AgentEvent>();
        const startedAt = Date.now();
        let resolveResult!: (r: LeafResult) => void;
        const done = new Promise<LeafResult>((r) => { resolveResult = r; });
        ch.push({ t: 'spawn', leafId: spec.id, agent: spec.agent, ts: Date.now() });
        setImmediate(() => {
          const result: LeafResult = {
            leafId: spec.id,
            status: 'done',
            exitCode: 0,
            startedAt,
            endedAt: Date.now(),
            structuredOutputValue: { n: 7 },
          };
          ch.push({ t: 'done', leafId: spec.id, result, ts: Date.now() });
          ch.close();
          resolveResult(result);
        });
        return {
          events: ch,
          async steer() {},
          async abort() {},
          wait: () => done,
        };
      },
    };

    const schema = z.object({ n: z.number() });
    await taskflow('plumbing').run(
      async ({ phase, session }) => {
        await phase('s', async () => {
          await session('x', { with: 'claude-code', task: 't', schema });
        });
      },
      { runsDir, runId: 'plumbing', adapterOverride: async () => captureAdapter },
    );

    expect(captured).toBeDefined();
    expect(captured!.jsonSchema).toMatchObject({
      type: 'object',
      properties: { n: { type: 'number' } },
    });
    // _zodSchema is the raw zod schema instance, so it should === schema.
    expect(captured!._zodSchema).toBe(schema);
  });
});
