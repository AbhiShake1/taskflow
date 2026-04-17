import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const RUN_REAL = process.env.HARNESS_REAL_TESTS === '1';
const HAS_AUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

/**
 * End-to-end multi-stage claude-code real pipeline.
 *
 * Proves the harness correctly orchestrates nested stages with cross-leaf
 * data flow against the real claude-agent-sdk:
 *   - Stage `discover` (1 leaf): emits nums.json (array 1..30).
 *   - Stage `compute` (3 parallel leaves via expand, count=3, as=i): squares
 *     its third and writes chunk-{i}.json.
 *   - Stage `aggregate` (1 leaf): reads all three chunks, writes summary.json
 *     with {total, expected, ok}.
 *
 * All writes land under `data/pipeline/`. No network beyond what the SDK does
 * with Anthropic. No external writes, no real scraping.
 */
describe.skipIf(!RUN_REAL || !HAS_AUTH)('real multi-stage pipeline', () => {
  it('discover → parallel compute → aggregate runs end-to-end against claude-code', async () => {
    // Clean the data/pipeline workspace so assertions see THIS run's output
    // rather than lingering artifacts from a previous invocation.
    await rm(join(REPO_ROOT, 'data', 'pipeline'), { recursive: true, force: true });

    const runsDir = await mkdtemp(join(tmpdir(), 'harness-pipeline-'));

    const child = spawn(
      'npx',
      ['tsx', 'runner/index.ts', 'tasks/pipeline.ts'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, HARNESS_NO_TTY: '1', HARNESS_RUNS_DIR: runsDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });

    // Wait for the runner process to exit. Budget is 110s to stay under the
    // vitest timeout of 120s — pipeline typically finishes in ~55s.
    const exitCode = await new Promise<number | null>((res) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          child.kill('SIGKILL');
          res(-1);
        }
      }, 110_000);
      child.on('exit', (code) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        res(code);
      });
    });

    // --- Assertion 1: runner exit code ---------------------------------------
    expect(exitCode, `runner did not exit cleanly. stderr: ${stderr}`).toBe(0);

    // --- Locate the run directory --------------------------------------------
    const runEntries = await readdir(runsDir);
    expect(runEntries, `no run dir created under ${runsDir}`).toHaveLength(1);
    const runDir = join(runsDir, runEntries[0]);
    const manifestPath = join(runDir, 'manifest.json');
    const eventsPath = join(runDir, 'events.jsonl');
    expect(existsSync(manifestPath), 'manifest.json missing').toBe(true);
    expect(existsSync(eventsPath), 'events.jsonl missing').toBe(true);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const events: Array<Record<string, unknown>> = (
      await readFile(eventsPath, 'utf8')
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // --- Assertion 2: manifest shape -----------------------------------------
    expect(manifest.exitCode).toBe(0);
    expect(manifest.leaves).toHaveLength(5);
    for (const l of manifest.leaves) {
      expect(l.status, `leaf ${l.id} not done`).toBe('done');
    }
    expect(manifest.stages).toEqual(['discover', 'compute', 'aggregate']);

    // --- Assertion 3: nums.json is [1..30] -----------------------------------
    const numsRaw = await readFile(
      join(REPO_ROOT, 'data', 'pipeline', 'nums.json'),
      'utf8',
    );
    const nums = JSON.parse(numsRaw);
    expect(nums).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));

    // --- Assertion 4: each chunk-{i}.json has correct squares ----------------
    for (let i = 0; i < 3; i++) {
      const chunkRaw = await readFile(
        join(REPO_ROOT, 'data', 'pipeline', `chunk-${i}.json`),
        'utf8',
      );
      const chunk = JSON.parse(chunkRaw);
      expect(chunk.chunk, `chunk-${i}.json chunk field`).toBe(i);
      expect(Array.isArray(chunk.squares)).toBe(true);
      expect(chunk.squares, `chunk-${i}.json squares length`).toHaveLength(10);
      // Expected squares: for chunk i, values are (i*10+1)..(i*10+10), squared.
      const expectedSquares = Array.from({ length: 10 }, (_, j) => {
        const n = i * 10 + j + 1;
        return n * n;
      });
      expect(chunk.squares).toEqual(expectedSquares);
    }

    // --- Assertion 5: summary.json ok/total/expected -------------------------
    const summaryRaw = await readFile(
      join(REPO_ROOT, 'data', 'pipeline', 'summary.json'),
      'utf8',
    );
    const summary = JSON.parse(summaryRaw);
    expect(summary.ok).toBe(true);
    expect(summary.total).toBe(9455);
    expect(summary.expected).toBe(9455);

    // --- Assertion 6: stage-enter/exit bookends ------------------------------
    const stageEnters = events.filter((e) => e.t === 'stage-enter');
    const stageExits = events.filter(
      (e) => e.t === 'stage-exit' && (e as { status: string }).status === 'done',
    );
    expect(stageEnters).toHaveLength(3);
    expect(stageExits).toHaveLength(3);
    const enterIds = stageEnters.map((e) => (e as { stageId: string }).stageId);
    expect(enterIds).toEqual(['discover', 'compute', 'aggregate']);

    // --- Assertion 7: parallelism + ordering proof ---------------------------
    const spawnEvents = events.filter((e) => e.t === 'spawn') as Array<{
      leafId: string;
      ts: number;
    }>;
    const emitSpawn = spawnEvents.find((e) => e.leafId === 'emit-nums');
    const squareSpawns = spawnEvents
      .filter((e) => e.leafId.startsWith('square-'))
      .sort((a, b) => a.ts - b.ts);
    expect(emitSpawn, 'emit-nums spawn event missing').toBeDefined();
    expect(squareSpawns, 'expected 3 square-* spawns').toHaveLength(3);

    // emit-nums strictly before every compute leaf spawn.
    for (const s of squareSpawns) {
      expect(
        emitSpawn!.ts,
        `emit-nums spawn (${emitSpawn!.ts}) must precede ${s.leafId} spawn (${s.ts})`,
      ).toBeLessThan(s.ts);
    }

    // The 3 compute spawns cluster tightly (all dispatched inside one
    // `parallel(h, [...])` block). Budget 2000ms is generous — in practice
    // they land within a couple of ms.
    const spread = squareSpawns[2].ts - squareSpawns[0].ts;
    expect(spread, `compute spawn spread ${spread}ms exceeds budget`).toBeLessThan(2000);

    // --- Assertion 8 (diagnostic): total token usage across the 5 leaves ----
    const doneEvents = events.filter((e) => e.t === 'done') as Array<{
      leafId: string;
      result: {
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheCreationInputTokens?: number;
          cacheReadInputTokens?: number;
        };
      };
    }>;
    expect(doneEvents).toHaveLength(5);
    const totals = doneEvents.reduce(
      (acc, d) => {
        const u = d.result.usage ?? {};
        acc.inputTokens += u.inputTokens ?? 0;
        acc.outputTokens += u.outputTokens ?? 0;
        acc.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
        acc.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
        return acc;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    );
    // eslint-disable-next-line no-console
    console.log(
      `[real-pipeline] 5-leaf totals: input=${totals.inputTokens} ` +
        `output=${totals.outputTokens} ` +
        `cacheCreation=${totals.cacheCreationInputTokens} ` +
        `cacheRead=${totals.cacheReadInputTokens} ` +
        `spawnSpread(compute)=${spread}ms`,
    );

    // Sanity: at least one leaf observed cache reads, proving rules-prefix
    // cache works in a multi-stage pipeline too.
    expect(totals.cacheReadInputTokens).toBeGreaterThan(0);
  }, 120_000);
});
