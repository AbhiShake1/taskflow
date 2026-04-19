import { text, isCancel, log } from '@clack/prompts';
import { parseSource } from './registry/parser';
import { defaultTaskflowJson, writeTaskflowJson } from './taskflow-json';
import type { RegistryConfig, RegistryConfigItem, TaskflowJson } from './registry/schema';

interface PublicRegistryIndex {
  registries?: Record<string, RegistryConfigItem>;
}

async function tryFetchPublicIndex(): Promise<PublicRegistryIndex | null> {
  const base = process.env.TASKFLOW_REGISTRY_URL ?? 'https://taskflow.sh/r';
  const url = `${base.replace(/\/+$/, '')}/registries.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (body && typeof body === 'object') {
      return body as PublicRegistryIndex;
    }
    return null;
  } catch {
    return null;
  }
}

export interface EnsureRegistriesOptions {
  cwd: string;
  writeFile: boolean;
  yes: boolean;
  silent: boolean;
}

export interface EnsureRegistriesResult {
  json: TaskflowJson;
  newRegistries: string[];
}

function collectNamespaces(inputs: string[]): string[] {
  const seen = new Set<string>();
  for (const input of inputs) {
    let spec;
    try {
      spec = parseSource(input);
    } catch {
      continue;
    }
    if (spec.kind === 'namespace') seen.add(spec.namespace);
  }
  return Array.from(seen);
}

export async function ensureRegistriesInConfig(
  inputs: string[],
  json: TaskflowJson | null,
  opts: EnsureRegistriesOptions,
): Promise<EnsureRegistriesResult> {
  const base: TaskflowJson = json ?? defaultTaskflowJson();
  const registries: RegistryConfig = { ...(base.registries ?? {}) };
  const namespaces = collectNamespaces(inputs);
  const newRegistries: string[] = [];

  const unconfigured = namespaces.filter(
    (ns) => ns !== '@taskflow' && registries[ns] === undefined,
  );
  if (unconfigured.length > 0) {
    const index = await tryFetchPublicIndex();
    if (index?.registries) {
      for (const ns of unconfigured) {
        const match = index.registries[ns];
        if (match !== undefined) {
          registries[ns] = match;
          newRegistries.push(ns);
          if (!opts.silent) log.info(`auto-registered ${ns} from public index`);
        }
      }
    }
  }

  for (const ns of namespaces) {
    if (ns === '@taskflow') continue;
    if (registries[ns] !== undefined) continue;

    if (opts.yes || opts.silent) {
      if (!opts.silent) {
        log.warn(
          `Namespace ${ns} is not configured — skipping auto-registration (run without --yes to add it).`,
        );
      }
      continue;
    }

    const answer = await text({
      message: `Register ${ns}? Enter URL template (must contain {name}), or leave blank to skip:`,
      placeholder: 'https://registry.example.com/r/{name}.json',
    });
    if (isCancel(answer) || typeof answer !== 'string' || answer.trim() === '') {
      if (!opts.silent) log.info(`skipped ${ns}`);
      continue;
    }
    if (!answer.includes('{name}')) {
      if (!opts.silent) log.warn(`URL must contain {name} — skipping ${ns}`);
      continue;
    }
    registries[ns] = answer.trim();
    newRegistries.push(ns);
  }

  const merged: TaskflowJson = { ...base, registries };

  if (opts.writeFile && newRegistries.length > 0) {
    await writeTaskflowJson(opts.cwd, merged);
    if (!opts.silent) log.success(`updated taskflow.json with ${newRegistries.length} registry entr(ies)`);
  }

  return { json: merged, newRegistries };
}
