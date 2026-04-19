import { confirm, log } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface InitOptions {
  cwd: string;
  silent: boolean;
  yes: boolean;
}

export interface InitResult {
  taskflowJsonPath: string;
  configTsPath: string;
  created: string[];
}

const DEFAULT_TASKFLOW_JSON = {
  $schema: 'https://taskflow.sh/schema/taskflow.json',
  version: '1',
  harnessDir: '.agents/taskflow/harness',
  rulesDir: '.agents/taskflow/rules',
  registries: {},
} as const;

const DEFAULT_CONFIG_TS = `import { defineConfig } from '@taskflow-corp/cli/config';

export default defineConfig({});
`;

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const taskflowJsonPath = resolve(opts.cwd, 'taskflow.json');
  const configTsPath = resolve(opts.cwd, '.agents/taskflow/config.ts');
  const harnessDir = resolve(opts.cwd, '.agents/taskflow/harness');
  const rulesDir = resolve(opts.cwd, '.agents/taskflow/rules');
  const created: string[] = [];

  const taskflowJsonExists = existsSync(taskflowJsonPath);

  if (!taskflowJsonExists) {
    let proceed = opts.yes;
    if (!proceed) {
      const answer = await confirm({
        message: 'Create taskflow.json?',
        initialValue: true,
      });
      proceed = answer === true;
    }
    if (proceed) {
      await writeFile(
        taskflowJsonPath,
        `${JSON.stringify(DEFAULT_TASKFLOW_JSON, null, 2)}\n`,
        'utf8',
      );
      created.push(taskflowJsonPath);
      if (!opts.silent) log.success(`created ${taskflowJsonPath}`);
    } else if (!opts.silent) {
      log.info(`skipped taskflow.json`);
    }
  }

  if (!existsSync(configTsPath)) {
    await mkdir(resolve(opts.cwd, '.agents/taskflow'), { recursive: true });
    await writeFile(configTsPath, DEFAULT_CONFIG_TS, 'utf8');
    created.push(configTsPath);
    if (!opts.silent) log.success(`created ${configTsPath}`);
  }

  if (!existsSync(harnessDir)) {
    await mkdir(harnessDir, { recursive: true });
    created.push(harnessDir);
    if (!opts.silent) log.success(`created ${harnessDir}`);
  }

  if (!existsSync(rulesDir)) {
    await mkdir(rulesDir, { recursive: true });
    created.push(rulesDir);
    if (!opts.silent) log.success(`created ${rulesDir}`);
  }

  return { taskflowJsonPath, configTsPath, created };
}
