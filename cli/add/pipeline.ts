import { log } from '@clack/prompts';
import { loadEnvFiles } from './env-loader';
import { ensureRegistriesInConfig } from './ensure-registries';
import { runInit } from './init';
import { lockfileHandle, assertFrozen } from './lockfile';
import { runPreflight } from './preflight';
import { clearRegistryContext } from './registry/context';
import { clearFetchCache } from './registry/fetcher';
import { fetchRegistryItems, resolveRegistryTree } from './registry/resolver';
import { loadTaskflowJson } from './taskflow-json';
import { applyConfigPatch } from './writers/patch-config';
import { applyEnvPatch } from './writers/patch-env';
import { writeRegistryItem } from './writers/write-files';
import type { LockItem, TaskflowJson } from './registry/schema';

export interface AddPipelineOptions {
  inputs: string[];
  cwd: string;
  overwrite: boolean;
  yes: boolean;
  silent: boolean;
  dryRun: boolean;
  frozen: boolean;
  pathOverride?: string;
  skipAdapterCheck: boolean;
  diff?: boolean;
  view?: boolean;
}

export interface AddPipelineResult {
  added: string[];
  skipped: string[];
  overwritten: string[];
}

function isUniversalFileType(type: string): boolean {
  return type === 'taskflow:file' || type === 'taskflow:rules';
}

export async function runAdd(opts: AddPipelineOptions): Promise<AddPipelineResult> {
  if (opts.inputs.length === 0) {
    throw new Error('taskflow add: at least one source is required.');
  }

  loadEnvFiles(opts.cwd);

  if (opts.view === true) {
    try {
      const json = await loadTaskflowJson(opts.cwd);
      const resolved = await fetchRegistryItems(opts.inputs, json, {
        yes: opts.yes,
        silent: opts.silent,
        cwd: opts.cwd,
      });
      for (const r of resolved) {
        process.stdout.write(`${JSON.stringify(r.item, null, 2)}\n`);
      }
      return { added: [], skipped: [], overwritten: [] };
    } finally {
      clearRegistryContext();
      clearFetchCache();
    }
  }

  try {
    let json = await loadTaskflowJson(opts.cwd);
    if (json === null) {
      await runInit({ cwd: opts.cwd, yes: opts.yes, silent: opts.silent });
      json = await loadTaskflowJson(opts.cwd);
    }

    const initial = await ensureRegistriesInConfig(opts.inputs, json, {
      cwd: opts.cwd,
      writeFile: false,
      yes: opts.yes,
      silent: opts.silent,
    });
    let mergedJson: TaskflowJson = initial.json;

    const probe = await fetchRegistryItems([opts.inputs[0]], mergedJson, {
      yes: opts.yes,
      silent: opts.silent,
      cwd: opts.cwd,
    });
    const probeIsUniversal =
      probe.length > 0 &&
      (isUniversalFileType(probe[0].item.type) ||
        (probe[0].item.files ?? []).every((f) => isUniversalFileType(f.type)));

    if (!probeIsUniversal) {
      const pre = await runPreflight([probe[0].item], { cwd: opts.cwd, taskflowJson: mergedJson });
      if (pre.errors.length > 0 && !opts.skipAdapterCheck) {
        throw new Error(`preflight failed: ${pre.errors.join('; ')}`);
      }
      if (pre.errors.length > 0 && !opts.silent) {
        log.warn(`preflight warnings suppressed by --skip-adapter-check: ${pre.errors.join('; ')}`);
      }
    }

    const persisted = await ensureRegistriesInConfig(opts.inputs, mergedJson, {
      cwd: opts.cwd,
      writeFile: true,
      yes: opts.yes,
      silent: opts.silent,
    });
    mergedJson = persisted.json;

    const resolved = await resolveRegistryTree(opts.inputs, mergedJson, {
      yes: opts.yes,
      silent: opts.silent,
      cwd: opts.cwd,
    });

    if (opts.frozen) {
      const lock = await lockfileHandle(opts.cwd).read();
      const requested: Record<string, LockItem> = {};
      for (const r of resolved) {
        requested[r.item.name] = { source: r.sourceUrl, type: r.item.type };
      }
      assertFrozen(lock, requested);
    }

    const effectiveJson: TaskflowJson = opts.pathOverride
      ? { ...mergedJson, harnessDir: opts.pathOverride }
      : mergedJson;

    const added: string[] = [];
    const skipped: string[] = [];
    const overwritten: string[] = [];

    const writeOpts = {
      cwd: opts.cwd,
      overwrite: opts.overwrite,
      yes: opts.yes,
      silent: opts.silent,
      dryRun: opts.dryRun,
    };

    const lock = lockfileHandle(opts.cwd);

    for (const r of resolved) {
      const res = await writeRegistryItem(r.item, effectiveJson, writeOpts);
      added.push(...res.written);
      skipped.push(...res.skipped);
      overwritten.push(...res.overwritten);

      await applyConfigPatch(r.item.config, {
        cwd: opts.cwd,
        dryRun: opts.dryRun,
        silent: opts.silent,
      });

      await applyEnvPatch(r.item.envVars, {
        cwd: opts.cwd,
        dryRun: opts.dryRun,
        silent: opts.silent,
      });

      if (!opts.dryRun) {
        const entry: LockItem = { source: r.sourceUrl, type: r.item.type };
        if (r.item.registryDependencies && r.item.registryDependencies.length > 0) {
          entry.dependencies = [...r.item.registryDependencies];
        }
        await lock.upsert(r.item.name, entry);
      }
    }

    return { added, skipped, overwritten };
  } finally {
    clearRegistryContext();
    clearFetchCache();
  }
}
