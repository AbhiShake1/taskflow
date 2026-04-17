// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM nested.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build nested.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('nested-fixture', {}, async (h) => {
  await stage(h, 'root', async () => {
    await stage(h, 'outer', async () => {
      await stage(h, 'inner-0', async () => {
        await leaf(h, { id: 'work-0', agent: 'claude-code', task: 'Do work for 0', claims: ['out/0.txt'] });
      });
      await stage(h, 'inner-1', async () => {
        await leaf(h, { id: 'work-1', agent: 'claude-code', task: 'Do work for 1', claims: ['out/1.txt'] });
      });
    });
  });
});
