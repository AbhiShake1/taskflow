import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const RUN_REAL = process.env.HARNESS_REAL_TESTS === '1';
const HAS_AUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!RUN_REAL || !HAS_AUTH)('real per-leaf timeout', () => {
  it('timeoutMs exceeded → watchdog fires, status=timeout, clean exit', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'harness-timeout-'));

    const child = spawn('npx', ['tsx', 'runner/index.ts', 'tasks/smoke-timeout.ts'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HARNESS_NO_TTY: '1', HARNESS_RUNS_DIR: runsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const startedAt = Date.now();

    // Wait up to 30s for the runner to exit on its own (timeoutMs=5s + SDK startup ~10s + buffer).
    const exitCode = await new Promise<number | null>(res => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); res(-1); } }, 30_000);
      child.on('exit', (code) => { if (done) return; done = true; clearTimeout(t); res(code); });
    });
    const wallMs = Date.now() - startedAt;

    // Inspect manifest + events
    const runEntries = await readdir(runsDir);
    expect(runEntries.length).toBeGreaterThan(0);
    const runDir = join(runsDir, runEntries[0]);
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
    const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));

    // Assertions:
    // 1. Runner process exited within budget and with non-zero code (spec's single leaf failing
    //    means the stage throws → exitCode: 1 in manifest).
    expect(exitCode).not.toBe(-1);
    expect(manifest.exitCode).not.toBe(0);

    // 2. Manifest has exactly 1 leaf with status === 'timeout'
    expect(manifest.leaves).toHaveLength(1);
    expect(manifest.leaves[0].status).toBe('timeout');

    // 3. events.jsonl has a done event for slow-task whose result.status === 'timeout'
    const doneEvents = events.filter((e: any) => e.t === 'done' && e.leafId === 'slow-task');
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    // The last done event for the leaf should carry the canonical final status.
    const finalDone = doneEvents[doneEvents.length - 1];
    expect(finalDone.result.status).toBe('timeout');

    // 4. Total wall time < 25s (5s timeout + 10s SDK startup + buffer, well under 25s)
    expect(wallMs, `wall time was ${wallMs}ms`).toBeLessThan(25_000);

    // Diagnostic
    const spawnEv = events.find((e: any) => e.t === 'spawn' && e.leafId === 'slow-task');
    const spawnTs = spawnEv?.ts as number | undefined;
    const doneTs = finalDone.ts as number;
    // eslint-disable-next-line no-console
    console.log(
      `[real-timeout] status=${finalDone.result.status} exitCode=${exitCode} wallMs=${wallMs} ` +
      `spawn→done=${spawnTs ? doneTs - spawnTs : 'n/a'}ms leafExitCode=${finalDone.result.exitCode}`,
    );

    // 5. No orphan SDK subprocess alive (give the OS 2s for kernel to finalize)
    await new Promise(r => setTimeout(r, 2_000));
    const orphans = await new Promise<string>(res => {
      const p = spawn('pgrep', ['-f', 'claude-agent-sdk/cli.js']);
      let out = ''; p.stdout.on('data', c => { out += c.toString(); });
      p.on('exit', () => res(out.trim()));
    });
    expect(orphans, `orphans: ${orphans}`).toBe('');
  }, 60_000);
});
