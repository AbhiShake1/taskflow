import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(ENV_LINE_RE);
    if (!m) continue;
    const key = m[1];
    out[key] = unquote(m[2]);
  }
  return out;
}

export function loadEnvFiles(cwd: string): void {
  for (const name of ['.env', '.env.local']) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    let contents: string;
    try {
      contents = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseEnvFile(contents);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
