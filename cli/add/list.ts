import { lockfileHandle } from './lockfile';

export interface ListOptions {
  cwd: string;
}

export async function runList(opts: ListOptions): Promise<void> {
  const lock = await lockfileHandle(opts.cwd).read();
  const entries = Object.entries(lock.items);
  if (entries.length === 0) {
    process.stdout.write('no harnesses installed\n');
    return;
  }
  const rows: string[] = ['name\ttype\tsource'];
  for (const [name, entry] of entries) {
    rows.push(`${name}\t${entry.type}\t${entry.source}`);
  }
  process.stdout.write(`${rows.join('\n')}\n`);
}
