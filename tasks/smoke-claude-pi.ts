// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM smoke-claude-pi.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build smoke-claude-pi.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('smoke-claude-pi', {}, async (h) => {
  await stage(h, 'smoke', async () => {
    await leaf(h, { id: 'write-hello', agent: 'claude-code', model: 'sonnet', task: 'Write the exact text "Hello from claude-code harness leaf." (with the trailing period, no quotes) to the file\ndata/smoke/hello.txt. Create parent directories if needed. Respond briefly with "done" when the file is written.\n', claims: ['data/smoke/hello.txt'] });
    await leaf(h, { id: 'verify-hello', agent: 'pi', model: 'anthropic/claude-sonnet-4-6', task: 'Read data/smoke/hello.txt. If its content exactly equals "Hello from claude-code harness leaf." (trailing period,\ntrimmed of leading/trailing whitespace), write a JSON object to data/smoke/verify.json with keys ok (true) and\ncontent (the file contents). Otherwise write a JSON object with keys ok (false), content (the file contents),\nand expected (the expected string). Then respond with "verified".\n', claims: ['data/smoke/verify.json'] });
  });
});
