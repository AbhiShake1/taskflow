import { describe, it, expect } from 'vitest';
import { spawn as ptySpawn } from 'node-pty';
import { readFile, mkdtemp, readdir, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '..');

// node-pty uses posix_spawnp and can't always resolve commands from PATH
// the way plain child_process can. Pin node directly + run the local tsx
// binary by absolute path to sidestep "posix_spawnp failed".
const NODE_BIN = process.execPath;
const TSX_BIN = execSync('node -p "require.resolve(\'tsx/cli\')"', {
  cwd: REPO_ROOT,
})
  .toString()
  .trim();

// npm sometimes extracts node-pty prebuilds without the exec bit on
// spawn-helper, which makes every ptySpawn() fail with "posix_spawnp failed".
// Self-heal before any test runs.
async function ensureSpawnHelperExecutable(): Promise<void> {
  try {
    const nodePtyPkg = execSync('node -p "require.resolve(\'node-pty\')"', {
      cwd: REPO_ROOT,
    })
      .toString()
      .trim();
    const root = dirname(dirname(nodePtyPkg)); // .../node-pty
    const arch = `${process.platform}-${process.arch}`;
    const helper = join(root, 'prebuilds', arch, 'spawn-helper');
    const s = await stat(helper).catch(() => undefined);
    if (!s) return;
    // Set u+rwx, g+rx, o+rx (0755) if not already executable for owner.
    if ((s.mode & 0o100) === 0) await chmod(helper, 0o755);
  } catch {
    /* best-effort; if this fails, the test itself will surface it */
  }
}
await ensureSpawnHelperExecutable();
const RUN_REAL = process.env.HARNESS_REAL_TESTS === '1';
const HAS_AUTH =
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY;
const SKIP = !RUN_REAL || !HAS_AUTH;

const stripAnsi = (s: string): string =>
  s
    // CSI sequences
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '')
    // OSC sequences terminated by BEL
    .replace(/\u001B\][^\u0007]*\u0007/g, '');

describe.skipIf(SKIP)('real TUI + claude-code via pty', () => {
  it('TUI renders tree view with running leaves and exits clean', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'harness-tui-'));

    const pty = ptySpawn(
      NODE_BIN,
      [TSX_BIN, 'runner/index.ts', 'tasks/smoke-claude.ts'],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HARNESS_RUNS_DIR: runsDir,
          FORCE_COLOR: '0',
        },
      },
    );

    let allOutput = '';
    pty.onData((data) => {
      allOutput += data;
    });

    // Wait for runner exit, hard cap at 90s (2 leaves, typical 15-30s each).
    const exitCode = await new Promise<number>((res, rej) => {
      const t = setTimeout(() => {
        try {
          pty.kill();
        } catch {
          /* ignore */
        }
        rej(new Error('timeout waiting for runner exit'));
      }, 90_000);
      pty.onExit(({ exitCode }) => {
        clearTimeout(t);
        res(exitCode);
      });
    });

    const visibleOutput = stripAnsi(allOutput);

    expect(exitCode).toBe(0);
    // TUI rendered the stage node + its leaves by name
    expect(visibleOutput).toContain('smoke');
    expect(visibleOutput).toContain('write-hello');
    expect(visibleOutput).toContain('verify-hello');
    // TUI key-help footer present — proves the App component mounted (vs. raw JSON)
    expect(visibleOutput).toContain('abort-leaf');
    // At least one leaf reached the done glyph
    expect(visibleOutput).toContain('\u2713'); // ✓

    // Manifest written + exit 0
    const [runId] = await readdir(runsDir);
    const manifest = JSON.parse(
      await readFile(join(runsDir, runId, 'manifest.json'), 'utf8'),
    );
    expect(manifest.exitCode).toBe(0);
    expect(manifest.leaves).toHaveLength(2);
    for (const l of manifest.leaves) expect(l.status).toBe('done');
  }, 120_000);

  it('pressing "a" on a running leaf aborts it via TUI', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'harness-tui-abort-'));
    const pty = ptySpawn(
      NODE_BIN,
      [TSX_BIN, 'runner/index.ts', 'tasks/smoke-abort.ts'],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HARNESS_RUNS_DIR: runsDir,
          FORCE_COLOR: '0',
        },
      },
    );

    let buf = '';
    pty.onData((d) => {
      buf += d;
    });

    // Wait until the TUI shows the leaf name (proof it has started) — poll up to 20s
    const start = Date.now();
    while (
      Date.now() - start < 20_000 &&
      !stripAnsi(buf).includes('slow-loop')
    ) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!stripAnsi(buf).includes('slow-loop')) {
      try {
        pty.kill();
      } catch {
        /* ignore */
      }
      throw new Error('TUI did not show slow-loop leaf within 20s');
    }

    // Give the SDK ~3s to issue its first tool call so we're clearly
    // aborting an in-flight leaf (not a no-op before any work).
    await new Promise((r) => setTimeout(r, 3_000));

    // Initial selection is the stage (selectedIdx=0). Press down-arrow
    // to move onto the leaf so 'a' will target the leaf.
    pty.write('\u001B[B');
    await new Promise((r) => setTimeout(r, 150));
    pty.write('a');

    const abortSentAt = Date.now();
    const exit = await new Promise<number>((res, rej) => {
      const t = setTimeout(() => {
        try {
          pty.kill();
        } catch {
          /* ignore */
        }
        rej(new Error('abort timeout — pty did not exit within 30s'));
      }, 30_000);
      pty.onExit(({ exitCode }) => {
        clearTimeout(t);
        res(exitCode);
      });
    });

    // Runner should NOT report clean success after a user abort.
    expect(exit).not.toBe(0);

    const [runId] = await readdir(runsDir);
    const manifest = JSON.parse(
      await readFile(join(runsDir, runId, 'manifest.json'), 'utf8'),
    );
    expect(manifest.leaves).toHaveLength(1);
    expect(['aborted', 'error', 'timeout']).toContain(
      manifest.leaves[0].status,
    );

    // eslint-disable-next-line no-console
    console.log(
      `[real-tui-abort] status=${manifest.leaves[0].status} exitCode=${exit} ` +
        `abort→exit=${Date.now() - abortSentAt}ms`,
    );
  }, 90_000);
});
