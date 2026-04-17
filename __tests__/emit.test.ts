import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SpecSchema } from '../factory/schema';
import { emit } from '../factory/emit';

const FIXTURE_DIR = join(__dirname, 'fixtures');

const fixtures = [
  'single-leaf',
  'parallel-expand',
  'foreach',
  'repeat',
  'nested',
] as const;

describe('emit() — golden fixtures', () => {
  for (const name of fixtures) {
    it(`${name}.spec.yml -> ${name}.ts byte-matches golden`, () => {
      const specPath = join(FIXTURE_DIR, `${name}.spec.yml`);
      const goldenPath = join(FIXTURE_DIR, `${name}.ts`);
      const specYaml = readFileSync(specPath, 'utf8');
      const spec = SpecSchema.parse(parseYaml(specYaml));
      const actual = emit(spec, `${name}.spec.yml`);
      const expected = readFileSync(goldenPath, 'utf8');
      expect(actual).toBe(expected);
    });
  }
});

describe('emit() — acceptance: parallel-expand produces plan-canonical shape', () => {
  it('parallel-expand: fetch stage matches the 3-shard acceptance example', () => {
    const specPath = join(FIXTURE_DIR, 'parallel-expand.spec.yml');
    const spec = SpecSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
    const out = emit(spec, 'parallel-expand.spec.yml');
    // Acceptance snippet: the `parallel(h, [...])` block must unroll expand
    // count=3 into 3 thunks with template vars substituted.
    const expectedSnippet = [
      `    await stage(h, 'fetch', async () => {`,
      `      await parallel(h, [`,
      `        () => leaf(h, { id: 'shard-0', agent: 'opencode', model: 'groq/llama-3.3-70b', task: 'Fetch shard 0 of URLs.', claims: ['data/scraped/don/2026-04-17/shard-0/**'] }),`,
      `        () => leaf(h, { id: 'shard-1', agent: 'opencode', model: 'groq/llama-3.3-70b', task: 'Fetch shard 1 of URLs.', claims: ['data/scraped/don/2026-04-17/shard-1/**'] }),`,
      `        () => leaf(h, { id: 'shard-2', agent: 'opencode', model: 'groq/llama-3.3-70b', task: 'Fetch shard 2 of URLs.', claims: ['data/scraped/don/2026-04-17/shard-2/**'] }),`,
      `      ]);`,
      `    });`,
    ].join('\n');
    expect(out).toContain(expectedSnippet);
  });
});

describe('emit() — template interpolation', () => {
  it('substitutes {i} inside expand-scoped stage steps', () => {
    const spec = SpecSchema.parse({
      name: 'interp',
      root: {
        stage: 'root',
        steps: [
          {
            stage: 'fan',
            expand: { count: 2, as: 'i' },
            steps: [
              { leaf: 'x-{i}', agent: 'pi', task: 't-{i}' },
            ],
          },
        ],
      },
    });
    const out = emit(spec, 'interp.spec.yml');
    expect(out).toContain(`{ id: 'x-0', agent: 'pi', task: 't-0' }`);
    expect(out).toContain(`{ id: 'x-1', agent: 'pi', task: 't-1' }`);
  });

  it('inherits outer expand scope into nested stage/leaf', () => {
    const spec = SpecSchema.parse({
      name: 'inherit',
      root: {
        stage: 'root',
        steps: [
          {
            stage: 'outer',
            expand: { count: 2, as: 'i' },
            steps: [
              {
                stage: 'inner-{i}',
                steps: [
                  { leaf: 'w-{i}', agent: 'pi', task: 't-{i}' },
                ],
              },
            ],
          },
        ],
      },
    });
    const out = emit(spec, 'inherit.spec.yml');
    expect(out).toContain(`await stage(h, 'inner-0', async () => {`);
    expect(out).toContain(`await stage(h, 'inner-1', async () => {`);
    expect(out).toContain(`{ id: 'w-0', agent: 'pi', task: 't-0' }`);
    expect(out).toContain(`{ id: 'w-1', agent: 'pi', task: 't-1' }`);
  });

  it('foreach binds items (strings) into scope', () => {
    const spec = SpecSchema.parse({
      name: 'fe',
      root: {
        stage: 'root',
        steps: [
          {
            stage: 's',
            foreach: { items: ['alpha', 'beta'], as: 'name' },
            steps: [
              { leaf: 'g-{name}', agent: 'pi', task: 'hi {name}' },
            ],
          },
        ],
      },
    });
    const out = emit(spec, 'fe.spec.yml');
    expect(out).toContain(`{ id: 'g-alpha', agent: 'pi', task: 'hi alpha' }`);
    expect(out).toContain(`{ id: 'g-beta', agent: 'pi', task: 'hi beta' }`);
  });
});

describe('emit() — initial scope', () => {
  it('substitutes {cwd} from an explicit initialScope into task strings', () => {
    // The `cwd` template var is populated from an externally-supplied initial
    // scope (cli.ts fills it with process.cwd() at build time). Specs that
    // need absolute paths — e.g. for sandboxed SDKs that remap relative cwds —
    // can reference `{cwd}/data/...` and get a literal absolute path in the
    // emitted TS.
    const spec = SpecSchema.parse({
      name: 'cwd-interp',
      root: {
        stage: 'root',
        steps: [
          {
            leaf: 'w',
            agent: 'claude-code',
            task: 'write to {cwd}/data/smoke/hello.txt',
            claims: ['{cwd}/data/smoke/hello.txt'],
          },
        ],
      },
    });
    const out = emit(spec, 'cwd-interp.spec.yml', { cwd: '/fake/repo' });
    expect(out).toContain(`task: 'write to /fake/repo/data/smoke/hello.txt'`);
    expect(out).toContain(`claims: ['/fake/repo/data/smoke/hello.txt']`);
  });

  it('initialScope does not shadow loop vars (inner scope wins)', () => {
    const spec = SpecSchema.parse({
      name: 'shadow',
      root: {
        stage: 'root',
        steps: [
          {
            stage: 'fan',
            expand: { count: 2, as: 'cwd' },
            steps: [{ leaf: 'l-{cwd}', agent: 'pi', task: 't-{cwd}' }],
          },
        ],
      },
    });
    // Inner `expand.as: cwd` rebinds the var; the initial scope value is
    // overwritten within the expand-bound range. Using the same key
    // intentionally to document precedence.
    const out = emit(spec, 'shadow.spec.yml', { cwd: '/outer' });
    expect(out).toContain(`{ id: 'l-0', agent: 'pi', task: 't-0' }`);
    expect(out).toContain(`{ id: 'l-1', agent: 'pi', task: 't-1' }`);
  });

  it('omitting initialScope leaves {cwd} undefined (error)', () => {
    // Golden fixtures must remain byte-stable; callers that omit the scope
    // get the pre-feature behavior. Using {cwd} without supplying it throws.
    const spec = SpecSchema.parse({
      name: 'no-scope',
      root: {
        stage: 'root',
        steps: [
          { leaf: 'x', agent: 'pi', task: '{cwd}/y' },
        ],
      },
    });
    expect(() => emit(spec, 'no-scope.spec.yml')).toThrow(
      /unknown template var "cwd"/,
    );
  });
});

describe('emit() — negative: unknown template var', () => {
  it('throws on {missing} with no enclosing scope', () => {
    const spec = SpecSchema.parse({
      name: 'broken',
      root: {
        stage: 'root',
        steps: [
          { leaf: 'x', agent: 'pi', task: 'shard-{missing}' },
        ],
      },
    });
    expect(() => emit(spec, 'broken.spec.yml')).toThrow(
      /unknown template var "missing"/,
    );
  });

  it('does NOT leak sibling scope across stages', () => {
    // `j` is bound in the first stage's expand; the second stage should NOT
    // see it.
    const spec = SpecSchema.parse({
      name: 'scope',
      root: {
        stage: 'root',
        steps: [
          {
            stage: 'a',
            expand: { count: 1, as: 'j' },
            steps: [{ leaf: 'ok-{j}', agent: 'pi', task: 't' }],
          },
          {
            stage: 'b',
            steps: [{ leaf: 'bad-{j}', agent: 'pi', task: 't' }],
          },
        ],
      },
    });
    expect(() => emit(spec, 'scope.spec.yml')).toThrow(
      /unknown template var "j"/,
    );
  });
});

describe('emit() — escaping', () => {
  it('single-quotes strings and escapes embedded apostrophes', () => {
    const spec = SpecSchema.parse({
      name: 'esc',
      root: {
        stage: 'root',
        steps: [
          { leaf: 'x', agent: 'pi', task: "it's fine" },
        ],
      },
    });
    const out = emit(spec, 'esc.spec.yml');
    expect(out).toContain(`task: 'it\\'s fine'`);
  });

  it('escapes newlines as \\n', () => {
    const spec = SpecSchema.parse({
      name: 'nl',
      root: {
        stage: 'root',
        steps: [
          { leaf: 'x', agent: 'pi', task: 'line1\nline2' },
        ],
      },
    });
    const out = emit(spec, 'nl.spec.yml');
    expect(out).toContain(`task: 'line1\\nline2'`);
  });
});

describe('emit() — determinism', () => {
  it('same input -> byte-identical output across invocations', () => {
    const specPath = join(FIXTURE_DIR, 'nested.spec.yml');
    const spec = SpecSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
    const a = emit(spec, 'x.spec.yml');
    const b = emit(spec, 'x.spec.yml');
    expect(a).toBe(b);
  });
});
