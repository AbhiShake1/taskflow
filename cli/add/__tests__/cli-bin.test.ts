import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = join(repoRoot, 'dist/cli/index.js');

function runBin(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('cli bin (compiled dist)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-cli-bin-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('prints help without crashing', () => {
    if (!existsSync(bin)) {
      // Build hasn't been run in this environment; skip.
      return;
    }
    const out = runBin(['--help'], cwd);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Usage:');
    expect(out.stdout).toContain('add');
    expect(out.stdout).toContain('init');
    expect(out.stdout).toContain('build');
  });

  it('add <local-file> installs the harness through the full pipeline', () => {
    if (!existsSync(bin)) return;

    const itemPath = join(cwd, 'item.json');
    writeFileSync(
      itemPath,
      JSON.stringify({
        $schema: 'https://taskflow.sh/schema/registry-item.json',
        name: 'hello',
        type: 'taskflow:harness',
        files: [
          {
            path: 'harness/hello.ts',
            type: 'taskflow:harness',
            content: "export const hello = () => 'hello';\n",
          },
        ],
      }),
    );

    const out = runBin(
      ['add', './item.json', '--yes', '--silent', '--skip-adapter-check'],
      cwd,
    );
    expect(out.status).toBe(0);

    expect(existsSync(join(cwd, 'taskflow.json'))).toBe(true);
    expect(existsSync(join(cwd, '.agents/taskflow/harness/hello.ts'))).toBe(true);
    expect(readFileSync(join(cwd, '.agents/taskflow/harness/hello.ts'), 'utf8')).toContain(
      'export const hello',
    );
    const lock = JSON.parse(readFileSync(join(cwd, 'taskflow.lock'), 'utf8'));
    expect(lock.items.hello.type).toBe('taskflow:harness');
  });

  it('add <multiple sources> parses all as array (variadic guard)', () => {
    if (!existsSync(bin)) return;

    const item1 = join(cwd, 'a.json');
    const item2 = join(cwd, 'b.json');
    writeFileSync(
      item1,
      JSON.stringify({
        $schema: 'https://taskflow.sh/schema/registry-item.json',
        name: 'a',
        type: 'taskflow:harness',
        files: [{ path: 'harness/a.ts', type: 'taskflow:harness', content: '// a\n' }],
      }),
    );
    writeFileSync(
      item2,
      JSON.stringify({
        $schema: 'https://taskflow.sh/schema/registry-item.json',
        name: 'b',
        type: 'taskflow:harness',
        files: [{ path: 'harness/b.ts', type: 'taskflow:harness', content: '// b\n' }],
      }),
    );

    const out = runBin(
      ['add', './a.json', './b.json', '--yes', '--silent', '--skip-adapter-check'],
      cwd,
    );
    expect(out.status).toBe(0);
    expect(existsSync(join(cwd, '.agents/taskflow/harness/a.ts'))).toBe(true);
    expect(existsSync(join(cwd, '.agents/taskflow/harness/b.ts'))).toBe(true);
  });

  it('add --view prints resolved item JSON without writing files', () => {
    if (!existsSync(bin)) return;

    const itemPath = join(cwd, 'item.json');
    writeFileSync(
      itemPath,
      JSON.stringify({
        $schema: 'https://taskflow.sh/schema/registry-item.json',
        name: 'v',
        type: 'taskflow:harness',
        files: [{ path: 'harness/v.ts', type: 'taskflow:harness', content: '// v\n' }],
      }),
    );

    const out = runBin(
      ['add', './item.json', '--yes', '--silent', '--skip-adapter-check', '--view'],
      cwd,
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('"name": "v"');
    expect(existsSync(join(cwd, '.agents/taskflow/harness/v.ts'))).toBe(false);
  });

  it('init scaffolds taskflow.json and .agents/taskflow/config.ts', () => {
    if (!existsSync(bin)) return;

    const out = runBin(['init', '--yes', '--silent'], cwd);
    expect(out.status).toBe(0);
    expect(existsSync(join(cwd, 'taskflow.json'))).toBe(true);
    expect(existsSync(join(cwd, '.agents/taskflow/config.ts'))).toBe(true);
  });
});
