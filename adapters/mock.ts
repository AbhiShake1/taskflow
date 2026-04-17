import type { AgentEvent, LeafResult, LeafSpec } from '../core/types';
import { AgentAdapter, AgentHandle, EventChannel, SpawnCtx } from './index';

const mockAdapter: AgentAdapter = {
  name: 'claude-code',   // re-used under one of the valid names for tests
  spawn(spec: LeafSpec, _ctx: SpawnCtx): AgentHandle {
    const ch = new EventChannel<AgentEvent>();
    const startedAt = Date.now();
    let resolveResult!: (r: LeafResult) => void;
    const done = new Promise<LeafResult>(r => { resolveResult = r; });

    ch.push({ t: 'spawn', leafId: spec.id, agent: spec.agent, model: spec.model, ts: Date.now() });

    const timer = setTimeout(() => {
      ch.push({ t: 'message', leafId: spec.id, role: 'assistant', content: `[mock reply to: ${spec.task}]`, ts: Date.now() });
      const result: LeafResult = { leafId: spec.id, status: 'done', exitCode: 0, startedAt, endedAt: Date.now() };
      ch.push({ t: 'done', leafId: spec.id, result, ts: Date.now() });
      ch.close();
      resolveResult(result);
    }, 10);

    return {
      events: ch,
      async steer(input: string) {
        ch.push({ t: 'steer', leafId: spec.id, content: input, ts: Date.now() });
      },
      async abort(_reason?: string) {
        clearTimeout(timer);
        const result: LeafResult = { leafId: spec.id, status: 'aborted', exitCode: 130, startedAt, endedAt: Date.now() };
        ch.push({ t: 'done', leafId: spec.id, result, ts: Date.now() });
        ch.close();
        resolveResult(result);
      },
      wait: () => done,
    };
  },
};

export default mockAdapter;
