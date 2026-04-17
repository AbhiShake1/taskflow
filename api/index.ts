// Fluent authoring API for taskflow.
//
// This is an ADDITIVE layer on top of the low-level primitives in `../core`.
// It lowers a synchronously-built tree of stages + leaves into calls to
// `harness() / stage() / leaf() / parallel()` without touching the engine.
//
// Design:
//   - `taskflow(name)` returns a builder.
//   - `.rules(path)` / `.env(vars)` are chainable config setters.
//   - `.run(fn)` calls `fn(publicCtx)` SYNCHRONOUSLY to collect the tree, then
//     invokes the engine to execute it.
//   - A single builder instance owns a `currentStageStack` — when a nested
//     `stage(name, cb)` callback fires, we push onto the stack, run the
//     callback, then pop. This is how `const { stage, leaf } = ctx; ...` still
//     targets the right parent while code is inside a `stage(...).stage(...)`
//     callback.
//
// No AsyncLocalStorage: the build phase is fully synchronous, so a plain stack
// is enough and keeps the code obvious.

import {
  harness as engineHarness,
  stage as engineStage,
  leaf as engineLeaf,
  parallel as engineParallel,
  type HarnessOptions,
  type Manifest,
} from '../core';
import type { AgentName, Ctx, LeafSpec as EngineLeafSpec } from '../core/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

const KNOWN_AGENTS: readonly AgentName[] = [
  'claude-code',
  'pi',
  'codex',
  'cursor',
  'opencode',
] as const;

export type PublicLeafSpec = {
  /** Optional: used only in the parallel/serial factory form (`{ id, ... }`). In `.leaf(id, spec)` form the id comes from the first argument. */
  id?: string;
  /** `'agent'` or `'agent:model'`. Split on the FIRST `:`; any further `:` chars stay in `model`. */
  with: string;
  /** Task prompt. */
  task: string;
  /** Files this leaf claims to write (globs). Maps to engine `claims`. */
  write?: string[];
  /** Per-leaf timeout. */
  timeoutMs?: number;
  /** Opt out of the rules prefix for this leaf. */
  rulesPrefix?: boolean;
};

export type PublicCtx = {
  stage(name: string): PublicStageBuilder;
  stage(name: string, body: (ctx: PublicCtx) => void): void;
  leaf(id: string, spec: PublicLeafSpec): void;
  parallel(thunks: Array<() => void>): void;
};

export interface PublicStageBuilder {
  leaf(id: string, spec: PublicLeafSpec): PublicStageBuilder;
  parallel(count: number, factory: (i: number) => PublicLeafSpec): PublicStageBuilder;
  parallel<T>(items: readonly T[], factory: (item: T, i: number) => PublicLeafSpec): PublicStageBuilder;
  serial(count: number, factory: (i: number) => PublicLeafSpec): PublicStageBuilder;
  serial<T>(items: readonly T[], factory: (item: T, i: number) => PublicLeafSpec): PublicStageBuilder;
  stage(name: string): PublicStageBuilder;
  stage(name: string, body: (ctx: PublicCtx) => void): PublicStageBuilder;
}

export interface TaskflowBuilder {
  rules(path: string): TaskflowBuilder;
  env(vars: Record<string, string>): TaskflowBuilder;
  run(
    fn: (ctx: PublicCtx) => void,
    opts?: HarnessOptions,
  ): Promise<{ manifest: Manifest; ctx: Ctx }>;
}

// ---------------------------------------------------------------------------
// Internal tree model (captured during the synchronous build phase).
// ---------------------------------------------------------------------------

type LeafNode = {
  kind: 'leaf';
  id: string;
  spec: EngineLeafSpec;
};

type GroupNode = {
  kind: 'group';
  /** 'parallel' runs children concurrently; 'serial' runs them one at a time. */
  mode: 'parallel' | 'serial';
  children: LeafNode[];
};

type StageNode = {
  kind: 'stage';
  name: string;
  children: Array<StageNode | LeafNode | GroupNode>;
};

type RootNode = {
  kind: 'root';
  children: Array<StageNode | LeafNode | GroupNode>;
};

// ---------------------------------------------------------------------------
// parseWith — split 'agent:model' on the first `:`.
// ---------------------------------------------------------------------------

export function parseWith(s: string): { agent: AgentName; model?: string } {
  const idx = s.indexOf(':');
  const agent = idx === -1 ? s : s.slice(0, idx);
  const model = idx === -1 ? undefined : s.slice(idx + 1);
  if (!KNOWN_AGENTS.includes(agent as AgentName)) {
    throw new Error(
      `unknown agent in with: "${s}" — must start with one of ${KNOWN_AGENTS.join('|')}`,
    );
  }
  return { agent: agent as AgentName, model: model === '' ? undefined : model };
}

function toEngineSpec(id: string, p: PublicLeafSpec): EngineLeafSpec {
  const { agent, model } = parseWith(p.with);
  const spec: EngineLeafSpec = {
    id,
    agent,
    task: p.task,
  };
  if (model !== undefined) spec.model = model;
  if (p.write !== undefined) spec.claims = p.write;
  if (p.timeoutMs !== undefined) spec.timeoutMs = p.timeoutMs;
  if (p.rulesPrefix !== undefined) spec.rulesPrefix = p.rulesPrefix;
  return spec;
}

// Normalise `.parallel/.serial` factory args into a LeafNode[] list. Handles
// both overloads: (count, factory) and (items, factory).
function buildFactoryLeaves(
  countOrItems: number | readonly unknown[],
  factory: (a: unknown, i: number) => PublicLeafSpec,
): LeafNode[] {
  const items: readonly unknown[] = typeof countOrItems === 'number'
    ? Array.from({ length: countOrItems }, (_, i) => i)
    : countOrItems;
  const out: LeafNode[] = [];
  items.forEach((item, i) => {
    const spec = factory(item, i);
    if (!spec.id) throw new Error('parallel/serial factory must return a spec with an "id" field');
    out.push({ kind: 'leaf', id: spec.id, spec: toEngineSpec(spec.id, spec) });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

class Builder {
  private rulesPath?: string;
  private envVars?: Record<string, string>;
  private root: RootNode = { kind: 'root', children: [] };

  // Tracks the current "parent container" while a synchronous `stage(name, cb)`
  // callback is executing. Top-of-stack is where new children go.
  private stageStack: Array<RootNode | StageNode> = [this.root];

  constructor(private readonly name: string) {}

  withRules(path: string): this {
    this.rulesPath = path;
    return this;
  }

  withEnv(vars: Record<string, string>): this {
    this.envVars = { ...(this.envVars ?? {}), ...vars };
    return this;
  }

  // Any new child goes to the current top-of-stack container.
  private currentParent(): RootNode | StageNode {
    return this.stageStack[this.stageStack.length - 1]!;
  }

  private pushChild(child: StageNode | LeafNode | GroupNode): void {
    this.currentParent().children.push(child);
  }

  // Build a StageBuilder handle for a StageNode already attached to its parent.
  private makeStageBuilder(node: StageNode): PublicStageBuilder {
    const self = this;
    const sb: PublicStageBuilder = {
      leaf(id: string, spec: PublicLeafSpec): PublicStageBuilder {
        node.children.push({ kind: 'leaf', id, spec: toEngineSpec(id, spec) });
        return sb;
      },
      parallel(
        countOrItems: number | readonly unknown[],
        factory: (a: any, i: number) => PublicLeafSpec,
      ): PublicStageBuilder {
        const leaves = buildFactoryLeaves(countOrItems, factory);
        node.children.push({ kind: 'group', mode: 'parallel', children: leaves });
        return sb;
      },
      serial(
        countOrItems: number | readonly unknown[],
        factory: (a: any, i: number) => PublicLeafSpec,
      ): PublicStageBuilder {
        const leaves = buildFactoryLeaves(countOrItems, factory);
        node.children.push({ kind: 'group', mode: 'serial', children: leaves });
        return sb;
      },
      stage(childName: string, body?: (ctx: PublicCtx) => void): PublicStageBuilder {
        const child: StageNode = { kind: 'stage', name: childName, children: [] };
        node.children.push(child);
        if (body) {
          self.stageStack.push(child);
          try {
            body(self.makePublicCtx());
          } finally {
            self.stageStack.pop();
          }
          return sb;
        }
        return self.makeStageBuilder(child);
      },
    };
    return sb;
  }

  private makePublicCtx(): PublicCtx {
    const self = this;
    // Overloaded stage — return StageBuilder when no body, void when body passed.
    function stage(name: string): PublicStageBuilder;
    function stage(name: string, body: (ctx: PublicCtx) => void): void;
    function stage(name: string, body?: (ctx: PublicCtx) => void): PublicStageBuilder | void {
      const node: StageNode = { kind: 'stage', name, children: [] };
      self.pushChild(node);
      if (body) {
        self.stageStack.push(node);
        try {
          body(self.makePublicCtx());
        } finally {
          self.stageStack.pop();
        }
        return;
      }
      return self.makeStageBuilder(node);
    }

    const leaf = (id: string, spec: PublicLeafSpec): void => {
      self.pushChild({ kind: 'leaf', id, spec: toEngineSpec(id, spec) });
    };

    const parallel = (thunks: Array<() => void>): void => {
      // Collect leaves emitted by each thunk into a single parallel group.
      const group: GroupNode = { kind: 'group', mode: 'parallel', children: [] };
      // Temporarily redirect `pushChild` into the group by pushing a pseudo-stage.
      // Simpler: we rely on the convention that thunks call ctx.leaf(...) which
      // appends to currentParent(). So we push the group's children array via
      // a synthetic StageNode proxy.
      const proxy: StageNode = { kind: 'stage', name: '__parallel__', children: [] };
      self.stageStack.push(proxy);
      try {
        for (const thunk of thunks) thunk();
      } finally {
        self.stageStack.pop();
      }
      // Only LeafNodes are valid inside a top-level parallel — flatten.
      for (const child of proxy.children) {
        if (child.kind !== 'leaf') {
          throw new Error('top-level parallel(thunks) may only contain leaves');
        }
        group.children.push(child);
      }
      self.pushChild(group);
    };

    return { stage, leaf, parallel };
  }

  async run(
    fn: (ctx: PublicCtx) => void,
    opts: HarnessOptions = {},
  ): Promise<{ manifest: Manifest; ctx: Ctx }> {
    // Build phase — synchronous. Populates this.root.
    fn(this.makePublicCtx());

    // Apply env vars before execution. We treat this as a simple process.env
    // merge; callers can clear them after the returned promise settles if they
    // need strict isolation. This is a stub that at least does SOMETHING useful.
    if (this.envVars) {
      for (const [k, v] of Object.entries(this.envVars)) {
        process.env[k] = v;
      }
    }

    const harnessOpts: HarnessOptions = { ...opts };
    if (this.rulesPath !== undefined && harnessOpts.rulesFile === undefined) {
      harnessOpts.rulesFile = this.rulesPath;
    }

    const root = this.root;
    return engineHarness(this.name, harnessOpts, async (h) => {
      await walkChildren(h, root.children);
    });
  }

  /** Testing hook: build the tree without executing. Exported via `_buildTree`. */
  buildTreeOnly(fn: (ctx: PublicCtx) => void): RootNode {
    fn(this.makePublicCtx());
    return this.root;
  }
}

// ---------------------------------------------------------------------------
// Executor — walk the captured tree and invoke engine primitives.
// ---------------------------------------------------------------------------

async function walkChildren(
  h: Ctx,
  nodes: Array<StageNode | LeafNode | GroupNode>,
): Promise<void> {
  for (const n of nodes) {
    if (n.kind === 'leaf') {
      await engineLeaf(h, n.spec);
    } else if (n.kind === 'stage') {
      await engineStage(h, n.name, () => walkChildren(h, n.children));
    } else {
      // group
      if (n.mode === 'parallel') {
        await engineParallel(
          h,
          n.children.map((leaf) => () => engineLeaf(h, leaf.spec)),
        );
      } else {
        for (const leaf of n.children) await engineLeaf(h, leaf.spec);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function taskflow(name: string): TaskflowBuilder {
  const b = new Builder(name);
  const api: TaskflowBuilder = {
    rules(path: string) {
      b.withRules(path);
      return api;
    },
    env(vars: Record<string, string>) {
      b.withEnv(vars);
      return api;
    },
    run(fn, opts) {
      return b.run(fn, opts);
    },
  };
  return api;
}

// Test-only export: build the tree without executing. Returns the raw RootNode
// so tests can assert shape directly. Not part of the user-facing surface.
export function _buildTree(name: string, fn: (ctx: PublicCtx) => void): RootNode {
  return new Builder(name).buildTreeOnly(fn);
}

export type { RootNode as _RootNode, StageNode as _StageNode, LeafNode as _LeafNode, GroupNode as _GroupNode };
