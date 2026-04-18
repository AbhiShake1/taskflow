// Self-evolution harness for the taskflow-sdk codebase.
//
// Runs 20 small-improvement iterations against the parent repo. Every iteration
// is a phase; within a phase the DAG is:
//
//   pick-improvement → implement → { lint ∥ format ∥ test } → capture-frame → validate-frame
//
// Every session is a fresh AI call — no context bloat across steps. The
// validate-frame session is gated by the system prompt at
// /Users/abhi/proj/flance/taskflow/.agents/taskflow/screenshot-validation.md,
// which the user can edit freely without touching this harness.
//
// After all iterations land, a single stitch-video phase uses ffmpeg to glue
// every captured frame into data/self-evolve.mp4 — the demo output.
//
// Run (from self-evolve/):
//   npm start
// Smoke (no LLM calls, no file changes):
//   npm run start:mock

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { taskflow } from 'taskflow-sdk';
import { z } from 'zod';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FRAMES_DIR = resolve(REPO_ROOT, 'data', 'frames');
const VIDEO_PATH = resolve(REPO_ROOT, 'data', 'self-evolve.mp4');
const VALIDATION_PROMPT_PATH = resolve(REPO_ROOT, '.agents', 'taskflow', 'screenshot-validation.md');

const ITERATIONS = 20;

const ImprovementIdea = z.object({
  summary: z.string().describe('One-line description of the improvement.'),
  rationale: z.string().describe('Why this improvement is worth making.'),
  files: z.array(z.string()).describe('Relative paths the improvement will write.'),
  riskLevel: z.enum(['low', 'medium']).describe('How risky the change is; the harness only ships low or medium.'),
  verifyClaim: z.enum(['tests-pass', 'lint-clean', 'format-clean', 'build-success', 'diff-applied']).describe('Which claim the screenshot validator should check.'),
});
type ImprovementIdea = z.infer<typeof ImprovementIdea>;

const CmdResult = z.object({
  status: z.enum(['ok', 'error']),
  summary: z.string().describe('≤140-char summary of what happened.'),
  counts: z.object({ passed: z.number(), failed: z.number() }).partial().optional(),
});

const CaptureResult = z.object({
  framePath: z.string().describe('Absolute path to the captured PNG.'),
  method: z.enum(['screencapture', 'asciinema', 'tee-to-png', 'other']),
});

const ValidationVerdict = z.object({
  valid: z.boolean(),
  reason: z.string().max(200),
  observed: z.array(z.string()).min(0).max(5),
});

async function main(): Promise<void> {
  const validationSystemPrompt = await readFile(VALIDATION_PROMPT_PATH, 'utf8');

  await taskflow('self-evolve').run(async ({ phase, session }) => {
    const frameLog: string[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const iter = String(i).padStart(2, '0');

      await phase(`iter-${iter}`, async () => {
        const idea = await session(`pick-${iter}`, {
          with: 'claude-code:sonnet',
          task: [
            `You are iteration ${i + 1} of ${ITERATIONS} in a self-evolution harness running against the taskflow-sdk repo at ${REPO_ROOT}.`,
            '',
            'Propose ONE small, safe improvement. Good candidates:',
            '- Fix a flaky or slow test.',
            '- Tighten a type (replace any/unknown with a precise type).',
            '- Add a missing unit test for an untested branch.',
            '- Improve an error message to be more diagnostic.',
            '- Remove dead code.',
            '- Add a JSDoc comment where the intent is non-obvious.',
            '',
            'Rules:',
            '- Touch ≤2 files.',
            '- Do NOT change public API signatures.',
            '- Do NOT bump dependencies.',
            '- Pick something different from what earlier iterations did. Read git log to see.',
            '- Return a structured idea, do not implement yet.',
          ].join('\n'),
          schema: ImprovementIdea,
          timeoutMs: 120_000,
        });

        await session(`implement-${iter}`, {
          with: 'claude-code:sonnet',
          task: [
            `Implement this improvement:`,
            '',
            `Summary: ${idea.summary}`,
            `Rationale: ${idea.rationale}`,
            `Files: ${idea.files.join(', ')}`,
            '',
            `Make the minimal change. Do not refactor adjacent code. Do not add emojis. Do not add comments unless they document a non-obvious WHY.`,
          ].join('\n'),
          write: idea.files,
          dependsOn: [`pick-${iter}`],
          timeoutMs: 300_000,
        });

        const [lint, format, tests] = await Promise.all([
          session(`lint-${iter}`, {
            with: 'codex:gpt-5.4',
            task: 'Run `npx tsc --noEmit` from the repo root. If there are errors, fix them in minimal style. Return status and summary.',
            dependsOn: [`implement-${iter}`],
            schema: CmdResult,
            timeoutMs: 180_000,
          }),
          session(`format-${iter}`, {
            with: 'codex:gpt-5.4',
            task: 'Check formatting with whatever formatter the repo uses (check package.json scripts first; if none, skip cleanly with status=ok and summary="no formatter configured"). If a formatter exists and files are unformatted, run it in --write mode. Return status and summary.',
            dependsOn: [`implement-${iter}`],
            schema: CmdResult,
            timeoutMs: 180_000,
          }),
          session(`test-${iter}`, {
            with: 'codex:gpt-5.4',
            task: 'Run `npx vitest run` from the repo root. Return status (ok if all passed, error otherwise) and counts.',
            dependsOn: [`implement-${iter}`],
            schema: CmdResult,
            timeoutMs: 300_000,
          }),
        ]);

        const allGreen = lint.status === 'ok' && format.status === 'ok' && tests.status === 'ok';
        if (!allGreen) {
          const failed = [
            lint.status !== 'ok' ? `lint: ${lint.summary}` : null,
            format.status !== 'ok' ? `format: ${format.summary}` : null,
            tests.status !== 'ok' ? `tests: ${tests.summary}` : null,
          ].filter(Boolean).join(' | ');
          throw new Error(`iter-${iter} verification failed — ${failed}`);
        }

        const framePath = resolve(FRAMES_DIR, `iter-${iter}-${idea.verifyClaim}.png`);

        const capture = await session(`capture-${iter}`, {
          with: 'claude-code:sonnet',
          task: [
            `Capture a terminal frame that proves claim "${idea.verifyClaim}" for iteration ${iter}.`,
            '',
            `Save the PNG to: ${framePath}`,
            '',
            'Steps:',
            `1. Re-run the relevant command so its output is freshly on screen (e.g. for tests-pass, run \`npx vitest run\`; for lint-clean, \`npx tsc --noEmit\`; for format-clean, the format check; for build-success, \`npm run build\`; for diff-applied, \`git diff --stat HEAD~1 HEAD\`).`,
            '2. Capture the terminal window or a portion of it to the target PNG.',
            '   - On macOS try \`screencapture -x\` for the full screen or \`screencapture -l $(osascript -e \'tell app "Terminal" to id of front window\')\` for just the terminal window. Save as PNG.',
            '   - Fallback: write the command output to a plain text file, then rasterize using any installed tool (e.g. silicon, carbon-now-cli, or `chafa` + imagemagick). Anything that produces a real PNG is acceptable.',
            `3. Verify the PNG exists at the target path and is non-empty.`,
            '',
            `Return the absolute PNG path and which capture method you used.`,
          ].join('\n'),
          write: [framePath],
          dependsOn: [`lint-${iter}`, `format-${iter}`, `test-${iter}`],
          schema: CaptureResult,
          timeoutMs: 120_000,
        });

        const verdict = await session(`validate-${iter}`, {
          with: 'claude-code:sonnet',
          task: [
            validationSystemPrompt,
            '',
            '---',
            '',
            `Iteration: ${iter}`,
            `Claim to verify: ${idea.verifyClaim}`,
            `Improvement summary: ${idea.summary}`,
            `Frame (PNG) path: ${capture.framePath}`,
            '',
            'Read the image at the frame path and apply the rules from the system prompt above. Return the ValidationVerdict JSON object.',
          ].join('\n'),
          dependsOn: [`capture-${iter}`],
          schema: ValidationVerdict,
          timeoutMs: 120_000,
        });

        if (!verdict.valid) {
          throw new Error(`iter-${iter} frame validation rejected — ${verdict.reason}`);
        }

        frameLog.push(capture.framePath);
      });
    }

    await phase('stitch-video', async () => {
      await session('make-video', {
        with: 'claude-code:sonnet',
        task: [
          `All ${ITERATIONS} iterations completed and were frame-validated. Stitch the captured frames into a single demo video.`,
          '',
          `Input frames (in chronological order):`,
          ...frameLog.map((p, j) => `  ${j + 1}. ${p}`),
          '',
          `Output: ${VIDEO_PATH}`,
          '',
          'Use ffmpeg. 1 second per frame. Loop the last frame for an extra 2 seconds so viewers can read it. Example:',
          `  ffmpeg -framerate 1 -pattern_type glob -i '${FRAMES_DIR}/iter-*.png' -vf "format=yuv420p" -r 30 ${VIDEO_PATH}`,
          '',
          'Verify the output MP4 exists and is > 0 bytes.',
        ].join('\n'),
        write: [VIDEO_PATH],
        timeoutMs: 180_000,
      });
    });
  }, { runsDir: resolve(REPO_ROOT, 'data', 'runs') });
}

main().catch((err) => {
  console.error('self-evolve harness failed:', err);
  process.exit(1);
});
