import type {
  Spec,
  RawNode,
  RawLeafSpec,
  RawStageSpec,
} from './schema';

/**
 * Deterministic YAML-spec -> TypeScript emitter.
 *
 * Pure function: no I/O, no globals. Same input -> byte-identical output.
 *
 * Fan-out (`expand`, `foreach`, `repeat`) is UNROLLED at build time.
 * Template vars (`{i}`, `{shard}`, ...) inside leaf/stage ids, tasks, and
 * claims are substituted AT EMIT TIME from the enclosing loop scope.
 *
 * Callers may supply an `initialScope` — a pre-populated outer scope that
 * seeds the root stage's recursion. `cli.ts` uses this to inject the build
 * machine's `process.cwd()` as `{cwd}`, so specs can write absolute-path
 * references like `{cwd}/data/smoke/hello.txt` without hard-coding them.
 *
 * `initialScope` is OPTIONAL and defaults to `{}`, so callers that don't
 * supply one (tests, golden fixtures) produce byte-identical output to the
 * pre-feature behavior.
 */

const INDENT = '  ';

type Scope = Readonly<Record<string, string | number>>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function emit(
  spec: Spec,
  sourceName: string = '<spec>',
  initialScope: Scope = {},
): string {
  const header = renderHeader(sourceName);
  const optsLiteral = renderHarnessOpts(spec);

  const body = renderNode(spec.root, /*indentLevel=*/ 1, /*scope=*/ initialScope);

  const lines: string[] = [];
  lines.push(header);
  lines.push(`import { harness, stage, leaf, parallel } from '../core';`);
  lines.push('');
  // Emit top-level `await harness(...)` so a host that `await import()`s this
  // module waits for the full run to finish before its import promise resolves.
  // Errors propagate — the runner (harness/runner/index.ts) catches them and
  // sets process.exitCode = 1.
  lines.push(
    `await harness(${q(spec.name)}, ${optsLiteral}, async (h) => {`,
  );
  lines.push(body);
  lines.push(`});`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Header + harness opts
// ---------------------------------------------------------------------------

function renderHeader(sourceName: string): string {
  const bar =
    '// ----------------------------------------------------------------------------';
  return [
    bar,
    `// AUTO-GENERATED FROM ${sourceName}. DO NOT EDIT.`,
    `// Regenerate with: npm run build ${sourceName}`,
    bar,
  ].join('\n');
}

function renderHarnessOpts(spec: Spec): string {
  if (spec.rulesFile === undefined) return '{}';
  return `{ rulesFile: ${q(spec.rulesFile)} }`;
}

// ---------------------------------------------------------------------------
// Node dispatch
// ---------------------------------------------------------------------------

function renderNode(
  node: RawNode,
  indentLevel: number,
  scope: Scope,
): string {
  if (isLeaf(node)) {
    return renderLeaf(node, indentLevel, scope);
  }
  return renderStage(node, indentLevel, scope);
}

function isLeaf(node: RawNode): node is RawLeafSpec {
  return (node as RawLeafSpec).leaf !== undefined;
}

// ---------------------------------------------------------------------------
// Stage rendering
// ---------------------------------------------------------------------------

/**
 * Render a stage.
 *
 * The stage wrapper `await stage(h, '<id>', async () => { ... })` is emitted
 * exactly ONCE; the fan-out directive (`expand` / `foreach` / `repeat`) is
 * unrolled across the *steps inside*, producing one step-set per iteration.
 *
 * Example — `stage: fetch / parallel: true / expand: {count:4, as:i}`:
 *
 *   await stage(h, 'fetch', async () => {
 *     await parallel(h, [
 *       () => leaf(h, { id: 'shard-0', ... }),
 *       () => leaf(h, { id: 'shard-1', ... }),
 *       () => leaf(h, { id: 'shard-2', ... }),
 *       () => leaf(h, { id: 'shard-3', ... }),
 *     ]);
 *   });
 */
function renderStage(
  stage: RawStageSpec,
  indentLevel: number,
  scope: Scope,
): string {
  const pad = INDENT.repeat(indentLevel);
  const innerPad = INDENT.repeat(indentLevel + 1);
  const stageId = interpolate(stage.stage, scope);

  const iterScopes = iterationScopes(stage, scope);

  const lines: string[] = [];
  lines.push(`${pad}await stage(h, ${q(stageId)}, async () => {`);

  if (stage.parallel) {
    // Emit all steps across all iterations as a single flat parallel array.
    lines.push(`${innerPad}await parallel(h, [`);
    for (const iterScope of iterScopes) {
      for (const step of stage.steps) {
        lines.push(`${renderStepAsThunk(step, indentLevel + 2, iterScope)},`);
      }
    }
    lines.push(`${innerPad}]);`);
  } else {
    // Serial: emit each step directly, unrolled per iteration in order.
    for (const iterScope of iterScopes) {
      for (const step of stage.steps) {
        lines.push(renderNode(step, indentLevel + 1, iterScope));
      }
    }
  }

  lines.push(`${pad}});`);
  return lines.join('\n');
}

/**
 * Compute the ordered per-iteration scopes for a stage's fan-out directive.
 *
 * - no directive        -> [outerScope]
 * - expand  {count, as} -> [{...outer, [as]: 0}, ..., {...outer, [as]: N-1}]
 * - foreach {items, as} -> one scope per item (with `as` bound to the value)
 * - repeat  N           -> N copies of outerScope (binds `_` for consistency)
 *
 * `repeat` is sugar for `expand: {count: N, as: '_'}` + `parallel: false`; the
 * schema forbids combining it with the explicit expand/foreach directives.
 */
function iterationScopes(stage: RawStageSpec, outer: Scope): Scope[] {
  if (stage.expand !== undefined) {
    const { count, as } = stage.expand;
    const out: Scope[] = [];
    for (let i = 0; i < count; i++) {
      out.push({ ...outer, [as]: i });
    }
    return out;
  }
  if (stage.foreach !== undefined) {
    const { items, as } = stage.foreach;
    return items.map((item) => ({ ...outer, [as]: item }));
  }
  if (stage.repeat !== undefined) {
    const out: Scope[] = [];
    for (let i = 0; i < stage.repeat; i++) {
      out.push({ ...outer, _: i });
    }
    return out;
  }
  return [outer];
}

// ---------------------------------------------------------------------------
// Leaf rendering
// ---------------------------------------------------------------------------

function renderLeaf(
  leafSpec: RawLeafSpec,
  indentLevel: number,
  scope: Scope,
): string {
  const pad = INDENT.repeat(indentLevel);
  const obj = renderLeafObject(leafSpec, indentLevel, scope);
  return `${pad}await leaf(h, ${obj});`;
}

function renderLeafObject(
  leafSpec: RawLeafSpec,
  indentLevel: number,
  scope: Scope,
): string {
  // Build the property list in a stable order.
  const props: string[] = [];
  props.push(`id: ${q(interpolate(leafSpec.leaf, scope))}`);
  props.push(`agent: ${q(leafSpec.agent)}`);
  if (leafSpec.model !== undefined) {
    props.push(`model: ${q(leafSpec.model)}`);
  }
  props.push(`task: ${q(interpolate(leafSpec.task, scope))}`);
  if (leafSpec.claims !== undefined) {
    props.push(`claims: ${renderClaims(leafSpec.claims, indentLevel, scope)}`);
  }
  if (leafSpec.timeoutMs !== undefined) {
    props.push(`timeoutMs: ${leafSpec.timeoutMs}`);
  }
  if (leafSpec.rulesPrefix !== undefined) {
    props.push(`rulesPrefix: ${leafSpec.rulesPrefix}`);
  }
  return `{ ${props.join(', ')} }`;
}

/**
 * Emit a leaf as a zero-arg thunk for use inside `parallel(h, [...])`.
 *
 *   () => leaf(h, { ... })
 *
 * For a stage step inside a parallel block we emit an immediately-invoked
 * arrow that awaits the nested stage:
 *
 *   () => (async () => { await stage(h, ...); })()
 *
 * `indentLevel` is the level of the thunk line itself (inside the array).
 */
function renderStepAsThunk(
  step: RawNode,
  indentLevel: number,
  scope: Scope,
): string {
  const pad = INDENT.repeat(indentLevel);
  if (isLeaf(step)) {
    const obj = renderLeafObject(step, indentLevel, scope);
    return `${pad}() => leaf(h, ${obj})`;
  }
  // Nested stage inside a parallel: render its body then wrap.
  const body = renderStage(step, indentLevel + 1, scope);
  const lines: string[] = [];
  lines.push(`${pad}() => (async () => {`);
  lines.push(body);
  lines.push(`${pad}})()`);
  return lines.join('\n');
}

/**
 * Claims array. Short (<= 80 chars on the emitted `claims: [...]` fragment)
 * collapses to a single line; otherwise breaks one-claim-per-line.
 */
function renderClaims(
  claims: string[],
  indentLevel: number,
  scope: Scope,
): string {
  const resolved = claims.map((c) => interpolate(c, scope));
  const singleLine = `[${resolved.map((c) => q(c)).join(', ')}]`;
  // 80 char budget is measured on just the literal fragment; keep it simple.
  if (singleLine.length <= 80) return singleLine;

  const pad = INDENT.repeat(indentLevel + 1);
  const closePad = INDENT.repeat(indentLevel);
  const items = resolved.map((c) => `${pad}${q(c)},`).join('\n');
  return `[\n${items}\n${closePad}]`;
}

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------

/**
 * Emit a single-quoted TS string literal. Escapes backslashes, single quotes,
 * newlines, and carriage returns.
 */
function q(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `'${escaped}'`;
}

/**
 * Substitute `{var}` placeholders using the enclosing scope.
 * Unknown vars throw `emit error: unknown template var "<var>" in "<src>"`.
 *
 * `{{` and `}}` are not special — the YAML side uses plain `{var}` tokens.
 */
function interpolate(input: string, scope: Scope): string {
  return input.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const key = name.trim();
    if (!(key in scope)) {
      throw new Error(
        `emit error: unknown template var "${key}" in "${input}"`,
      );
    }
    return String(scope[key]);
  });
}
