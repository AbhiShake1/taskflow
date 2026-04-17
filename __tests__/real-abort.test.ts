import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const RUN_REAL = process.env.HARNESS_REAL_TESTS === '1';
const HAS_AUTH = !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!RUN_REAL || !HAS_AUTH)('real SIGINT abort', () => {
  it('SIGINT against running claude-code leaf → aborted status, clean exit', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'harness-abort-'));

    const child = spawn('npx', ['tsx', 'runner/index.ts', 'tasks/smoke-abort.ts'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HARNESS_NO_TTY: '1', HARNESS_RUNS_DIR: runsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait up to 15s for the spawn event to appear in events.jsonl (indicates leaf started)
    const startedAt = Date.now();
    let eventsPath = '';
    while (Date.now() - startedAt < 15_000) {
      const entries = await readdir(runsDir).catch(() => []);
      if (entries.length > 0) {
        const candidate = join(runsDir, entries[0], 'events.jsonl');
        if (existsSync(candidate)) {
          const content = await readFile(candidate, 'utf8');
          if (content.includes('"t":"spawn"')) { eventsPath = candidate; break; }
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!eventsPath) {
      child.kill('SIGKILL');
      throw new Error('leaf did not spawn within 15s');
    }

    // Give the SDK 3s to issue its first tool call, then send SIGINT
    await new Promise(r => setTimeout(r, 3_000));
    const sigintAt = Date.now();
    child.kill('SIGINT');

    // Wait for the subprocess to exit. Cap at 15s — SDK should die within ~3s of interrupt.
    const exitCode = await new Promise<number | null>(res => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); res(-1); } }, 15_000);
      child.on('exit', (code) => { if (done) return; done = true; clearTimeout(t); res(code); });
    });

    // Inspect manifest + events
    const runEntries = await readdir(runsDir);
    const runDir = join(runsDir, runEntries[0]);
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'));
    const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map(l => JSON.parse(l));

    // Assertions:
    // 1. Runner process exited within the budget
    expect(exitCode).not.toBe(-1);

    // 2. Leaf status is aborted (or error — both are acceptable "did not complete")
    expect(manifest.leaves).toHaveLength(1);
    expect(['aborted', 'error', 'timeout']).toContain(manifest.leaves[0].status);

    // 3. A done event was emitted for the leaf
    const doneEvents = events.filter((e: any) => e.t === 'done');
    expect(doneEvents).toHaveLength(1);
    expect(['aborted', 'error', 'timeout']).toContain(doneEvents[0].result.status);

    // Diagnostic: delta from SIGINT -> done
    const doneTs = doneEvents[0].ts as number;
    // eslint-disable-next-line no-console
    console.log(
      `[real-abort] status=${doneEvents[0].result.status} exitCode=${exitCode} ` +
      `sigint→done=${doneTs - sigintAt}ms leafExitCode=${doneEvents[0].result.exitCode}`,
    );

    // 4. No orphan SDK subprocess alive (give the OS 2s for kernel to finalize)
    await new Promise(r => setTimeout(r, 2_000));
    const orphans = await new Promise<string>(res => {
      const p = spawn('pgrep', ['-f', 'claude-agent-sdk/cli.js']);
      let out = ''; p.stdout.on('data', c => { out += c.toString(); });
      p.on('exit', () => res(out.trim()));
    });
    expect(orphans, `orphans: ${orphans}`).toBe('');
  }, 60_000);
});
