// Single leaf with a 5s per-session timeout running a ~2-minute shell loop.
// The watchdog must fire, promote status to 'timeout', and abort the adapter
// process cleanly. Used by real-timeout.test.ts.
//
// Mock smoke:
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//     HARNESS_RUNS_DIR=/tmp/tf-smoke-timeout npx tsx tasks/smoke-timeout.ts

import { taskflow } from '../api';
import type { HarnessOptions } from '../core';
import type { AgentAdapter } from '../adapters';
import type { AgentName } from '../core/types';

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
  taskflow('smoke-timeout').run(async ({ phase, session }) => {
    await phase('timeout-stage', async () => {
      await session('slow-task', {
        with: 'claude-code:sonnet',
        task:
          `Run the following shell command using the Bash tool: \`for i in $(seq 1 60); do echo $i; sleep 2; done\`.\n` +
          `This will take about 2 minutes. Report "counting" immediately so we know you started. Do NOT wait for the\n` +
          `command to finish before responding — the Bash tool's background mode is fine.\n`,
        write: ['data/smoke/timeout-log.txt'],
        timeoutMs: 5000,
      });
    });
  }, opts),
);
