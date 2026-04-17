// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM smoke-abort.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build smoke-abort.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('smoke-abort', {}, async (h) => {
  await stage(h, 'abort-stage', async () => {
    await leaf(h, { id: 'slow-loop', agent: 'claude-code', model: 'sonnet', task: 'Run the following shell command using the Bash tool: `for i in $(seq 1 60); do echo $i; sleep 2; done > /Users/abhi/proj/flance/taskflow/data/smoke/countdown.txt`.\nThis will take roughly 120 seconds. Report "counting" immediately so we know you started. Do NOT wait for the\ncommand to finish before responding.\n', claims: ['data/smoke/countdown.txt'] });
  });
});
