import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTodoStore, extractTodosFromMarkdown } from '../core/todos';
import type { Todo } from '../core/hooks';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'todos-test-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('extractTodosFromMarkdown', () => {
  it('returns [] for empty input', () => {
    expect(extractTodosFromMarkdown('')).toEqual([]);
  });

  it('extracts mixed checked and unchecked in order with done flags', () => {
    const md = [
      '- [ ] first',
      '- [x] second',
      '- [X] third',
      '- [ ] fourth',
    ].join('\n');
    expect(extractTodosFromMarkdown(md)).toEqual([
      { text: 'first', done: false },
      { text: 'second', done: true },
      { text: 'third', done: true },
      { text: 'fourth', done: false },
    ]);
  });

  it('extracts indented checkboxes (spaces and tab)', () => {
    const md = [
      '    - [ ] four-spaces',
      '\t- [x] tab-indented',
    ].join('\n');
    expect(extractTodosFromMarkdown(md)).toEqual([
      { text: 'four-spaces', done: false },
      { text: 'tab-indented', done: true },
    ]);
  });

  it('extracts the * bullet variant', () => {
    expect(extractTodosFromMarkdown('* [ ] starred')).toEqual([
      { text: 'starred', done: false },
    ]);
  });

  it('ignores lines without checkbox syntax', () => {
    const md = [
      'just some prose',
      '- [ ] real one',
      '# heading',
      '- not a checkbox',
      '- [ ]   trim me   ',
    ].join('\n');
    expect(extractTodosFromMarkdown(md)).toEqual([
      { text: 'real one', done: false },
      { text: 'trim me', done: false },
    ]);
  });
});

describe('createTodoStore', () => {
  it('add(string) and add(Todo) both work and preserve insertion order', () => {
    const store = createTodoStore();
    store.add('one');
    store.add({ text: 'two', done: true } satisfies Todo);
    store.add('three');
    expect(store.list()).toEqual([
      { text: 'one', done: false },
      { text: 'two', done: true },
      { text: 'three', done: false },
    ]);
  });

  it('initial accepts strings and Todos', () => {
    const store = createTodoStore({
      initial: ['a', { text: 'b', done: true }],
    });
    expect(store.list()).toEqual([
      { text: 'a', done: false },
      { text: 'b', done: true },
    ]);
  });

  it('complete flips the first matching text; non-existent is a no-op', () => {
    const store = createTodoStore({ initial: ['a', 'b', 'a'] });
    store.complete('a');
    expect(store.list()).toEqual([
      { text: 'a', done: true },
      { text: 'b', done: false },
      { text: 'a', done: false },
    ]);
    store.complete('does-not-exist');
    expect(store.list()).toEqual([
      { text: 'a', done: true },
      { text: 'b', done: false },
      { text: 'a', done: false },
    ]);
  });

  it('remaining returns only undone items', () => {
    const store = createTodoStore({
      initial: [
        { text: 'a', done: false },
        { text: 'b', done: true },
        { text: 'c', done: false },
      ],
    });
    expect(store.remaining()).toEqual([
      { text: 'a', done: false },
      { text: 'c', done: false },
    ]);
  });

  it('clear empties the store', () => {
    const store = createTodoStore({ initial: ['a', 'b'] });
    store.clear();
    expect(store.list()).toEqual([]);
    expect(store.remaining()).toEqual([]);
  });

  it('loadFromMarkdown REPLACES contents', () => {
    const store = createTodoStore({ initial: ['previous-1', 'previous-2'] });
    store.loadFromMarkdown('- [ ] new-one\n- [x] new-two');
    expect(store.list()).toEqual([
      { text: 'new-one', done: false },
      { text: 'new-two', done: true },
    ]);
  });

  it('serialize returns a fresh array (mutating the array does not affect the store)', () => {
    const store = createTodoStore({ initial: ['a'] });
    const snap = store.serialize();
    snap.push({ text: 'leak', done: false });
    snap.length = 0;
    expect(store.list()).toEqual([{ text: 'a', done: false }]);
  });
});

describe('createTodoStore persistence', () => {
  it('writes JSON after add + flush; file parses back to the same list', async () => {
    const persistPath = join(workDir, randomUUID(), 'todos.json');
    const store = createTodoStore({ persistPath });
    store.add('alpha');
    store.add({ text: 'beta', done: true });
    await store.flush();
    const raw = await readFile(persistPath, 'utf8');
    expect(JSON.parse(raw)).toEqual([
      { text: 'alpha', done: false },
      { text: 'beta', done: true },
    ]);
  });

  it('clear + flush writes []', async () => {
    const persistPath = join(workDir, randomUUID(), 'todos.json');
    const store = createTodoStore({ persistPath, initial: ['a', 'b'] });
    store.clear();
    await store.flush();
    const raw = await readFile(persistPath, 'utf8');
    expect(JSON.parse(raw)).toEqual([]);
  });

  it('atomic write: <path>.tmp does not remain after flush', async () => {
    const persistPath = join(workDir, randomUUID(), 'todos.json');
    const store = createTodoStore({ persistPath });
    store.add('one');
    store.add('two');
    store.complete('one');
    await store.flush();
    let tmpExists = true;
    try {
      await stat(`${persistPath}.tmp`);
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });
});
