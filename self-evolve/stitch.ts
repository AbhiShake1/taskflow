// Standalone stitcher — for the infinite-mode loop where evolve.ts never
// reaches its own stitch phase. Run whenever you want a snapshot demo
// video from whatever frames have landed so far.
//
// Usage (from self-evolve/):
//   npm run stitch

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FRAMES_DIR = resolve(REPO_ROOT, 'data', 'frames');
const VIDEO_PATH = resolve(REPO_ROOT, 'data', 'self-evolve.mp4');

async function main(): Promise<void> {
  if (!existsSync(FRAMES_DIR)) {
    console.error(`no frames directory at ${FRAMES_DIR} — nothing to stitch yet.`);
    process.exit(1);
  }
  const entries = await readdir(FRAMES_DIR);
  const frames = entries
    .filter((n) => /^iter-\d{2,}-.+\.png$/.test(n))
    .sort();
  if (frames.length === 0) {
    console.error('no iter-*.png frames found — nothing to stitch.');
    process.exit(1);
  }
  console.log(`stitching ${frames.length} frame(s) into ${VIDEO_PATH}`);

  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-framerate', '1',
      '-pattern_type', 'glob',
      '-i', `${FRAMES_DIR}/iter-*.png`,
      '-vf', 'format=yuv420p',
      '-r', '30',
      VIDEO_PATH,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`ffmpeg exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
  console.log(`done: ${VIDEO_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
