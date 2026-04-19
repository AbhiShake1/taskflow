import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApply } from '../apply';
import { clearRegistryContext } from '../registry/context';
import { clearFetchCache } from '../registry/fetcher';

describe('runApply', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-apply-'));
    clearFetchCache();
    clearRegistryContext();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('re-installs a preset from a local file and overwrites any existing file', async () => {
    const itemPath = join(cwd, 'preset.json');
    writeFileSync(
      itemPath,
      JSON.stringify({
        $schema: 'https://taskflow.sh/schema/registry-item.json',
        name: 'preset-a',
        type: 'taskflow:harness',
        files: [
          {
            path: 'harness/preset-a.ts',
            type: 'taskflow:harness',
            content: '// v2\n',
          },
        ],
      }),
    );

    const dest = join(cwd, '.agents/taskflow/harness/preset-a.ts');
    await mkdir(join(cwd, '.agents/taskflow/harness'), { recursive: true });
    writeFileSync(dest, '// v1');

    await runApply({
      preset: itemPath,
      cwd,
      yes: true,
      silent: true,
      dryRun: false,
      skipAdapterCheck: true,
    });

    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('// v2\n');
  });
});
