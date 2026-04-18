import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProofApi } from './hooks';

const SAFE_NAME = /[^a-zA-Z0-9._-]/g;

function sanitize(name: string): string {
  if (!name || name.length === 0) {
    throw new Error('proof: name must be non-empty');
  }
  return name.replace(SAFE_NAME, '_');
}

export function createProofApi(dir: string): ProofApi {
  const dirAbs = resolve(dir);
  let ensured = false;
  const ensureDir = async () => {
    if (ensured) return;
    await mkdir(dirAbs, { recursive: true });
    ensured = true;
  };
  return {
    async captureJson(name, value) {
      const safe = sanitize(name);
      await ensureDir();
      const out = resolve(dirAbs, `${safe}.json`);
      await writeFile(out, JSON.stringify(value, null, 2), 'utf8');
      return out;
    },
    async captureFile(name, srcPath) {
      const safe = sanitize(name);
      await ensureDir();
      const out = resolve(dirAbs, safe);
      await copyFile(srcPath, out);
      return out;
    },
  };
}
