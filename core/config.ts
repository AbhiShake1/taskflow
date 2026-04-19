import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defu } from 'defu';
import { createJiti } from 'jiti';
import type { HookHandlers, ResolvedConfig } from './hooks';
import type { Plugin } from './plugin';

export interface TaskflowConfig {
  events?: Partial<HookHandlers>;
  todos?: Partial<ResolvedConfig['todos']>;
  hooks?: Partial<ResolvedConfig['hooks']>;
  plugins?: Plugin[];
  scope?: string;
}

export interface LoadedConfig {
  resolved: ResolvedConfig;
  eventLayers: Array<Partial<HookHandlers>>;
  sources: string[];
  plugins: Plugin[];
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  // events is reserved on ResolvedConfig but the loader writes per-source
  // handlers to LoadedConfig.eventLayers (an array) and the engine mounts each
  // layer onto HookRegistry directly; resolved.events stays {} as a forward-
  // compat slot.
  events: {},
  todos: { autoExtract: true, maxRetries: 3, forceGeneration: false },
  hooks: { errorPolicy: 'swallow', timeoutMs: 30_000 },
  plugins: [],
};

export function defineConfig(c: TaskflowConfig): TaskflowConfig {
  return c;
}

const CONFIG_EXTS = ['ts', 'mjs', 'js'] as const;
const CONFIG_BASEDIR = join('.agents', 'taskflow');

function findConfigInDir(dir: string): string | undefined {
  for (const ext of CONFIG_EXTS) {
    const candidate = join(dir, CONFIG_BASEDIR, `config.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isDescendantOrEqual(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  const rel = relative(p, c);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

function walkDirsBetween(home: string, cwd: string): string[] {
  const homeAbs = resolve(home);
  const cwdAbs = resolve(cwd);
  if (homeAbs === cwdAbs) return [homeAbs];
  if (!isDescendantOrEqual(homeAbs, cwdAbs)) return [];
  const out: string[] = [homeAbs];
  const rel = relative(homeAbs, cwdAbs);
  const segments = rel.split(sep).filter((s) => s.length > 0);
  let cur = homeAbs;
  for (const seg of segments) {
    cur = join(cur, seg);
    out.push(cur);
  }
  return out;
}

function discoverSources(home: string, cwd: string): string[] {
  const homeAbs = resolve(home);
  const cwdAbs = resolve(cwd);
  const sources: string[] = [];
  const seen = new Set<string>();

  if (!isDescendantOrEqual(homeAbs, cwdAbs)) {
    const homeFile = findConfigInDir(homeAbs);
    if (homeFile) {
      sources.push(homeFile);
      seen.add(homeFile);
    }
    if (cwdAbs !== homeAbs) {
      const cwdFile = findConfigInDir(cwdAbs);
      if (cwdFile && !seen.has(cwdFile)) {
        sources.push(cwdFile);
        seen.add(cwdFile);
      }
    }
    return sources;
  }

  for (const dir of walkDirsBetween(homeAbs, cwdAbs)) {
    const file = findConfigInDir(dir);
    if (file && !seen.has(file)) {
      sources.push(file);
      seen.add(file);
    }
  }
  return sources;
}

const jitiInstance = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

async function loadOne(absPath: string): Promise<TaskflowConfig> {
  let mod: unknown;
  try {
    mod = await jitiInstance.import(pathToFileURL(absPath).href, { default: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`taskflow: failed to load config at ${absPath}: ${msg}`);
  }
  const candidate =
    mod && typeof mod === 'object' && 'default' in (mod as Record<string, unknown>)
      ? (mod as { default: unknown }).default
      : mod;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(
      `taskflow: failed to load config at ${absPath}: default export is not an object`,
    );
  }
  const obj = candidate as Record<string, unknown>;
  const known = ['events', 'todos', 'hooks', 'plugins', 'scope'];
  if (!known.some((k) => k in obj)) {
    throw new Error(
      `taskflow: failed to load config at ${absPath}: config object contains none of the expected keys – must include at least one of: events, todos, hooks, plugins, scope`,
    );
  }
  return obj as TaskflowConfig;
}

const cache = new Map<string, Promise<LoadedConfig>>();

export function clearConfigCache(): void {
  cache.clear();
}

export function loadConfig(opts?: { cwd?: string; home?: string }): Promise<LoadedConfig> {
  const cwd = resolve(opts?.cwd ?? process.cwd());
  const home = resolve(opts?.home ?? homedir());
  const key = `${home}\u0000${cwd}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const p = doLoad(home, cwd);
  cache.set(key, p);
  return p;
}

async function doLoad(home: string, cwd: string): Promise<LoadedConfig> {
  const sources = discoverSources(home, cwd);
  const eventLayers: Array<Partial<HookHandlers>> = [];
  const plugins: Plugin[] = [];
  const todoFragments: Array<Partial<ResolvedConfig['todos']>> = [];
  const hookFragments: Array<Partial<ResolvedConfig['hooks']>> = [];
  let scope: string | undefined;

  for (const src of sources) {
    const cfg = await loadOne(src);
    if (cfg.events && Object.keys(cfg.events).length > 0) {
      eventLayers.push(cfg.events);
    }
    if (cfg.plugins && cfg.plugins.length > 0) {
      plugins.push(...cfg.plugins);
    }
    if (cfg.todos) todoFragments.push(cfg.todos);
    if (cfg.hooks) hookFragments.push(cfg.hooks);
    if (typeof cfg.scope === 'string' && cfg.scope.length > 0) scope = cfg.scope;
  }

  const todos = defu({}, ...[...todoFragments].reverse(), DEFAULT_CONFIG.todos) as ResolvedConfig['todos'];
  const hooks = defu({}, ...[...hookFragments].reverse(), DEFAULT_CONFIG.hooks) as ResolvedConfig['hooks'];

  const resolved: ResolvedConfig = {
    events: {},
    todos,
    hooks,
    plugins: [],
    ...(scope !== undefined ? { scope } : {}),
  };

  return { resolved, eventLayers, sources, plugins };
}
