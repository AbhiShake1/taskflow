import { log } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lockfileHandle } from './lockfile';
import { loadTaskflowJson } from './taskflow-json';

export interface RemoveOptions {
  name: string;
  cwd: string;
  silent: boolean;
  dryRun: boolean;
}

export async function runRemove(opts: RemoveOptions): Promise<void> {
  const handle = lockfileHandle(opts.cwd);
  const lock = await handle.read();
  const entry = lock.items[opts.name];
  if (!entry) {
    if (!opts.silent) log.warn(`${opts.name} is not in taskflow.lock`);
    return;
  }

  const json = await loadTaskflowJson(opts.cwd);
  const harnessDir = json?.harnessDir ?? '.agents/taskflow/harness';
  const guess = resolve(opts.cwd, harnessDir, `${opts.name}.ts`);

  if (existsSync(guess)) {
    if (opts.dryRun) {
      if (!opts.silent) log.info(`would delete ${guess}`);
    } else {
      await rm(guess, { force: true });
      if (!opts.silent) log.success(`deleted ${guess}`);
    }
  } else if (!opts.silent) {
    log.info(`no file found at ${guess} — lockfile-only remove`);
  }

  if (!opts.dryRun) {
    await handle.remove(opts.name);
    if (!opts.silent) log.success(`removed ${opts.name} from taskflow.lock`);
  }
}
