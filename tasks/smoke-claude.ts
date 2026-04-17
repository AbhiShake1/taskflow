// 2-leaf serial smoke against the real claude-code adapter.
// Leaf 1 writes a canary string; leaf 2 reads it back and emits a verification
// JSON. Used by real-tui.test.ts.
//
// Mock smoke:
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//     HARNESS_RUNS_DIR=/tmp/tf-smoke-claude npx tsx tasks/smoke-claude.ts

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
  taskflow('smoke-claude').run(async ({ phase, session }) => {
    await phase('smoke', async () => {
      await session('write-hello', {
        with: 'claude-code:sonnet',
        task:
          `Write the exact text "Hello from claude-code harness leaf." (with the trailing period, no quotes) to the file at\n` +
          `absolute path ${CWD}/data/smoke/hello.txt. Create parent directories if needed. Respond briefly with "done" when the\n` +
          `file is written.\n`,
        write: ['data/smoke/hello.txt'],
      });
      await session('verify-hello', {
        with: 'claude-code:sonnet',
        task:
          `Read the file at absolute path ${CWD}/data/smoke/hello.txt. If its content — trimmed of leading/trailing\n` +
          `whitespace — exactly equals the string "Hello from claude-code harness leaf.", write a JSON document to\n` +
          `${CWD}/data/smoke/verify.json whose top-level object has ok set to true and content set to the file's content.\n` +
          `Otherwise set ok to false and also include an expected field with the string above. Respond with "verified".\n`,
        write: ['data/smoke/verify.json'],
      });
    });
  }, opts),
);
