/**
 * ui-content.ts — Harness 3 of the UI-harness trio.
 *
 * Reads a directory of screenshots/videos, stitches a video via ffmpeg,
 * generates a narrative + per-platform scripts via LLM, and publishes to
 * YouTube, Facebook, Instagram, LinkedIn, Twitter/X, Medium, Reddit.
 *
 * Platform adapters are STUBS — swap in real OAuth + API calls before
 * going to production. Each stub returns { status: 'skipped', message: ... }
 * when its env vars are missing.
 *
 * Requires: npm i -g @taskflow-corp/sdk (global install — nothing else to set up).
 *
 * Run: tsx ui-content.ts
 * Env:
 *   UI_MEDIA_DIR        override media input dir (default: data/artifacts)
 *   UI_CONTENT_OUT_DIR  override output dir (default: data/content)
 *   YOUTUBE_API_KEY, FACEBOOK_ACCESS_TOKEN, INSTAGRAM_ACCESS_TOKEN,
 *   LINKEDIN_ACCESS_TOKEN, TWITTER_BEARER_TOKEN, MEDIUM_INTEGRATION_TOKEN,
 *   REDDIT_REFRESH_TOKEN  — platform creds; missing ones → platform skipped.
 */

import { readdir, stat, writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve, basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { taskflow } from '@taskflow-corp/sdk';

const CONFIG = {
  mediaDir: process.env.UI_MEDIA_DIR ?? 'data/artifacts',
  outDir: process.env.UI_CONTENT_OUT_DIR ?? 'data/content',
  model: 'claude-code:sonnet',
  video: { width: 1920, height: 1080, fps: 30, imageDurationSec: 2.0 },
} as const;

// ---------------------------------------------------------------------------
// Platform adapter types
// ---------------------------------------------------------------------------

type PlatformId =
  | 'youtube'
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'twitter'
  | 'medium'
  | 'reddit';

interface PublishArgs {
  video: string;
  caption: string;
  thumbnail?: string;
}

interface PublishResult {
  platform: PlatformId;
  status: 'published' | 'skipped' | 'error';
  id?: string;
  url?: string;
  message?: string;
}

interface PlatformAdapter {
  id: PlatformId;
  envVar: string;
  publish(args: PublishArgs, env: NodeJS.ProcessEnv): Promise<PublishResult>;
}

// ---------------------------------------------------------------------------
// Platform adapter stubs — all 7
// ---------------------------------------------------------------------------

const youtubeAdapter: PlatformAdapter = {
  id: 'youtube',
  envVar: 'YOUTUBE_API_KEY',
  async publish(_args, env) {
    const key = env.YOUTUBE_API_KEY;
    if (!key || key.length === 0) {
      return { platform: 'youtube', status: 'skipped', message: 'set YOUTUBE_API_KEY to enable' };
    }
    // TODO: replace with real youtube API call (videos.insert via googleapis)
    return { platform: 'youtube', status: 'skipped', message: 'stub adapter — swap in real youtube API call' };
  },
};

const facebookAdapter: PlatformAdapter = {
  id: 'facebook',
  envVar: 'FACEBOOK_ACCESS_TOKEN',
  async publish(_args, env) {
    const token = env.FACEBOOK_ACCESS_TOKEN;
    if (!token || token.length === 0) {
      return { platform: 'facebook', status: 'skipped', message: 'set FACEBOOK_ACCESS_TOKEN to enable' };
    }
    // TODO: replace with real facebook API call (Graph API /me/videos)
    return { platform: 'facebook', status: 'skipped', message: 'stub adapter — swap in real facebook API call' };
  },
};

const instagramAdapter: PlatformAdapter = {
  id: 'instagram',
  envVar: 'INSTAGRAM_ACCESS_TOKEN',
  async publish(_args, env) {
    const token = env.INSTAGRAM_ACCESS_TOKEN;
    if (!token || token.length === 0) {
      return { platform: 'instagram', status: 'skipped', message: 'set INSTAGRAM_ACCESS_TOKEN to enable' };
    }
    // TODO: replace with real instagram API call (Graph API media_publish)
    return { platform: 'instagram', status: 'skipped', message: 'stub adapter — swap in real instagram API call' };
  },
};

const linkedinAdapter: PlatformAdapter = {
  id: 'linkedin',
  envVar: 'LINKEDIN_ACCESS_TOKEN',
  async publish(_args, env) {
    const token = env.LINKEDIN_ACCESS_TOKEN;
    if (!token || token.length === 0) {
      return { platform: 'linkedin', status: 'skipped', message: 'set LINKEDIN_ACCESS_TOKEN to enable' };
    }
    // TODO: replace with real linkedin API call (REST /v2/ugcPosts)
    return { platform: 'linkedin', status: 'skipped', message: 'stub adapter — swap in real linkedin API call' };
  },
};

const twitterAdapter: PlatformAdapter = {
  id: 'twitter',
  envVar: 'TWITTER_BEARER_TOKEN',
  async publish(_args, env) {
    const token = env.TWITTER_BEARER_TOKEN;
    if (!token || token.length === 0) {
      return { platform: 'twitter', status: 'skipped', message: 'set TWITTER_BEARER_TOKEN to enable' };
    }
    // TODO: replace with real twitter API call (v2 /2/tweets with media upload)
    return { platform: 'twitter', status: 'skipped', message: 'stub adapter — swap in real twitter API call' };
  },
};

const mediumAdapter: PlatformAdapter = {
  id: 'medium',
  envVar: 'MEDIUM_INTEGRATION_TOKEN',
  async publish(_args, env) {
    const token = env.MEDIUM_INTEGRATION_TOKEN;
    if (!token || token.length === 0) {
      return { platform: 'medium', status: 'skipped', message: 'set MEDIUM_INTEGRATION_TOKEN to enable' };
    }
    // TODO: replace with real medium API call (POST /v1/users/{id}/posts)
    return { platform: 'medium', status: 'skipped', message: 'stub adapter — swap in real medium API call' };
  },
};

const redditAdapter: PlatformAdapter = {
  id: 'reddit',
  envVar: 'REDDIT_REFRESH_TOKEN',
  async publish(_args, env) {
    const token = env.REDDIT_REFRESH_TOKEN;
    if (!token || token.length === 0) {
      return { platform: 'reddit', status: 'skipped', message: 'set REDDIT_REFRESH_TOKEN to enable' };
    }
    // TODO: replace with real reddit API call (OAuth2 /api/submit)
    return { platform: 'reddit', status: 'skipped', message: 'stub adapter — swap in real reddit API call' };
  },
};

const PLATFORMS: ReadonlyArray<PlatformAdapter> = Object.freeze([
  youtubeAdapter,
  facebookAdapter,
  instagramAdapter,
  linkedinAdapter,
  twitterAdapter,
  mediumAdapter,
  redditAdapter,
]);

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const NarrativeBeat = z
  .object({
    summary: z.string().min(1).max(500),
    framePaths: z.array(z.string()),
  })
  .strict();

const NarrativeOutline = z
  .object({
    title: z.string().min(1).max(200),
    hook: z.string().min(1).max(500),
    beats: z.array(NarrativeBeat).min(1).max(10),
    outro: z.string().min(1).max(500),
  })
  .strict();
type NarrativeOutline = z.infer<typeof NarrativeOutline>;

const PlatformScripts = z
  .object({
    youtube: z.string().max(5000),
    facebook: z.string().max(5000),
    instagram: z.string().max(5000),
    linkedin: z.string().max(1300),
    twitter: z.string().max(280),
    medium: z.string().max(100000),
    reddit: z.string().max(40000),
  })
  .strict();
type PlatformScripts = z.infer<typeof PlatformScripts>;

const PublishResultSchema = z
  .object({
    platform: z.enum(['youtube', 'facebook', 'instagram', 'linkedin', 'twitter', 'medium', 'reddit']),
    status: z.enum(['published', 'skipped', 'error']),
    id: z.string().optional(),
    url: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// gather: walk media dir
// ---------------------------------------------------------------------------

interface GatherResult {
  clips: string[];
  features: string[];
  fixHistory: Array<{ id: string; attempts: number; kind: string }>;
}

const FixHistoryEntry = z.object({
  id: z.string(),
  attempts: z.number(),
  kind: z.string(),
});

const SummaryShape = z.object({
  fixHistory: z.array(FixHistoryEntry).optional(),
}).passthrough();

async function gather(): Promise<GatherResult> {
  const mediaDir = resolve(process.cwd(), CONFIG.mediaDir);
  let entries: string[];
  try {
    entries = await readdir(mediaDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[ui-content:gather] cannot read media dir "${mediaDir}": ${msg}`);
  }

  const allowed = new Set(['.png', '.jpg', '.jpeg', '.mp4']);
  const clips: string[] = [];
  for (const name of entries) {
    const ext = extname(name).toLowerCase();
    if (!allowed.has(ext)) continue;
    const full = resolve(mediaDir, name);
    try {
      const s = await stat(full);
      if (s.isFile()) clips.push(full);
    } catch {
      // skip unreadable entries silently
    }
  }
  clips.sort();

  if (clips.length === 0) {
    throw new Error(`[ui-content:gather] no media found in ${CONFIG.mediaDir} — expected .png/.jpg/.jpeg/.mp4 files`);
  }

  const featureSet = new Set<string>();
  for (const p of clips) {
    const base = basename(p, extname(p));
    const match = base.match(/^([^._-]+)/);
    if (match && match[1]) featureSet.add(match[1]);
  }
  const features = [...featureSet].sort();

  let fixHistory: GatherResult['fixHistory'] = [];
  try {
    const summaryPath = resolve(mediaDir, '_summary.json');
    const raw = await readFile(summaryPath, 'utf8');
    const parsed = SummaryShape.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.fixHistory) {
      fixHistory = parsed.data.fixHistory;
    }
  } catch {
    // optional — absent _summary.json is fine
  }

  return { clips, features, fixHistory };
}

// ---------------------------------------------------------------------------
// ffmpeg stitch
// ---------------------------------------------------------------------------

function isFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    proc.on('error', () => resolvePromise(false));
    proc.on('exit', (code) => resolvePromise(code === 0));
  });
}

async function stitchVideo(clips: string[], outputPath: string): Promise<void> {
  const ok = await isFfmpegAvailable();
  if (!ok) throw new Error('[ui-content:stitch] ffmpeg not available on PATH');

  const listPath = join(tmpdir(), `ui-content-concat-${Date.now()}-${process.pid}.txt`);
  const lines: string[] = [];
  const imageDuration = CONFIG.video.imageDurationSec;

  for (const clip of clips) {
    const ext = extname(clip).toLowerCase();
    lines.push(`file '${clip.replace(/'/g, "'\\''")}'`);
    if (ext !== '.mp4') {
      lines.push(`duration ${imageDuration.toFixed(3)}`);
    }
  }

  // ffmpeg concat-demuxer quirk: last file must be repeated without a trailing
  // `duration` so the final image holds for its declared span.
  const last = clips[clips.length - 1];
  if (last !== undefined && extname(last).toLowerCase() !== '.mp4') {
    lines.push(`file '${last.replace(/'/g, "'\\''")}'`);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(listPath, lines.join('\n') + '\n', 'utf8');

  const { width: W, height: H, fps: FPS } = CONFIG.video;
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-vf', vf,
    '-r', String(FPS),
    '-c:v', 'libx264',
    outputPath,
  ];

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    proc.on('error', (err) => rejectPromise(err));
    proc.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        const tail = Buffer.concat(stderrChunks).toString('utf8').slice(-2048);
        rejectPromise(new Error(`ffmpeg exited with code ${code ?? 'null'}:\n${tail}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const outDirAbs = resolve(process.cwd(), CONFIG.outDir);
  await mkdir(outDirAbs, { recursive: true });

  await taskflow('ui-content').run(async ({ phase, session }) => {
    const gathered = await phase('gather', async () => gather());

    await phase('stitch-video', async () => {
      const outPath = resolve(outDirAbs, 'video.mp4');
      const ok = await isFfmpegAvailable();
      if (!ok) {
        console.warn('[ui-content] ffmpeg not on PATH; skipping video stitch');
        await writeFile(outPath + '.missing', 'ffmpeg not installed\n', 'utf8');
        return;
      }
      await stitchVideo(gathered.clips, outPath);
    });

    const { outline, scripts } = await phase('narrate', async () => {
      const framePaths = gathered.clips;
      const features = gathered.features;

      const o = await session('narrate-outline', {
        with: CONFIG.model,
        task: [
          'You are drafting a 90-second product walkthrough.',
          `Features: ${features.join(', ') || '(none detected)'}.`,
          `Available frames: ${framePaths.length}.`,
          `Frame paths (in order):`,
          ...framePaths.map((p) => `  - ${p}`),
          '',
          'Return a NarrativeOutline matching the schema: title, hook, 3-7 beats (each with a summary and 1+ framePaths drawn from the list above), and a short outro.',
        ].join('\n'),
        schema: NarrativeOutline,
        timeoutMs: 300_000,
      });

      const s = await session('narrate-script', {
        with: CONFIG.model,
        task: [
          'Given this narrative outline:',
          '',
          JSON.stringify(o, null, 2),
          '',
          'Produce one script per platform. Respect length limits:',
          '  - twitter ≤ 280 chars',
          '  - linkedin ≤ 1300 chars',
          '  - reddit ≤ 40000 chars',
          '  - medium ≤ 100000 chars',
          '  - youtube, facebook, instagram ≤ 5000 chars',
          '',
          'YouTube is longest-form (treat as title + description + tag-style notes).',
          'Medium is article-style (intro, body, takeaway).',
          'Reddit should feel like an r/sideproject post (casual, first-person, no marketing jargon).',
          'Twitter must punch hard in under 280 chars.',
          'LinkedIn is professional, narrative-driven.',
          'Instagram is caption-first, line-break-heavy, emoji-sparse.',
          'Facebook is conversational.',
        ].join('\n'),
        schema: PlatformScripts,
        timeoutMs: 300_000,
      });

      await writeFile(
        resolve(outDirAbs, 'scripts.json'),
        JSON.stringify({ outline: o, scripts: s }, null, 2),
        'utf8',
      );

      return { outline: o, scripts: s };
    });

    void outline;

    await phase('distribute', async () => {
      const videoPath = resolve(outDirAbs, 'video.mp4');
      const results: PublishResult[] = [];
      for (const p of PLATFORMS) {
        const caption = scripts[p.id];
        const r = await p.publish({ video: videoPath, caption }, process.env);
        const validated = PublishResultSchema.parse(r);
        console.log(
          `[publish:${validated.platform}] status=${validated.status}${validated.message ? ' — ' + validated.message : ''}`,
        );
        results.push(validated);
      }
      await writeFile(
        resolve(outDirAbs, 'publish.manifest.json'),
        JSON.stringify({ publishedAt: new Date().toISOString(), results }, null, 2),
        'utf8',
      );
    });
  });
}

void main().catch((err) => {
  console.error('[ui-content] harness failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
