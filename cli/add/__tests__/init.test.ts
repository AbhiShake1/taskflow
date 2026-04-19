import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../init';

describe('runInit', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-init-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('creates taskflow.json, config.ts, and harness/rules dirs in a fresh cwd', async () => {
    const result = await runInit({ cwd, yes: true, silent: true });
    expect(existsSync(result.taskflowJsonPath)).toBe(true);
    expect(existsSync(result.configTsPath)).toBe(true);
    expect(existsSync(join(cwd, '.agents/taskflow/harness'))).toBe(true);
    expect(existsSync(join(cwd, '.agents/taskflow/rules'))).toBe(true);

    const json = JSON.parse(readFileSync(result.taskflowJsonPath, 'utf8'));
    expect(json.version).toBe('1');
    expect(json.harnessDir).toBe('.agents/taskflow/harness');
    expect(json.rulesDir).toBe('.agents/taskflow/rules');
  });

  it('is idempotent: a second run does not overwrite existing files', async () => {
    await runInit({ cwd, yes: true, silent: true });
    const jsonBefore = readFileSync(join(cwd, 'taskflow.json'), 'utf8');
    const configBefore = readFileSync(
      join(cwd, '.agents/taskflow/config.ts'),
      'utf8',
    );
    // Mutate files to prove second run leaves them alone.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(cwd, 'taskflow.json'), '{"version":"1","items":"custom"}\n');
    writeFileSync(
      join(cwd, '.agents/taskflow/config.ts'),
      '// user edits preserved\n',
    );
    const result = await runInit({ cwd, yes: true, silent: true });
    // Second run should report no newly created paths (all existed).
    expect(result.created).toEqual([]);
    expect(readFileSync(join(cwd, 'taskflow.json'), 'utf8')).toContain(
      '"items":"custom"',
    );
    expect(readFileSync(join(cwd, '.agents/taskflow/config.ts'), 'utf8')).toBe(
      '// user edits preserved\n',
    );
    void jsonBefore;
    void configBefore;
  });
});
