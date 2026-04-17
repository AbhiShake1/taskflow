// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM repeat.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build repeat.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('repeat-fixture', {}, async (h) => {
  await stage(h, 'root', async () => {
    await stage(h, 'retry', async () => {
      await leaf(h, { id: 'attempt', agent: 'pi', task: 'Try the thing.' });
      await leaf(h, { id: 'attempt', agent: 'pi', task: 'Try the thing.' });
    });
  });
});
