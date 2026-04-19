import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFiles } from '../env-loader';

describe('loadEnvFiles', () => {
  let cwd: string;
  const preserve: Record<string, string | undefined> = {};
  const trackedKeys = [
    'TASKFLOW_ENVLOAD_A',
    'TASKFLOW_ENVLOAD_B',
    'TASKFLOW_ENVLOAD_C',
    'TASKFLOW_ENVLOAD_QUOTED',
    'TASKFLOW_ENVLOAD_PREEXISTING',
  ];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-envload-'));
    for (const k of trackedKeys) {
      preserve[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    for (const k of trackedKeys) {
      if (preserve[k] === undefined) delete process.env[k];
      else process.env[k] = preserve[k];
    }
  });

  it('loads .env into process.env', () => {
    writeFileSync(join(cwd, '.env'), 'TASKFLOW_ENVLOAD_A=from-env\n');
    loadEnvFiles(cwd);
    expect(process.env.TASKFLOW_ENVLOAD_A).toBe('from-env');
  });

  it('.env.local overrides .env because it loads later (and .env did not pre-set the key)', () => {
    writeFileSync(join(cwd, '.env'), 'TASKFLOW_ENVLOAD_A=from-env\n');
    writeFileSync(join(cwd, '.env.local'), 'TASKFLOW_ENVLOAD_B=from-local\n');
    loadEnvFiles(cwd);
    expect(process.env.TASKFLOW_ENVLOAD_A).toBe('from-env');
    expect(process.env.TASKFLOW_ENVLOAD_B).toBe('from-local');
  });

  it('does not overwrite already-set process.env entries', () => {
    process.env.TASKFLOW_ENVLOAD_PREEXISTING = 'shell-wins';
    writeFileSync(join(cwd, '.env'), 'TASKFLOW_ENVLOAD_PREEXISTING=file-should-lose\n');
    loadEnvFiles(cwd);
    expect(process.env.TASKFLOW_ENVLOAD_PREEXISTING).toBe('shell-wins');
  });

  it('handles quoted values, comments, and blank lines', () => {
    writeFileSync(
      join(cwd, '.env'),
      [
        '# a comment',
        '',
        'TASKFLOW_ENVLOAD_QUOTED="hello world"',
        "TASKFLOW_ENVLOAD_C='single quoted'",
        '   ',
        'TASKFLOW_ENVLOAD_A=plain',
        '',
      ].join('\n'),
    );
    loadEnvFiles(cwd);
    expect(process.env.TASKFLOW_ENVLOAD_QUOTED).toBe('hello world');
    expect(process.env.TASKFLOW_ENVLOAD_C).toBe('single quoted');
    expect(process.env.TASKFLOW_ENVLOAD_A).toBe('plain');
  });

  it('is a no-op when neither file exists', () => {
    expect(() => loadEnvFiles(cwd)).not.toThrow();
  });
});
