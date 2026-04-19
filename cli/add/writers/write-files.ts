import { confirm, log } from '@clack/prompts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { RegistryItem, RegistryItemFile, TaskflowJson } from '../registry/schema';

export interface WriteOptions {
  cwd: string;
  overwrite: boolean;
  yes: boolean;
  silent: boolean;
  dryRun: boolean;
}

export interface WriteResult {
  written: string[];
  skipped: string[];
  overwritten: string[];
}

const ENV_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function resolvePath(input: string, cwd: string): string {
  const expanded = expandHome(input);
  if (isAbsolute(expanded)) return expanded;
  return resolve(cwd, expanded);
}

function isEnvFileName(p: string): boolean {
  const name = basename(p);
  return name === '.env' || name === '.env.local';
}

function parseEnvContents(contents: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = trimmed.match(ENV_LINE_RE);
    if (!m) continue;
    out.set(m[1], m[2]);
  }
  return out;
}

function mergeEnvContents(existing: string, incoming: string): string {
  const existingMap = parseEnvContents(existing);
  const incomingMap = parseEnvContents(incoming);
  const additions: string[] = [];
  for (const [key, value] of incomingMap) {
    if (!existingMap.has(key)) additions.push(`${key}=${value}`);
  }
  if (additions.length === 0) return existing;
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  return `${existing}${sep}${additions.join('\n')}\n`;
}

function resolveDestination(
  file: RegistryItemFile,
  taskflowJson: TaskflowJson,
  cwd: string,
): string | null {
  if (file.type === 'taskflow:config-patch') return null;

  if (file.target !== undefined && file.target !== '') {
    return resolvePath(file.target, cwd);
  }

  const harnessDir = taskflowJson.harnessDir ?? '.agents/taskflow/harness';
  const rulesDir = taskflowJson.rulesDir ?? '.agents/taskflow/rules';
  const fileName = basename(file.path);

  switch (file.type) {
    case 'taskflow:harness':
      return resolve(cwd, harnessDir, fileName);
    case 'taskflow:plugin':
      return resolve(cwd, harnessDir, 'plugins', fileName);
    case 'taskflow:rules':
      return resolve(cwd, rulesDir, fileName);
    case 'taskflow:utils':
      return resolve(cwd, harnessDir, 'utils', fileName);
    case 'taskflow:example':
      return resolve(cwd, harnessDir, 'examples', fileName);
    case 'taskflow:file':
      // target is required for taskflow:file by schema — unreachable
      return resolve(cwd, fileName);
    default:
      return resolve(cwd, fileName);
  }
}

export async function writeRegistryItem(
  item: RegistryItem,
  taskflowJson: TaskflowJson,
  opts: WriteOptions,
): Promise<WriteResult> {
  const result: WriteResult = { written: [], skipped: [], overwritten: [] };
  const files = item.files ?? [];

  // For taskflow:harness items, ensure harnessDir exists.
  if (files.some((f) => f.type === 'taskflow:harness')) {
    const harnessDir = resolve(opts.cwd, taskflowJson.harnessDir ?? '.agents/taskflow/harness');
    if (!existsSync(harnessDir) && !opts.dryRun) {
      await mkdir(harnessDir, { recursive: true });
    }
  }

  for (const file of files) {
    const dest = resolveDestination(file, taskflowJson, opts.cwd);
    if (dest === null) continue; // taskflow:config-patch handled elsewhere
    const content = file.content ?? '';

    const fileExists = existsSync(dest);

    // .env / .env.local merge semantics — existing keys win, append missing ones.
    if (isEnvFileName(dest)) {
      const existing = fileExists ? await readFile(dest, 'utf8') : '';
      const merged = mergeEnvContents(existing, content);
      if (merged === existing) {
        result.skipped.push(dest);
        if (!opts.silent) log.info(`skip (no new keys): ${dest}`);
        continue;
      }
      if (opts.dryRun) {
        if (!opts.silent) log.info(`would merge env file: ${dest}`);
        result.written.push(dest);
        continue;
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, merged, 'utf8');
      if (!opts.silent) log.success(`merged env file: ${dest}`);
      result.written.push(dest);
      continue;
    }

    if (fileExists) {
      const current = await readFile(dest, 'utf8');
      if (current === content) {
        result.skipped.push(dest);
        if (!opts.silent) log.info(`skip (identical): ${dest}`);
        continue;
      }

      if (!opts.overwrite) {
        if (opts.yes || opts.silent) {
          result.skipped.push(dest);
          if (!opts.silent) log.info(`skip (exists, no --overwrite): ${dest}`);
          continue;
        }
        const answer = await confirm({
          message: `Overwrite ${dest}?`,
          initialValue: false,
        });
        if (answer !== true) {
          result.skipped.push(dest);
          if (!opts.silent) log.info(`skip (declined): ${dest}`);
          continue;
        }
      }

      if (opts.dryRun) {
        if (!opts.silent) log.info(`would overwrite: ${dest}`);
        result.overwritten.push(dest);
        continue;
      }

      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content, 'utf8');
      if (!opts.silent) log.success(`overwrote: ${dest}`);
      result.overwritten.push(dest);
      continue;
    }

    if (opts.dryRun) {
      if (!opts.silent) log.info(`would write: ${dest}`);
      result.written.push(dest);
      continue;
    }

    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, 'utf8');
    if (!opts.silent) log.success(`wrote: ${dest}`);
    result.written.push(dest);
  }

  return result;
}
