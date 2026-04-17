// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM single-leaf.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build single-leaf.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('single-leaf', {}, async (h) => {
  await stage(h, 'root', async () => {
    await leaf(h, { id: 'hello', agent: 'claude-code', model: 'sonnet', task: 'Say hello', claims: ['out/hello.txt'] });
  });
});
