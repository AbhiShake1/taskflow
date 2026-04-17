// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM smoke-parallel-claude.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build smoke-parallel-claude.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('smoke-parallel-claude', {}, async (h) => {
  await stage(h, 'parallel-smoke', async () => {
    await parallel(h, [
      () => leaf(h, { id: 'worker-0', agent: 'claude-code', model: 'sonnet', task: 'Write the single line "worker 0 reporting in" (no quotes, no trailing newline beyond the one line) to the file\nat absolute path /Users/abhi/proj/flance/taskflow/data/smoke/parallel/worker-0.txt. Create parent directories if needed. Respond briefly\nwith "done-0" when the file is written.\n', claims: ['data/smoke/parallel/worker-0/**'] }),
      () => leaf(h, { id: 'worker-1', agent: 'claude-code', model: 'sonnet', task: 'Write the single line "worker 1 reporting in" (no quotes, no trailing newline beyond the one line) to the file\nat absolute path /Users/abhi/proj/flance/taskflow/data/smoke/parallel/worker-1.txt. Create parent directories if needed. Respond briefly\nwith "done-1" when the file is written.\n', claims: ['data/smoke/parallel/worker-1/**'] }),
      () => leaf(h, { id: 'worker-2', agent: 'claude-code', model: 'sonnet', task: 'Write the single line "worker 2 reporting in" (no quotes, no trailing newline beyond the one line) to the file\nat absolute path /Users/abhi/proj/flance/taskflow/data/smoke/parallel/worker-2.txt. Create parent directories if needed. Respond briefly\nwith "done-2" when the file is written.\n', claims: ['data/smoke/parallel/worker-2/**'] }),
    ]);
  });
});
