// Live TUI viewer for an in-flight self-evolve run.
//
// Tails the latest data/runs/<runId>/events.jsonl and replays each event into
// a fresh EventBus, then mounts the standard taskflow TUI on top. Read-only —
// steer/abort/quit just unmount the local viewer; the bg harness keeps running.
//
// Run from anywhere, but the LATEST_RUNS_DIR default assumes the SDK root:
//   cd /Users/abhi/proj/flance/taskflow && npx tsx self-evolve/watch.ts
// Or override:
//   RUNS_DIR=data/runs RUN_ID=2026-04-19T03-04-03-782Z npx tsx self-evolve/watch.ts

import { readdirSync, watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mountTui } from 'taskflow-sdk/tui';
// EventBus + RunEvent live under dist/core/{events,types} — not in the
// package.json exports map. Reach in directly; the package layout is stable.
const eventsMod = await import(
  resolve(import.meta.dirname, 'node_modules/taskflow-sdk/dist/core/events.js')
);
const EventBus = eventsMod.EventBus as new () => {
  publish: (ev: unknown) => void;
  subscribe: (fn: (ev: unknown) => void) => () => void;
};
type RunEvent = unknown;

const REPO_ROOT = resolve(import.meta.dirname, '..');
const RUNS_DIR = resolve(process.env.RUNS_DIR ?? `${REPO_ROOT}/data/runs`);

function pickLatestRun(): string {
  const explicit = process.env.RUN_ID;
  if (explicit) return resolve(RUNS_DIR, explicit);
  const entries = readdirSync(RUNS_DIR);
  if (entries.length === 0) {
    console.error(`no runs found under ${RUNS_DIR}`);
    process.exit(1);
  }
  entries.sort();
  return resolve(RUNS_DIR, entries[entries.length - 1]!);
}

async function main(): Promise<void> {
  const runDir = pickLatestRun();
  const eventsPath = `${runDir}/events.jsonl`;
  const bus = new EventBus();

  const fh = await open(eventsPath, 'r');
  let position = 0;
  let buffered = '';

  async function drain(): Promise<void> {
    const stat = await fh.stat();
    if (stat.size <= position) return;
    const buf = Buffer.alloc(stat.size - position);
    await fh.read(buf, 0, buf.length, position);
    position = stat.size;
    buffered += buf.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as RunEvent;
        bus.publish(ev);
      } catch {
        // skip malformed
      }
    }
  }

  await drain();

  const watcher = watch(eventsPath, { persistent: true }, () => {
    drain().catch(() => {});
  });

  // mountTui's typed EventBus is more specific than what we duck-type with;
  // at runtime mountTui only consumes subscribe(), so the cast is safe.
  const unmount = mountTui(bus as unknown as Parameters<typeof mountTui>[0], {
    onQuit: () => {
      watcher.close();
      fh.close().catch(() => {});
      unmount();
      process.exit(0);
    },
  });

  // Keep alive even if no terminal events
  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
