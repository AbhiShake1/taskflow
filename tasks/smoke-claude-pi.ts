// Same shape as smoke-claude.ts but the second leaf runs through the `pi`
// adapter, so it exercises cross-adapter handoff over the filesystem.
//
// Mock smoke:
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//     HARNESS_RUNS_DIR=/tmp/tf-smoke-claude-pi npx tsx tasks/smoke-claude-pi.ts

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
  taskflow('smoke-claude-pi').run(async ({ phase, session }) => {
    await phase('smoke', async () => {
      await session('write-hello', {
        with: 'claude-code:sonnet',
        task:
          `Write the exact text "Hello from claude-code harness leaf." (with the trailing period, no quotes) to the file\n` +
          `data/smoke/hello.txt. Create parent directories if needed. Respond briefly with "done" when the file is written.\n`,
        write: ['data/smoke/hello.txt'],
      });
      await session('verify-hello', {
        with: 'pi:anthropic/claude-sonnet-4-6',
        task:
          `Read data/smoke/hello.txt. If its content exactly equals "Hello from claude-code harness leaf." (trailing period,\n` +
          `trimmed of leading/trailing whitespace), write a JSON object to data/smoke/verify.json with keys ok (true) and\n` +
          `content (the file contents). Otherwise write a JSON object with keys ok (false), content (the file contents),\n` +
          `and expected (the expected string). Then respond with "verified".\n`,
        write: ['data/smoke/verify.json'],
      });
    });
  }, opts),
);
