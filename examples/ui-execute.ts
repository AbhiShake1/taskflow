/**
 * ui-execute.ts — Harness 2 of the UI-harness trio.
 *
 * Reads plans/ui-tests.yml and generates a complete standalone Playwright
 * project at generated/playwright/. Pure deterministic codegen — no LLM calls.
 *
 * After running:  cd generated/playwright && npm install && npx playwright install && npx playwright test
 *
 * Requires: npm i -g @taskflow-corp/sdk (global install — nothing else to set up).
 *
 * Run: tsx ui-execute.ts
 * Env: UI_PLAN_PATH (override plan path), UI_OUT_DIR (override output dir).
 */

import { writeFile, mkdir, rm, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';

const CONFIG = {
  planPath: process.env.UI_PLAN_PATH ?? 'plans/ui-tests.yml',
  outDir: process.env.UI_OUT_DIR ?? 'generated/playwright',
} as const;

// --- Schemas ---------------------------------------------------------------

const TestidPattern = z
  .string()
  .regex(/^[a-z0-9]+(?:\.[a-z0-9]+){3}$/, 'expected feature.view.element.action');

const TestIdPattern = z
  .string()
  .regex(/^[a-z0-9]+(?:\.[a-z0-9]+){2}$/, 'expected feature.subfeature.action');

const SnapshotName = z.string().regex(/^[a-z0-9_]+$/, 'expected snake_case snapshot name');

const StepGoto = z.object({ action: z.literal('goto'), value: z.string() }).strict();
const StepClick = z.object({ action: z.literal('click'), target: TestidPattern }).strict();
const StepType = z
  .object({ action: z.literal('type'), target: TestidPattern, value: z.string() })
  .strict();
const StepHover = z.object({ action: z.literal('hover'), target: TestidPattern }).strict();
const StepWait = z
  .object({ action: z.literal('wait'), timeout: z.number().int().positive() })
  .strict();
const StepSnapshot = z
  .object({ action: z.literal('snapshot'), name: SnapshotName })
  .strict();
const StepSelect = z
  .object({ action: z.literal('select'), target: TestidPattern, value: z.string() })
  .strict();
const StepCheck = z.object({ action: z.literal('check'), target: TestidPattern }).strict();
const StepUncheck = z
  .object({ action: z.literal('uncheck'), target: TestidPattern })
  .strict();
const StepPress = z
  .object({ action: z.literal('press'), target: TestidPattern, value: z.string() })
  .strict();

const Step = z.discriminatedUnion('action', [
  StepGoto,
  StepClick,
  StepType,
  StepHover,
  StepWait,
  StepSnapshot,
  StepSelect,
  StepCheck,
  StepUncheck,
  StepPress,
]);
type Step = z.infer<typeof Step>;

const Test = z
  .object({
    id: TestIdPattern,
    depends_on: z.array(z.string()).default([]),
    steps: z.array(Step).min(1),
  })
  .strict();
type Test = z.infer<typeof Test>;

function detectCycle(nodes: Map<string, readonly string[]>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodes.keys()) color.set(id, WHITE);
  const stack: string[] = [];

  function dfs(u: string): string[] | null {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of nodes.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        const i = stack.indexOf(v);
        return stack.slice(i).concat(v);
      }
      if (c === WHITE) {
        const cycle = dfs(v);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  }

  for (const id of nodes.keys()) {
    if (color.get(id) === WHITE) {
      const cycle = dfs(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

const Plan = z
  .object({
    version: z.literal(1),
    globals: z.object({ base_url: z.string().url() }).strict(),
    tests: z.array(Test).min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const t of plan.tests) {
      if (ids.has(t.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate test id: ${t.id}`,
          path: ['tests'],
        });
      }
      ids.add(t.id);
    }
    const graph = new Map<string, readonly string[]>();
    for (const t of plan.tests) graph.set(t.id, t.depends_on);
    for (const t of plan.tests) {
      for (const dep of t.depends_on) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: 'custom',
            message: `test "${t.id}" depends on unknown id "${dep}"`,
            path: ['tests'],
          });
        }
      }
    }
    const cycle = detectCycle(graph);
    if (cycle) {
      ctx.addIssue({
        code: 'custom',
        message: `dependency cycle detected: ${cycle.join(' -> ')}`,
        path: ['tests'],
      });
    }
    for (const t of plan.tests) {
      const snaps = new Set<string>();
      for (const s of t.steps) {
        if (s.action === 'snapshot') {
          if (snaps.has(s.name)) {
            ctx.addIssue({
              code: 'custom',
              message: `test "${t.id}" has duplicate snapshot name: ${s.name}`,
              path: ['tests'],
            });
          }
          snaps.add(s.name);
        }
      }
    }
  });
type Plan = z.infer<typeof Plan>;

// --- Codegen helpers --------------------------------------------------------

interface StepCtx {
  baseUrl: string;
  testId: string;
}

function resolveUrl(baseUrl: string, value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  const left = baseUrl.replace(/\/+$/, '');
  const right = value.replace(/^\/+/, '');
  if (left === '') return right;
  if (right === '') return left;
  return `${left}/${right}`;
}

function compileStep(step: Step, ctx: StepCtx): string {
  switch (step.action) {
    case 'goto': {
      const url = resolveUrl(ctx.baseUrl, step.value);
      return `await page.goto(${JSON.stringify(url)});`;
    }
    case 'click':
      return `await page.getByTestId(${JSON.stringify(step.target)}).click();`;
    case 'type':
      return `await page.getByTestId(${JSON.stringify(step.target)}).fill(${JSON.stringify(step.value)});`;
    case 'hover':
      return `await page.getByTestId(${JSON.stringify(step.target)}).hover();`;
    case 'wait':
      return `await page.waitForTimeout(${step.timeout});`;
    case 'select':
      return `await page.getByTestId(${JSON.stringify(step.target)}).selectOption(${JSON.stringify(step.value)});`;
    case 'check':
      return `await page.getByTestId(${JSON.stringify(step.target)}).check();`;
    case 'uncheck':
      return `await page.getByTestId(${JSON.stringify(step.target)}).uncheck();`;
    case 'press':
      return `await page.getByTestId(${JSON.stringify(step.target)}).press(${JSON.stringify(step.value)});`;
    case 'snapshot': {
      const path = `screenshots/${ctx.testId}_${step.name}.png`;
      return `await page.screenshot({ path: ${JSON.stringify(path)}, fullPage: true });`;
    }
    default: {
      const never: never = step;
      throw new Error(`unreachable: unhandled step action ${JSON.stringify(never)}`);
    }
  }
}

function compileTest(test: Test, plan: Plan): string {
  const ctx: StepCtx = { baseUrl: plan.globals.base_url, testId: test.id };
  const lines = test.steps.map((s) => `  ${compileStep(s, ctx)}`);
  return (
    `import { test } from '@playwright/test';\n` +
    `\n` +
    `test(${JSON.stringify(test.id)}, async ({ page }) => {\n` +
    `${lines.join('\n')}\n` +
    `});\n`
  );
}

interface SpecFile {
  path: string;
  source: string;
}

interface CompiledProject {
  specs: SpecFile[];
  pwConfig: string;
  packageJson: string;
  readme: string;
}

function compilePwConfig(plan: Plan): string {
  const fallback = plan.globals.base_url;
  return (
    `import { defineConfig } from '@playwright/test';\n` +
    `\n` +
    `export default defineConfig({\n` +
    `  testDir: './tests',\n` +
    `  fullyParallel: true,\n` +
    `  retries: 0,\n` +
    `  use: {\n` +
    `    baseURL: process.env.PW_BASE_URL ?? ${JSON.stringify(fallback)},\n` +
    `    screenshot: 'only-on-failure',\n` +
    `    trace: 'on-first-retry',\n` +
    `  },\n` +
    `});\n`
  );
}

function compilePackageJson(): string {
  const pkg = {
    name: 'ui-execute-playwright',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      test: 'playwright test',
    },
    devDependencies: {
      '@playwright/test': '^1.48.0',
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function compileReadme(plan: Plan): string {
  const count = plan.tests.length;
  return (
    `# ui-execute generated playwright project\n` +
    `\n` +
    `Auto-generated by examples/ui-execute.ts from plans/ui-tests.yml.\n` +
    `${count} test spec${count === 1 ? '' : 's'} under tests/.\n` +
    `\n` +
    `## Run\n` +
    `\n` +
    `\`\`\`bash\n` +
    `npm install\n` +
    `npx playwright install\n` +
    `npx playwright test\n` +
    `\`\`\`\n` +
    `\n` +
    `## Base URL\n` +
    `\n` +
    `Defaults to \`${plan.globals.base_url}\`. Override with the \`PW_BASE_URL\`\n` +
    `environment variable:\n` +
    `\n` +
    `\`\`\`bash\n` +
    `PW_BASE_URL=http://localhost:4000 npx playwright test\n` +
    `\`\`\`\n`
  );
}

function compilePlan(plan: Plan): CompiledProject {
  const specs: SpecFile[] = plan.tests.map((t) => ({
    path: `tests/${t.id}.spec.ts`,
    source: compileTest(t, plan),
  }));
  return {
    specs,
    pwConfig: compilePwConfig(plan),
    packageJson: compilePackageJson(),
    readme: compileReadme(plan),
  };
}

// --- Filesystem IO ---------------------------------------------------------

const EXPECTED_TOP_LEVEL = new Set(['package.json', 'playwright.config.ts', 'tests', 'README.md']);

async function looksGenerated(outDir: string): Promise<boolean> {
  try {
    const entries = await readdir(outDir);
    if (entries.length === 0) return true;
    for (const e of entries) {
      if (!EXPECTED_TOP_LEVEL.has(e)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

async function writeProject(project: CompiledProject, outDir: string): Promise<void> {
  // outDir is wiped and recreated so specs from an old plan don't linger. If
  // the caller pointed us at a directory with unrelated content we warn — the
  // wipe still runs, but at least it's visible.
  if (!(await looksGenerated(outDir))) {
    console.warn(`[ui-execute] warning: ${outDir} contains non-generated entries — wiping anyway`);
  }
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await writeFile(join(outDir, 'package.json'), project.packageJson, 'utf8');
  await writeFile(join(outDir, 'playwright.config.ts'), project.pwConfig, 'utf8');
  await writeFile(join(outDir, 'README.md'), project.readme, 'utf8');

  for (const spec of project.specs) {
    const abs = join(outDir, spec.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, spec.source, 'utf8');
  }
}

async function loadPlan(planPath: string): Promise<Plan> {
  let raw: string;
  try {
    raw = await readFile(planPath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[ui-execute] cannot read plan at ${planPath}: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[ui-execute] plan at ${planPath} is not valid YAML: ${msg}`);
  }
  const result = Plan.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `[ui-execute] plan at ${planPath} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const planPath = resolve(process.cwd(), CONFIG.planPath);
  const outDir = resolve(process.cwd(), CONFIG.outDir);

  // Fail fast with a readable message when the plan file is missing — the
  // user is far more likely to hit "plan not found" than a schema issue, and
  // the default stack trace points at yaml.parse which isn't useful.
  try {
    await stat(planPath);
  } catch {
    console.error(`[ui-execute] plan file not found: ${planPath}`);
    console.error(`[ui-execute] set UI_PLAN_PATH or create plans/ui-tests.yml first.`);
    process.exit(1);
  }

  const plan = await loadPlan(planPath);
  const project = compilePlan(plan);
  await writeProject(project, outDir);

  console.log(`[ui-execute] wrote ${project.specs.length} specs + config to ${outDir}/`);
}

// Guard main() from running when this file is imported by its unit tests.
// Top-level await would force callers to pay the startup cost; detecting
// direct invocation via import.meta.url keeps the module cheap to import.
const isDirectRun = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const entryUrl = new URL(`file://${resolve(entry)}`).href;
    return import.meta.url === entryUrl;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}

export {
  resolveUrl,
  compileStep,
  compileTest,
  compilePlan,
  compilePwConfig,
  compilePackageJson,
  compileReadme,
  writeProject,
  loadPlan,
  detectCycle,
  Plan,
  Test,
  Step,
};
export type { CompiledProject, SpecFile, StepCtx };
