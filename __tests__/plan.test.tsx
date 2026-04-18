// Static-preview ("plan mode") tests. These exercise the AST walker in
// plan/ast.ts and the Ink render in plan/render.tsx. They must NEVER execute
// the user module; they read files from disk as text only.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { describe, it, expect, afterAll } from 'vitest';
import { render } from 'ink-testing-library';
import { planFromFile, type PlanPhase, type PlanSession, type PlanUnknown } from '../plan/ast';
import { preparePlanStore, PlanApp } from '../plan/render';

// Track every temp file so we can sweep at the end — otherwise CI clutters /tmp.
const created: string[] = [];
const tmpRoot = mkdtempSync(join(tmpdir(), 'plan-test-'));
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const f of created) { try { rmSync(f, { force: true }); } catch { /* noop */ } }
});

function writeFixture(name: string, src: string): string {
  const p = join(tmpRoot, name);
  writeFileSync(p, src, 'utf8');
  created.push(p);
  return p;
}

// ---------------------------------------------------------------------------

describe('planFromFile: serial pipeline', () => {
  it('parses tasks/pipeline.ts into the expected phase/session tree', () => {
    const root = planFromFile('tasks/pipeline.ts');
    expect(root.kind).toBe('root');
    expect(root.name).toBe('pipeline');
    expect(root.children).toHaveLength(3);

    const [discover, compute, aggregate] = root.children as [PlanPhase, PlanPhase, PlanPhase];
    expect(discover.kind).toBe('phase');
    expect(discover.name).toBe('discover');
    expect(discover.parallel).toBe(false);
    expect(discover.children).toHaveLength(1);
    const emit = discover.children[0] as PlanSession;
    expect(emit.id).toBe('emit-nums');
    expect(emit.agent).toBe('claude-code');
    expect(emit.model).toBe('sonnet');
    expect(emit.write).toEqual(['data/pipeline/nums.json']);

    expect(compute.name).toBe('compute');
    expect(compute.parallel).toBe(true);
    expect(compute.children).toHaveLength(3);
    const ids = compute.children.map(c => (c as PlanSession).id);
    expect(ids).toEqual(['square-0', 'square-1', 'square-2']);
    expect((compute.children[0] as PlanSession).write).toEqual(['data/pipeline/chunk-0.json']);

    expect(aggregate.name).toBe('aggregate');
    expect(aggregate.parallel).toBe(false);
    expect(aggregate.children).toHaveLength(1);
    expect((aggregate.children[0] as PlanSession).id).toBe('sum-all');
  });
});

describe('planFromFile: Promise.all + map over literal array', () => {
  it('expands map over [0,1,2,3] into four PlanSessions with shard-0..shard-3', () => {
    const p = writeFixture('map-literal.ts', `
      import { taskflow } from '../../api';
      export default taskflow('m').run(async ({ phase, session }) => {
        await phase('fan', async () => {
          await Promise.all(
            [0,1,2,3].map((i) =>
              session(\`shard-\${i}\`, { with: 'claude-code:sonnet', task: 'go', write: [\`data/s-\${i}.json\`] })
            )
          );
        });
      });
    `);
    const root = planFromFile(p);
    const fan = root.children[0] as PlanPhase;
    expect(fan.parallel).toBe(true);
    expect(fan.children).toHaveLength(4);
    const ids = fan.children.map(c => (c as PlanSession).id);
    expect(ids).toEqual(['shard-0', 'shard-1', 'shard-2', 'shard-3']);
    const writes = (fan.children[2] as PlanSession).write;
    expect(writes).toEqual(['data/s-2.json']);
  });
});

describe('planFromFile: dynamic id fallback', () => {
  it('marks idIsDynamic and inserts a ${?} placeholder for unresolvable identifiers', () => {
    const p = writeFixture('dynamic-id.ts', `
      import { taskflow } from '../../api';
      export default taskflow('d').run(async ({ session }) => {
        const dynamicVar = process.env.SHARD ?? 'x';
        await session(\`shard-\${dynamicVar}\`, { with: 'claude-code:sonnet', task: 'go' });
      });
    `);
    const root = planFromFile(p);
    const s = root.children[0] as PlanSession;
    expect(s.idIsDynamic).toBe(true);
    expect(s.id).toContain('${?}');
  });
});

describe('planFromFile: unknown patterns', () => {
  it('emits PlanUnknown for a helper function call we cannot resolve', () => {
    const p = writeFixture('helper.ts', `
      import { taskflow } from '../../api';
      function spawnFamily() { return Promise.resolve(); }
      export default taskflow('h').run(async () => {
        await spawnFamily();
      });
    `);
    const root = planFromFile(p);
    const u = root.children[0] as PlanUnknown;
    expect(u.kind).toBe('unknown');
    expect(u.reason).toMatch(/helper function/);
  });
});

describe('planFromFile: schema resolution', () => {
  it('captures schemaName and produces a JSON-Schema preview for identifier references', () => {
    const p = writeFixture('schema.ts', `
      import { z } from 'zod';
      import { taskflow } from '../../api';
      const urlsSchema = z.object({ urls: z.array(z.string()) });
      export default taskflow('s').run(async ({ session }) => {
        await session('d', { with: 'claude-code:sonnet', task: 'go', schema: urlsSchema });
      });
    `);
    const root = planFromFile(p);
    const s = root.children[0] as PlanSession;
    expect(s.schemaName).toBe('urlsSchema');
    expect(s.schemaPreview).toBeDefined();
    expect(s.schemaPreview).toContain('"type": "object"');
    expect(s.schemaPreview).toContain('urls');
  });
});

describe('planFromFile: rules capture', () => {
  it('pulls the .rules() argument onto PlanRoot.rules', () => {
    const p = writeFixture('rules.ts', `
      import { taskflow } from '../../api';
      export default taskflow('r').rules('./rules.md').run(async ({ session }) => {
        await session('x', { with: 'claude-code:sonnet', task: 'go' });
      });
    `);
    const root = planFromFile(p);
    expect(root.rules).toBe('./rules.md');
  });
});

describe('planFromFile: fire-and-forget detection', () => {
  it('flags a session call that is not awaited', () => {
    const p = writeFixture('ff.ts', `
      import { taskflow } from '../../api';
      export default taskflow('f').run(async ({ phase, session }) => {
        await phase('p', async () => {
          session('loose', { with: 'claude-code:sonnet', task: 'fire and forget' }).catch(() => {});
          await session('tight', { with: 'claude-code:sonnet', task: 'waited' });
        });
      });
    `);
    const root = planFromFile(p);
    const phase = root.children[0] as PlanPhase;
    const [loose, tight] = phase.children as [PlanSession, PlanSession];
    expect(loose.awaited).toBe(false);
    expect(tight.awaited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Render smoke: the Ink frame contains every key piece of the plan tree.
// ---------------------------------------------------------------------------

describe('renderPlan: dependsOn topological ordering', () => {
  it('reorders sibling sessions so deps appear before dependents in the rendered tree', () => {
    const src = `
import { taskflow } from '../api/index';
export default taskflow('dag-preview').run(async ({ session }) => {
  await Promise.all([
    session('merge', { with: 'claude-code', task: 'merge a+b', dependsOn: ['plan-a', 'plan-b'] }),
    session('plan-a', { with: 'claude-code', task: 'plan a' }),
    session('plan-b', { with: 'claude-code', task: 'plan b' }),
  ]);
});
`;
    const fixture = writeFixture('dag-preview.ts', src);
    const root = planFromFile(fixture);
    const { store, headerLine } = preparePlanStore(root);
    const { lastFrame } = render(<PlanApp store={store} headerLine={headerLine} />);
    const frame = lastFrame() ?? '';

    const idxPlanA = frame.indexOf('plan-a');
    const idxPlanB = frame.indexOf('plan-b');
    const idxMerge = frame.indexOf('merge');
    expect(idxPlanA).toBeGreaterThan(-1);
    expect(idxPlanB).toBeGreaterThan(-1);
    expect(idxMerge).toBeGreaterThan(-1);
    expect(idxPlanA).toBeLessThan(idxMerge);
    expect(idxPlanB).toBeLessThan(idxMerge);
    expect(frame).toContain('⇠ plan-a, plan-b');
  });
});

describe('renderPlan: Ink frame smoke', () => {
  it('renders pipeline.ts with every session id, agent/model, write path, and parallel count', () => {
    const root = planFromFile('tasks/pipeline.ts');
    const { store, headerLine } = preparePlanStore(root);
    const { lastFrame } = render(<PlanApp store={store} headerLine={headerLine} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('pipeline');
    expect(frame).toContain('emit-nums');
    expect(frame).toContain('square-0');
    expect(frame).toContain('square-1');
    expect(frame).toContain('square-2');
    expect(frame).toContain('sum-all');
    expect(frame).toContain('claude-code');
    expect(frame).toContain('sonnet');
    expect(frame).toContain('parallel');
    // Glyph check — every node in plan state shows ◯.
    expect(frame).toContain('◯');
  });
});
