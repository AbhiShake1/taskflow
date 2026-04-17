// Canonical example of the fluent taskflow authoring API.
//
// This file is hand-authored (not emitted). Running it executes the harness as
// a side-effect of module load — `.run(...)` returns a Promise the top-level
// await resolves when the run finishes.
//
// Smoke-run against the mock adapter (direct tsx, no runner wrapper):
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//   HARNESS_RUNS_DIR=/tmp/tf-fluent-smoke npx tsx tasks/scrape-don-example.ts
//
// Or via the runner (TUI, handle registry, env-driven mock):
//   npm run run tasks/scrape-don-example.ts

import { taskflow } from '../api';
import type { HarnessOptions } from '../core';
import type { AgentAdapter } from '../adapters';
import type { AgentName } from '../core/types';

// When invoked directly with tsx (no runner wrapper), honour the same env vars
// the runner does so the documented smoke command still works.
async function resolveOpts(): Promise<HarnessOptions> {
  const opts: HarnessOptions = {};
  if (process.env.HARNESS_RUNS_DIR) opts.runsDir = process.env.HARNESS_RUNS_DIR;
  if (process.env.HARNESS_ADAPTER_OVERRIDE === 'mock') {
    const mock = (await import('../adapters/mock')).default as AgentAdapter;
    opts.adapterOverride = async (_agent: AgentName) => mock;
  }
  return opts;
}

export default (await resolveOpts().then((opts) =>
  taskflow('scrape-don')
    .rules('./rules.md')
    .run(({ phase }) => {
      phase('discover').session('discover-urls', {
        with: 'claude-code:sonnet',
        task: 'Discover all business URLs via sitemap',
        write: ['data/urls.json'],
      });

      phase('fetch').parallel(4, (i) => ({
        id: `shard-${i}`,
        with: 'opencode:groq/llama-3.3-70b',
        task: `Fetch shard ${i} of URLs`,
        write: [`data/shard-${i}/**`],
      }));

      phase('ingest').session('merge', {
        with: 'pi:anthropic/claude-opus-4-7',
        task: 'Merge shard outputs into data/merged.json',
        write: ['data/merged.json'],
      });
    }, opts),
));
