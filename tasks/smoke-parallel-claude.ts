// 3 parallel claude sessions writing to disjoint file trees. Proves
// `Promise.all([session(...) * N])` dispatches concurrently.
//
// Mock smoke:
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//     HARNESS_RUNS_DIR=/tmp/tf-smoke-parallel npx tsx tasks/smoke-parallel-claude.ts

import { taskflow } from '../api';
import type { HarnessOptions } from '../core';
import type { AgentAdapter } from '../adapters';
import type { AgentName } from '../core/types';

const CWD = process.cwd();

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
  taskflow('smoke-parallel-claude').run(async ({ phase, session }) => {
    await phase('parallel-smoke', async () => {
      await Promise.all(
        [0, 1, 2].map((i) =>
          session(`worker-${i}`, {
            with: 'claude-code:sonnet',
            task:
              `Write the single line "worker ${i} reporting in" (no quotes, no trailing newline beyond the one line) to the file\n` +
              `at absolute path ${CWD}/data/smoke/parallel/worker-${i}.txt. Create parent directories if needed. Respond briefly\n` +
              `with "done-${i}" when the file is written.\n`,
            write: [`data/smoke/parallel/worker-${i}/**`],
          }),
        ),
      );
    });
  }, opts),
);
