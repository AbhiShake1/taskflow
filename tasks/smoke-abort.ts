// Single long-running leaf — deliberately runs a ~2-minute shell loop so the
// abort tests (real-abort.test.ts, real-tui.test.ts) can kill it mid-flight.
//
// Mock smoke:
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//     HARNESS_RUNS_DIR=/tmp/tf-smoke-abort npx tsx tasks/smoke-abort.ts

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
  taskflow('smoke-abort').run(async ({ phase, session }) => {
    await phase('abort-stage', async () => {
      await session('slow-loop', {
        with: 'claude-code:sonnet',
        task:
          `Run the following shell command using the Bash tool: \`for i in $(seq 1 60); do echo $i; sleep 2; done > ${CWD}/data/smoke/countdown.txt\`.\n` +
          `This will take roughly 120 seconds. Report "counting" immediately so we know you started. Do NOT wait for the\n` +
          `command to finish before responding.\n`,
        write: ['data/smoke/countdown.txt'],
      });
    });
  }, opts),
);
