import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  AgentEvent,
  AgentName,
  Ctx,
  LeafResult,
  LeafSpec,
  LeafStatus,
  LeafSummary,
} from './types';
import { claimsOverlap } from './claims';
import { EventBus } from './events';
import { resolveAdapter, type AgentAdapter, type SpawnCtx } from '../adapters/index';
import { getRunner } from '../runner/context';

export type HarnessOptions = {
  rulesFile?: string;
  runId?: string;
  runsDir?: string;
  adapterOverride?: (agent: AgentName) => Promise<AgentAdapter>;
};

export type Manifest = {
  name: string;
  runId: string;
  startedAt: number;
  endedAt: number;
  exitCode: number;
  leaves: LeafSummary[];
  stages: string[];
};

function defaultRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function readRulesFile(p: string | undefined): Promise<string | undefined> {
  if (!p) return undefined;
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  try {
    return await readFile(abs, 'utf8');
  } catch {
    // If rules file cannot be read, behave as if no rules were set.
    return undefined;
  }
}

export async function harness(
  name: string,
  opts: HarnessOptions,
  body: (h: Ctx) => Promise<void>,
): Promise<{ ctx: Ctx; manifest: Manifest }> {
  const runner = getRunner();
  const runId = opts.runId ?? runner?.runId ?? defaultRunId();
  const runsDir = runner?.runsDir ?? opts.runsDir ?? 'data/runs';
  const runDir = join(runsDir, runId);
  const leavesDir = join(runDir, 'leaves');

  await mkdir(leavesDir, { recursive: true });

  const rules = await readRulesFile(opts.rulesFile);
  // If a runner is registered, use its bus (file attachment + lifecycle is
  // the runner's responsibility). Otherwise own the bus ourselves.
  const ownsBus = !runner;
  const bus = runner?.bus ?? new EventBus();
  if (ownsBus) {
    await bus.attachFile(join(runDir, 'events.jsonl'));
  }

  const ctx: Ctx = {
    runId,
    runDir,
    rules,
    bus,
    stageStack: [],
    _leafRecords: [],
    _stageOrder: [],
    _activeClaims: new Map(),
    _adapterOverride: opts.adapterOverride,
  };

  const startedAt = Date.now();
  let threw: unknown = undefined;
  try {
    await body(ctx);
  } catch (e) {
    threw = e;
  }
  const endedAt = Date.now();

  const allDone = ctx._leafRecords.length > 0
    && ctx._leafRecords.every(r => r.status === 'done');
  const exitCode = (threw === undefined && allDone) ? 0 : (threw === undefined && ctx._leafRecords.length === 0 ? 0 : 1);

  const manifest: Manifest = {
    name,
    runId,
    startedAt,
    endedAt,
    exitCode,
    leaves: ctx._leafRecords.slice(),
    stages: ctx._stageOrder.slice(),
  };

  try {
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  } finally {
    // Only close the bus if we created it. The runner owns its own bus.
    if (ownsBus) await bus.close();
  }

  if (threw !== undefined) {
    // We still surface the failure to the caller — the manifest is on disk.
    throw threw;
  }

  return { ctx, manifest };
}

export async function stage(h: Ctx, id: string, body: () => Promise<void>): Promise<void> {
  const parentId = h.stageStack[h.stageStack.length - 1];
  h.stageStack.push(id);
  h._stageOrder.push(id);
  h.bus.publish({ t: 'stage-enter', stageId: id, parentId, ts: Date.now() });

  let status: 'done' | 'error' = 'done';
  let threw: unknown = undefined;
  try {
    await body();
  } catch (e) {
    status = 'error';
    threw = e;
  } finally {
    h.bus.publish({ t: 'stage-exit', stageId: id, status, ts: Date.now() });
    h.stageStack.pop();
  }

  if (threw !== undefined) throw threw;
}

function checkClaimConflicts(h: Ctx, spec: LeafSpec): void {
  const mine = spec.claims ?? [];
  if (mine.length === 0) return;
  for (const [otherId, other] of h._activeClaims) {
    if (claimsOverlap(mine, other)) {
      throw new Error(`claim conflict: "${spec.id}" vs "${otherId}"`);
    }
  }
}

export async function leaf(h: Ctx, spec: LeafSpec): Promise<LeafResult> {
  // Runtime overlap check against in-flight siblings.
  checkClaimConflicts(h, spec);
  h._activeClaims.set(spec.id, spec.claims ?? []);

  try {
    // Adapter-resolution priority:
    //   1. spec-level override from HarnessOptions (emitted module or tests)
    //   2. runner-level override (e.g. HARNESS_ADAPTER_OVERRIDE=mock from CLI)
    //   3. real adapter for the agent name
    const runnerOverride = getRunner()?.adapterOverride;
    const adapter = h._adapterOverride
      ? await h._adapterOverride(spec.agent)
      : runnerOverride
      ? await runnerOverride(spec.agent)
      : await resolveAdapter(spec.agent);

    const rulesPrefixEnabled = spec.rulesPrefix !== false;
    const spawnCtx: SpawnCtx = {
      runDir: h.runDir,
      rulesPrefix: rulesPrefixEnabled && h.rules
        ? `Rules:\n${h.rules}\n\nTask:\n`
        : undefined,
      // Run the agent in the repo root (runner-provided) rather than runDir. Both
      // claude-agent-sdk and omp (via `pi --allow-home`) sandbox to a temp dir when
      // no cwd is supplied, so any files they write land outside the repo. Falling
      // back to process.cwd() here matches the runner's default.
      cwd: getRunner()?.cwd ?? process.cwd(),
      ...(spec.structuredOutput
        ? {
            structuredOutput: {
              jsonSchema: spec.structuredOutput.jsonSchema,
              ...(spec.structuredOutput._zodSchema !== undefined
                ? { _zodSchema: spec.structuredOutput._zodSchema }
                : {}),
            },
          }
        : {}),
    };

    const startedAt = Date.now();
    const handle = adapter.spawn(spec, spawnCtx);

    // Register this leaf's live handle with the runner (if any), so the TUI
    // can route steer/abort keystrokes to it. Always cleaned up below.
    const runner = getRunner();
    runner?.activeHandles.set(spec.id, handle);

    // Observe events as they stream in. Two purposes:
    //   1. Publish them onto the run bus for downstream consumers.
    //   2. Track the last assistant message text so the engine can backfill
    //      `result.finalAssistantText` when the adapter didn't set it. Most
    //      adapters already set it on their terminal `done`, but nothing
    //      *requires* them to — this keeps the contract single-sourced here.
    let lastAssistantText: string | undefined;
    const drain = (async () => {
      for await (const ev of handle.events as AsyncIterable<AgentEvent>) {
        if (ev.t === 'message' && ev.role === 'assistant' && typeof ev.content === 'string' && ev.content.length > 0) {
          lastAssistantText = ev.content;
        }
        h.bus.publish(ev);
      }
    })().catch(() => { /* already surfaced via handle.wait() */ });

    // Race wait() against timeout.
    let result: LeafResult;
    if (spec.timeoutMs && spec.timeoutMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>(res => {
        timer = setTimeout(() => res('timeout'), spec.timeoutMs);
      });
      const winner = await Promise.race([handle.wait(), timedOut]);
      if (timer) clearTimeout(timer);
      if (winner === 'timeout') {
        await handle.abort('timeout');
        const original = await handle.wait();
        result = { ...original, status: 'timeout' as LeafStatus };
        // The adapter's abort() pushes its own `done` event with status: 'aborted'
        // into the event bus. Publish a corrective `done` so events.jsonl reflects
        // the true terminal status (timeout) the watchdog promoted this leaf to —
        // otherwise downstream consumers would see a manifest/event-log mismatch.
        h.bus.publish({ t: 'done', leafId: spec.id, result, ts: Date.now() });
      } else {
        result = winner as LeafResult;
      }
    } else {
      result = await handle.wait();
    }

    // Make sure event drain has run to completion so publishes are flushed.
    await drain;

    // Engine-side backfill: adapters MAY set `finalAssistantText` on their done
    // event, but the contract is single-sourced here. If the adapter didn't set
    // it, fall back to the last assistant message we observed in the stream.
    // `structuredOutputValue` stays adapter-owned — only the adapter knows
    // whether it came from a real tool-use capture or a fallback parse.
    if (result.finalAssistantText === undefined && lastAssistantText !== undefined) {
      result = { ...result, finalAssistantText: lastAssistantText };
    }

    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;

    const proofDir = join(h.runDir, 'leaves', spec.id);
    const proofPath = join(proofDir, 'proof.json');
    await mkdir(proofDir, { recursive: true });
    const proof = { result };
    await writeFile(proofPath, JSON.stringify(proof, null, 2), 'utf8');

    const summary: LeafSummary = {
      id: spec.id,
      status: result.status,
      durationMs,
      proofPath,
    };
    h._leafRecords.push(summary);

    if (result.status !== 'done') {
      throw new Error(`leaf failed: ${spec.id}`);
    }

    return { ...result, proofPath };
  } finally {
    h._activeClaims.delete(spec.id);
    // De-register handle regardless of outcome.
    getRunner()?.activeHandles.delete(spec.id);
  }
}

export async function parallel(h: Ctx, fns: Array<() => Promise<unknown>>): Promise<void> {
  const settled = await Promise.allSettled(fns.map(fn => fn()));
  const errors = settled
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map(r => (r.reason instanceof Error ? r.reason : new Error(String(r.reason))));

  if (errors.length > 0) {
    // Use node-native AggregateError for a single-error-per-branch surface.
    const AggErr = (globalThis as unknown as { AggregateError: typeof AggregateError }).AggregateError;
    throw new AggErr(errors, `parallel: ${errors.length} branch(es) failed`);
  }
}

// Also re-export the Ctx and core types for convenience.
export type { Ctx, LeafSpec, LeafResult } from './types';

// Ensure mkdir for manifest dir (used only for a defensive write if body skipped it).
export async function _ensureRunDir(runDir: string): Promise<void> {
  await mkdir(runDir, { recursive: true });
}

// Small helper so downstream imports don't drag in node types.
export { dirname };
