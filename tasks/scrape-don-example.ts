// Canonical example of the async-await fluent taskflow API.
//
// Every `session(...)` call returns a Promise<T> where T is driven by the
// optional `schema` field. This lets you pass structured data between
// sessions via ordinary JS control flow — no ad-hoc file-chaining, no
// tree-builder, no custom DSL. Parallelism is just `Promise.all([...])`.
//
// Smoke-run against the mock adapter (direct tsx, no runner wrapper):
//   HARNESS_ADAPTER_OVERRIDE=mock HARNESS_NO_TTY=1 \
//   HARNESS_RUNS_DIR=/tmp/tf-fluent-smoke npx tsx tasks/scrape-don-example.ts
//
// Or via the runner (TUI, handle registry, env-driven mock):
//   npm run run tasks/scrape-don-example.ts

import { z } from 'zod';
import { taskflow } from '../api';
import type { HarnessOptions } from '../core';
import type { AgentAdapter } from '../adapters';
import type { AgentName } from '../core/types';

// Typed schemas for two of the sessions — exercises schema inference end-to-end.
const urlsSchema = z.object({
  urls: z.array(z.string().url()),
  categories: z.array(z.string()),
});

const shardResultSchema = z.object({
  shardId: z.string(),
  count: z.number(),
});

// Honour the same env vars the runner does, so the documented smoke command works.
async function resolveOpts(): Promise<HarnessOptions> {
  const opts: HarnessOptions = {};
  if (process.env.HARNESS_RUNS_DIR) opts.runsDir = process.env.HARNESS_RUNS_DIR;
  if (process.env.HARNESS_ADAPTER_OVERRIDE === 'mock') {
    const mock = (await import('../adapters/mock')).default as AgentAdapter;
    opts.adapterOverride = async (_agent: AgentName) => mock;
  }
  return opts;
}

export default await resolveOpts().then((opts) =>
  taskflow('scrape-don').run(async ({ phase, session }) => {
      // Phase 1: discover URLs. `discovered` is typed { urls: string[]; categories: string[] }.
      const discovered = await phase('discover', async () => {
        return session('discover-urls', {
          with: 'claude-code:sonnet',
          task: 'Discover all business URLs via sitemap',
          write: ['data/urls.json'],
          schema: urlsSchema,
        });
      });

      // Phase 2: fetch shards in parallel using Promise.all. Each element of
      // `shards` is typed { shardId: string; count: number }.
      const shards = await phase('fetch', async () => {
        return Promise.all(
          discovered.urls.slice(0, 4).map((url, i) =>
            session(`shard-${i}`, {
              with: 'opencode:groq/llama-3.3-70b',
              task: `Fetch ${url}`,
              write: [`data/shard-${i}/**`],
              schema: shardResultSchema,
            }),
          ),
        );
      });

      // Phase 3: ingest. `telemetry` is fire-and-forget (note the .catch).
      await phase('ingest', async () => {
        session('telemetry', {
          with: 'claude-code:sonnet',
          task: `Log shard counts: ${shards.map((s) => s.count).join(',')}`,
        }).catch(() => {
          /* fire-and-forget; dev owns .catch() */
        });

        // Schema-less return — `merge` resolves to the final assistant text as a string.
        return session('merge', {
          with: 'pi:anthropic/claude-opus-4-7',
          task: 'Merge shards into data/merged.json',
          write: ['data/merged.json'],
        });
      });
    }, opts),
);
