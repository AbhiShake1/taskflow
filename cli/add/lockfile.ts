import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lockSchema, type Lock, type LockItem } from './registry/schema';

export interface LockfileHandle {
  read(): Promise<Lock>;
  write(lock: Lock): Promise<void>;
  upsert(name: string, entry: LockItem): Promise<void>;
  remove(name: string): Promise<void>;
  readonly path: string;
}

const DEFAULT_LOCK: Lock = { version: '1', items: {} };

export function lockfileHandle(cwd: string): LockfileHandle {
  const path = resolve(cwd, 'taskflow.lock');

  async function read(): Promise<Lock> {
    if (!existsSync(path)) return { version: '1', items: {} };
    const raw = await readFile(path, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`taskflow.lock: invalid JSON — ${(err as Error).message}`);
    }
    const result = lockSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`taskflow.lock: schema validation failed — ${result.error.message}`);
    }
    return result.data;
  }

  async function write(lock: Lock): Promise<void> {
    const text = `${JSON.stringify(lock, null, 2)}\n`;
    await writeFile(path, text, 'utf8');
  }

  async function upsert(name: string, entry: LockItem): Promise<void> {
    const current = existsSync(path) ? await read() : { ...DEFAULT_LOCK };
    const items = { ...current.items, [name]: entry };
    await write({ version: '1', items });
  }

  async function remove(name: string): Promise<void> {
    if (!existsSync(path)) return;
    const current = await read();
    if (!(name in current.items)) return;
    const items = { ...current.items };
    delete items[name];
    await write({ version: '1', items });
  }

  return { read, write, upsert, remove, path };
}

export function assertFrozen(lock: Lock, requested: Record<string, LockItem>): void {
  for (const [name, want] of Object.entries(requested)) {
    const have = lock.items[name];
    if (!have) {
      throw new Error(
        `taskflow.lock: ${name} missing from lockfile. Run without --frozen to add it.`,
      );
    }
    if (have.source !== want.source) {
      throw new Error(
        `taskflow.lock: ${name} source drift — lock=${have.source} requested=${want.source}`,
      );
    }
    if (want.sha256 !== undefined && have.sha256 !== undefined && have.sha256 !== want.sha256) {
      throw new Error(
        `taskflow.lock: ${name} sha256 drift — lock=${have.sha256} requested=${want.sha256}`,
      );
    }
  }
}
