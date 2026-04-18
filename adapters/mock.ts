import type { AgentEvent, LeafResult, LeafSpec } from '../core/types';
import { AgentAdapter, AgentHandle, EventChannel, SpawnCtx } from './index';

/**
 * Per-turn scripted response. The first turn (initial spawn) consumes
 * `turns[0]`; each subsequent `continueAfterDone(steerText)` consumes the
 * next entry. When the script is exhausted, the mock falls back to
 * `assistant: "ack: <last input>"`.
 *
 * Wired in via `MockAdapterOptions.turns` on the factory below; default
 * export still ships zero-config behavior identical to the legacy mock so
 * existing tests don't break.
 */
export interface MockTurn {
  assistantText?: string;
  structuredOutputValue?: unknown;
  /** Optional delay before emitting the assistant message + done. Default 10ms. */
  delayMs?: number;
}

export interface MockAdapterOptions {
  turns?: MockTurn[];
}

/**
 * Build a mock adapter. The default-exported instance has no scripted turns
 * (preserves legacy behavior). Tests that want to drive the verify-loop should
 * import this factory and pass a `turns` array.
 */
export function createMockAdapter(opts: MockAdapterOptions = {}): AgentAdapter {
  // The script is shared across every spawn() call from this adapter instance.
  // Each spawn maintains its own cursor into it (so two parallel leaves on the
  // same mock both see the same script — fine for the simple tests we run).
  const script = opts.turns ?? [];

  return {
    name: 'claude-code', // re-used under one of the valid agent names for tests
    spawn(spec: LeafSpec, _ctx: SpawnCtx): AgentHandle {
      // Mutable per-turn state. Each call to `runTurn()` swaps `ch` to a fresh
      // EventChannel and creates a new `done` promise so `wait()` can resolve
      // again on the next terminal `done`.
      let ch = new EventChannel<AgentEvent>();
      const startedAt = Date.now();
      let resolveResult!: (r: LeafResult) => void;
      let done = new Promise<LeafResult>(r => { resolveResult = r; });
      let timer: NodeJS.Timeout | undefined;
      let aborted = false;
      let turnIdx = 0;

      // Emit the spawn event once at the very beginning. Subsequent turns do
      // not re-emit spawn — the leaf is the same leaf, just continued.
      ch.push({ t: 'spawn', leafId: spec.id, agent: spec.agent, model: spec.model, ts: Date.now() });

      // Drive a single turn: emit the user echo, schedule the assistant reply
      // + terminal done. Re-used by the initial spawn and by continueAfterDone.
      const runTurn = (userText: string, isInitial: boolean) => {
        // Echo the user message (initial task on first turn, steer text after).
        // The initial spawn omitted this echo historically; preserve that to
        // avoid breaking existing assertions that expect ['spawn','message','done'].
        if (!isInitial) {
          ch.push({ t: 'message', leafId: spec.id, role: 'user', content: userText, ts: Date.now() });
        }

        const turn = script[turnIdx++];
        const assistantText = turn?.assistantText ?? (isInitial ? `[mock reply to: ${userText}]` : `ack: ${userText}`);
        const delayMs = turn?.delayMs ?? 10;

        timer = setTimeout(() => {
          if (aborted) return;
          ch.push({ t: 'message', leafId: spec.id, role: 'assistant', content: assistantText, ts: Date.now() });
          const result: LeafResult = {
            leafId: spec.id,
            status: 'done',
            exitCode: 0,
            startedAt,
            endedAt: Date.now(),
            finalAssistantText: assistantText,
            ...(turn?.structuredOutputValue !== undefined ? { structuredOutputValue: turn.structuredOutputValue } : {}),
          };
          ch.push({ t: 'done', leafId: spec.id, result, ts: Date.now() });
          ch.close();
          resolveResult(result);
        }, delayMs);
      };

      runTurn(spec.task, true);

      // The handle's `events` is a thin wrapper that delegates each
      // [Symbol.asyncIterator]() call to the CURRENT channel. The engine
      // re-iterates after each `continueAfterDone` to pick up new events.
      const events: AsyncIterable<AgentEvent> = {
        [Symbol.asyncIterator]: () => ch[Symbol.asyncIterator](),
      };

      return {
        events,
        async steer(input: string) {
          ch.push({ t: 'steer', leafId: spec.id, content: input, ts: Date.now() });
        },
        async abort(_reason?: string) {
          aborted = true;
          if (timer) clearTimeout(timer);
          const result: LeafResult = { leafId: spec.id, status: 'aborted', exitCode: 130, startedAt, endedAt: Date.now() };
          ch.push({ t: 'done', leafId: spec.id, result, ts: Date.now() });
          ch.close();
          resolveResult(result);
        },
        wait: () => done,
        supportsResume: true,
        async continueAfterDone(text: string) {
          if (aborted) {
            throw new Error('mock: session aborted; continueAfterDone unavailable');
          }
          // Swap to a fresh channel + done promise so the engine can re-iterate
          // events and re-await wait() to get the next terminal result.
          ch = new EventChannel<AgentEvent>();
          done = new Promise<LeafResult>(r => { resolveResult = r; });
          // Surface the steer as a transcript event in the new channel so
          // observers (verify hook tests) can assert it landed.
          ch.push({ t: 'steer', leafId: spec.id, content: text, ts: Date.now() });
          runTurn(text, false);
        },
      };
    },
  };
}

const mockAdapter: AgentAdapter = createMockAdapter();

export default mockAdapter;
