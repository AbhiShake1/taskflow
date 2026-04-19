import { log } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { registryItemSchema, registrySchema, type RegistryItem } from './registry/schema';

export interface BuildOptions {
  cwd: string;
  input?: string;
  output?: string;
  silent?: boolean;
}

interface RawFile {
  path: string;
  type: string;
  content?: string;
  target?: string;
}

interface RawItem {
  $schema?: string;
  name: string;
  type: string;
  files?: RawFile[];
  [key: string]: unknown;
}

interface RawRegistry {
  $schema?: string;
  name: string;
  homepage: string;
  items: RawItem[];
}

export async function runBuild(opts: BuildOptions): Promise<void> {
  const silent = opts.silent === true;
  const inputPath = resolve(opts.cwd, opts.input ?? 'registry.json');
  const outputDir = resolve(opts.cwd, opts.output ?? 'r');

  if (!existsSync(inputPath)) {
    throw new Error(`registry input not found: ${inputPath}`);
  }

  const raw = await readFile(inputPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`registry.json: invalid JSON — ${(err as Error).message}`);
  }

  const topLevel = registrySchema.safeParse(parsed);
  if (!topLevel.success) {
    throw new Error(`registry.json: ${topLevel.error.message}`);
  }

  const rawObj = parsed as RawRegistry;
  await mkdir(outputDir, { recursive: true });

  const emitted: string[] = [];
  for (const rawItem of rawObj.items) {
    const stamped: RawItem = {
      ...rawItem,
      $schema: 'https://taskflow.sh/schema/registry-item.json',
    };

    if (Array.isArray(stamped.files)) {
      const inlined: RawFile[] = [];
      for (const f of stamped.files) {
        if (f.content === undefined && typeof f.path === 'string') {
          const abs = resolve(opts.cwd, f.path);
          const content = await readFile(abs, 'utf8');
          inlined.push({ ...f, content });
        } else {
          inlined.push(f);
        }
      }
      stamped.files = inlined;
    }

    const validated = registryItemSchema.safeParse(stamped);
    if (!validated.success) {
      throw new Error(
        `registry item "${stamped.name}" failed validation: ${validated.error.message}`,
      );
    }
    const final: RegistryItem = validated.data;

    const outPath = join(outputDir, `${final.name}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(final, null, 2)}\n`, 'utf8');
    emitted.push(outPath);
  }

  const indexOut = join(outputDir, 'registry.json');
  await copyFile(inputPath, indexOut);

  if (!silent) {
    log.success(`built ${emitted.length} item(s) into ${outputDir}`);
  }
}
