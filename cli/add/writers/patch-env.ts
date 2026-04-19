import { log } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ENV_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
// Unquoted env values must avoid whitespace, quotes, `$`, `#`, and other shell metachars.
const NEEDS_QUOTING_RE = /[\s"'`$#\\&|;<>(){}*?!~]/;

function parseExistingKeys(contents: string): Set<string> {
  const out = new Set<string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = trimmed.match(ENV_LINE_RE);
    if (m) out.add(m[1]);
  }
  return out;
}

function quoteIfNeeded(value: string): string {
  if (value === '') return '""';
  if (!NEEDS_QUOTING_RE.test(value)) return value;
  // Quote with double quotes; escape backslashes and double quotes.
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escaped}"`;
}

export async function applyEnvPatch(
  envVars: Record<string, string> | undefined,
  opts: { cwd: string; dryRun: boolean; silent: boolean },
): Promise<void> {
  if (!envVars || Object.keys(envVars).length === 0) return;

  const target = resolve(opts.cwd, '.env.local');
  const existing = existsSync(target) ? await readFile(target, 'utf8') : '';
  const existingKeys = parseExistingKeys(existing);

  const additions: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (existingKeys.has(key)) continue;
    additions.push(`${key}=${quoteIfNeeded(value)}`);
  }

  if (additions.length === 0) {
    if (!opts.silent) log.info(`no new env vars to add to ${target}`);
    return;
  }

  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const updated = `${existing}${sep}${additions.join('\n')}\n`;

  if (opts.dryRun) {
    if (!opts.silent) log.info(`would append ${additions.length} env var(s) to ${target}`);
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, updated, 'utf8');
  if (!opts.silent) log.success(`appended ${additions.length} env var(s) to ${target}`);
}
