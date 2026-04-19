import { loadEnvFiles } from './env-loader';
import { clearRegistryContext } from './registry/context';
import { clearFetchCache } from './registry/fetcher';
import { fetchRegistryItems } from './registry/resolver';
import { loadTaskflowJson } from './taskflow-json';

export interface ViewOptions {
  source: string;
  cwd: string;
}

export async function runView(opts: ViewOptions): Promise<void> {
  loadEnvFiles(opts.cwd);
  try {
    const json = await loadTaskflowJson(opts.cwd);
    const resolved = await fetchRegistryItems([opts.source], json);
    process.stdout.write(`${JSON.stringify(resolved[0].item, null, 2)}\n`);
  } finally {
    clearRegistryContext();
    clearFetchCache();
  }
}
