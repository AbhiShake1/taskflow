// ----------------------------------------------------------------------------
// AUTO-GENERATED FROM smoke-claude.spec.yml. DO NOT EDIT.
// Regenerate with: npm run build smoke-claude.spec.yml
// ----------------------------------------------------------------------------
import { harness, stage, leaf, parallel } from '../core';

await harness('smoke-claude', {}, async (h) => {
  await stage(h, 'smoke', async () => {
    await leaf(h, { id: 'write-hello', agent: 'claude-code', model: 'sonnet', task: 'Write the exact text "Hello from claude-code harness leaf." (with the trailing period, no quotes) to the file at\nabsolute path /Users/abhi/proj/flance/taskflow/data/smoke/hello.txt. Create parent directories if needed. Respond briefly with "done" when the\nfile is written.\n', claims: ['data/smoke/hello.txt'] });
    await leaf(h, { id: 'verify-hello', agent: 'claude-code', model: 'sonnet', task: 'Read the file at absolute path /Users/abhi/proj/flance/taskflow/data/smoke/hello.txt. If its content — trimmed of leading/trailing\nwhitespace — exactly equals the string "Hello from claude-code harness leaf.", write a JSON document to\n/Users/abhi/proj/flance/taskflow/data/smoke/verify.json whose top-level object has ok set to true and content set to the file\'s content.\nOtherwise set ok to false and also include an expected field with the string above. Respond with "verified".\n', claims: ['data/smoke/verify.json'] });
  });
});
