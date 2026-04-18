import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Todo, TodoApi } from './hooks';

const CHECKBOX_RE = /^[ \t]*[-*] \[([ xX])\] (.+)$/;

export function extractTodosFromMarkdown(text: string): Todo[] {
  if (!text) return [];
  const out: Todo[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(CHECKBOX_RE);
    if (!m) continue;
    const flag = m[1];
    const body = m[2].trim();
    if (!body) continue;
    out.push({ text: body, done: flag === 'x' || flag === 'X' });
  }
  return out;
}

export interface TodoStore extends TodoApi {
  serialize(): Todo[];
  flush(): Promise<void>;
}

function normalize(item: string | Todo): Todo {
  if (typeof item === 'string') return { text: item, done: false };
  return { text: item.text, done: !!item.done };
}

export function createTodoStore(opts: {
  persistPath?: string;
  initial?: Array<string | Todo>;
} = {}): TodoStore {
  const items: Todo[] = (opts.initial ?? []).map(normalize);
  const persistPath = opts.persistPath;

  let pending: Promise<void> | null = null;
  let queued = false;
  let dirCreated = false;

  async function writeOnce(): Promise<void> {
    if (!persistPath) return;
    if (!dirCreated) {
      await mkdir(dirname(persistPath), { recursive: true });
      dirCreated = true;
    }
    const tmp = `${persistPath}.tmp`;
    const snapshot = JSON.stringify(items);
    await writeFile(tmp, snapshot, 'utf8');
    await rename(tmp, persistPath);
  }

  function schedule(): void {
    if (!persistPath) return;
    if (pending) {
      queued = true;
      return;
    }
    pending = (async () => {
      try {
        await writeOnce();
        while (queued) {
          queued = false;
          await writeOnce();
        }
      } finally {
        pending = null;
      }
    })();
  }

  return {
    list(): Todo[] {
      return items.slice();
    },
    add(item) {
      items.push(normalize(item));
      schedule();
    },
    complete(text) {
      for (const t of items) {
        if (t.text === text && !t.done) {
          t.done = true;
          schedule();
          return;
        }
      }
    },
    remaining(): Todo[] {
      return items.filter((t) => !t.done);
    },
    clear() {
      items.length = 0;
      schedule();
    },
    loadFromMarkdown(text) {
      items.length = 0;
      for (const t of extractTodosFromMarkdown(text)) items.push(t);
      schedule();
    },
    serialize(): Todo[] {
      return items.slice();
    },
    async flush() {
      while (pending) {
        await pending;
      }
    },
  };
}
