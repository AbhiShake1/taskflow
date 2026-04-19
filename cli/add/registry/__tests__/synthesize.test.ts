import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoverHit } from '../discover';
import { synthesizeFromDiscoverHit, validateHarnessSource } from '../synthesize';

function makeHit(path: string): DiscoverHit {
  return {
    repo: 'alice/harnesses',
    branch: 'main',
    path,
    matchLines: [{ lineNo: 1, content: 'stub' }],
    url: `https://github.com/alice/harnesses/blob/main/${path}`,
    rawUrl: `https://raw.githubusercontent.com/alice/harnesses/main/${path}`,
  };
}

function stubFetch(body: string, status = 200): void {
  const impl = vi.fn(async () => {
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/plain' },
    });
  });
  vi.stubGlobal('fetch', impl);
}

describe('validateHarnessSource', () => {
  it('accepts a valid harness source', () => {
    const src = "import { taskflow } from '@taskflow-corp/cli';\nawait taskflow('x').run({});";
    expect(validateHarnessSource(src, 'tasks/x.ts')).toEqual({ ok: true });
  });

  it('recognizes legacy import names', () => {
    for (const pkg of ['taskflow-cli', 'taskflowjs', '@taskflow-corp/sdk']) {
      const src = `import { taskflow } from '${pkg}';\nawait taskflow('y').run({});`;
      expect(validateHarnessSource(src, 'y.ts')).toEqual({ ok: true });
    }
  });

  it('rejects config files', () => {
    const src = "import { defineConfig } from '@taskflow-corp/cli/config';\nexport default defineConfig({});";
    const result = validateHarnessSource(src, 'taskflow.config.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/defineConfig/);
  });

  it('rejects test files by path', () => {
    const src = "import { taskflow } from '@taskflow-corp/cli';\ntaskflow('x');";
    const result = validateHarnessSource(src, 'tasks/foo.test.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/test/);
  });

  it('rejects unrelated files with no taskflow import', () => {
    const src = "import fs from 'node:fs';\nconsole.log(fs);";
    const result = validateHarnessSource(src, 'misc/util.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/taskflow package/);
  });

  it('rejects files with the import but no taskflow(...) call', () => {
    const src = "import { taskflow } from '@taskflow-corp/cli';\nconst x = 1;";
    const result = validateHarnessSource(src, 'x.ts');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/taskflow\(/);
  });
});

describe('synthesizeFromDiscoverHit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds a RegistryItem for a valid harness', async () => {
    stubFetch(
      "import { taskflow } from '@taskflow-corp/cli';\nawait taskflow('ui-plan').run({});",
    );
    const result = await synthesizeFromDiscoverHit(makeHit('examples/ui-plan.ts'));
    if ('reject' in result) throw new Error(`expected success, got reject: ${result.reason}`);
    expect(result.item.name).toBe('ui-plan');
    expect(result.item.type).toBe('taskflow:harness');
    expect(result.item.description).toContain('alice/harnesses/examples/ui-plan.ts@main');
    expect(result.item.files).toHaveLength(1);
    expect(result.item.files?.[0]).toMatchObject({
      path: 'harness/ui-plan.ts',
      type: 'taskflow:harness',
    });
    expect(result.item.files?.[0].content).toContain("taskflow('ui-plan')");
    expect(result.sourceUrl).toBe(
      'https://raw.githubusercontent.com/alice/harnesses/main/examples/ui-plan.ts',
    );
  });

  it('rejects a taskflow config file', async () => {
    stubFetch(
      "import { defineConfig } from '@taskflow-corp/cli/config';\nexport default defineConfig({});",
    );
    const result = await synthesizeFromDiscoverHit(makeHit('taskflow.config.ts'));
    expect('reject' in result).toBe(true);
    if ('reject' in result) expect(result.reason).toMatch(/defineConfig/);
  });

  it('rejects a test file path', async () => {
    stubFetch(
      "import { taskflow } from '@taskflow-corp/cli';\ntaskflow('x');",
    );
    const result = await synthesizeFromDiscoverHit(makeHit('tasks/foo.test.ts'));
    expect('reject' in result).toBe(true);
    if ('reject' in result) expect(result.reason).toMatch(/test/);
  });

  it('rejects an unrelated .ts with no taskflow import', async () => {
    stubFetch("import fs from 'node:fs';\nconsole.log(fs);");
    const result = await synthesizeFromDiscoverHit(makeHit('util/helper.ts'));
    expect('reject' in result).toBe(true);
    if ('reject' in result) expect(result.reason).toMatch(/taskflow package/);
  });

  it('rejects when raw fetch returns 404', async () => {
    stubFetch('not found', 404);
    const result = await synthesizeFromDiscoverHit(makeHit('missing.ts'));
    expect('reject' in result).toBe(true);
    if ('reject' in result) expect(result.reason).toBe('raw file not found');
  });

  it('recognizes an @taskflow-corp/sdk import', async () => {
    stubFetch(
      "import { taskflow } from '@taskflow-corp/sdk';\nawait taskflow('sdk-harness').run({});",
    );
    const result = await synthesizeFromDiscoverHit(makeHit('sdk-harness.ts'));
    if ('reject' in result) throw new Error(`expected success, got reject: ${result.reason}`);
    expect(result.item.name).toBe('sdk-harness');
  });
});
