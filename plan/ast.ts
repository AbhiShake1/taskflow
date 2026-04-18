// AST-only walker that converts a taskflow authoring file into a static PlanNode
// tree. No user code executes; nothing is type-checked. We pattern-match the
// shapes the fluent API expects and downgrade everything else to PlanUnknown.
//
// Design ethos: robustness > completeness. If a pattern is ambiguous or
// dynamic, emit a PlanUnknown with a human-readable reason and an excerpt of
// the source — never throw, never guess semantics.

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as ts from 'typescript';
import { parseWith } from '../api/parseWith';

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

export type PlanNode = PlanRoot | PlanPhase | PlanSession | PlanUnknown;

export interface PlanRoot {
  kind: 'root';
  name: string;
  rules?: string;
  children: Array<PlanPhase | PlanSession | PlanUnknown>;
  sourcePath: string;
}

export interface PlanPhase {
  kind: 'phase';
  name: string;
  parallel: boolean;
  expandHint?: number;
  awaited: boolean;
  children: Array<PlanPhase | PlanSession | PlanUnknown>;
}

export interface PlanSession {
  kind: 'session';
  id: string;
  idIsDynamic: boolean;
  agent: string;
  model?: string;
  task: string;
  write?: string[];
  timeoutMs?: number;
  schemaName?: string;
  schemaPreview?: string;
  awaited: boolean;
}

export interface PlanUnknown {
  kind: 'unknown';
  reason: string;
  sourceExcerpt: string;
}

// ---------------------------------------------------------------------------
// Context carried through the recursion
// ---------------------------------------------------------------------------

interface WalkCtx {
  sf: ts.SourceFile;
  /** Bindings for literal substitution inside template strings (e.g. loop vars). */
  bindings: Map<string, string | number>;
  /** Module-scope `const foo = z.object({...})` bindings, used to resolve schema identifiers. */
  schemaBindings: Map<string, ts.Expression>;
  /** Module-scope `const CWD = process.cwd()` style bindings → replacement token. */
  specialIdents: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function planFromFile(filePath: string): PlanRoot {
  const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  const source = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const ctx: WalkCtx = {
    sf,
    bindings: new Map(),
    schemaBindings: new Map(),
    specialIdents: new Map(),
  };

  collectModuleBindings(sf, ctx);

  const rootCall = findTaskflowRootCall(sf);
  if (!rootCall) {
    return {
      kind: 'root',
      name: '<unknown>',
      children: [{
        kind: 'unknown',
        reason: 'no `taskflow(...)` call found in file',
        sourceExcerpt: truncate(source, 200),
      }],
      sourcePath: abs,
    };
  }

  const { name, rules, runFn } = rootCall;
  const children: PlanRoot['children'] = [];
  if (runFn) {
    const bodyStatements = extractFunctionBody(runFn);
    if (bodyStatements) {
      for (const stmt of bodyStatements) {
        walkStatement(stmt, ctx, children);
      }
    } else {
      children.push({
        kind: 'unknown',
        reason: '.run() body is not an arrow/function expression we can read',
        sourceExcerpt: excerpt(runFn, sf),
      });
    }
  } else {
    children.push({
      kind: 'unknown',
      reason: 'no `.run(...)` call found',
      sourceExcerpt: excerpt(rootCall.callNode, sf),
    });
  }

  const root: PlanRoot = { kind: 'root', name, children, sourcePath: abs };
  if (rules !== undefined) root.rules = rules;
  return root;
}

// ---------------------------------------------------------------------------
// Module-scope binding collection
// ---------------------------------------------------------------------------

function collectModuleBindings(sf: ts.SourceFile, ctx: WalkCtx): void {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const name = decl.name.text;
      const init = decl.initializer;

      // Special-case `const CWD = process.cwd()` so string tasks stay readable.
      if (
        ts.isCallExpression(init) &&
        ts.isPropertyAccessExpression(init.expression) &&
        ts.isIdentifier(init.expression.expression) &&
        init.expression.expression.text === 'process' &&
        init.expression.name.text === 'cwd'
      ) {
        ctx.specialIdents.set(name, '<cwd>');
        continue;
      }

      // Track anything that starts with a call to `z.` as a candidate zod schema.
      if (isZodSchemaExpression(init)) {
        ctx.schemaBindings.set(name, init);
      }
    }
  }
}

function isZodSchemaExpression(expr: ts.Expression): boolean {
  // Walk left through .chain() calls until we find z.something() or z itself.
  let cur: ts.Expression = expr;
  for (let hops = 0; hops < 20; hops++) {
    if (ts.isCallExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    break;
  }
  return ts.isIdentifier(cur) && cur.text === 'z';
}

// ---------------------------------------------------------------------------
// Locate the top-level taskflow(...).run(...) call
// ---------------------------------------------------------------------------

interface RootCallInfo {
  name: string;
  rules?: string;
  runFn?: ts.Expression;
  callNode: ts.Node;
}

function findTaskflowRootCall(sf: ts.SourceFile): RootCallInfo | undefined {
  let out: RootCallInfo | undefined;
  const visit = (node: ts.Node): void => {
    if (out) return;
    if (ts.isCallExpression(node)) {
      const info = matchTaskflowChain(node);
      if (info) {
        out = info;
        return;
      }
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return out;
}

/**
 * Match a chain ending in `.run(<fn>, ...)`. Walks left through the call chain
 * collecting `.rules(...)` and finally expects the innermost head to be
 * `taskflow('name')`. Intermediate nodes like `.env({...})` are skipped.
 */
function matchTaskflowChain(call: ts.CallExpression): RootCallInfo | undefined {
  // The outermost call must be `.run(...)`.
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  if (call.expression.name.text !== 'run') return undefined;

  const runFn = call.arguments[0];
  let cur: ts.Expression = call.expression.expression;
  let rules: string | undefined;
  let name: string | undefined;

  for (let hops = 0; hops < 20; hops++) {
    if (ts.isCallExpression(cur)) {
      if (ts.isPropertyAccessExpression(cur.expression)) {
        const method = cur.expression.name.text;
        if (method === 'rules') {
          const arg = cur.arguments[0];
          if (arg && ts.isStringLiteral(arg)) rules = arg.text;
        }
        // .env() and other chained methods: skip silently.
        cur = cur.expression.expression;
        continue;
      }
      if (ts.isIdentifier(cur.expression) && cur.expression.text === 'taskflow') {
        const arg = cur.arguments[0];
        if (arg && ts.isStringLiteral(arg)) name = arg.text;
        break;
      }
      return undefined;
    }
    return undefined;
  }

  if (name === undefined) return undefined;
  const info: RootCallInfo = { name, callNode: call };
  if (rules !== undefined) info.rules = rules;
  if (runFn !== undefined) info.runFn = runFn;
  return info;
}

// ---------------------------------------------------------------------------
// Body extraction + statement walking
// ---------------------------------------------------------------------------

/**
 * Given the body expression of `.run(<expr>, ...)` or `phase('x', <expr>)`,
 * return the list of statements inside. Handles both:
 *   async ({ phase, session }) => { ...stmts... }
 *   async () => session(...) // implicit-return arrow (lifted into ExpressionStatement)
 */
function extractFunctionBody(expr: ts.Expression): ts.Statement[] | undefined {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    const body = expr.body;
    if (ts.isBlock(body)) return [...body.statements];
    // Implicit-return arrow body: model it as an explicit ReturnStatement so
    // the walker treats the expression as awaited (phase/run awaits the body).
    return [ts.factory.createReturnStatement(body)];
  }
  return undefined;
}

function walkStatement(
  stmt: ts.Statement,
  ctx: WalkCtx,
  out: Array<PlanPhase | PlanSession | PlanUnknown>,
): void {
  if (ts.isExpressionStatement(stmt)) {
    walkExpression(stmt.expression, ctx, out, /*awaited*/ false);
    return;
  }
  if (ts.isReturnStatement(stmt)) {
    // A phase/run body's return value is awaited by the caller, so treat the
    // returned expression as awaited. This avoids false "(fire-and-forget)"
    // tags on `return session(...)` and `return Promise.all([...])`.
    if (stmt.expression) walkExpression(stmt.expression, ctx, out, /*awaited*/ true);
    return;
  }
  if (ts.isVariableStatement(stmt)) {
    // `const x = await phase('foo', body)` / `const x = await session(...)`
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      walkExpression(decl.initializer, ctx, out, /*awaited*/ false);
    }
    return;
  }
  if (ts.isIfStatement(stmt)) {
    const branchOut: PlanRoot['children'] = [];
    walkStatement(stmt.thenStatement, ctx, branchOut);
    if (stmt.elseStatement) walkStatement(stmt.elseStatement, ctx, branchOut);
    for (const b of branchOut) {
      if (b.kind === 'session') {
        // Annotate conditional origin.
        b.id = `${b.id} (conditional)`;
      }
      out.push(b);
    }
    return;
  }
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) walkStatement(s, ctx, out);
    return;
  }
  // Other statement shapes: note an unknown and continue.
  out.push({
    kind: 'unknown',
    reason: `unhandled statement kind: ${ts.SyntaxKind[stmt.kind]}`,
    sourceExcerpt: excerpt(stmt, ctx.sf),
  });
}

function walkExpression(
  expr: ts.Expression,
  ctx: WalkCtx,
  out: Array<PlanPhase | PlanSession | PlanUnknown>,
  awaited: boolean,
): void {
  // Await <inner>
  if (ts.isAwaitExpression(expr)) {
    walkExpression(expr.expression, ctx, out, /*awaited*/ true);
    return;
  }

  // .catch(...) — used for fire-and-forget sessions; unwrap the receiver.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === 'catch'
  ) {
    walkExpression(expr.expression.expression, ctx, out, awaited);
    return;
  }

  if (!ts.isCallExpression(expr)) {
    // Raw identifier / literal — not actionable.
    return;
  }

  // session(...), phase(...), Promise.all(...)
  if (ts.isIdentifier(expr.expression)) {
    const callee = expr.expression.text;
    if (callee === 'session') {
      out.push(parseSessionCall(expr, ctx, awaited));
      return;
    }
    if (callee === 'phase') {
      out.push(parsePhaseCall(expr, ctx, awaited));
      return;
    }
  }
  if (
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === 'Promise' &&
    expr.expression.name.text === 'all'
  ) {
    out.push(parsePromiseAll(expr, ctx));
    return;
  }

  // Unknown helper/method call: mark it.
  out.push({
    kind: 'unknown',
    reason: `helper function unresolvable: ${excerpt(expr.expression, ctx.sf, 60)}`,
    sourceExcerpt: excerpt(expr, ctx.sf),
  });
}

// ---------------------------------------------------------------------------
// phase(...) / session(...) parsers
// ---------------------------------------------------------------------------

function parsePhaseCall(call: ts.CallExpression, ctx: WalkCtx, awaited: boolean): PlanPhase | PlanUnknown {
  const [nameArg, bodyArg] = call.arguments;
  if (!nameArg || !ts.isStringLiteral(nameArg)) {
    return {
      kind: 'unknown',
      reason: 'phase() called without a literal name',
      sourceExcerpt: excerpt(call, ctx.sf),
    };
  }
  const children: PlanRoot['children'] = [];
  const stmts = bodyArg ? extractFunctionBody(bodyArg) : undefined;
  let parallel = false;
  let expandHint: number | undefined;

  if (stmts) {
    for (const stmt of stmts) walkStatement(stmt, ctx, children);
    // If the phase body's *only* yield was a Promise.all that produced a
    // parallel PlanPhase, hoist that parallelism to this phase so the tree
    // stays flat at the expected two-level depth.
    if (children.length === 1 && children[0].kind === 'phase' && children[0].name === '<parallel>') {
      parallel = true;
      expandHint = children[0].expandHint;
      children.splice(0, 1, ...children[0].children);
    }
  } else if (bodyArg) {
    children.push({
      kind: 'unknown',
      reason: 'phase() body is not an inline function',
      sourceExcerpt: excerpt(bodyArg, ctx.sf),
    });
  }

  const phase: PlanPhase = { kind: 'phase', name: nameArg.text, parallel, awaited, children };
  if (expandHint !== undefined) phase.expandHint = expandHint;
  return phase;
}

function parseSessionCall(call: ts.CallExpression, ctx: WalkCtx, awaited: boolean): PlanSession | PlanUnknown {
  const [idArg, specArg] = call.arguments;
  if (!idArg) {
    return {
      kind: 'unknown',
      reason: 'session() called with no id',
      sourceExcerpt: excerpt(call, ctx.sf),
    };
  }

  const { value: id, dynamic } = resolveStringLike(idArg, ctx);

  if (!specArg || !ts.isObjectLiteralExpression(specArg)) {
    return {
      kind: 'unknown',
      reason: 'session() called without an object literal spec',
      sourceExcerpt: excerpt(call, ctx.sf),
    };
  }

  const spec = readObjectLiteral(specArg, ctx);
  const withStr = spec.with && typeof spec.with === 'string' ? spec.with : undefined;
  let agent = '<unknown>';
  let model: string | undefined;
  if (withStr) {
    try {
      const p = parseWith(withStr);
      agent = p.agent;
      model = p.model;
    } catch {
      agent = `<invalid-with: ${withStr}>`;
    }
  }

  const session: PlanSession = {
    kind: 'session',
    id,
    idIsDynamic: dynamic,
    agent,
    task: typeof spec.task === 'string' ? spec.task : '',
    awaited,
  };
  if (model !== undefined) session.model = model;
  if (Array.isArray(spec.write)) session.write = spec.write.filter((x): x is string => typeof x === 'string');
  if (typeof spec.timeoutMs === 'number') session.timeoutMs = spec.timeoutMs;

  // Schema: either an Identifier pointing at a module-scope z.object(...) or
  // an inline expression. Try to JSON-schema it.
  const schemaNode = spec._schemaNode;
  if (schemaNode) {
    if (ts.isIdentifier(schemaNode)) {
      session.schemaName = schemaNode.text;
      const bound = ctx.schemaBindings.get(schemaNode.text);
      if (bound) {
        const preview = tryJsonSchemaForZodExpression(bound, ctx);
        if (preview) session.schemaPreview = preview;
      }
    } else {
      session.schemaName = '<inline>';
      const preview = tryJsonSchemaForZodExpression(schemaNode, ctx);
      if (preview) session.schemaPreview = preview;
    }
  }

  return session;
}

// ---------------------------------------------------------------------------
// Promise.all / .map handling
// ---------------------------------------------------------------------------

function parsePromiseAll(call: ts.CallExpression, ctx: WalkCtx): PlanPhase | PlanUnknown {
  const [arrArg] = call.arguments;
  if (!arrArg) {
    return { kind: 'unknown', reason: 'Promise.all() called with no arguments', sourceExcerpt: excerpt(call, ctx.sf) };
  }

  // Case 1: array literal of sessions/phases. Treat the parent Promise.all's
  // await as an effective await for each element — they are not orphaned.
  if (ts.isArrayLiteralExpression(arrArg)) {
    const kids: PlanRoot['children'] = [];
    for (const el of arrArg.elements) {
      if (ts.isCallExpression(el)) {
        walkExpression(el, ctx, kids, /*awaited*/ true);
      } else {
        kids.push({
          kind: 'unknown',
          reason: 'Promise.all array element is not a direct session/phase call',
          sourceExcerpt: excerpt(el, ctx.sf),
        });
      }
    }
    return { kind: 'phase', name: '<parallel>', parallel: true, awaited: true, children: kids };
  }

  // Case 2: [...literals].map((v, i) => session(...))
  if (
    ts.isCallExpression(arrArg) &&
    ts.isPropertyAccessExpression(arrArg.expression) &&
    arrArg.expression.name.text === 'map'
  ) {
    const recv = arrArg.expression.expression;
    const fn = arrArg.arguments[0];
    if (ts.isArrayLiteralExpression(recv) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      const elems = recv.elements;
      const literalElems: Array<string | number> = [];
      let everyLiteral = true;
      for (const e of elems) {
        if (ts.isNumericLiteral(e)) literalElems.push(Number(e.text));
        else if (ts.isStringLiteral(e)) literalElems.push(e.text);
        else { everyLiteral = false; break; }
      }

      if (everyLiteral && fn.parameters.length > 0) {
        const kids: PlanRoot['children'] = [];
        const param0 = fn.parameters[0];
        const param1 = fn.parameters[1];
        const name0 = param0 && ts.isIdentifier(param0.name) ? param0.name.text : undefined;
        const name1 = param1 && ts.isIdentifier(param1.name) ? param1.name.text : undefined;

        for (let idx = 0; idx < literalElems.length; idx++) {
          const savedVal = name0 ? ctx.bindings.get(name0) : undefined;
          const savedIdx = name1 ? ctx.bindings.get(name1) : undefined;
          if (name0) ctx.bindings.set(name0, literalElems[idx]);
          if (name1) ctx.bindings.set(name1, idx);
          try {
            const body = (fn as ts.ArrowFunction | ts.FunctionExpression).body;
            if (ts.isBlock(body)) {
              for (const s of body.statements) walkStatement(s, ctx, kids);
            } else {
              // Implicit-return arrow body. The surrounding Promise.all awaits
              // the resulting promise, so treat the session/phase as awaited.
              walkExpression(body, ctx, kids, /*awaited*/ true);
            }
          } finally {
            if (name0) {
              if (savedVal === undefined) ctx.bindings.delete(name0);
              else ctx.bindings.set(name0, savedVal);
            }
            if (name1) {
              if (savedIdx === undefined) ctx.bindings.delete(name1);
              else ctx.bindings.set(name1, savedIdx);
            }
          }
        }
        return { kind: 'phase', name: '<parallel>', parallel: true, awaited: true, children: kids };
      }

      // Non-literal array receiver — can't expand. Emit one placeholder session
      // with expandHint when the length is statically knowable.
      const expandHint = ts.isArrayLiteralExpression(recv) ? recv.elements.length : undefined;
      const placeholder: PlanPhase = {
        kind: 'phase',
        name: '<parallel>',
        parallel: true,
        awaited: true,
        children: [{
          kind: 'unknown',
          reason: 'Promise.all + .map over non-literal values — cannot expand statically',
          sourceExcerpt: excerpt(arrArg, ctx.sf),
        }],
      };
      if (expandHint !== undefined) placeholder.expandHint = expandHint;
      return placeholder;
    }

    // Map over a non-array receiver (e.g. `discovered.urls.slice(0, 4).map(...)`).
    // Try to parse the mapper body statically to surface shape information.
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      const kids: PlanRoot['children'] = [];
      const param0 = fn.parameters[0];
      const param1 = fn.parameters[1];
      const name0 = param0 && ts.isIdentifier(param0.name) ? param0.name.text : undefined;
      const name1 = param1 && ts.isIdentifier(param1.name) ? param1.name.text : undefined;

      const savedVal = name0 ? ctx.bindings.get(name0) : undefined;
      const savedIdx = name1 ? ctx.bindings.get(name1) : undefined;
      if (name0) ctx.bindings.set(name0, `\${${name0}}`);
      if (name1) ctx.bindings.set(name1, 0);
      try {
        const body = (fn as ts.ArrowFunction | ts.FunctionExpression).body;
        if (ts.isBlock(body)) {
          for (const s of body.statements) walkStatement(s, ctx, kids);
        } else {
          // Implicit-return arrow body under an awaited Promise.all — treat
          // the inner session/phase as awaited (the array's await drives it).
          walkExpression(body, ctx, kids, /*awaited*/ true);
        }
      } finally {
        if (name0) {
          if (savedVal === undefined) ctx.bindings.delete(name0);
          else ctx.bindings.set(name0, savedVal);
        }
        if (name1) {
          if (savedIdx === undefined) ctx.bindings.delete(name1);
          else ctx.bindings.set(name1, savedIdx);
        }
      }

      return {
        kind: 'phase',
        name: '<parallel>',
        parallel: true,
        awaited: true,
        children: kids.length > 0 ? kids : [{
          kind: 'unknown',
          reason: 'Promise.all + .map over dynamic array; showing one representative child',
          sourceExcerpt: excerpt(arrArg, ctx.sf),
        }],
      };
    }
  }

  return {
    kind: 'unknown',
    reason: 'Promise.all argument is neither an array literal nor a .map(...) expression',
    sourceExcerpt: excerpt(arrArg, ctx.sf),
  };
}

// ---------------------------------------------------------------------------
// Small AST utilities: read object literals, resolve strings, serialize zod
// ---------------------------------------------------------------------------

interface ReadLiteral {
  with?: string;
  task?: string;
  write?: unknown[];
  timeoutMs?: number;
  rulesPrefix?: boolean;
  _schemaNode?: ts.Expression;
}

function readObjectLiteral(obj: ts.ObjectLiteralExpression, ctx: WalkCtx): ReadLiteral {
  const out: ReadLiteral = {};
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const key = prop.name.text;
    const val = prop.initializer;
    if (key === 'with') {
      const r = resolveStringLike(val, ctx);
      out.with = r.value;
    } else if (key === 'task') {
      const r = resolveStringLike(val, ctx);
      out.task = r.value;
    } else if (key === 'write') {
      if (ts.isArrayLiteralExpression(val)) {
        out.write = val.elements.map(el => resolveStringLike(el, ctx).value);
      }
    } else if (key === 'timeoutMs') {
      if (ts.isNumericLiteral(val)) out.timeoutMs = Number(val.text);
    } else if (key === 'rulesPrefix') {
      if (val.kind === ts.SyntaxKind.TrueKeyword) out.rulesPrefix = true;
      else if (val.kind === ts.SyntaxKind.FalseKeyword) out.rulesPrefix = false;
    } else if (key === 'schema') {
      out._schemaNode = val;
    }
  }
  return out;
}

/**
 * Resolve any string-ish expression (string literal, template, concatenation,
 * known identifier) into a plain string, flagging whether any dynamic pieces
 * are present.
 */
function resolveStringLike(expr: ts.Expression, ctx: WalkCtx): { value: string; dynamic: boolean } {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { value: expr.text, dynamic: false };
  }
  if (ts.isTemplateExpression(expr)) {
    let dyn = false;
    let s = expr.head.text;
    for (const span of expr.templateSpans) {
      const sub = span.expression;
      if (ts.isIdentifier(sub)) {
        const key = sub.text;
        if (ctx.bindings.has(key)) {
          s += String(ctx.bindings.get(key));
        } else if (ctx.specialIdents.has(key)) {
          s += ctx.specialIdents.get(key);
        } else {
          s += '${?}';
          dyn = true;
        }
      } else if (ts.isNumericLiteral(sub) || ts.isStringLiteral(sub)) {
        s += sub.text;
      } else {
        // Any non-trivial substitution is dynamic.
        s += '${?}';
        dyn = true;
      }
      s += span.literal.text;
    }
    return { value: s, dynamic: dyn };
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolveStringLike(expr.left, ctx);
    const r = resolveStringLike(expr.right, ctx);
    return { value: l.value + r.value, dynamic: l.dynamic || r.dynamic };
  }
  if (ts.isIdentifier(expr)) {
    const key = expr.text;
    if (ctx.bindings.has(key)) return { value: String(ctx.bindings.get(key)), dynamic: false };
    if (ctx.specialIdents.has(key)) return { value: ctx.specialIdents.get(key)!, dynamic: false };
    return { value: `\${${key}}`, dynamic: true };
  }
  if (ts.isNumericLiteral(expr)) return { value: expr.text, dynamic: false };
  return { value: excerpt(expr, ctx.sf, 60), dynamic: true };
}

// ---------------------------------------------------------------------------
// Zod-schema serialization. Tries to `new Function(...)` the schema expression
// in an isolated scope that only exposes `z`, then runs `z.toJSONSchema(...)`.
// Any failure silently yields undefined — we treat this as best-effort.
// ---------------------------------------------------------------------------

function tryJsonSchemaForZodExpression(expr: ts.Expression, ctx: WalkCtx): string | undefined {
  const src = ctx.sf.getFullText().slice(expr.getStart(ctx.sf), expr.getEnd());
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    // Load zod lazily; we ship it as a dep already.
    const zmod: typeof import('zod') = require('zod');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const build = new Function('z', `return (${src});`) as (z: typeof zmod.z) => unknown;
    const schema = build(zmod.z);
    if (schema && typeof schema === 'object') {
      const json = zmod.toJSONSchema(schema as never);
      return JSON.stringify(json, null, 2);
    }
  } catch {
    /* best-effort */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Source excerpt helpers
// ---------------------------------------------------------------------------

function excerpt(node: ts.Node, sf: ts.SourceFile, max = 140): string {
  const text = sf.getFullText().slice(node.getStart(sf), node.getEnd());
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

// Keep the `dirname` import referenced for tooling that prunes unused imports.
void dirname;
