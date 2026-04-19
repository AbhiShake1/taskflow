#!/usr/bin/env node
/**
 * `taskflow` CLI — single entrypoint published as `bin.taskflow` so users can
 * run a harness file from anywhere without authoring scaffolding scripts:
 *
 *   taskflow run harness/foo.ts        # execute, TUI if TTY else JSONL
 *   taskflow watch harness/foo.ts      # alias for run (matches `npm run watch` muscle memory)
 *   taskflow plan harness/foo.ts       # static AST preview, no LLM calls
 *
 * Each subcommand delegates to the existing in-source entry point with
 * argv re-shaped so the delegate sees its conventional layout.
 */

const HELP = `taskflow — multi-agent orchestration harness CLI

usage: taskflow <command> <harness.ts>

commands:
  run    Execute a harness file. Mounts the live TUI when stdout is a TTY,
         otherwise streams events as JSONL to stdout.
  watch  Alias for run.
  plan   Render a static AST preview of the harness's phase/session tree
         without invoking any model. Useful before committing to a real run.

env:
  HARNESS_NO_TTY=1                       Force the headless JSONL stream.
  HARNESS_RUNS_DIR=path                  Override the runs archive root.
  HARNESS_ADAPTER_OVERRIDE=mock          Swap every agent for the mock — smoke runs.
`;

// jiti handles extensionless relative imports in the compiled bundle so we
// don't have to rewrite every `import './foo'` across the source tree with
// `.js` extensions — Node's strict ESM resolver rejects extensionless
// relative imports, but jiti's resolver tolerates them.
async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(HELP);
    process.exit(subcommand ? 0 : 1);
  }

  process.argv = [process.argv[0]!, process.argv[1]!, ...rest];

  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const hereUrl = import.meta.url;
  const resolveRel = (rel: string): string => new URL(rel, hereUrl).pathname;

  switch (subcommand) {
    case 'run':
    case 'watch':
      await jiti.import(resolveRel('../runner/index.js'));
      return;
    case 'plan':
      await jiti.import(resolveRel('../plan/cli.js'));
      return;
    default:
      process.stderr.write(`taskflow: unknown command "${subcommand}"\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('taskflow:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
