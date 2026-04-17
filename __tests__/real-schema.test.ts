import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { taskflow } from '../api';

const RUN_REAL = process.env.HARNESS_REAL_TESTS === '1';
const HAS_AUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

/**
 * Real-LLM structured-output smoke test. Exercises the claude-code adapter's
 * native tool-use path end-to-end:
 *   - Register a `submit_result` MCP tool whose input schema is derived from
 *     a zod schema
 *   - Prompt the model to respond by calling the tool
 *   - Capture the tool call input and validate against the zod schema
 *
 * Budget this carefully — one real run per invocation.
 */
describe.skipIf(!RUN_REAL || !HAS_AUTH)('real structured output (claude-code)', () => {
  it('returns a typed, schema-validated value from the LLM via tool-use', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'harness-real-schema-'));
    try {
      const echoSchema = z.object({ echo: z.string() });

      let received: { echo: string } | undefined;
      const { manifest } = await taskflow('real-schema-smoke').run(
        async ({ phase, session }) => {
          await phase('echo', async () => {
            received = await session('echo-call', {
              with: 'claude-code:sonnet',
              task: "Respond by calling submit_result with { echo: 'hello' } and nothing else.",
              schema: echoSchema,
            });
          });
        },
        { runsDir, runId: 'real-schema-smoke' },
      );

      expect(manifest.exitCode).toBe(0);
      expect(received).toBeDefined();
      expect(received!.echo).toBe('hello');
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  }, 120_000);
});
