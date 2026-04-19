import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RegistryItem, TaskflowJson } from '../registry/schema';
import { writeRegistryItem } from '../writers/write-files';

const BASE_TASKFLOW_JSON: TaskflowJson = {
  version: '1',
  harnessDir: '.agents/taskflow/harness',
  rulesDir: '.agents/taskflow/rules',
};

function harnessItem(content: string): RegistryItem {
  return {
    name: 'ok',
    type: 'taskflow:harness',
    files: [{ path: 'harness/ok.ts', type: 'taskflow:harness', content }],
  };
}

describe('writeRegistryItem', () => {
  let cwd: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-writer-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('writes new harness file into <cwd>/<harnessDir>/<basename>', async () => {
    const item = harnessItem('// v1');
    const result = await writeRegistryItem(item, BASE_TASKFLOW_JSON, {
      cwd,
      overwrite: false,
      yes: false,
      silent: true,
      dryRun: false,
    });
    const expected = join(cwd, '.agents/taskflow/harness/ok.ts');
    expect(result.written).toContain(expected);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, 'utf8')).toBe('// v1');
  });

  it('merges .env.local (appends missing, preserves existing keys)', async () => {
    const envPath = join(cwd, '.env.local');
    writeFileSync(envPath, 'EXISTING=old\nKEEP=yes\n');
    const item: RegistryItem = {
      name: 'envy',
      type: 'taskflow:harness',
      files: [
        {
          path: '.env.local',
          type: 'taskflow:file',
          target: '.env.local',
          content: 'EXISTING=new\nNEW=added\n',
        },
      ],
    };
    await writeRegistryItem(item, BASE_TASKFLOW_JSON, {
      cwd,
      overwrite: false,
      yes: false,
      silent: true,
      dryRun: false,
    });
    const merged = readFileSync(envPath, 'utf8');
    expect(merged).toContain('EXISTING=old');
    expect(merged).toContain('KEEP=yes');
    expect(merged).toContain('NEW=added');
    // EXISTING is not overwritten
    expect(merged).not.toContain('EXISTING=new');
  });

  it('returns skipped when existing file has identical content', async () => {
    const dest = join(cwd, '.agents/taskflow/harness/ok.ts');
    await mkdir(join(cwd, '.agents/taskflow/harness'), { recursive: true });
    writeFileSync(dest, '// same');
    const result = await writeRegistryItem(
      harnessItem('// same'),
      BASE_TASKFLOW_JSON,
      { cwd, overwrite: false, yes: false, silent: true, dryRun: false },
    );
    expect(result.skipped).toContain(dest);
    expect(result.overwritten).toHaveLength(0);
  });

  it('overwrites when different content + overwrite=true', async () => {
    const dest = join(cwd, '.agents/taskflow/harness/ok.ts');
    await mkdir(join(cwd, '.agents/taskflow/harness'), { recursive: true });
    writeFileSync(dest, '// old');
    const result = await writeRegistryItem(
      harnessItem('// new'),
      BASE_TASKFLOW_JSON,
      { cwd, overwrite: true, yes: false, silent: true, dryRun: false },
    );
    expect(result.overwritten).toContain(dest);
    expect(readFileSync(dest, 'utf8')).toBe('// new');
  });

  it('does NOT auto-overwrite when only yes=true (only overwrite=true does)', async () => {
    const dest = join(cwd, '.agents/taskflow/harness/ok.ts');
    await mkdir(join(cwd, '.agents/taskflow/harness'), { recursive: true });
    writeFileSync(dest, '// old');
    const result = await writeRegistryItem(
      harnessItem('// new'),
      BASE_TASKFLOW_JSON,
      { cwd, overwrite: false, yes: true, silent: true, dryRun: false },
    );
    expect(result.skipped).toContain(dest);
    expect(result.overwritten).toHaveLength(0);
    expect(readFileSync(dest, 'utf8')).toBe('// old');
  });

  it('dryRun=true writes nothing to disk', async () => {
    const item = harnessItem('// v1');
    const result = await writeRegistryItem(item, BASE_TASKFLOW_JSON, {
      cwd,
      overwrite: false,
      yes: false,
      silent: true,
      dryRun: true,
    });
    const expected = join(cwd, '.agents/taskflow/harness/ok.ts');
    expect(result.written).toContain(expected);
    expect(existsSync(expected)).toBe(false);
  });

  it('taskflow:file respects target path, including ~/ expansion', async () => {
    // Sandbox HOME so ~/ expansion lands inside the tmp cwd.
    process.env.HOME = cwd;
    const item: RegistryItem = {
      name: 'escape',
      type: 'taskflow:harness',
      files: [
        {
          path: 'anywhere.txt',
          type: 'taskflow:file',
          target: '~/nested/anywhere.txt',
          content: 'hi',
        },
      ],
    };
    await writeRegistryItem(item, BASE_TASKFLOW_JSON, {
      cwd,
      overwrite: false,
      yes: false,
      silent: true,
      dryRun: false,
    });
    const expected = join(cwd, 'nested/anywhere.txt');
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, 'utf8')).toBe('hi');
  });
});
