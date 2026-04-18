// dogfood-build.ts — taskflow editing taskflow.
//
// Real run (requires ANTHROPIC_API_KEY, claude-code adapter installed):
//   npx tsx tasks/dogfood-build.ts
//
// Smoke run with mock (no LLM call, no file change):
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//     HARNESS_RUNS_DIR=/tmp/tf-dogfood npx tsx tasks/dogfood-build.ts
//
// What this proves: a two-phase plan-then-apply pipeline against the real
// claude-code adapter, where the second leaf writes a single trivial change
// (one header comment line) into core/events.ts. Self-hosting end-to-end:
// taskflow is the orchestrator, the editor, AND the edited.

import { taskflow } from '../api/index';
import type { HarnessOptions } from '../core';
import type { AgentAdapter } from '../adapters';
import type { AgentName } from '../core/types';

const TARGET = 'core/events.ts';

async function resolveOpts(): Promise<HarnessOptions> {
  const opts: HarnessOptions = {};
  if (process.env.HARNESS_RUNS_DIR) opts.runsDir = process.env.HARNESS_RUNS_DIR;
  if (process.env.HARNESS_ADAPTER_OVERRIDE === 'mock') {
    const mock = (await import('../adapters/mock')).default as AgentAdapter;
    opts.adapterOverride = async (_agent: AgentName) => mock;
  }
  return opts;
}

export default await resolveOpts().then((opts) =>
  taskflow('dogfood-build').run(async ({ phase, session }) => {
    const proposed = await phase('plan', async () => {
      return session('plan-comment', {
        with: 'claude-code:sonnet',
        task:
          `Read the file at ${TARGET} (relative to cwd). Propose ONE single-line\n` +
          `header comment that summarizes what the file exports. The line must\n` +
          `start with "// " and be under 100 characters. Output ONLY the comment\n` +
          `line itself — no preamble, no quotes, no markdown fences. Do not edit\n` +
          `any files in this phase.\n`,
      });
    });

    await phase('apply', async () => {
      await session('apply-comment', {
        with: 'claude-code:sonnet',
        task:
          `Add the following header comment as the FIRST line of ${TARGET}, then\n` +
          `a blank line, then the existing file contents. Make no other changes.\n` +
          `Comment to insert:\n\n${proposed}\n`,
        write: [TARGET],
      });
    });
  }, opts),
);
