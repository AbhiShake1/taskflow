import { runAdd, type AddPipelineResult } from './pipeline';

export interface ApplyOptions {
  preset: string;
  cwd: string;
  yes: boolean;
  silent: boolean;
  dryRun: boolean;
  skipAdapterCheck: boolean;
}

export async function runApply(opts: ApplyOptions): Promise<AddPipelineResult> {
  return runAdd({
    inputs: [opts.preset],
    cwd: opts.cwd,
    overwrite: true,
    yes: opts.yes,
    silent: opts.silent,
    dryRun: opts.dryRun,
    frozen: false,
    skipAdapterCheck: opts.skipAdapterCheck,
  });
}
