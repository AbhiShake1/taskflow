// Fluent authoring API for taskflow.
//
// This is an ADDITIVE layer on top of the low-level primitives in `../core`.
// It lowers a synchronously-built tree of phases + sessions into calls to
// `harness() / stage() / leaf() / parallel()` without touching the engine.
//
// Design:
//   - `taskflow(name)` returns a builder.
//   - `.rules(path)` / `.env(vars)` are chainable config setters.
//   - `.run(fn)` calls `fn(publicCtx)` SYNCHRONOUSLY to collect the tree, then
//     invokes the engine to execute it.
//   - A single builder instance owns a `currentPhaseStack` — when a nested
//     `phase(name, cb)` callback fires, we push onto the stack, run the
//     callback, then pop. This is how `const { phase, session } = ctx; ...`
//     still targets the right parent while code is inside a
//     `phase(...).phase(...)` callback.
//
// Naming: the public surface speaks `phase` (grouping) and `session` (one
// agent invocation). The engine underneath still uses its own vocabulary
// (`stage` / `leaf`) — that is an internal detail and intentionally not
// exposed to callers of this API.
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

export type PublicSessionSpec = {
  /** Optional: used only in the parallel/serial factory form (`{ id, ... }`). In `.session(id, spec)` form the id comes from the first argument. */
  id?: string;
  /** `'agent'` or `'agent:model'`. Split on the FIRST `:`; any further `:` chars stay in `model`. */
  with: string;
  /** Task prompt. */
  task: string;
  /** Files this session claims to write (globs). Maps to engine `claims`. */
  write?: string[];
  /** Per-session timeout. */
  timeoutMs?: number;
  /** Opt out of the rules prefix for this session. */
  rulesPrefix?: boolean;
};

export type PublicCtx = {
  phase(name: string): PublicPhaseBuilder;
  phase(name: string, body: (ctx: PublicCtx) => void): void;
  session(id: string, spec: PublicSessionSpec): void;
  parallel(thunks: Array<() => void>): void;
};

export interface PublicPhaseBuilder {
  session(id: string, spec: PublicSessionSpec): PublicPhaseBuilder;
  parallel(count: number, factory: (i: number) => PublicSessionSpec): PublicPhaseBuilder;
  parallel<T>(items: readonly T[], factory: (item: T, i: number) => PublicSessionSpec): PublicPhaseBuilder;
  serial(count: number, factory: (i: number) => PublicSessionSpec): PublicPhaseBuilder;
  serial<T>(items: readonly T[], factory: (item: T, i: number) => PublicSessionSpec): PublicPhaseBuilder;
  phase(name: string): PublicPhaseBuilder;
  phase(name: string, body: (ctx: PublicCtx) => void): PublicPhaseBuilder;
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
// Uses the public vocabulary (phase/session) for internal consistency.
// ---------------------------------------------------------------------------

type SessionNode = {
  kind: 'session';
  id: string;
  spec: EngineLeafSpec;
};

type GroupNode = {
  kind: 'group';
  /** 'parallel' runs children concurrently; 'serial' runs them one at a time. */
  mode: 'parallel' | 'serial';
  children: SessionNode[];
};

type PhaseNode = {
  kind: 'phase';
  name: string;
  children: Array<PhaseNode | SessionNode | GroupNode>;
};

type RootNode = {
  kind: 'root';
  children: Array<PhaseNode | SessionNode | GroupNode>;
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

function toEngineSpec(id: string, p: PublicSessionSpec): EngineLeafSpec {
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

// Normalise `.parallel/.serial` factory args into a SessionNode[] list. Handles
// both overloads: (count, factory) and (items, factory).
function buildFactorySessions(
  countOrItems: number | readonly unknown[],
  factory: (a: unknown, i: number) => PublicSessionSpec,
): SessionNode[] {
  const items: readonly unknown[] = typeof countOrItems === 'number'
    ? Array.from({ length: countOrItems }, (_, i) => i)
    : countOrItems;
  const out: SessionNode[] = [];
  items.forEach((item, i) => {
    const spec = factory(item, i);
    if (!spec.id) throw new Error('parallel/serial factory must return a spec with an "id" field');
    out.push({ kind: 'session', id: spec.id, spec: toEngineSpec(spec.id, spec) });
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

  // Tracks the current "parent container" while a synchronous `phase(name, cb)`
  // callback is executing. Top-of-stack is where new children go.
  private phaseStack: Array<RootNode | PhaseNode> = [this.root];

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
  private currentParent(): RootNode | PhaseNode {
    return this.phaseStack[this.phaseStack.length - 1]!;
  }

  private pushChild(child: PhaseNode | SessionNode | GroupNode): void {
    this.currentParent().children.push(child);
  }

  // Build a PhaseBuilder handle for a PhaseNode already attached to its parent.
  private makePhaseBuilder(node: PhaseNode): PublicPhaseBuilder {
    const self = this;
    const pb: PublicPhaseBuilder = {
      session(id: string, spec: PublicSessionSpec): PublicPhaseBuilder {
        node.children.push({ kind: 'session', id, spec: toEngineSpec(id, spec) });
        return pb;
      },
      parallel(
        countOrItems: number | readonly unknown[],
        factory: (a: any, i: number) => PublicSessionSpec,
      ): PublicPhaseBuilder {
        const sessions = buildFactorySessions(countOrItems, factory);
        node.children.push({ kind: 'group', mode: 'parallel', children: sessions });
        return pb;
      },
      serial(
        countOrItems: number | readonly unknown[],
        factory: (a: any, i: number) => PublicSessionSpec,
      ): PublicPhaseBuilder {
        const sessions = buildFactorySessions(countOrItems, factory);
        node.children.push({ kind: 'group', mode: 'serial', children: sessions });
        return pb;
      },
      phase(childName: string, body?: (ctx: PublicCtx) => void): PublicPhaseBuilder {
        const child: PhaseNode = { kind: 'phase', name: childName, children: [] };
        node.children.push(child);
        if (body) {
          self.phaseStack.push(child);
          try {
            body(self.makePublicCtx());
          } finally {
            self.phaseStack.pop();
          }
          return pb;
        }
        return self.makePhaseBuilder(child);
      },
    };
    return pb;
  }

  private makePublicCtx(): PublicCtx {
    const self = this;
    // Overloaded phase — return PhaseBuilder when no body, void when body passed.
    function phase(name: string): PublicPhaseBuilder;
    function phase(name: string, body: (ctx: PublicCtx) => void): void;
    function phase(name: string, body?: (ctx: PublicCtx) => void): PublicPhaseBuilder | void {
      const node: PhaseNode = { kind: 'phase', name, children: [] };
      self.pushChild(node);
      if (body) {
        self.phaseStack.push(node);
        try {
          body(self.makePublicCtx());
        } finally {
          self.phaseStack.pop();
        }
        return;
      }
      return self.makePhaseBuilder(node);
    }

    const session = (id: string, spec: PublicSessionSpec): void => {
      self.pushChild({ kind: 'session', id, spec: toEngineSpec(id, spec) });
    };

    const parallel = (thunks: Array<() => void>): void => {
      // Collect sessions emitted by each thunk into a single parallel group.
      const group: GroupNode = { kind: 'group', mode: 'parallel', children: [] };
      // Temporarily redirect `pushChild` into the group by pushing a pseudo-phase.
      // Simpler: we rely on the convention that thunks call ctx.session(...)
      // which appends to currentParent(). So we push the group's children array
      // via a synthetic PhaseNode proxy.
      const proxy: PhaseNode = { kind: 'phase', name: '__parallel__', children: [] };
      self.phaseStack.push(proxy);
      try {
        for (const thunk of thunks) thunk();
      } finally {
        self.phaseStack.pop();
      }
      // Only SessionNodes are valid inside a top-level parallel — flatten.
      for (const child of proxy.children) {
        if (child.kind !== 'session') {
          throw new Error('top-level parallel(thunks) may only contain sessions');
        }
        group.children.push(child);
      }
      self.pushChild(group);
    };

    return { phase, session, parallel };
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
  nodes: Array<PhaseNode | SessionNode | GroupNode>,
): Promise<void> {
  for (const n of nodes) {
    if (n.kind === 'session') {
      await engineLeaf(h, n.spec);
    } else if (n.kind === 'phase') {
      await engineStage(h, n.name, () => walkChildren(h, n.children));
    } else {
      // group
      if (n.mode === 'parallel') {
        await engineParallel(
          h,
          n.children.map((s) => () => engineLeaf(h, s.spec)),
        );
      } else {
        for (const s of n.children) await engineLeaf(h, s.spec);
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

export type { RootNode as _RootNode, PhaseNode as _PhaseNode, SessionNode as _SessionNode, GroupNode as _GroupNode };
