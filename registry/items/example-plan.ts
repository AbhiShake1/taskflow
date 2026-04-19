import { z } from 'zod';
import { taskflow } from 'taskflowjs';

const Feature = z
  .object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    files: z.array(z.string()).min(1),
  })
  .strict();

const FeatureList = z.object({ items: z.array(Feature).max(10) }).strict();

const CONFIG = {
  projectRoot: process.cwd(),
  model: 'claude-code:sonnet',
  maxFeatures: 10,
} as const;

async function main(): Promise<void> {
  await taskflow('example-plan').run(async ({ phase, session }) => {
    const features = await phase('discover', () =>
      session('scan-features', {
        with: CONFIG.model,
        task: [
          `Scan the codebase rooted at ${CONFIG.projectRoot}.`,
          `Identify up to ${CONFIG.maxFeatures} user-facing features.`,
          'For each feature return kebab-case name and a list of source files.',
          'Prefer files under src/, app/, pages/, components/.',
          'Return a FeatureList JSON object.',
        ].join('\n'),
        schema: FeatureList,
        timeoutMs: 300_000,
      }),
    );

    await phase('summarize', () =>
      Promise.all(
        features.items.map((f) =>
          session(`summary-${f.name}`, {
            with: CONFIG.model,
            task: `One-sentence summary of feature "${f.name}" based on these files: ${f.files.join(', ')}.`,
            timeoutMs: 120_000,
          }),
        ),
      ),
    );

    console.log(`[example-plan] planned ${features.items.length} feature(s)`);
  });
}

void main();
