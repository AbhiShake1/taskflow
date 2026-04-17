import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(__dirname, '..');

describe('e2e pipeline via mock adapter', () => {
  let runsDir: string;
  let runId: string;
  let manifestPath: string;
  let eventsPath: string;

  beforeAll(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'harness-e2e-'));
    await new Promise<void>((res, rej) => {
      const p = spawn(
        'npx',
        ['tsx', 'runner/index.ts', 'tasks/pipeline.ts'],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            HARNESS_ADAPTER_OVERRIDE: 'mock',
            HARNESS_NO_TTY: '1',
            HARNESS_RUNS_DIR: runsDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      p.stderr.on('data', (c) => {
        stderr += c.toString();
      });
      p.on('error', rej);
      p.on('exit', (code) =>
        code === 0 ? res() : rej(new Error(`runner exited ${code}: ${stderr}`)),
      );
    });

    // Pick the single run dir created
    const entries = readdirSync(runsDir);
    expect(entries.length).toBe(1);
    runId = entries[0];
    manifestPath = join(runsDir, runId, 'manifest.json');
    eventsPath = join(runsDir, runId, 'events.jsonl');
  }, 30_000);

  it('writes manifest.json with exitCode 0', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.exitCode).toBe(0);
    expect(manifest.name).toBe('pipeline');
    expect(manifest.leaves).toHaveLength(5);
    for (const l of manifest.leaves) expect(l.status).toBe('done');
  });

  it('writes events.jsonl with all 5 spawn + 5 done events', async () => {
    const lines = (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    expect(events.filter((e: { t: string }) => e.t === 'spawn')).toHaveLength(5);
    expect(events.filter((e: { t: string }) => e.t === 'done')).toHaveLength(5);
    // pipeline has 3 phases: discover, compute, aggregate.
    expect(events.filter((e: { t: string }) => e.t === 'stage-enter').length).toBeGreaterThanOrEqual(3);
  });

  it('writes proof.json for each leaf', async () => {
    const leafIds = [
      'emit-nums',
      'square-0',
      'square-1',
      'square-2',
      'sum-all',
    ];
    for (const id of leafIds) {
      const p = join(runsDir, runId, 'leaves', id, 'proof.json');
      expect(existsSync(p)).toBe(true);
      const proof = JSON.parse(await readFile(p, 'utf8'));
      expect(proof.result.status).toBe('done');
    }
  });

  it('compute squares ran in parallel (start windows overlap)', async () => {
    const lines = (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    const spawns = events.filter(
      (e: { t: string; leafId?: string }) =>
        e.t === 'spawn' && typeof e.leafId === 'string' && e.leafId.startsWith('square-'),
    );
    expect(spawns).toHaveLength(3);
    const times = spawns.map((e: { ts: number }) => e.ts).sort((a: number, b: number) => a - b);
    // mock adapter: all 3 spawn within a tight window
    expect(times[2] - times[0]).toBeLessThan(50);
  });
});
