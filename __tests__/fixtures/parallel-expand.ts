// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM parallel-expand.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build parallel-expand.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('parallel-expand', {}, async (h) => {
  await stage(h, 'root', async () => {
    await stage(h, 'fetch', async () => {
      await parallel(h, [
        () => leaf(h, { id: 'shard-0', agent: 'opencode', model: 'groq/llama-3.3-70b', task: 'Fetch shard 0 of URLs.', claims: ['data/scraped/don/2026-04-17/shard-0/**'] }),
        () => leaf(h, { id: 'shard-1', agent: 'opencode', model: 'groq/llama-3.3-70b', task: 'Fetch shard 1 of URLs.', claims: ['data/scraped/don/2026-04-17/shard-1/**'] }),
        () => leaf(h, { id: 'shard-2', agent: 'opencode', model: 'groq/llama-3.3-70b', task: 'Fetch shard 2 of URLs.', claims: ['data/scraped/don/2026-04-17/shard-2/**'] }),
      ]);
    });
  });
});
