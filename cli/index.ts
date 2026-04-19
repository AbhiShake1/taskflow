#!/usr/bin/env node
import { cac } from 'cac';
import { resolve } from 'node:path';

interface RunFlags {
  [key: string]: unknown;
}

let cachedJiti: Promise<ReturnType<typeof import('jiti').createJiti>> | null = null;

async function getJiti(): Promise<ReturnType<typeof import('jiti').createJiti>> {
  if (cachedJiti) return cachedJiti;
  cachedJiti = (async () => {
    const { createJiti } = await import('jiti');
    return createJiti(import.meta.url, { interopDefault: true });
  })();
  return cachedJiti;
}

async function runViaJiti(argv: string[], target: string): Promise<void> {
  process.argv = [process.argv[0]!, process.argv[1]!, ...argv];
  const jiti = await getJiti();
  const resolveRel = (rel: string): string => new URL(rel, import.meta.url).pathname;
  await jiti.import(resolveRel(target));
}

async function importViaJiti<T>(rel: string): Promise<T> {
  const jiti = await getJiti();
  const abs = new URL(rel, import.meta.url).pathname;
  return jiti.import<T>(abs);
}

function die(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`taskflow: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const cli = cac('taskflow');

  cli
    .command('run <harness>', 'Execute a harness file (TUI if TTY else JSONL)')
    .allowUnknownOptions()
    .action(async (harness: string, _opts: RunFlags) => {
      try {
        await runViaJiti([harness], '../runner/index.js');
      } catch (err) {
        die(err);
      }
    });

  cli
    .command('watch <harness>', 'Alias for run')
    .allowUnknownOptions()
    .action(async (harness: string, _opts: RunFlags) => {
      try {
        await runViaJiti([harness], '../runner/index.js');
      } catch (err) {
        die(err);
      }
    });

  cli
    .command('plan <harness>', 'Static AST preview of a harness')
    .allowUnknownOptions()
    .action(async (harness: string, _opts: RunFlags) => {
      try {
        await runViaJiti([harness], '../plan/cli.js');
      } catch (err) {
        die(err);
      }
    });

  cli
    .command('init', 'Create taskflow.json + .agents/taskflow/config.ts')
    .option('-y, --yes', 'skip prompts')
    .option('-c, --cwd <dir>', 'working directory')
    .option('-s, --silent', 'mute output')
    .action(async (opts: { yes?: boolean; cwd?: string; silent?: boolean }) => {
      try {
        const mod = await importViaJiti<typeof import('./add/init')>('./add/init.js');
        await mod.runInit({
          cwd: resolve(opts.cwd ?? process.cwd()),
          yes: opts.yes === true,
          silent: opts.silent === true,
        });
      } catch (err) {
        die(err);
      }
    });

  cli
    .command(
      'add [...sources]',
      'Install harness from a registry, URL, git repo, or local file',
    )
    .option('-y, --yes', 'skip confirmation')
    .option('-o, --overwrite', 'overwrite existing files')
    .option('--dry-run', 'preview only')
    .option('-p, --path <dir>', 'harness install directory override')
    .option('-c, --cwd <dir>', 'working directory')
    .option('-s, --silent', 'mute output')
    .option('--frozen', 'error on lockfile drift (CI)')
    .option('--skip-adapter-check', 'skip requiredAdapters preflight')
    .option('--diff', 'preview changes without writing (implies --dry-run)')
    .option('--view', 'print resolved registry item JSON and exit')
    .action(
      async (
        sources: string[],
        opts: {
          yes?: boolean;
          overwrite?: boolean;
          dryRun?: boolean;
          path?: string;
          cwd?: string;
          silent?: boolean;
          frozen?: boolean;
          skipAdapterCheck?: boolean;
          diff?: boolean;
          view?: boolean;
        },
      ) => {
        try {
          if (!Array.isArray(sources) || sources.length === 0) {
            throw new Error('add: at least one source is required.');
          }
          const mod = await importViaJiti<typeof import('./add/pipeline')>('./add/pipeline.js');
          const result = await mod.runAdd({
            inputs: sources,
            cwd: resolve(opts.cwd ?? process.cwd()),
            overwrite: opts.overwrite === true,
            yes: opts.yes === true,
            silent: opts.silent === true,
            dryRun: opts.dryRun === true || opts.diff === true,
            frozen: opts.frozen === true,
            ...(opts.path !== undefined ? { pathOverride: opts.path } : {}),
            skipAdapterCheck: opts.skipAdapterCheck === true,
            diff: opts.diff === true,
            view: opts.view === true,
          });
          if (opts.silent !== true) {
            process.stdout.write(
              `add: ${result.added.length} written, ${result.overwritten.length} overwritten, ${result.skipped.length} skipped\n`,
            );
          }
        } catch (err) {
          die(err);
        }
      },
    );

  cli
    .command('build [input]', 'Publisher: inline file contents, emit per-item JSONs')
    .option('-o, --output <dir>', 'output directory (default: ./r)')
    .option('-c, --cwd <dir>', 'working directory')
    .option('-s, --silent', 'mute output')
    .action(
      async (
        input: string | undefined,
        opts: { output?: string; cwd?: string; silent?: boolean },
      ) => {
        try {
          const mod = await importViaJiti<typeof import('./add/build')>('./add/build.js');
          await mod.runBuild({
            cwd: resolve(opts.cwd ?? process.cwd()),
            ...(input !== undefined ? { input } : {}),
            ...(opts.output !== undefined ? { output: opts.output } : {}),
            silent: opts.silent === true,
          });
        } catch (err) {
          die(err);
        }
      },
    );

  cli
    .command('view <source>', 'Resolve a source and print the registry item JSON')
    .option('-c, --cwd <dir>', 'working directory')
    .action(async (source: string, opts: { cwd?: string }) => {
      try {
        const mod = await importViaJiti<typeof import('./add/view')>('./add/view.js');
        await mod.runView({ source, cwd: resolve(opts.cwd ?? process.cwd()) });
      } catch (err) {
        die(err);
      }
    });

  cli
    .command('list', 'Show installed harnesses from taskflow.lock')
    .option('-c, --cwd <dir>', 'working directory')
    .action(async (opts: { cwd?: string }) => {
      try {
        const mod = await importViaJiti<typeof import('./add/list')>('./add/list.js');
        await mod.runList({ cwd: resolve(opts.cwd ?? process.cwd()) });
      } catch (err) {
        die(err);
      }
    });

  cli
    .command('search <query>', 'Fuzzy-match against the public registry index')
    .option('-c, --cwd <dir>', 'working directory')
    .option('-s, --silent', 'mute output')
    .action(async (query: string, opts: { cwd?: string; silent?: boolean }) => {
      try {
        const mod = await importViaJiti<typeof import('./add/search')>('./add/search.js');
        await mod.runSearch({
          query,
          cwd: resolve(opts.cwd ?? process.cwd()),
          silent: opts.silent === true,
        });
      } catch (err) {
        die(err);
      }
    });

  cli
    .command('update [...names]', 'Re-resolve and rewrite installed harnesses')
    .option('-y, --yes', 'skip prompts')
    .option('-o, --overwrite', 'overwrite existing files')
    .option('--dry-run', 'preview only')
    .option('-c, --cwd <dir>', 'working directory')
    .option('-s, --silent', 'mute output')
    .option('--skip-adapter-check', 'skip requiredAdapters preflight')
    .action(
      async (
        names: string[] | undefined,
        opts: {
          yes?: boolean;
          overwrite?: boolean;
          dryRun?: boolean;
          cwd?: string;
          silent?: boolean;
          skipAdapterCheck?: boolean;
        },
      ) => {
        try {
          const mod = await importViaJiti<typeof import('./add/update')>('./add/update.js');
          await mod.runUpdate({
            names: names ?? [],
            cwd: resolve(opts.cwd ?? process.cwd()),
            yes: opts.yes === true,
            overwrite: opts.overwrite === true,
            dryRun: opts.dryRun === true,
            silent: opts.silent === true,
            skipAdapterCheck: opts.skipAdapterCheck === true,
          });
        } catch (err) {
          die(err);
        }
      },
    );

  cli
    .command('remove <name>', 'Delete an installed harness and update the lockfile')
    .option('-c, --cwd <dir>', 'working directory')
    .option('-s, --silent', 'mute output')
    .option('--dry-run', 'preview only')
    .action(
      async (
        name: string,
        opts: { cwd?: string; silent?: boolean; dryRun?: boolean },
      ) => {
        try {
          const mod = await importViaJiti<typeof import('./add/remove')>('./add/remove.js');
          await mod.runRemove({
            name,
            cwd: resolve(opts.cwd ?? process.cwd()),
            silent: opts.silent === true,
            dryRun: opts.dryRun === true,
          });
        } catch (err) {
          die(err);
        }
      },
    );

  cli
    .command('apply <preset>', 'Re-install a preset with overwrite (shadcn-style re-skin)')
    .option('-y, --yes', 'skip prompts')
    .option('--dry-run', 'preview only')
    .option('-c, --cwd <dir>', 'working directory')
    .option('-s, --silent', 'mute output')
    .option('--skip-adapter-check', 'skip requiredAdapters preflight')
    .action(
      async (
        preset: string,
        opts: {
          yes?: boolean;
          dryRun?: boolean;
          cwd?: string;
          silent?: boolean;
          skipAdapterCheck?: boolean;
        },
      ) => {
        try {
          const mod = await importViaJiti<typeof import('./add/apply')>('./add/apply.js');
          await mod.runApply({
            preset,
            cwd: resolve(opts.cwd ?? process.cwd()),
            yes: opts.yes === true,
            silent: opts.silent === true,
            dryRun: opts.dryRun === true,
            skipAdapterCheck: opts.skipAdapterCheck === true,
          });
        } catch (err) {
          die(err);
        }
      },
    );

  cli
    .command('mcp', 'Start the MCP server (stdio)')
    .option('-c, --cwd <dir>', 'working directory')
    .action(async (opts: { cwd?: string }) => {
      try {
        const mod = await importViaJiti<typeof import('./add/mcp')>('./add/mcp.js');
        await mod.runMcp({ cwd: resolve(opts.cwd ?? process.cwd()) });
      } catch (err) {
        die(err);
      }
    });

  cli.help();
  cli.version('0.1.20');
  cli.parse();
}

main().catch(die);
