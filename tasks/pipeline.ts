// 5-leaf deterministic Σn² pipeline, rewritten in the fluent async-await API.
//
// Stages:
//   discover   — emit [1..30] as JSON
//   compute    — 3 parallel leaves square their 10-element chunk
//   aggregate  — sum every squared value and compare against the closed-form
//                reference (sum_{i=1}^{30} i² = 9455)
//
// Mock smoke (no real LLM calls):
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//     HARNESS_RUNS_DIR=/tmp/tf-pipeline-smoke npx tsx tasks/pipeline.ts
//
// Real run via runner (mounts TUI, archives events.jsonl + manifest.json):
//   npm run run tasks/pipeline.ts

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
  taskflow('pipeline').run(async ({ phase, session }) => {
    await phase('discover', async () => {
      await session('emit-nums', {
        with: 'claude-code:sonnet',
        task:
          `Using the Bash or Write tool, create the file at absolute path ${CWD}/data/pipeline/nums.json containing the\n` +
          `JSON array of integers from 1 through 30 (inclusive), in order. The file must be exactly one line of JSON,\n` +
          `for example: [1,2,3,...,30]. Create parent directories if needed. Respond "done" when written.\n`,
        write: ['data/pipeline/nums.json'],
      });
    });

    await phase('compute', async () => {
      await Promise.all(
        [0, 1, 2].map((i) =>
          session(`square-${i}`, {
            with: 'claude-code:sonnet',
            task:
              `You are chunk ${i} of 3. Read ${CWD}/data/pipeline/nums.json which contains a JSON array of 30 integers.\n` +
              `Your share is array indices ${i}*10 through ${i}*10+9 inclusive (ten values). Compute the square of each value\n` +
              `in your share and write the result to ${CWD}/data/pipeline/chunk-${i}.json as JSON of shape\n` +
              `object-with-fields: chunk (integer, your chunk index), squares (array of ten integers, the squared values in\n` +
              `original order). Do NOT process values outside your share. Respond "chunk ${i} done" when written.\n`,
            write: [`data/pipeline/chunk-${i}.json`],
          }),
        ),
      );
    });

    await phase('aggregate', async () => {
      await session('sum-all', {
        with: 'claude-code:sonnet',
        task:
          `Read the three files ${CWD}/data/pipeline/chunk-0.json, ${CWD}/data/pipeline/chunk-1.json,\n` +
          `${CWD}/data/pipeline/chunk-2.json — each has a squares array. Sum every value across all three arrays.\n` +
          `Compute the reference value yourself: it is the sum of i*i for i from 1 through 30 inclusive (which equals\n` +
          `30*31*61/6). Then write ${CWD}/data/pipeline/summary.json as JSON with keys total (the computed sum), expected\n` +
          `(the reference value), ok (boolean, true iff total equals expected). Respond "aggregate done".\n`,
        write: ['data/pipeline/summary.json'],
      });
    });
  }, opts),
);
