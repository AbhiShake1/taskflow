import { log } from '@clack/prompts';
import { lockfileHandle } from './lockfile';
import { runAdd } from './pipeline';

export interface UpdateOptions {
  names: string[];
  cwd: string;
  yes: boolean;
  silent: boolean;
  dryRun: boolean;
  overwrite: boolean;
  skipAdapterCheck: boolean;
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  const lock = await lockfileHandle(opts.cwd).read();
  const all = Object.keys(lock.items);
  const targets = opts.names.length > 0 ? opts.names : all;
  if (targets.length === 0) {
    if (!opts.silent) log.info('no installed harnesses to update');
    return;
  }

  const sources: string[] = [];
  for (const name of targets) {
    const entry = lock.items[name];
    if (!entry) {
      if (!opts.silent) log.warn(`${name} is not in taskflow.lock — skipping`);
      continue;
    }
    sources.push(entry.source);
  }

  if (sources.length === 0) return;

  await runAdd({
    inputs: sources,
    cwd: opts.cwd,
    overwrite: opts.overwrite,
    yes: opts.yes,
    silent: opts.silent,
    dryRun: opts.dryRun,
    frozen: false,
    skipAdapterCheck: opts.skipAdapterCheck,
  });
}
