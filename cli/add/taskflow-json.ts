import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { taskflowJsonSchema, type TaskflowJson } from './registry/schema';

export function defaultTaskflowJson(): TaskflowJson {
  return {
    version: '1',
    harnessDir: '.agents/taskflow/harness',
    rulesDir: '.agents/taskflow/rules',
    registries: {},
  };
}

export async function loadTaskflowJson(cwd: string): Promise<TaskflowJson | null> {
  const path = resolve(cwd, 'taskflow.json');
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`taskflow.json: invalid JSON — ${(err as Error).message}`);
  }
  const result = taskflowJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`taskflow.json: schema validation failed — ${result.error.message}`);
  }
  return result.data;
}

export async function writeTaskflowJson(cwd: string, json: TaskflowJson): Promise<void> {
  const path = resolve(cwd, 'taskflow.json');
  const payload: Record<string, unknown> = {
    $schema: 'https://taskflow.sh/schema/taskflow.json',
    version: json.version,
    harnessDir: json.harnessDir,
    rulesDir: json.rulesDir,
  };
  if (json.aliases !== undefined) payload.aliases = json.aliases;
  if (json.registries !== undefined) payload.registries = json.registries;
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
