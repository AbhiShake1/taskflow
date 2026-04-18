import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ScopedFs } from './hooks';

function resolveUnderRoot(root: string, p: string): string {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`scoped-fs: path escapes root: ${p}`);
  }
  return abs;
}

export function createScopedFs(root: string): ScopedFs {
  const rootAbs = resolve(root);
  return {
    async read(p) {
      const abs = resolveUnderRoot(rootAbs, p);
      return readFile(abs, 'utf8');
    },
    async write(p, content) {
      const abs = resolveUnderRoot(rootAbs, p);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    },
    async mkdir(p) {
      const abs = resolveUnderRoot(rootAbs, p);
      await mkdir(abs, { recursive: true });
    },
    async list(p) {
      const abs = resolveUnderRoot(rootAbs, p);
      return readdir(abs);
    },
  };
}
