// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM pipeline.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build pipeline.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('pipeline', {}, async (h) => {
  await stage(h, 'pipeline', async () => {
    await stage(h, 'discover', async () => {
      await leaf(h, { id: 'emit-nums', agent: 'claude-code', model: 'sonnet', task: 'Using the Bash or Write tool, create the file at absolute path /Users/abhi/proj/flance/taskflow/data/pipeline/nums.json containing the\nJSON array of integers from 1 through 30 (inclusive), in order. The file must be exactly one line of JSON,\nfor example: [1,2,3,...,30]. Create parent directories if needed. Respond "done" when written.\n', claims: ['data/pipeline/nums.json'] });
    });
    await stage(h, 'compute', async () => {
      await parallel(h, [
        () => leaf(h, { id: 'square-0', agent: 'claude-code', model: 'sonnet', task: 'You are chunk 0 of 3. Read /Users/abhi/proj/flance/taskflow/data/pipeline/nums.json which contains a JSON array of 30 integers.\nYour share is array indices 0*10 through 0*10+9 inclusive (ten values). Compute the square of each value\nin your share and write the result to /Users/abhi/proj/flance/taskflow/data/pipeline/chunk-0.json as JSON of shape\nobject-with-fields: chunk (integer, your chunk index), squares (array of ten integers, the squared values in\noriginal order). Do NOT process values outside your share. Respond "chunk 0 done" when written.\n', claims: ['data/pipeline/chunk-0.json'] }),
        () => leaf(h, { id: 'square-1', agent: 'claude-code', model: 'sonnet', task: 'You are chunk 1 of 3. Read /Users/abhi/proj/flance/taskflow/data/pipeline/nums.json which contains a JSON array of 30 integers.\nYour share is array indices 1*10 through 1*10+9 inclusive (ten values). Compute the square of each value\nin your share and write the result to /Users/abhi/proj/flance/taskflow/data/pipeline/chunk-1.json as JSON of shape\nobject-with-fields: chunk (integer, your chunk index), squares (array of ten integers, the squared values in\noriginal order). Do NOT process values outside your share. Respond "chunk 1 done" when written.\n', claims: ['data/pipeline/chunk-1.json'] }),
        () => leaf(h, { id: 'square-2', agent: 'claude-code', model: 'sonnet', task: 'You are chunk 2 of 3. Read /Users/abhi/proj/flance/taskflow/data/pipeline/nums.json which contains a JSON array of 30 integers.\nYour share is array indices 2*10 through 2*10+9 inclusive (ten values). Compute the square of each value\nin your share and write the result to /Users/abhi/proj/flance/taskflow/data/pipeline/chunk-2.json as JSON of shape\nobject-with-fields: chunk (integer, your chunk index), squares (array of ten integers, the squared values in\noriginal order). Do NOT process values outside your share. Respond "chunk 2 done" when written.\n', claims: ['data/pipeline/chunk-2.json'] }),
      ]);
    });
    await stage(h, 'aggregate', async () => {
      await leaf(h, { id: 'sum-all', agent: 'claude-code', model: 'sonnet', task: 'Read the three files /Users/abhi/proj/flance/taskflow/data/pipeline/chunk-0.json, /Users/abhi/proj/flance/taskflow/data/pipeline/chunk-1.json,\n/Users/abhi/proj/flance/taskflow/data/pipeline/chunk-2.json — each has a squares array. Sum every value across all three arrays.\nCompute the reference value yourself: it is the sum of i*i for i from 1 through 30 inclusive (which equals\n30*31*61/6). Then write /Users/abhi/proj/flance/taskflow/data/pipeline/summary.json as JSON with keys total (the computed sum), expected\n(the reference value), ok (boolean, true iff total equals expected). Respond "aggregate done".\n', claims: ['data/pipeline/summary.json'] });
    });
  });
});
