import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConfigPatch } from '../writers/patch-config';

function setup(contents: string): { cwd: string; configPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'taskflow-patch-cfg-'));
  const configDir = join(cwd, '.agents/taskflow');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'config.ts');
  writeFileSync(configPath, contents, 'utf8');
  return { cwd, configPath };
}

describe('applyConfigPatch (ts-morph)', () => {
  let dirs: string[] = [];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function mk(contents: string): { cwd: string; configPath: string } {
    const s = setup(contents);
    dirs.push(s.cwd);
    return s;
  }

  it('adds scope to an empty defineConfig object', async () => {
    const { cwd, configPath } = mk(`export default defineConfig({});\n`);
    await applyConfigPatch({ scope: 'no new files' }, { cwd, dryRun: false, silent: true });
    const out = readFileSync(configPath, 'utf8');
    expect(out).toMatch(/scope:\s*["']no new files["']/);
  });

  it('replaces an existing scope value', async () => {
    const { cwd, configPath } = mk(`export default defineConfig({ scope: 'old' });\n`);
    await applyConfigPatch({ scope: 'new' }, { cwd, dryRun: false, silent: true });
    const out = readFileSync(configPath, 'utf8');
    expect(out).toMatch(/scope:\s*["']new["']/);
    expect(out).not.toMatch(/['"]old['"]/);
  });

  it('appends plugin identifiers into an existing plugins array', async () => {
    const { cwd, configPath } = mk(`export default defineConfig({ plugins: [A] });\n`);
    await applyConfigPatch({ plugins: ['B'] }, { cwd, dryRun: false, silent: true });
    const out = readFileSync(configPath, 'utf8');
    expect(out).toMatch(/\bA\b/);
    expect(out).toMatch(/\bB\b/);
  });

  it('does not duplicate an already-present plugin identifier', async () => {
    const { cwd, configPath } = mk(`export default defineConfig({ plugins: [A, B] });\n`);
    await applyConfigPatch({ plugins: ['B'] }, { cwd, dryRun: false, silent: true });
    const out = readFileSync(configPath, 'utf8');
    expect(out.match(/\bB\b/g)?.length).toBe(1);
  });

  it('creates a plugins prop when missing', async () => {
    const { cwd, configPath } = mk(`export default defineConfig({});\n`);
    await applyConfigPatch({ plugins: ['Foo'] }, { cwd, dryRun: false, silent: true });
    const out = readFileSync(configPath, 'utf8');
    expect(out).toMatch(/plugins:\s*\[\s*Foo\s*\]/);
  });

  it('handles plain export default object literal (no defineConfig wrapper)', async () => {
    const { cwd, configPath } = mk(`export default { scope: 'a' };\n`);
    await applyConfigPatch({ scope: 'b' }, { cwd, dryRun: false, silent: true });
    const out = readFileSync(configPath, 'utf8');
    expect(out).toMatch(/scope:\s*["']b["']/);
  });

  it('is a silent no-op when the config file is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'taskflow-patch-cfg-missing-'));
    dirs.push(cwd);
    await expect(
      applyConfigPatch({ scope: 'x' }, { cwd, dryRun: false, silent: true }),
    ).resolves.toBeUndefined();
    expect(existsSync(join(cwd, '.agents/taskflow/config.ts'))).toBe(false);
  });

  it('dryRun does not write to disk', async () => {
    const { cwd, configPath } = mk(`export default defineConfig({});\n`);
    const before = readFileSync(configPath, 'utf8');
    await applyConfigPatch({ scope: 'x' }, { cwd, dryRun: true, silent: true });
    const after = readFileSync(configPath, 'utf8');
    expect(after).toBe(before);
  });
});
