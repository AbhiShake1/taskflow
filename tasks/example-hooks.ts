// example-hooks.ts — demonstrates every Wave-1/2 surface against the mock adapter.
// Runs offline, no API keys, no real CLIs. Suitable for CI smoke.
//
// Mock-only smoke run:
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//     HARNESS_RUNS_DIR=/tmp/tf-example-hooks npx tsx tasks/example-hooks.ts
//
// What this exercises:
//   - defineConfig({ scope, todos.forceGeneration, events: {...} })
//   - collectTodos hook (seeds a mandatory todo)
//   - verifyTaskComplete hook (gates the verify-loop on todos)
//   - afterTaskDone hook that calls ctx.phase + ctx.session (hook-spawned chain)
//   - HARNESS_ADAPTER_OVERRIDE=mock to substitute every agent with the mock
//   - dependsOn DAG: three sessions spawned concurrently via Promise.all, with
//     the third (`merge`) declaring `dependsOn: ['plan-a','plan-b']` so the
//     engine holds its entry until both predecessors resolve. The existing
//     verifyTaskComplete hook still fires per-session and gates the verify
//     loop on todos — each DAG session completes in its first or second turn,
//     but `merge` doesn't even begin draining events until after `plan-a` and
//     `plan-b` emit their `done` events.
//
// Wiring note: there is no programmatic config-mount on the public taskflow
// builder — config is normally discovered via a `.agents/taskflow/config.ts`
// file walk. To keep this example single-file (no project-root side-effects),
// we replicate what runner/index.ts does and call setRunner() ourselves with
// an inline-defined config. This is intentional for the demo; real projects
// should drop a config.ts under `.agents/taskflow/` and let auto-discovery
// pick it up.

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { taskflow, defineConfig } from '../api/index';
import { EventBus } from '../core/events';
import { DEFAULT_CONFIG } from '../core/config';
import type { ResolvedConfig } from '../core/hooks';
import { setRunner } from '../runner/context';
import mockAdapter from '../adapters/mock';
import type { AgentAdapter, AgentHandle } from '../adapters/index';
import type { AgentName } from '../core/types';

// Guard so the afterTaskDone hook only chains once even though it fires for
// every leaf (including the chained child).
let alreadyChained = false;

const config = defineConfig({
  scope: 'Stay focused. Do exactly what the task says. No new files.',
  todos: { forceGeneration: true, maxRetries: 2 },
  events: {
    collectTodos: async () => ['save proof to data/example/proof.json'],
    verifyTaskComplete: async (ctx) => {
      // Demonstrate the verify-loop: first attempt fails, then we mark every
      // todo done so the second attempt succeeds. In a real config this would
      // inspect proof files, run unit tests, hit an API, etc.
      const attempt = ctx.sessionScope?.attempt ?? 0;
      const remaining = ctx.todos.remaining();
      if (attempt === 0 && remaining.length > 0) {
        return { done: false, remaining: remaining.map((t) => t.text) };
      }
      // Mark all todos done — demonstrates ctx.todos write access from a hook.
      for (const t of remaining) ctx.todos.complete(t.text);
      return { done: true };
    },
    afterTaskDone: async (ctx, { spec }) => {
      ctx.logger.info('finished ' + spec.id);
      // Demonstrate ctx.session from a hook. Guard against recursion via the
      // parent session id and the alreadyChained latch.
      if (ctx.sessionScope?.id === 'main' && !alreadyChained) {
        alreadyChained = true;
        await ctx.phase('post-main', async () => {
          // Agent name must be one of the canonical values; the mock override
          // below substitutes the mock adapter regardless of which we name.
          await ctx.session('post-verify', {
            with: 'claude-code',
            task: 'Verify the previous result. Reply with done.',
          });
        });
      }
    },
  },
});

// -- Inline runner mount (see "Wiring note" above). ---------------------------
async function mountRunner(): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runsDir = resolve(process.env.HARNESS_RUNS_DIR ?? 'data/runs');
  const runDir = `${runsDir}/${runId}`;
  await mkdir(runDir, { recursive: true });

  const bus = new EventBus();
  await bus.attachFile(`${runDir}/events.jsonl`);

  const activeHandles = new Map<string, AgentHandle>();

  // The mock adapter is the only sensible default for this example — it has
  // no external deps. HARNESS_ADAPTER_OVERRIDE=mock also flips every agent
  // name (e.g. 'mock', 'claude-code', etc.) to the mock at adapter-resolve
  // time, so the example works whether or not the env var is set.
  const adapterOverride = async (_agent: AgentName): Promise<AgentAdapter> => mockAdapter;

  // Translate the TaskflowConfig to a ResolvedConfig the engine consumes
  // directly (defu-merge of defaults with any user fragments we set above).
  const resolved: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    todos: { ...DEFAULT_CONFIG.todos, ...(config.todos ?? {}) },
    hooks: { ...DEFAULT_CONFIG.hooks, ...(config.hooks ?? {}) },
    ...(typeof config.scope === 'string' ? { scope: config.scope } : {}),
  };
  const eventLayers = config.events ? [config.events] : [];

  setRunner({
    bus,
    runsDir,
    runId,
    activeHandles,
    adapterOverride,
    cwd: process.cwd(),
    config: resolved,
    eventLayers,
    plugins: config.plugins ?? [],
  });

  // Mirror events to stdout so the demo prints something.
  bus.subscribe((ev) => {
    if (ev.t === 'stage-enter' || ev.t === 'stage-exit' || ev.t === 'spawn' || ev.t === 'done') {
      console.log(JSON.stringify(ev));
    }
  });
}

await mountRunner();

export default await taskflow('example-hooks').run(async ({ phase, session }) => {
  await phase('main', async () => {
    // The 'with' field expects a canonical AgentName (claude-code|pi|codex|
    // cursor|opencode). Our adapterOverride below maps every agent to the
    // mock so this runs offline.
    await session('main', {
      with: 'claude-code',
      task: 'Do the thing.\n\n- [ ] step one\n- [ ] step two',
    });
  });

  await phase('dag-demo', async () => {
    // All three sessions are spawned concurrently. `merge` declares
    // dependsOn: ['plan-a','plan-b'] so the engine lazy-registers the three
    // leaf promises on entry, then blocks `merge` inside leaf() until both
    // predecessors resolve — even though Promise.all dispatches them at the
    // same instant.
    await Promise.all([
      session('plan-a', {
        with: 'claude-code',
        task: 'Plan step A\n\n- [ ] produce plan',
      }),
      session('plan-b', {
        with: 'claude-code',
        task: 'Plan step B\n\n- [ ] produce plan',
      }),
      session('merge', {
        with: 'claude-code',
        task: 'Merge A+B',
        dependsOn: ['plan-a', 'plan-b'],
      }),
    ]);
  });
});
