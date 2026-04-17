// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM foreach.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build foreach.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('foreach-fixture', {}, async (h) => {
  await stage(h, 'root', async () => {
    await stage(h, 'greet', async () => {
      await leaf(h, { id: 'greet-alpha', agent: 'claude-code', task: 'Greet alpha', claims: ['out/alpha.txt'] });
      await leaf(h, { id: 'greet-beta', agent: 'claude-code', task: 'Greet beta', claims: ['out/beta.txt'] });
    });
  });
});
