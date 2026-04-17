// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM smoke-timeout.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build smoke-timeout.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('smoke-timeout', {}, async (h) => {
  await stage(h, 'timeout-stage', async () => {
    await leaf(h, { id: 'slow-task', agent: 'claude-code', model: 'sonnet', task: 'Run the following shell command using the Bash tool: `for i in $(seq 1 60); do echo $i; sleep 2; done`.\nThis will take about 2 minutes. Report "counting" immediately so we know you started. Do NOT wait for the\ncommand to finish before responding — the Bash tool\'s background mode is fine.\n', claims: ['data/smoke/timeout-log.txt'], timeoutMs: 5000 });
  });
});
