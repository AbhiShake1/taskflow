/**
 * ui-plan.ts — Harness 1 of the UI-harness trio.
 *
 * Scans a project, injects missing data-testids, emits plans/ui-tests.yml.
 *
 * Requires: npm i -g @taskflow-corp/sdk (global install — nothing else to set up).
 *
 * Run: tsx ui-plan.ts
 * Env:   ANTHROPIC_API_KEY (for claude-code:sonnet)
 *        HARNESS_ADAPTER_OVERRIDE=mock  (smoke test without LLM calls)
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { taskflow } from '@taskflow-corp/sdk';

const CONFIG = {
  projectRoot: process.cwd(),
  baseUrl: 'http://localhost:3000',
  planPath: 'plans/ui-tests.yml',
  model: 'claude-code:sonnet',
  maxFeatures: 20,
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

const Test = z
  .object({
    id: TestIdPattern,
    depends_on: z.array(z.string()).default([]),
    steps: z.array(Step).min(1),
  })
  .strict();

// DFS cycle detector used inside Plan.superRefine — returns the offending
// cycle path (ids) or null when the dependency graph is acyclic.
function detectCycle(nodes: Map<string, string[]>): string[] | null {
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
    const graph = new Map<string, string[]>();
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

const Feature = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case feature name'),
    files: z.array(z.string()).min(1),
    views: z.array(z.string()).min(1),
  })
  .strict();

const FeatureList = z.object({ items: z.array(Feature).max(CONFIG.maxFeatures) }).strict();

const TestidAudit = z
  .object({
    feature: z.string(),
    missing: z.array(
      z
        .object({
          file: z.string(),
          element: z.string(),
          suggestedTestid: TestidPattern,
          line: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const InjectResult = z
  .object({
    feature: z.string(),
    added: z.number().int().nonnegative(),
    filesTouched: z.array(z.string()),
  })
  .strict();

type Feature = z.infer<typeof Feature>;
type TestidAudit = z.infer<typeof TestidAudit>;

// --- Helpers ---------------------------------------------------------------

async function withRetries<T>(
  sessionCall: (id: string) => Promise<T>,
  baseId: string,
  attempts: number = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    const id = a === 0 ? baseId : `${baseId}-r${a}`;
    try {
      return await sessionCall(id);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[retry] ${baseId} attempt ${a + 1}/${attempts} failed: ${msg.slice(0, 200)}`);
    }
  }
  throw lastErr;
}

// --- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  await taskflow('ui-plan').run(async ({ phase, session }) => {
    const features = await phase('discover', () =>
      withRetries(
        (id) =>
          session(id, {
            with: CONFIG.model,
            task: [
              `Scan the codebase rooted at ${CONFIG.projectRoot}.`,
              '',
              `Identify up to ${CONFIG.maxFeatures} user-facing UI features. A "feature" is a cohesive`,
              'slice of UI (e.g. auth, settings, checkout, dashboard).',
              '',
              'For each feature return:',
              '  - name: kebab-case identifier',
              '  - files: relative paths of source files containing that feature\'s UI',
              '  - views: human-readable view labels the feature exposes (e.g. "login", "signup")',
              '',
              'Prefer files under src/, app/, pages/, components/. Skip node_modules, dist, build.',
              'Return a FeatureList JSON object.',
            ].join('\n'),
            schema: FeatureList,
            timeoutMs: 300_000,
          }),
        'scan-features',
      ),
    );

    const audits = await phase('audit-testids', () =>
      Promise.all(
        features.items.map((f) =>
          withRetries(
            (id) =>
              session(id, {
                with: CONFIG.model,
                task: [
                  `For feature "${f.name}" in the codebase at ${CONFIG.projectRoot}, inspect these files:`,
                  ...f.files.map((p) => `  - ${p}`),
                  '',
                  'List interactive elements (buttons, inputs, links, selects, checkboxes)',
                  'that currently lack a data-testid attribute. For each, suggest a testid',
                  'in the form "feature.view.element.action" using lowercase-alphanumeric',
                  `segments (feature must be "${f.name}"; view must be one of: ${f.views.join(', ')}).`,
                  '',
                  'Return a TestidAudit JSON object.',
                ].join('\n'),
                schema: TestidAudit,
                timeoutMs: 300_000,
              }),
            `audit-${f.name}`,
          ),
        ),
      ),
    );

    await phase('inject-testids', () =>
      Promise.all(
        features.items.map((f, i) =>
          withRetries(
            (id) =>
              session(id, {
                with: CONFIG.model,
                task: [
                  `Add ${audits[i]!.missing.length} data-testid attributes to feature "${f.name}".`,
                  '',
                  'Exact mappings (apply each verbatim):',
                  ...audits[i]!.missing.map(
                    (m) => `  - ${m.file} :: ${m.element} -> data-testid="${m.suggestedTestid}"`,
                  ),
                  '',
                  'Rules:',
                  '- Do not modify logic, styling, props beyond adding the data-testid attribute.',
                  '- Idempotent: if a testid already exists with the same value, skip.',
                  '- Only touch files listed above.',
                  '',
                  'Return an InjectResult JSON object.',
                ].join('\n'),
                write: [...f.files],
                dependsOn: [`audit-${f.name}`],
                schema: InjectResult,
                timeoutMs: 600_000,
              }),
            `inject-${f.name}`,
          ),
        ),
      ),
    );

    const TestSubset = z.object({ tests: z.array(Test) }).strict();

    const subsets = await phase('emit-tests', () =>
      Promise.all(
        features.items.map((f) =>
          withRetries(
            (id) =>
              session(id, {
                with: CONFIG.model,
                task: [
                  `Emit UI tests for feature "${f.name}" targeting ${CONFIG.baseUrl}.`,
                  '',
                  `Views covered: ${f.views.join(', ')}.`,
                  '',
                  'Rules:',
                  `- Each test id follows "feature.subfeature.action" and starts with "${f.name}.".`,
                  '- Each steps[] entry uses only: goto, click, type, hover, wait, snapshot,',
                  '  select, check, uncheck, press.',
                  '- target values follow "feature.view.element.action" (match the testids we just injected).',
                  '- Snapshot names are snake_case and unique within a single test.',
                  '- depends_on lists other test ids in this feature that must run first.',
                  '- Cover each view with at least one test; include at least one snapshot per test.',
                  '',
                  'Return { tests: Test[] }.',
                ].join('\n'),
                dependsOn: [`inject-${f.name}`],
                schema: TestSubset,
                timeoutMs: 300_000,
              }),
            `tests-${f.name}`,
          ),
        ),
      ),
    );

    await phase('merge-validate', async () => {
      const plan = Plan.parse({
        version: 1,
        globals: { base_url: CONFIG.baseUrl },
        tests: subsets.flatMap((s) => s.tests),
      });
      const outPath = resolve(CONFIG.projectRoot, CONFIG.planPath);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, YAML.stringify(plan), 'utf8');
      console.log(`[ui-plan] wrote ${plan.tests.length} tests to ${outPath}`);
    });
  });
}

void main();
