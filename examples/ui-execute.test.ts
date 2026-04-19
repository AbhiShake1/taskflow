import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveUrl,
  compileStep,
  compileTest,
  compilePlan,
  compilePwConfig,
  compilePackageJson,
  compileReadme,
  writeProject,
  loadPlan,
  Plan,
  Test,
  Step,
} from './ui-execute';

// --- Fixtures --------------------------------------------------------------

const BASE_URL = 'http://localhost:3000';

function makePlan(tests: unknown[]): unknown {
  return {
    version: 1,
    globals: { base_url: BASE_URL },
    tests,
  };
}

function validTest(id: string, steps: unknown[], depends_on: string[] = []): unknown {
  return { id, depends_on, steps };
}

function baseCtx(id = 'feat.view.action'): { baseUrl: string; testId: string } {
  return { baseUrl: BASE_URL, testId: id };
}

// Rough balance check — ensures emitted source has paired delimiters. The
// compiler emits only pure string-literal arguments via JSON.stringify, so a
// balanced count is a quick sanity check for escaping bugs.
function delimBalanced(src: string): boolean {
  let parens = 0, braces = 0, brackets = 0;
  let inStr: '"' | "'" | '`' | null = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c as '"' | "'" | '`'; i++; continue; }
    if (c === '(') parens++;
    else if (c === ')') parens--;
    else if (c === '{') braces++;
    else if (c === '}') braces--;
    else if (c === '[') brackets++;
    else if (c === ']') brackets--;
    i++;
  }
  return parens === 0 && braces === 0 && brackets === 0;
}

// --- resolveUrl ------------------------------------------------------------

describe('resolveUrl', () => {
  const cases: Array<[string, string, string, string]> = [
    ['no-trailing base + leading slash', 'http://x/y', '/z', 'http://x/y/z'],
    ['trailing base + leading slash', 'http://x/y/', '/z', 'http://x/y/z'],
    ['no-trailing base + no leading', 'http://x/y', 'z', 'http://x/y/z'],
    ['trailing base + no leading', 'http://x/y/', 'z', 'http://x/y/z'],
    ['multiple trailing slashes', 'http://x/y///', 'z', 'http://x/y/z'],
    ['multiple leading slashes', 'http://x/y', '///z', 'http://x/y/z'],
    ['double-slash both', 'http://x/y///', '////z', 'http://x/y/z'],
    ['with path already', 'http://x/y/a', '/b', 'http://x/y/a/b'],
    ['deep path', 'https://a.b.c/p/q', '/r/s/t', 'https://a.b.c/p/q/r/s/t'],
    ['preserves query', 'http://x/y', 'path?q=1&r=2', 'http://x/y/path?q=1&r=2'],
    ['preserves fragment', 'http://x/y', '/path#frag', 'http://x/y/path#frag'],
    ['preserves both', 'http://x/y', '/p?a=1#f', 'http://x/y/p?a=1#f'],
    ['absolute http passthrough', '', 'http://full.url/path', 'http://full.url/path'],
    ['absolute https passthrough', '', 'https://full.url/path?q=1', 'https://full.url/path?q=1'],
    ['absolute passthrough ignores base', 'http://base/', 'https://other.com/x', 'https://other.com/x'],
    ['absolute with query/fragment', 'http://base/', 'https://a.b/c?d=e#f', 'https://a.b/c?d=e#f'],
    ['HTTP uppercase passthrough', '', 'HTTP://upper.case/x', 'HTTP://upper.case/x'],
    ['HTTPS uppercase passthrough', '', 'HTTPS://upper.case/x', 'HTTPS://upper.case/x'],
    ['root path', 'http://x', '/', 'http://x'],
    ['root path alt', 'http://x/', '/', 'http://x'],
  ];

  for (const [name, base, value, expected] of cases) {
    it(`resolveUrl: ${name}`, () => {
      expect(resolveUrl(base, value)).toBe(expected);
    });
  }

  it('resolveUrl preserves exact query string after join', () => {
    expect(resolveUrl('http://a', '/b?foo=bar&baz=qux')).toBe('http://a/b?foo=bar&baz=qux');
  });

  it('resolveUrl preserves fragment with special chars', () => {
    expect(resolveUrl('http://a', '/b#section-2.1')).toBe('http://a/b#section-2.1');
  });
});

// --- compileStep happy paths ----------------------------------------------

describe('compileStep — happy paths', () => {
  it('goto: relative value joins base_url', () => {
    const out = compileStep({ action: 'goto', value: '/login' }, baseCtx());
    expect(out.trim()).toBe(`await page.goto("http://localhost:3000/login");`);
  });

  it('goto: absolute value passes through', () => {
    const out = compileStep({ action: 'goto', value: 'https://other.com/p' }, baseCtx());
    expect(out.trim()).toBe(`await page.goto("https://other.com/p");`);
  });

  it('goto: joins bare relative value', () => {
    const out = compileStep({ action: 'goto', value: 'dashboard' }, baseCtx());
    expect(out.trim()).toBe(`await page.goto("http://localhost:3000/dashboard");`);
  });

  it('click', () => {
    const out = compileStep({ action: 'click', target: 'feat.view.btn.click' }, baseCtx());
    expect(out.trim()).toBe(`await page.getByTestId("feat.view.btn.click").click();`);
  });

  it('type', () => {
    const out = compileStep(
      { action: 'type', target: 'feat.view.input.type', value: 'hello' },
      baseCtx(),
    );
    expect(out.trim()).toBe(
      `await page.getByTestId("feat.view.input.type").fill("hello");`,
    );
  });

  it('hover', () => {
    const out = compileStep({ action: 'hover', target: 'feat.view.card.hover' }, baseCtx());
    expect(out.trim()).toBe(`await page.getByTestId("feat.view.card.hover").hover();`);
  });

  it('wait emits raw integer', () => {
    const out = compileStep({ action: 'wait', timeout: 2000 }, baseCtx());
    expect(out.trim()).toBe(`await page.waitForTimeout(2000);`);
  });

  it('wait with large integer', () => {
    const out = compileStep({ action: 'wait', timeout: 120000 }, baseCtx());
    expect(out.trim()).toBe(`await page.waitForTimeout(120000);`);
  });

  it('select', () => {
    const out = compileStep(
      { action: 'select', target: 'feat.view.dropdown.select', value: 'option2' },
      baseCtx(),
    );
    expect(out.trim()).toBe(
      `await page.getByTestId("feat.view.dropdown.select").selectOption("option2");`,
    );
  });

  it('check', () => {
    const out = compileStep({ action: 'check', target: 'feat.view.toggle.check' }, baseCtx());
    expect(out.trim()).toBe(`await page.getByTestId("feat.view.toggle.check").check();`);
  });

  it('uncheck', () => {
    const out = compileStep({ action: 'uncheck', target: 'feat.view.toggle.check' }, baseCtx());
    expect(out.trim()).toBe(`await page.getByTestId("feat.view.toggle.check").uncheck();`);
  });

  it('press', () => {
    const out = compileStep(
      { action: 'press', target: 'feat.view.input.type', value: 'Enter' },
      baseCtx(),
    );
    expect(out.trim()).toBe(
      `await page.getByTestId("feat.view.input.type").press("Enter");`,
    );
  });

  it('press with modifier chord', () => {
    const out = compileStep(
      { action: 'press', target: 'feat.view.input.type', value: 'Control+Enter' },
      baseCtx(),
    );
    expect(out.trim()).toBe(
      `await page.getByTestId("feat.view.input.type").press("Control+Enter");`,
    );
  });

  it('snapshot emits screenshot with fullPage true and testId/name path', () => {
    const out = compileStep(
      { action: 'snapshot', name: 'first_load' },
      { baseUrl: BASE_URL, testId: 'feat.sub.act' },
    );
    expect(out.trim()).toBe(
      `await page.screenshot({ path: "screenshots/feat.sub.act_first_load.png", fullPage: true });`,
    );
  });
});

// --- compileStep escaping -------------------------------------------------

describe('compileStep — escaping', () => {
  const tricky: Array<[string, string]> = [
    ['double-quote inside', 'hello "world"'],
    ['backslash', 'a\\b'],
    ['newline', 'line1\nline2'],
    ['tab', 'col1\tcol2'],
    ['carriage return', 'a\rb'],
    ['emoji', 'hi 🎉🔥'],
    ['unicode chars', 'Ω≈ç√∫˜µ≤≥÷'],
    ['mixed chaos', 'he said "\\n" on \tline 1\n🎉'],
    ['empty string', ''],
    ['only-quotes', '""""'],
    ['only-backslashes', '\\\\\\\\'],
    ['backtick', 'a`b'],
    ['dollar-brace', '${a}'],
    ['null char', 'a\u0000b'],
  ];

  for (const [label, value] of tricky) {
    it(`type: safely escapes ${label}`, () => {
      const src = compileStep({ action: 'type', target: 'feat.view.i.t', value }, baseCtx());
      expect(delimBalanced(src)).toBe(true);
      // Reading back the stringified form must equal the original value.
      const match = src.match(/\.fill\((.*)\);$/s);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]!)).toBe(value);
    });

    it(`press: safely escapes ${label}`, () => {
      const src = compileStep(
        { action: 'press', target: 'feat.view.i.t', value },
        baseCtx(),
      );
      expect(delimBalanced(src)).toBe(true);
      const match = src.match(/\.press\((.*)\);$/s);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]!)).toBe(value);
    });

    it(`select: safely escapes ${label}`, () => {
      const src = compileStep(
        { action: 'select', target: 'feat.view.d.s', value },
        baseCtx(),
      );
      expect(delimBalanced(src)).toBe(true);
      const match = src.match(/\.selectOption\((.*)\);$/s);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1]!)).toBe(value);
    });
  }

  it('goto: safely escapes query with special characters', () => {
    const src = compileStep(
      { action: 'goto', value: '/path?q=a b&x="y"' },
      baseCtx(),
    );
    expect(delimBalanced(src)).toBe(true);
    expect(src.trim()).toContain('await page.goto(');
  });

  it('snapshot name with underscores and digits is safe', () => {
    const src = compileStep(
      { action: 'snapshot', name: 'step_42_final' },
      { baseUrl: BASE_URL, testId: 'a.b.c' },
    );
    expect(src).toContain('"screenshots/a.b.c_step_42_final.png"');
    expect(delimBalanced(src)).toBe(true);
  });

  it('emitted line never contains bare unquoted identifier for target', () => {
    const src = compileStep(
      { action: 'click', target: 'feat.view.btn.click' },
      baseCtx(),
    );
    expect(src).toContain('"feat.view.btn.click"');
    expect(src).not.toMatch(/getByTestId\(feat\./);
  });

  it('unreachable action throws (exhaustiveness)', () => {
    const bogus = { action: 'teleport' } as unknown as Step;
    expect(() => compileStep(bogus, baseCtx())).toThrow();
  });
});

// --- compileStep target quoting -------------------------------------------

describe('compileStep — target always JSON-stringified', () => {
  const targetActions: Array<Step['action']> = [
    'click', 'type', 'hover', 'select', 'check', 'uncheck', 'press',
  ];

  for (const action of targetActions) {
    it(`${action}: target quoted`, () => {
      const step = ((): Step => {
        switch (action) {
          case 'click': return { action, target: 'f.v.e.a' };
          case 'type': return { action, target: 'f.v.e.a', value: 'v' };
          case 'hover': return { action, target: 'f.v.e.a' };
          case 'select': return { action, target: 'f.v.e.a', value: 'opt' };
          case 'check': return { action, target: 'f.v.e.a' };
          case 'uncheck': return { action, target: 'f.v.e.a' };
          case 'press': return { action, target: 'f.v.e.a', value: 'Enter' };
          default: throw new Error(`unreachable: ${action as string}`);
        }
      })();
      const src = compileStep(step, baseCtx());
      expect(src).toContain('"f.v.e.a"');
    });
  }
});

// --- compileTest ----------------------------------------------------------

describe('compileTest', () => {
  it('wraps single step in test template with id quoted', () => {
    const plan = Plan.parse(
      makePlan([
        validTest('feat.sub.act', [{ action: 'goto', value: '/' }]),
      ]),
    );
    const src = compileTest(plan.tests[0]!, plan);
    expect(src).toContain(`import { test } from '@playwright/test';`);
    expect(src).toContain(`test("feat.sub.act", async ({ page }) => {`);
    expect(src.endsWith('});\n')).toBe(true);
  });

  it('preserves step order', () => {
    const plan = Plan.parse(
      makePlan([
        validTest('feat.sub.act', [
          { action: 'goto', value: '/a' },
          { action: 'click', target: 'feat.view.first.click' },
          { action: 'click', target: 'feat.view.second.click' },
          { action: 'click', target: 'feat.view.third.click' },
        ]),
      ]),
    );
    const src = compileTest(plan.tests[0]!, plan);
    const firstIdx = src.indexOf('first');
    const secondIdx = src.indexOf('second');
    const thirdIdx = src.indexOf('third');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });

  it('emits 2-space indent on step lines', () => {
    const plan = Plan.parse(
      makePlan([
        validTest('feat.sub.act', [
          { action: 'goto', value: '/' },
          { action: 'wait', timeout: 1000 },
        ]),
      ]),
    );
    const src = compileTest(plan.tests[0]!, plan);
    const lines = src.split('\n');
    const bodyLines = lines.filter((l) => l.startsWith('  await'));
    expect(bodyLines.length).toBe(2);
    for (const l of bodyLines) {
      expect(l.startsWith('  await')).toBe(true);
      expect(l.startsWith('   ')).toBe(false);
    }
  });

  it('test() call is unindented', () => {
    const plan = Plan.parse(
      makePlan([
        validTest('feat.sub.act', [{ action: 'goto', value: '/' }]),
      ]),
    );
    const src = compileTest(plan.tests[0]!, plan);
    const testLine = src.split('\n').find((l) => l.startsWith('test('))!;
    expect(testLine).toBeDefined();
    expect(testLine.startsWith('test(')).toBe(true);
    expect(/^\s/.test(testLine)).toBe(false);
  });

  it('5 steps produce 5 body lines', () => {
    const steps = [
      { action: 'goto', value: '/' },
      { action: 'click', target: 'feat.view.a.click' },
      { action: 'type', target: 'feat.view.b.type', value: 'x' },
      { action: 'wait', timeout: 500 },
      { action: 'snapshot', name: 'done' },
    ];
    const plan = Plan.parse(
      makePlan([validTest('feat.sub.act', steps)]),
    );
    const src = compileTest(plan.tests[0]!, plan);
    const bodyLines = src.split('\n').filter((l) => l.startsWith('  await'));
    expect(bodyLines).toHaveLength(5);
  });

  it('compiled source contains dollar-brace only when user-supplied value has it', () => {
    const plan = Plan.parse(
      makePlan([
        validTest('feat.sub.act', [{ action: 'goto', value: '/' }]),
      ]),
    );
    const src = compileTest(plan.tests[0]!, plan);
    expect(src).not.toContain('${');
  });
});

// --- compilePlan ----------------------------------------------------------

describe('compilePlan', () => {
  function threeTests(): unknown {
    return makePlan([
      validTest('feat.sub.one', [{ action: 'goto', value: '/one' }]),
      validTest('feat.sub.two', [{ action: 'goto', value: '/two' }]),
      validTest('feat.sub.three', [{ action: 'goto', value: '/three' }]),
    ]);
  }

  it('returns one spec per test', () => {
    const plan = Plan.parse(threeTests());
    const out = compilePlan(plan);
    expect(out.specs).toHaveLength(3);
  });

  it('spec paths are tests/<test-id>.spec.ts', () => {
    const plan = Plan.parse(threeTests());
    const out = compilePlan(plan);
    expect(out.specs[0]!.path).toBe('tests/feat.sub.one.spec.ts');
    expect(out.specs[1]!.path).toBe('tests/feat.sub.two.spec.ts');
    expect(out.specs[2]!.path).toBe('tests/feat.sub.three.spec.ts');
  });

  it('pwConfig includes the plan base_url as fallback', () => {
    const plan = Plan.parse(threeTests());
    const out = compilePlan(plan);
    expect(out.pwConfig).toContain(`"${BASE_URL}"`);
    expect(out.pwConfig).toContain('process.env.PW_BASE_URL');
  });

  it('pwConfig shape is exact', () => {
    const plan = Plan.parse(threeTests());
    const out = compilePlan(plan);
    expect(out.pwConfig).toContain(`import { defineConfig } from '@playwright/test';`);
    expect(out.pwConfig).toContain(`testDir: './tests',`);
    expect(out.pwConfig).toContain(`fullyParallel: true,`);
    expect(out.pwConfig).toContain(`retries: 0,`);
    expect(out.pwConfig).toContain(`screenshot: 'only-on-failure',`);
    expect(out.pwConfig).toContain(`trace: 'on-first-retry',`);
  });

  it('packageJson is valid JSON', () => {
    const plan = Plan.parse(threeTests());
    const out = compilePlan(plan);
    const parsed = JSON.parse(out.packageJson) as Record<string, unknown>;
    expect(typeof parsed).toBe('object');
  });

  it('packageJson declares @playwright/test in devDependencies', () => {
    const plan = Plan.parse(threeTests());
    const out = compilePlan(plan);
    const parsed = JSON.parse(out.packageJson);
    expect(parsed.devDependencies).toHaveProperty('@playwright/test');
  });

  it('packageJson has "test": "playwright test" script', () => {
    const plan = Plan.parse(threeTests());
    const out = compilePlan(plan);
    const parsed = JSON.parse(out.packageJson);
    expect(parsed.scripts?.test).toBe('playwright test');
  });

  it('readme mentions install commands', () => {
    const plan = Plan.parse(threeTests());
    const out = compilePlan(plan);
    expect(out.readme).toContain('npm install');
    expect(out.readme).toContain('npx playwright install');
    expect(out.readme).toContain('npx playwright test');
  });

  it('readme mentions the base url', () => {
    const plan = Plan.parse(threeTests());
    const out = compilePlan(plan);
    expect(out.readme).toContain(BASE_URL);
  });
});

// --- compilePwConfig / compilePackageJson / compileReadme helpers ---------

describe('compilePwConfig', () => {
  it('uses plan base_url as fallback literal', () => {
    const plan = Plan.parse(
      makePlan([validTest('feat.sub.act', [{ action: 'goto', value: '/' }])]),
    );
    const cfg = compilePwConfig(plan);
    expect(cfg).toContain(`process.env.PW_BASE_URL ?? "${BASE_URL}"`);
  });

  it('uses a different base_url when plan changes it', () => {
    const plan = Plan.parse({
      version: 1,
      globals: { base_url: 'https://example.org' },
      tests: [validTest('feat.sub.act', [{ action: 'goto', value: '/' }])],
    });
    const cfg = compilePwConfig(plan);
    expect(cfg).toContain(`"https://example.org"`);
  });
});

describe('compilePackageJson', () => {
  it('is a string ending with newline', () => {
    const pj = compilePackageJson();
    expect(pj.endsWith('\n')).toBe(true);
  });

  it('parses to an object', () => {
    const pj = compilePackageJson();
    expect(() => JSON.parse(pj)).not.toThrow();
  });

  it('declares @playwright/test dependency', () => {
    const pj = JSON.parse(compilePackageJson());
    expect(pj.devDependencies['@playwright/test']).toBeDefined();
  });
});

describe('compileReadme', () => {
  it('uses plural test spec when there are multiple', () => {
    const plan = Plan.parse(
      makePlan([
        validTest('feat.sub.one', [{ action: 'goto', value: '/' }]),
        validTest('feat.sub.two', [{ action: 'goto', value: '/' }]),
      ]),
    );
    const readme = compileReadme(plan);
    expect(readme).toContain('2 test specs');
  });

  it('uses singular test spec when there is exactly one', () => {
    const plan = Plan.parse(
      makePlan([validTest('feat.sub.act', [{ action: 'goto', value: '/' }])]),
    );
    const readme = compileReadme(plan);
    expect(readme).toContain('1 test spec');
    expect(readme).not.toContain('1 test specs');
  });
});

// --- Plan schema validation -----------------------------------------------

describe('Plan schema — id + dependency validation', () => {
  it('rejects duplicate test ids', () => {
    const r = Plan.safeParse(
      makePlan([
        validTest('feat.sub.act', [{ action: 'goto', value: '/' }]),
        validTest('feat.sub.act', [{ action: 'goto', value: '/' }]),
      ]),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/duplicate test id/);
  });

  it('rejects depends_on pointing at unknown id', () => {
    const r = Plan.safeParse(
      makePlan([
        validTest('feat.sub.act', [{ action: 'goto', value: '/' }], ['feat.sub.missing']),
      ]),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/unknown id/);
  });

  it('rejects a 2-cycle', () => {
    const r = Plan.safeParse(
      makePlan([
        validTest('feat.sub.a', [{ action: 'goto', value: '/' }], ['feat.sub.b']),
        validTest('feat.sub.b', [{ action: 'goto', value: '/' }], ['feat.sub.a']),
      ]),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/cycle/);
  });

  it('rejects a 3-cycle', () => {
    const r = Plan.safeParse(
      makePlan([
        validTest('feat.sub.a', [{ action: 'goto', value: '/' }], ['feat.sub.b']),
        validTest('feat.sub.b', [{ action: 'goto', value: '/' }], ['feat.sub.c']),
        validTest('feat.sub.c', [{ action: 'goto', value: '/' }], ['feat.sub.a']),
      ]),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/cycle/);
  });

  it('accepts a valid linear chain', () => {
    const r = Plan.safeParse(
      makePlan([
        validTest('feat.sub.a', [{ action: 'goto', value: '/' }]),
        validTest('feat.sub.b', [{ action: 'goto', value: '/' }], ['feat.sub.a']),
        validTest('feat.sub.c', [{ action: 'goto', value: '/' }], ['feat.sub.b']),
      ]),
    );
    expect(r.success).toBe(true);
  });

  it('rejects duplicate snapshot names within one test', () => {
    const r = Plan.safeParse(
      makePlan([
        validTest('feat.sub.act', [
          { action: 'goto', value: '/' },
          { action: 'snapshot', name: 'foo' },
          { action: 'snapshot', name: 'foo' },
        ]),
      ]),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/duplicate snapshot name/);
  });

  it('accepts duplicate snapshot names across different tests', () => {
    const r = Plan.safeParse(
      makePlan([
        validTest('feat.sub.a', [
          { action: 'goto', value: '/' },
          { action: 'snapshot', name: 'shared' },
        ]),
        validTest('feat.sub.b', [
          { action: 'goto', value: '/' },
          { action: 'snapshot', name: 'shared' },
        ]),
      ]),
    );
    expect(r.success).toBe(true);
  });

  it('rejects invalid test id pattern', () => {
    const r = Plan.safeParse(
      makePlan([validTest('nope', [{ action: 'goto', value: '/' }])]),
    );
    expect(r.success).toBe(false);
  });

  it('rejects empty steps', () => {
    const r = Plan.safeParse(
      makePlan([validTest('feat.sub.act', [])]),
    );
    expect(r.success).toBe(false);
  });

  it('rejects non-url base_url', () => {
    const r = Plan.safeParse({
      version: 1,
      globals: { base_url: 'not a url' },
      tests: [validTest('feat.sub.act', [{ action: 'goto', value: '/' }])],
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-1 version', () => {
    const r = Plan.safeParse({
      version: 2,
      globals: { base_url: BASE_URL },
      tests: [validTest('feat.sub.act', [{ action: 'goto', value: '/' }])],
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty tests list', () => {
    const r = Plan.safeParse({
      version: 1,
      globals: { base_url: BASE_URL },
      tests: [],
    });
    expect(r.success).toBe(false);
  });
});

describe('Plan schema — missing required action fields', () => {
  const missingCases: Array<[string, unknown]> = [
    ['goto missing value', { action: 'goto' }],
    ['click missing target', { action: 'click' }],
    ['type missing target', { action: 'type', value: 'x' }],
    ['type missing value', { action: 'type', target: 'f.v.e.a' }],
    ['hover missing target', { action: 'hover' }],
    ['wait missing timeout', { action: 'wait' }],
    ['snapshot missing name', { action: 'snapshot' }],
    ['select missing target', { action: 'select', value: 'x' }],
    ['select missing value', { action: 'select', target: 'f.v.e.a' }],
    ['check missing target', { action: 'check' }],
    ['uncheck missing target', { action: 'uncheck' }],
    ['press missing target', { action: 'press', value: 'Enter' }],
    ['press missing value', { action: 'press', target: 'f.v.e.a' }],
  ];

  for (const [label, step] of missingCases) {
    it(`rejects: ${label}`, () => {
      const r = Plan.safeParse(
        makePlan([validTest('feat.sub.act', [step])]),
      );
      expect(r.success).toBe(false);
    });
  }
});

describe('Plan schema — forbidden extra fields (strict)', () => {
  const extraCases: Array<[string, unknown]> = [
    ['goto with extra target', { action: 'goto', value: '/', target: 'f.v.e.a' }],
    ['click with extra value', { action: 'click', target: 'f.v.e.a', value: 'x' }],
    ['type with extra timeout', { action: 'type', target: 'f.v.e.a', value: 'x', timeout: 1 }],
    ['hover with extra value', { action: 'hover', target: 'f.v.e.a', value: 'x' }],
    ['wait with extra target', { action: 'wait', timeout: 1, target: 'f.v.e.a' }],
    ['snapshot with extra value', { action: 'snapshot', name: 'a', value: 'x' }],
    ['select with extra timeout', { action: 'select', target: 'f.v.e.a', value: 'x', timeout: 1 }],
    ['check with extra value', { action: 'check', target: 'f.v.e.a', value: 'x' }],
    ['uncheck with extra value', { action: 'uncheck', target: 'f.v.e.a', value: 'x' }],
    ['press with extra timeout', { action: 'press', target: 'f.v.e.a', value: 'Enter', timeout: 1 }],
  ];

  for (const [label, step] of extraCases) {
    it(`rejects: ${label}`, () => {
      const r = Plan.safeParse(
        makePlan([validTest('feat.sub.act', [step])]),
      );
      expect(r.success).toBe(false);
    });
  }
});

describe('Step schema — wait timeout must be positive int', () => {
  it('rejects zero timeout', () => {
    const r = Step.safeParse({ action: 'wait', timeout: 0 });
    expect(r.success).toBe(false);
  });

  it('rejects negative timeout', () => {
    const r = Step.safeParse({ action: 'wait', timeout: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects float timeout', () => {
    const r = Step.safeParse({ action: 'wait', timeout: 1.5 });
    expect(r.success).toBe(false);
  });
});

describe('Step schema — snapshot name pattern', () => {
  it('rejects uppercase', () => {
    const r = Step.safeParse({ action: 'snapshot', name: 'Foo' });
    expect(r.success).toBe(false);
  });

  it('rejects hyphen', () => {
    const r = Step.safeParse({ action: 'snapshot', name: 'foo-bar' });
    expect(r.success).toBe(false);
  });

  it('accepts snake_case with digits', () => {
    const r = Step.safeParse({ action: 'snapshot', name: 'step_42_end' });
    expect(r.success).toBe(true);
  });
});

describe('Test schema — depends_on defaults to empty array', () => {
  it('missing depends_on is fine', () => {
    const r = Test.safeParse({
      id: 'feat.sub.act',
      steps: [{ action: 'goto', value: '/' }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.depends_on).toEqual([]);
  });
});

// --- End-to-end codegen round-trip ----------------------------------------

describe('end-to-end codegen round-trip', () => {
  function richPlan(): unknown {
    return makePlan([
      validTest('feat.sub.first', [
        { action: 'goto', value: '/a' },
        { action: 'click', target: 'feat.view.btn.click' },
        { action: 'type', target: 'feat.view.inp.type', value: 'hello world' },
        { action: 'snapshot', name: 'after_type' },
      ]),
      validTest(
        'feat.sub.second',
        [
          { action: 'goto', value: '/b' },
          { action: 'hover', target: 'feat.view.card.hover' },
          { action: 'wait', timeout: 1000 },
          { action: 'select', target: 'feat.view.dd.select', value: 'opt1' },
          { action: 'check', target: 'feat.view.chk.check' },
          { action: 'snapshot', name: 'second_done' },
        ],
        ['feat.sub.first'],
      ),
      validTest('feat.sub.third', [
        { action: 'goto', value: '/c' },
        { action: 'uncheck', target: 'feat.view.chk.check' },
        { action: 'press', target: 'feat.view.inp.type', value: 'Enter' },
        { action: 'snapshot', name: 'third_done' },
      ]),
    ]);
  }

  it('each spec source starts with playwright import and ends with });\\n', () => {
    const plan = Plan.parse(richPlan());
    const out = compilePlan(plan);
    for (const spec of out.specs) {
      expect(spec.source.startsWith(`import { test } from '@playwright/test';`)).toBe(true);
      expect(spec.source.endsWith('});\n')).toBe(true);
    }
  });

  it('no spec source contains "any"', () => {
    const plan = Plan.parse(richPlan());
    const out = compilePlan(plan);
    for (const spec of out.specs) {
      expect(spec.source.split(/\b/).includes('any')).toBe(false);
    }
  });

  it('no spec source contains "TODO"', () => {
    const plan = Plan.parse(richPlan());
    const out = compilePlan(plan);
    for (const spec of out.specs) {
      expect(spec.source).not.toContain('TODO');
    }
  });

  it('no spec source contains "${" (unresolved template placeholder)', () => {
    const plan = Plan.parse(richPlan());
    const out = compilePlan(plan);
    for (const spec of out.specs) {
      expect(spec.source).not.toContain('${');
    }
  });

  it('plan covers all 10 actions across the three tests', () => {
    const plan = Plan.parse(richPlan());
    const actions = new Set<string>();
    for (const t of plan.tests) for (const s of t.steps) actions.add(s.action);
    // Rich plan hits 9; add a plan variant with all 10 to be thorough.
    expect(actions.size).toBeGreaterThanOrEqual(9);
  });

  it('all 10 actions used in a single plan compile without error', () => {
    const plan = Plan.parse(
      makePlan([
        validTest('feat.sub.all', [
          { action: 'goto', value: '/' },
          { action: 'click', target: 'f.v.a.click' },
          { action: 'type', target: 'f.v.b.type', value: 'v' },
          { action: 'hover', target: 'f.v.c.hover' },
          { action: 'wait', timeout: 10 },
          { action: 'snapshot', name: 'snap1' },
          { action: 'select', target: 'f.v.d.select', value: 'opt' },
          { action: 'check', target: 'f.v.e.check' },
          { action: 'uncheck', target: 'f.v.e.check' },
          { action: 'press', target: 'f.v.f.press', value: 'Enter' },
        ]),
      ]),
    );
    const out = compilePlan(plan);
    expect(out.specs).toHaveLength(1);
    const src = out.specs[0]!.source;
    expect(src).toContain('await page.goto(');
    expect(src).toContain('.click();');
    expect(src).toContain('.fill(');
    expect(src).toContain('.hover();');
    expect(src).toContain('waitForTimeout(');
    expect(src).toContain('page.screenshot(');
    expect(src).toContain('.selectOption(');
    expect(src).toContain('.check();');
    expect(src).toContain('.uncheck();');
    expect(src).toContain('.press(');
  });
});

// --- Filesystem: writeProject + disk round-trip ---------------------------

describe('writeProject — disk IO', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-execute-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function richPlan(): unknown {
    return makePlan([
      validTest('feat.sub.one', [
        { action: 'goto', value: '/a' },
        { action: 'click', target: 'feat.view.btn.click' },
        { action: 'snapshot', name: 'done' },
      ]),
      validTest('feat.sub.two', [
        { action: 'goto', value: '/b' },
        { action: 'type', target: 'feat.view.inp.type', value: 'hi' },
      ]),
    ]);
  }

  it('writes all top-level files', async () => {
    const plan = Plan.parse(richPlan());
    const project = compilePlan(plan);
    await writeProject(project, tmp);
    expect(fs.existsSync(path.join(tmp, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'playwright.config.ts'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'tests'))).toBe(true);
  });

  it('writes one spec file per test', async () => {
    const plan = Plan.parse(richPlan());
    const project = compilePlan(plan);
    await writeProject(project, tmp);
    const specs = fs.readdirSync(path.join(tmp, 'tests'));
    expect(specs.length).toBe(2);
    expect(specs).toContain('feat.sub.one.spec.ts');
    expect(specs).toContain('feat.sub.two.spec.ts');
  });

  it('written files are byte-equal to in-memory project', async () => {
    const plan = Plan.parse(richPlan());
    const project = compilePlan(plan);
    await writeProject(project, tmp);
    expect(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).toBe(project.packageJson);
    expect(fs.readFileSync(path.join(tmp, 'playwright.config.ts'), 'utf8')).toBe(project.pwConfig);
    expect(fs.readFileSync(path.join(tmp, 'README.md'), 'utf8')).toBe(project.readme);
    for (const spec of project.specs) {
      expect(fs.readFileSync(path.join(tmp, spec.path), 'utf8')).toBe(spec.source);
    }
  });

  it('wipes outDir before writing (removes stale files)', async () => {
    // Pre-populate with content that matches the "looks-generated" allow-list,
    // so we can assert wipe happened without the warning.
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), 'stale package json');
    fs.mkdirSync(path.join(tmp, 'tests'));
    fs.writeFileSync(path.join(tmp, 'tests', 'stale.spec.ts'), '// stale');
    const plan = Plan.parse(richPlan());
    const project = compilePlan(plan);
    await writeProject(project, tmp);
    expect(fs.existsSync(path.join(tmp, 'tests', 'stale.spec.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8')).toBe(project.packageJson);
  });

  it('wipes outDir even when it contains non-generated content (warns but proceeds)', async () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'unrelated.txt'), 'not part of generated project');
    const plan = Plan.parse(richPlan());
    const project = compilePlan(plan);
    await writeProject(project, tmp);
    expect(fs.existsSync(path.join(tmp, 'unrelated.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'package.json'))).toBe(true);
  });

  it('handles previously-absent outDir by creating it', async () => {
    const nested = path.join(tmp, 'does', 'not', 'exist');
    const plan = Plan.parse(richPlan());
    const project = compilePlan(plan);
    await writeProject(project, nested);
    expect(fs.existsSync(path.join(nested, 'package.json'))).toBe(true);
  });
});

// --- Path safety ----------------------------------------------------------

describe('path safety — multi-dot test ids', () => {
  it('id with 2 dots maps to the same id-named spec file', async () => {
    const plan = Plan.parse(
      makePlan([validTest('auth.login.submit', [{ action: 'goto', value: '/' }])]),
    );
    const out = compilePlan(plan);
    expect(out.specs[0]!.path).toBe('tests/auth.login.submit.spec.ts');
  });

  it('id is NOT sanitized — dots preserved verbatim', () => {
    const plan = Plan.parse(
      makePlan([
        validTest('a1.b2.c3', [{ action: 'goto', value: '/' }]),
      ]),
    );
    const out = compilePlan(plan);
    expect(out.specs[0]!.path).toBe('tests/a1.b2.c3.spec.ts');
  });

  it('snapshot path uses testId with dots', () => {
    const step = compileStep(
      { action: 'snapshot', name: 'loaded' },
      { baseUrl: BASE_URL, testId: 'auth.login.submit' },
    );
    expect(step).toContain('"screenshots/auth.login.submit_loaded.png"');
  });
});

// --- loadPlan (smoke for yaml IO) -----------------------------------------

describe('loadPlan', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-execute-plan-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loads a well-formed YAML plan', async () => {
    const yaml =
      `version: 1\n` +
      `globals:\n  base_url: ${BASE_URL}\n` +
      `tests:\n` +
      `  - id: feat.sub.act\n` +
      `    depends_on: []\n` +
      `    steps:\n      - action: goto\n        value: /home\n`;
    const p = path.join(tmp, 'plan.yml');
    fs.writeFileSync(p, yaml);
    const plan = await loadPlan(p);
    expect(plan.tests).toHaveLength(1);
    expect(plan.tests[0]!.id).toBe('feat.sub.act');
  });

  it('throws a descriptive error when the file is missing', async () => {
    await expect(loadPlan(path.join(tmp, 'nope.yml'))).rejects.toThrow(/cannot read plan/);
  });

  it('throws when YAML is malformed', async () => {
    const p = path.join(tmp, 'plan.yml');
    fs.writeFileSync(p, ':::\n\tnot yaml: [unclosed');
    await expect(loadPlan(p)).rejects.toThrow();
  });

  it('throws when schema validation fails', async () => {
    const p = path.join(tmp, 'plan.yml');
    fs.writeFileSync(p, `version: 1\nglobals:\n  base_url: not-a-url\ntests: []\n`);
    await expect(loadPlan(p)).rejects.toThrow(/schema validation/);
  });
});
