import {
  spawn as defaultSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventChannel, type AgentAdapter, type AgentHandle, type SpawnCtx } from './index';
import type { AgentEvent, LeafResult, LeafSpec, LeafStatus } from '../core/types';
// TODO(taskflow): upgrade to codex-native structured output once `codex exec`
// gains a first-class --response-format / --schema flag. For now we rely on
// prompt-engineered fallback — see adapters/structured-output.ts.
import { jsonBlockFromText, jsonFallbackPromptSuffix } from './structured-output';

/**
 * Injected spawn fn — overridable by tests via {@link __setSpawn}.
 * Default is node's child_process.spawn.
 */
export let _spawn: typeof defaultSpawn = defaultSpawn;
export function __setSpawn(fn: typeof defaultSpawn): void {
  _spawn = fn;
}
export function __resetSpawn(): void {
  _spawn = defaultSpawn;
}

// ---- codex NDJSON message shapes (best-effort; unknown fields are tolerated) ----
type CodexMsg =
  | { type: 'thread.started'; thread_id?: string; [k: string]: unknown }
  | { type: 'turn.start'; turn_id?: string | number; [k: string]: unknown }
  | {
      type: 'turn.delta';
      turn_id?: string | number;
      role?: string;
      delta?: string;
      content?: string;
      [k: string]: unknown;
    }
  | {
      type: 'turn.end';
      turn_id?: string | number;
      role?: string;
      content?: string;
      [k: string]: unknown;
    }
  | { type: 'item.message'; role?: string; content?: string; [k: string]: unknown }
  | {
      type: 'item.tool_use';
      name?: string;
      tool?: string;
      args?: unknown;
      input?: unknown;
      call_id?: string;
      [k: string]: unknown;
    }
  | {
      type: 'item.tool_result';
      name?: string;
      tool?: string;
      result?: unknown;
      output?: unknown;
      call_id?: string;
      [k: string]: unknown;
    }
  | {
      type: 'item.edit';
      file?: string;
      path?: string;
      added?: number;
      added_lines?: number;
      removed?: number;
      removed_lines?: number;
      [k: string]: unknown;
    }
  | { type: 'error'; message?: string; error?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

const codexAdapter: AgentAdapter = {
  name: 'codex',
  spawn(spec: LeafSpec, ctx: SpawnCtx): AgentHandle {
    const ch = new EventChannel<AgentEvent>();
    const startedAt = Date.now();
    const leafId = spec.id;

    // 1) Synchronous pre-spawn event — visible even if codex binary is missing.
    ch.push({ t: 'spawn', leafId, agent: 'codex', model: spec.model, ts: Date.now() });

    // Resolve prompt with optional rules prefix.
    const basePrompt =
      spec.rulesPrefix !== false && ctx.rulesPrefix ? ctx.rulesPrefix + spec.task : spec.task;
    // Prompt-engineering fallback for structured output: append schema guidance.
    const prompt = ctx.structuredOutput
      ? basePrompt + '\n' + jsonFallbackPromptSuffix(ctx.structuredOutput.jsonSchema)
      : basePrompt;

    // codex CLI: `codex exec --json --model <id> -p "<task>"`.
    // The `-p` flag passes the prompt via argv; stdin is reserved for steering (plain text).
    const args = ['exec', '--json'];
    if (spec.model) args.push('--model', spec.model);
    args.push('-p', prompt);

    // Buffered assistant content, keyed by turn id (or '_' when codex omits it).
    const turnBuffers = new Map<string, string>();
    const keyFor = (turn: unknown): string =>
      typeof turn === 'string' || typeof turn === 'number' ? String(turn) : '_';

    let doneEmitted = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let stderrBuf = '';
    // Track the last assistant message text we emitted, so we can backfill
    // result.finalAssistantText and parse structured output from it on finalize.
    let lastAssistantText: string | undefined;
    let resolveResult!: (r: LeafResult) => void;
    const doneP = new Promise<LeafResult>((res) => {
      resolveResult = res;
    });

    const finalize = (status: LeafStatus, exitCode: number, errorMsg?: string): void => {
      if (doneEmitted) return;
      doneEmitted = true;
      if (killTimer) clearTimeout(killTimer);
      const base: LeafResult = {
        leafId,
        status,
        exitCode,
        startedAt,
        endedAt: Date.now(),
        ...(errorMsg ? { error: errorMsg } : {}),
      };
      // Attach finalAssistantText + structured output only when we actually have
      // a final message — avoid sprinkling undefined fields on failure paths.
      let result: LeafResult = base;
      if (lastAssistantText !== undefined) {
        result = { ...result, finalAssistantText: lastAssistantText };
        if (ctx.structuredOutput && status === 'done') {
          const parsed = jsonBlockFromText(lastAssistantText);
          if (parsed !== null) {
            result = { ...result, structuredOutputValue: parsed };
          } else {
            // Adapter couldn't parse → demote to error. The fluent API layer
            // surfaces this as a rejected session promise with a clear message.
            result = {
              ...result,
              status: 'error',
              exitCode: 1,
              error: 'codex: structured output requested but no JSON block found in final assistant message',
            };
          }
        }
      }
      ch.push({ t: 'done', leafId, result, ts: Date.now() });
      ch.close();
      resolveResult(result);
    };

    let child: ChildProcess | ChildProcessWithoutNullStreams;
    try {
      child = _spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: ctx.cwd });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ch.push({ t: 'error', leafId, error: `codex spawn failed: ${msg}`, ts: Date.now() });
      finalize('error', 127, msg);
      return buildHandle();
    }

    // Guard against unhandled 'error' events (ENOENT is the classic case).
    child.on('error', (err: NodeJS.ErrnoException) => {
      const isEnoent = err && err.code === 'ENOENT';
      const msg = isEnoent
        ? 'codex binary not found'
        : `codex process error: ${err?.message ?? String(err)}`;
      ch.push({ t: 'error', leafId, error: msg, ts: Date.now() });
      finalize('error', 127, msg);
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        let msg: CodexMsg;
        try {
          msg = JSON.parse(line) as CodexMsg;
        } catch {
          ch.push({ t: 'error', leafId, error: `malformed json: ${line}`, ts: Date.now() });
          return;
        }
        handleCodexMsg(msg);
      });
      rl.on('error', () => {
        /* readline errors bubble up via child error/exit — avoid double-emission */
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding?.('utf8');
      child.stderr.on('data', (chunk: string | Buffer) => {
        stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
      child.stderr.on('error', () => {
        /* ignore */
      });
    }

    child.on('exit', (code, signal) => {
      if (doneEmitted) return;
      if (aborted) {
        finalize('aborted', typeof code === 'number' ? code : 130);
        return;
      }
      const exitCode = typeof code === 'number' ? code : signal ? 128 : 1;
      if (exitCode === 0) {
        finalize('done', 0);
      } else {
        const err = stderrBuf.trim()
          ? `codex exited with code ${exitCode}: ${stderrBuf.trim()}`
          : `codex exited with code ${exitCode}`;
        ch.push({ t: 'error', leafId, error: err, ts: Date.now() });
        finalize('error', exitCode, err);
      }
    });

    function handleCodexMsg(msg: CodexMsg): void {
      switch (msg.type) {
        case 'thread.started':
          // thread id is internal; we already emitted synthetic spawn.
          return;

        case 'turn.start':
          return;

        case 'turn.delta': {
          if (msg.role && msg.role !== 'assistant') return;
          const k = keyFor(msg.turn_id);
          if (typeof msg.content === 'string') {
            // Full-content update: replace buffer.
            turnBuffers.set(k, msg.content);
          } else if (typeof msg.delta === 'string') {
            turnBuffers.set(k, (turnBuffers.get(k) ?? '') + msg.delta);
          }
          return;
        }

        case 'turn.end': {
          if (msg.role && msg.role !== 'assistant') {
            turnBuffers.delete(keyFor(msg.turn_id));
            return;
          }
          const k = keyFor(msg.turn_id);
          const buffered = turnBuffers.get(k);
          const content =
            typeof msg.content === 'string' && msg.content.length > 0
              ? msg.content
              : buffered ?? '';
          turnBuffers.delete(k);
          if (content.length > 0) {
            lastAssistantText = content;
            ch.push({
              t: 'message',
              leafId,
              role: 'assistant',
              content,
              ts: Date.now(),
            });
          }
          return;
        }

        case 'item.message': {
          if (msg.role && msg.role !== 'assistant') return;
          if (typeof msg.content === 'string' && msg.content.length > 0) {
            lastAssistantText = msg.content;
            ch.push({
              t: 'message',
              leafId,
              role: 'assistant',
              content: msg.content,
              ts: Date.now(),
            });
          }
          return;
        }

        case 'item.tool_use': {
          const name = (msg.name ?? msg.tool ?? 'unknown') as string;
          const args = (msg.args ?? msg.input) as unknown;
          ch.push({ t: 'tool', leafId, name, args, ts: Date.now() });
          return;
        }

        case 'item.tool_result': {
          const name = (msg.name ?? msg.tool ?? 'unknown') as string;
          const result = (msg.result ?? msg.output) as unknown;
          ch.push({ t: 'tool-res', leafId, name, result, ts: Date.now() });
          return;
        }

        case 'item.edit': {
          const m = msg as Record<string, unknown>;
          const file = pickString(m, ['file', 'path', 'filename']);
          const added = pickNumber(m, ['added', 'added_lines', 'linesAdded']);
          const removed = pickNumber(m, ['removed', 'removed_lines', 'linesRemoved']);
          if (file) {
            ch.push({
              t: 'edit',
              leafId,
              file,
              added: added ?? 0,
              removed: removed ?? 0,
              ts: Date.now(),
            });
          }
          return;
        }

        case 'error': {
          const errText =
            (typeof msg.message === 'string' && msg.message) ||
            (typeof msg.error === 'string' && msg.error) ||
            'codex reported error';
          ch.push({ t: 'error', leafId, error: errText, ts: Date.now() });
          return;
        }

        default:
          // Unknown types are ignored silently.
          return;
      }
    }

    function buildHandle(): AgentHandle {
      return {
        events: ch,
        async steer(input: string) {
          if (doneEmitted) return;
          const stdin = (child as ChildProcessWithoutNullStreams).stdin;
          if (!stdin || stdin.destroyed) return;
          // codex's stdin append is limited — plain-text lines only, no JSON wrapper.
          const line = input + '\n';
          try {
            stdin.write(line);
          } catch {
            /* pipe may be closed — swallow */
          }
          ch.push({ t: 'steer', leafId, content: input, ts: Date.now() });
        },
        async abort(_reason?: string) {
          if (doneEmitted) return;
          aborted = true;
          try {
            child.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
          }, 2000);
          // Don't wait on exit here — runtime consumers await wait() separately.
        },
        wait: () => doneP,
      };
    }

    return buildHandle();
  },
};

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

export default codexAdapter;
