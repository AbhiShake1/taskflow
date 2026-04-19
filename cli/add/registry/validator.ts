import { RegistryMissingEnvironmentVariablesError } from './errors';
import type { RegistryConfigItem } from './schema';

const ENV_VAR_RE = /\$\{(\w+)\}/g;

export function extractEnvVarsFromString(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(ENV_VAR_RE)) out.push(m[1]);
  return out;
}

export function extractEnvVarsFromRegistryConfig(entry: RegistryConfigItem): string[] {
  const seen = new Set<string>();
  const collect = (s: string): void => {
    for (const name of extractEnvVarsFromString(s)) seen.add(name);
  };
  if (typeof entry === 'string') {
    collect(entry);
    return Array.from(seen);
  }
  collect(entry.url);
  if (entry.params) for (const v of Object.values(entry.params)) collect(v);
  if (entry.headers) for (const v of Object.values(entry.headers)) collect(v);
  return Array.from(seen);
}

export function validateRegistryConfig(
  namespace: string,
  entry: RegistryConfigItem,
): void {
  void namespace;
  const required = extractEnvVarsFromRegistryConfig(entry);
  const missing = required.filter((name) => {
    const v = process.env[name];
    return v === undefined || v === '';
  });
  if (missing.length > 0) throw new RegistryMissingEnvironmentVariablesError(missing);
}
