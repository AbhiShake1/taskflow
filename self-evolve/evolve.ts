// Self-evolution harness for the taskflow-sdk codebase.
//
// Runs N small-improvement iterations against the parent repo. Each iteration
// is a phase, with a self-healing verify loop and a final commit gated on
// frame validation:
//
//   pick-improvement
//     → implement
//       → [ lint ∥ format ∥ test ]   (attempt 0)
//         → (any fail) fix → retry [lint ∥ format ∥ test]   (up to MAX_FIX_ATTEMPTS)
//           → capture-frame (terminal PNG proof)
//             → validate-frame (fresh AI, reads only PNG + claim + system prompt)
//               → commit-iter (git add + git commit with proof path in message)
//
// Every session is a fresh AI call — no context bloat across steps. The
// frame validator's system prompt lives at
// /Users/abhi/proj/flance/taskflow/.agents/taskflow/screenshot-validation.md
// so you can edit validation rules without touching this harness.
//
// After all iterations land and each frame is validated and committed, a
// stitch-video phase glues the frames into data/self-evolve.mp4 via ffmpeg.
//
// Run (from self-evolve/):
//   npm start
// Smoke (no LLM, no file changes):
//   npm run start:mock
// Tweak:
//   SELF_EVOLVE_ITERATIONS=5 npm start           # shorter first run
//   SELF_EVOLVE_PUSH=1 npm start                 # also git push after each iter
//   SELF_EVOLVE_MAX_FIX=2 npm start              # fewer self-fix retries

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { taskflow } from 'taskflow-sdk';
import { z } from 'zod';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FRAMES_DIR = resolve(REPO_ROOT, 'data', 'frames');
const VIDEO_PATH = resolve(REPO_ROOT, 'data', 'self-evolve.mp4');
const VALIDATION_PROMPT_PATH = resolve(REPO_ROOT, '.agents', 'taskflow', 'screenshot-validation.md');

// The harness runs continuously by default — each restart resumes from where
// the prior run left off (by scanning existing proof frames). Setting a
// numeric SELF_EVOLVE_ITERATIONS caps the loop for short pilot runs; leaving
// it unset (default) means "evolve forever until SIGINT".
const ITERATIONS = process.env.SELF_EVOLVE_ITERATIONS
  ? Number(process.env.SELF_EVOLVE_ITERATIONS)
  : Number.POSITIVE_INFINITY;
const MAX_FIX_ATTEMPTS = Number(process.env.SELF_EVOLVE_MAX_FIX ?? '3');
const PUSH_EACH_ITER = process.env.SELF_EVOLVE_PUSH === '1';

const ImprovementIdea = z.object({
  summary: z.string().describe('One-line description of the improvement.'),
  rationale: z.string().describe('Why this improvement is worth making.'),
  files: z.array(z.string()).describe('Relative paths the improvement will write.'),
  riskLevel: z.enum(['low', 'medium']).describe('How risky the change is; only low or medium ship.'),
  verifyClaim: z.enum(['tests-pass', 'lint-clean', 'format-clean', 'build-success', 'diff-applied']).describe('Which claim the screenshot validator checks.'),
  commitType: z.enum(['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf']).describe('Conventional commit type for this change.'),
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

const CommitResult = z.object({
  committed: z.boolean(),
  sha: z.string().optional(),
  pushed: z.boolean(),
  message: z.string(),
});

// Retry a session call up to `attempts` times with a unique id suffix per
// attempt ({baseId}, {baseId}-r1, {baseId}-r2, …). Transient failures
// (timeouts, schema mismatches, single-flight model blips) are common at
// claude-code scale and shouldn't kill the whole 20-iter run.
async function withRetries<T>(
  sessionCall: (id: string) => Promise<T>,
  baseId: string,
  attempts: number = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    const id = a === 0 ? baseId : `${baseId}-r${a}`;
    try {
      return await sessionCall(id);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[retry] ${baseId} attempt ${a + 1}/${attempts} failed: ${msg.slice(0, 200)}`);
    }
  }
  throw lastErr;
}

// Determine which iterations have already been completed by inspecting
// data/frames/. An iteration is considered done iff at least one frame PNG
// exists for it (the harness only writes a frame after validate-${iter}
// passes, and the commit-${iter} session that follows is the final step).
async function discoverCompletedIters(): Promise<Map<string, string>> {
  const completed = new Map<string, string>();
  try {
    const entries = await readdir(FRAMES_DIR);
    for (const name of entries) {
      const match = name.match(/^iter-(\d{2})-.+\.png$/);
      if (match) completed.set(match[1]!, resolve(FRAMES_DIR, name));
    }
  } catch {
    // FRAMES_DIR doesn't exist yet — fresh run, nothing to skip.
  }
  return completed;
}

async function main(): Promise<void> {
  const validationSystemPrompt = await readFile(VALIDATION_PROMPT_PATH, 'utf8');
  const alreadyDone = await discoverCompletedIters();
  if (alreadyDone.size > 0) {
    console.error(`[self-evolve] resume: ${alreadyDone.size} iter(s) already have proof frames — skipping: ${[...alreadyDone.keys()].sort().join(', ')}`);
  }

  // Resume: next iter picks up AFTER the highest existing frame index so we
  // don't collide with a partial in-flight iter's dirty files.
  const startIter = alreadyDone.size > 0
    ? Math.max(...[...alreadyDone.keys()].map(Number)) + 1
    : 0;

  await taskflow('self-evolve').run(async ({ phase, session }) => {
    const frameLog: string[] = [...alreadyDone.values()].sort();
    const failedIters: Array<{ iter: string; error: string }> = [];

    for (let i = startIter; i < ITERATIONS; i++) {
      const iter = String(i).padStart(2, '0');

      if (alreadyDone.has(iter)) continue;

      try {
        await phase(`iter-${iter}`, async () => {
        const idea = await withRetries((id) => session(id, {
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
            '- Pick something different from recent commits (run `git log --oneline -20` from the repo root to see what\'s been done; avoid duplicating).',
            '- Return the structured idea; do not implement yet.',
          ].join('\n'),
          schema: ImprovementIdea,
          timeoutMs: 360_000,
        }), `pick-${iter}`);

        await withRetries((id) => session(id, {
          with: 'claude-code:sonnet',
          task: [
            `Implement this improvement in the taskflow-sdk repo at ${REPO_ROOT}:`,
            '',
            `Summary: ${idea.summary}`,
            `Rationale: ${idea.rationale}`,
            `Files: ${idea.files.join(', ')}`,
            '',
            'Rules:',
            '- Make the minimal change.',
            '- Do not refactor adjacent code.',
            '- Do not add emojis.',
            '- Do not add comments unless they document a non-obvious WHY.',
            '- When done, ensure the file is written; no further commentary needed.',
          ].join('\n'),
          write: idea.files,
          timeoutMs: 600_000,
        }), `implement-${iter}`);

        // Self-healing verify loop: lint/format/test run in parallel. If any
        // fails, spawn a `fix` session that reads the failures and tries to
        // correct them. Re-verify. Bounded by MAX_FIX_ATTEMPTS.
        let verifyAttempt = 0;
        let priorStep = `implement-${iter}`;
        let finalVerify: { lint: z.infer<typeof CmdResult>; format: z.infer<typeof CmdResult>; tests: z.infer<typeof CmdResult> } | null = null;

        while (verifyAttempt < MAX_FIX_ATTEMPTS + 1) {
          const tag = `${iter}-a${verifyAttempt}`;
          const [lint, format, tests] = await Promise.all([
            session(`lint-${tag}`, {
              with: 'claude-code:sonnet',
              task: `Run \`cd ${REPO_ROOT} && npx tsc --noEmit\`. If there are errors, DO NOT fix them here — just report status=error with a concise summary of the errors (first 5 lines). If clean, status=ok.`,
              dependsOn: [priorStep],
              schema: CmdResult,
              timeoutMs: 300_000,
            }),
            session(`format-${tag}`, {
              with: 'claude-code:sonnet',
              task: 'Inspect package.json scripts for a formatter (biome, prettier, etc.). If none configured, return status=ok and summary="no formatter configured". If one exists, run it in check mode; return status=ok on clean or status=error with summary listing mis-formatted files.',
              dependsOn: [priorStep],
              schema: CmdResult,
              timeoutMs: 300_000,
            }),
            session(`test-${tag}`, {
              with: 'claude-code:sonnet',
              task: `Run \`cd ${REPO_ROOT} && npx vitest run\`. Return status=ok when exit 0 (all passed/skipped), status=error otherwise, with counts.passed / counts.failed populated from the vitest summary.`,
              dependsOn: [priorStep],
              schema: CmdResult,
              timeoutMs: 600_000,
            }),
          ]);

          finalVerify = { lint, format, tests };
          const failed = [
            lint.status !== 'ok' ? `lint: ${lint.summary}` : null,
            format.status !== 'ok' ? `format: ${format.summary}` : null,
            tests.status !== 'ok' ? `tests: ${tests.summary}` : null,
          ].filter(Boolean);

          if (failed.length === 0) break;

          if (verifyAttempt >= MAX_FIX_ATTEMPTS) {
            throw new Error(`iter-${iter} verification failed after ${MAX_FIX_ATTEMPTS} fix attempts — ${failed.join(' | ')}`);
          }

          const fixId = `fix-${tag}`;
          await session(fixId, {
            with: 'claude-code:sonnet',
            task: [
              `The verify step for iteration ${iter} (attempt ${verifyAttempt}) reported failures:`,
              '',
              ...failed.map((f) => `  - ${f}`),
              '',
              'Fix ONLY what is necessary to make the failures pass. Do not regress tests, do not revert the improvement from `implement-' + iter + '`. Keep the fix minimal.',
              '',
              `Improvement being preserved: ${idea.summary}`,
              `Original files: ${idea.files.join(', ')}`,
              '',
              'If the tests are failing because the improvement itself was wrong and cannot be made to work, you MAY revert the original-file edits — but prefer fixing over reverting.',
            ].join('\n'),
            write: idea.files,
            dependsOn: [`lint-${tag}`, `format-${tag}`, `test-${tag}`],
            timeoutMs: 600_000,
          });

          priorStep = fixId;
          verifyAttempt += 1;
        }

        const framePath = resolve(FRAMES_DIR, `iter-${iter}-${idea.verifyClaim}.png`);

        const capture = await withRetries((id) => session(id, {
          with: 'claude-code:sonnet',
          task: [
            `Capture a terminal frame that visually proves claim "${idea.verifyClaim}" for iteration ${iter}.`,
            '',
            `Save the PNG to: ${framePath}`,
            '',
            'Steps:',
            `1. Re-run the command that produces the proof:`,
            `   - tests-pass    → \`npx vitest run\``,
            `   - lint-clean    → \`npx tsc --noEmit\` (absent output = clean)`,
            `   - format-clean  → whatever formatter the repo has, in check mode`,
            `   - build-success → \`npm run build\``,
            `   - diff-applied  → \`git diff --stat HEAD\``,
            '2. Capture a PNG showing that command\'s output:',
            '   - Preferred on macOS: \`screencapture -x <target>\` (full screen) or \`screencapture -l $(osascript -e \'tell app "Terminal" to id of front window\') <target>\` (front terminal window).',
            '   - Fallback: pipe the command\'s stdout to a text file, then rasterize with any available tool (e.g. silicon, carbon-now-cli, imagemagick convert). Any real PNG is fine.',
            '3. Verify the PNG exists at the target path and has non-zero size.',
            '',
            `Return the absolute PNG path and which capture method you used.`,
          ].join('\n'),
          write: [framePath],
          schema: CaptureResult,
          timeoutMs: 180_000,
        }), `capture-${iter}`);

        const verdict = await withRetries((id) => session(id, {
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
            `Verify attempts used: ${verifyAttempt} fix cycles`,
            '',
            'Read the image at the frame path and apply the rules from the system prompt above. Return the ValidationVerdict JSON object.',
          ].join('\n'),
          schema: ValidationVerdict,
          timeoutMs: 180_000,
        }), `validate-${iter}`);

        if (!verdict.valid) {
          throw new Error(`iter-${iter} frame validation rejected — ${verdict.reason}`);
        }

        frameLog.push(capture.framePath);

        const commitBody = [
          `${idea.commitType}(self-evolve iter-${iter}): ${idea.summary}`,
          '',
          `Rationale: ${idea.rationale}`,
          `Files: ${idea.files.join(', ')}`,
          `Verify attempts: ${verifyAttempt} fix cycle(s)`,
          `Proof frame: ${capture.framePath}`,
          `Validator observed: ${verdict.observed.join('; ') || '—'}`,
          '',
          'Co-Authored-By: taskflow self-evolve harness <noreply@anthropic.com>',
        ].join('\n');

        await withRetries((id) => session(id, {
          with: 'claude-code:sonnet',
          task: [
            `From ${REPO_ROOT}, stage and commit this iteration's work.`,
            '',
            'Steps:',
            `1. \`git add ${idea.files.map((f) => `"${f}"`).join(' ')} "${capture.framePath}"\``,
            '2. `git status --short` — confirm only these files are staged.',
            `3. Commit with this exact message (use a heredoc so newlines survive):`,
            '',
            '```',
            commitBody,
            '```',
            '',
            PUSH_EACH_ITER
              ? '4. `git push origin main` — push the commit.'
              : '4. Do NOT push. The user reviews in bulk.',
            '',
            'Return CommitResult: committed=true if the commit landed, sha=short sha, pushed=true/false, message=the first line of the commit message.',
          ].join('\n'),
          schema: CommitResult,
          timeoutMs: 180_000,
        }), `commit-${iter}`);
        });
      } catch (err) {
        // One failed iter shouldn't kill the remaining 19. Log it, keep
        // whatever frames/commits survived so far, and move on. The
        // stitch-video phase downstream works with whatever we got.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[iter-${iter}] aborted: ${msg.slice(0, 300)}`);
        failedIters.push({ iter, error: msg.slice(0, 500) });
      }
    }

    if (failedIters.length > 0) {
      console.error(`[self-evolve] ${failedIters.length} iteration(s) failed across this run:`);
      for (const f of failedIters) console.error(`  - iter-${f.iter}: ${f.error}`);
    }

    // Auto-stitch only when the loop ran to completion against a finite cap.
    // In infinite mode (the default) the loop never exits — use the separate
    // `npm run stitch` script when you want a snapshot demo video.
    if (Number.isFinite(ITERATIONS) && frameLog.length > 0) {
      await phase('stitch-video', async () => {
        await session('make-video', {
          with: 'claude-code:sonnet',
          task: [
            `Stitch ${frameLog.length} captured frames into a single demo video.`,
            '',
            `Output: ${VIDEO_PATH}`,
            '',
            'Use ffmpeg. 1 second per frame, loop the last frame for +2 seconds, 30fps output.',
            `  ffmpeg -y -framerate 1 -pattern_type glob -i '${FRAMES_DIR}/iter-*.png' -vf "format=yuv420p" -r 30 ${VIDEO_PATH}`,
            '',
            'Verify the output MP4 exists and is > 0 bytes.',
          ].join('\n'),
          write: [VIDEO_PATH],
          timeoutMs: 300_000,
        });
      });
    }
  }, { runsDir: resolve(REPO_ROOT, 'data', 'runs') });
}

main().catch((err) => {
  console.error('self-evolve harness failed:', err);
  process.exit(1);
});
