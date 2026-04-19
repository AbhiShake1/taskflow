import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBuild } from '../build';

describe('runBuild', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'taskflow-build-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('inlines file contents and emits per-item JSONs plus registry.json', async () => {
    mkdirSync(join(cwd, 'items'), { recursive: true });
    const source = '// tiny harness\nexport const x = 1;\n';
    writeFileSync(join(cwd, 'items/tiny.ts'), source, 'utf8');
    writeFileSync(
      join(cwd, 'registry.json'),
      JSON.stringify({
        name: '@test',
        homepage: 'https://example.test',
        items: [
          {
            name: 'tiny',
            type: 'taskflow:harness',
            files: [{ path: 'items/tiny.ts', type: 'taskflow:harness' }],
          },
        ],
      }),
      'utf8',
    );

    await runBuild({ cwd, silent: true });

    const itemPath = join(cwd, 'r/tiny.json');
    expect(existsSync(itemPath)).toBe(true);
    const item = JSON.parse(readFileSync(itemPath, 'utf8')) as {
      files: { content: string }[];
    };
    expect(item.files[0].content).toBe(source);

    expect(existsSync(join(cwd, 'r/registry.json'))).toBe(true);
  });
});
