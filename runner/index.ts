/**
 * harness:run — executable entry that runs a harness TS file under a live
 * EventBus, mounts the TUI (or a headless fallback), and wires steering/
 * abort keyboard events back to the adapter handles of in-flight leaves
 * via the runner context registry.
 *
 * Used by both the in-repo dev script (`tsx runner/index.ts harness.ts`)
 * and the published CLI (`taskflow run harness.ts`). The latter runs
 * compiled JS under plain node — `jiti` handles the .ts harness file
 * import without requiring tsx as a runtime dep.
 */
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createJiti } from 'jiti';
import { EventBus } from '../core/events';
import { setRunner, type RunnerContext } from './context';
import type { AgentAdapter, AgentHandle } from '../adapters/index';
import type { AgentName } from '../core/types';
import mockAdapter from '../adapters/mock';
import { loadConfig } from '../core/config';

async function main(): Promise<void> {
  const harnessPath = process.argv[2];
  if (!harnessPath) {
    console.error('usage: harness:run <harness.ts>');
    process.exit(2);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runsDir = resolve(process.env.HARNESS_RUNS_DIR ?? 'data/runs');
  const runDir = `${runsDir}/${runId}`;
  await mkdir(runDir, { recursive: true });

  // The runner owns the bus and the jsonl file — the core library will
  // skip attachFile / close when it detects a runner-provided bus.
  const bus = new EventBus();
  await bus.attachFile(`${runDir}/events.jsonl`);

  const activeHandles = new Map<string, AgentHandle>();

  // Optional runner-level adapter override. Currently only the 'mock' mode is
  // wired — it substitutes the mock adapter for every agent so a full spec can
  // be smoke-tested without API keys or real CLIs installed.
  const adapterOverride: RunnerContext['adapterOverride'] | undefined =
    process.env.HARNESS_ADAPTER_OVERRIDE === 'mock'
      ? async (_agent: AgentName): Promise<AgentAdapter> => mockAdapter
      : undefined;

  // Load taskflow config (hierarchical .agents/taskflow/config.ts walk) once at
  // startup so the harness inherits the resolved config + event layers + plugins
  // without reloading per harness() call. Failures fall back to defaults — the
  // harness has its own try/catch fallback too.
  let cfg: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    cfg = await loadConfig();
  } catch (err) {
    console.error('config load failed, falling back to defaults:', (err as Error).message);
  }

  setRunner({
    bus,
    runsDir,
    runId,
    activeHandles,
    adapterOverride,
    cwd: process.cwd(),
    ...(cfg
      ? { config: cfg.resolved, eventLayers: cfg.eventLayers, plugins: cfg.plugins }
      : {}),
  });

  // Pick UI mode. Interactive TUI requires both stdin and stdout to be a TTY.
  // HARNESS_NO_TTY forces the headless stream regardless of the terminal.
  const isTty =
    !process.env.HARNESS_NO_TTY &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let unmount: (() => void) | undefined;

  if (isTty) {
    try {
      const tui = await import('../tui/index');
      unmount = tui.mountTui(bus, {
        onSteer: (leafId: string, text: string) => {
          void activeHandles.get(leafId)?.steer(text);
        },
        onAbortLeaf: (leafId: string) => {
          void activeHandles.get(leafId)?.abort('user-abort');
        },
        onQuit: () => process.exit(130),
      });
    } catch (err) {
      console.error(
        'TUI failed to mount, falling back to headless:',
        (err as Error).message,
      );
      try {
        const { streamHeadless } = await import('../tui/index');
        unmount = streamHeadless(bus);
      } catch {
        const un = bus.subscribe((ev) => console.log(JSON.stringify(ev)));
        unmount = () => un();
      }
    }
  } else {
    try {
      const { streamHeadless } = await import('../tui/index');
      unmount = streamHeadless(bus);
    } catch {
      // Final fallback: inline subscriber so we always see something in logs.
      const un = bus.subscribe((ev) => console.log(JSON.stringify(ev)));
      unmount = () => un();
    }
  }

  // SIGINT / SIGTERM -> abort every in-flight leaf, then let the harness
  // body unwind naturally through its finally-blocks.
  const abortAll = async () => {
    for (const h of activeHandles.values()) {
      try { await h.abort('signal'); } catch { /* swallow */ }
    }
  };
  process.on('SIGINT', abortAll);
  process.on('SIGTERM', abortAll);

  try {
    // Load the harness module. When running under tsx (the dev path —
    // `tsx runner/index.ts harness.ts`), tsx has already registered an ESM
    // loader, so plain dynamic import handles the .ts file with a single
    // evaluation. Going through jiti.import on top of tsx caused jiti to
    // re-evaluate the module, calling top-level harness() twice and
    // creating two run dirs.
    //
    // Under plain node (the published CLI path), Node 22.6+ supports
    // --experimental-strip-types so .ts works there too. If that's not
    // present, jiti is the fallback.
    const harnessAbs = resolve(harnessPath);
    try {
      await import(harnessAbs);
    } catch (importErr) {
      const msg = importErr instanceof Error ? importErr.message : String(importErr);
      if (/Unknown file extension|Cannot use import/.test(msg)) {
        const jiti = createJiti(import.meta.url, { interopDefault: false });
        await jiti.import(harnessAbs);
      } else {
        throw importErr;
      }
    }
  } catch (err) {
    console.error('harness error:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    unmount?.();
    // Drop the runner context so a subsequent in-process import of this
    // module (in tests) doesn't see a stale runner.
    setRunner(undefined);
    await bus.close();
  }
}

void main();
