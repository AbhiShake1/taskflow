import { createWriteStream, WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunEvent } from './types';

export type EventSubscriber = (ev: RunEvent) => void;

export class EventBus {
  private subs = new Set<EventSubscriber>();
  private stream?: WriteStream;

  async attachFile(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: 'a' });
  }

  subscribe(fn: EventSubscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(ev: RunEvent): void {
    for (const fn of this.subs) {
      try { fn(ev); } catch { /* isolate subscriber errors */ }
    }
    if (this.stream) {
      const line = JSON.stringify(ev) + '\n';
      this.stream.write(line);
    }
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    const s = this.stream;
    this.stream = undefined;
    await new Promise<void>(res => s.end(() => res()));
  }
}
