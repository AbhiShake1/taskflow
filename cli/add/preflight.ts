import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RegistryItem, TaskflowJson } from './registry/schema';

export interface PreflightResult {
  missingAdapters: string[];
  missingEnvVars: string[];
  targetWritable: boolean;
  errors: string[];
}

const KNOWN_ADAPTERS: ReadonlySet<string> = new Set([
  'claude-code',
  'pi',
  'codex',
  'cursor',
  'opencode',
  'mock',
]);

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runPreflight(
  items: RegistryItem[],
  opts: { cwd: string; taskflowJson: TaskflowJson },
): Promise<PreflightResult> {
  const errors: string[] = [];

  const adaptersNeeded = new Set<string>();
  const envNeeded = new Set<string>();
  for (const item of items) {
    for (const a of item.requiredAdapters ?? []) adaptersNeeded.add(a);
    for (const e of item.requiredEnv ?? []) envNeeded.add(e);
  }

  const missingAdapters = Array.from(adaptersNeeded).filter((a) => !KNOWN_ADAPTERS.has(a));
  const missingEnvVars = Array.from(envNeeded).filter(
    (name) => process.env[name] === undefined || process.env[name] === '',
  );

  const harnessDir = resolve(opts.cwd, opts.taskflowJson.harnessDir ?? '.agents/taskflow/harness');
  const rulesDir = resolve(opts.cwd, opts.taskflowJson.rulesDir ?? '.agents/taskflow/rules');

  // Check the parent of harnessDir / rulesDir (since the dirs themselves may not exist yet).
  const harnessParent = dirname(harnessDir);
  const rulesParent = dirname(rulesDir);

  const [harnessOk, rulesOk] = await Promise.all([
    isWritable(harnessParent),
    isWritable(rulesParent),
  ]);

  const targetWritable = harnessOk && rulesOk;
  if (!harnessOk) errors.push(`harness parent directory not writable: ${harnessParent}`);
  if (!rulesOk) errors.push(`rules parent directory not writable: ${rulesParent}`);

  if (missingAdapters.length > 0) {
    errors.push(`required adapter(s) not available: ${missingAdapters.join(', ')}`);
  }
  if (missingEnvVars.length > 0) {
    errors.push(`required env var(s) not set: ${missingEnvVars.join(', ')}`);
  }

  return { missingAdapters, missingEnvVars, targetWritable, errors };
}
