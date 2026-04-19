import { RegistryNotConfiguredError } from './errors';
import { expandEnvVars } from './env';
import { parseRegistryAndItemFromString } from './parser';
import type { RegistryConfig, RegistryConfigItem } from './schema';
import { validateRegistryConfig } from './validator';

const DEFAULT_TASKFLOW_REGISTRY_URL = 'https://taskflow.sh/r';

export const BUILTIN_REGISTRIES: RegistryConfig = {
  '@taskflow': '${REGISTRY_URL}/{name}.json',
};

function isUrl(input: string): boolean {
  try {
    new URL(input);
    return true;
  } catch {
    return false;
  }
}

function isLocalPath(input: string): boolean {
  return input.endsWith('.json') && !isUrl(input);
}

function substitutePlaceholders(template: string, name: string, style: string): string {
  return template.replaceAll('{name}', name).replaceAll('{style}', style);
}

export function buildUrlAndHeadersForRegistryItem(
  input: string,
  config: { registries?: RegistryConfig; style?: string } | null,
): { url: string; headers: Record<string, string> } | null {
  if (isUrl(input) || isLocalPath(input)) return null;

  const { registry, item } = parseRegistryAndItemFromString(input);
  const namespace = registry ?? '@taskflow';
  const style = config?.style ?? 'default';

  const merged: RegistryConfig = { ...BUILTIN_REGISTRIES, ...(config?.registries ?? {}) };

  if (namespace === '@taskflow' && !process.env.REGISTRY_URL) {
    process.env.REGISTRY_URL =
      process.env.TASKFLOW_REGISTRY_URL ?? DEFAULT_TASKFLOW_REGISTRY_URL;
  }

  const entry: RegistryConfigItem | undefined = merged[namespace];
  if (entry === undefined) throw new RegistryNotConfiguredError(namespace);

  validateRegistryConfig(namespace, entry);

  if (typeof entry === 'string') {
    const templated = substitutePlaceholders(entry, item, style);
    return { url: expandEnvVars(templated), headers: {} };
  }

  const templatedUrl = substitutePlaceholders(entry.url, item, style);
  let url = expandEnvVars(templatedUrl);

  if (entry.params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(entry.params)) {
      const expanded = expandEnvVars(v);
      if (expanded === '') continue;
      qs.set(k, expanded);
    }
    const query = qs.toString();
    if (query) url += (url.includes('?') ? '&' : '?') + query;
  }

  const headers: Record<string, string> = {};
  if (entry.headers) {
    for (const [k, v] of Object.entries(entry.headers)) {
      const expanded = expandEnvVars(v);
      if (expanded === '') continue;
      headers[k] = expanded;
    }
  }

  return { url, headers };
}
