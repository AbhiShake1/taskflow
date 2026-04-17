import {
  spawn as defaultSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventChannel, type AgentAdapter, type AgentHandle, type SpawnCtx } from './index';
import type { AgentEvent, LeafResult, LeafSpec, LeafStatus } from '../core/types';
// TODO(taskflow): upgrade to cursor-native structured output if/when the
// cursor-agent CLI exposes one. For now we use prompt-engineered fallback.
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

/**
 * Milliseconds the watchdog waits after spawn for the first stdout event.
 * `cursor-agent -p` has a known occasional-hang bug; this forces progress
 * or cleanly aborts the leaf.
 */
export const WATCHDOG_MS = 30_000;

// ---- cursor stream-json message shapes (best-effort; unknown fields tolerated) ----
type CursorMsg =
  | {
      type: 'message';
      role?: string;
      content?: string;
      text?: string;
      [k: string]: unknown;
    }
  | {
      type: 'tool_call';
      name?: string;
      tool?: string;
      args?: unknown;
      input?: unknown;
      [k: string]: unknown;
    }
  | {
      type: 'tool_result';
      name?: string;
      tool?: string;
      tool_use_id?: string;
      result?: unknown;
      output?: unknown;
      [k: string]: unknown;
    }
  | { type: 'error'; message?: string; error?: string; [k: string]: unknown }
  | { type: 'done'; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

const cursorAdapter: AgentAdapter = {
  name: 'cursor',
  spawn(spec: LeafSpec, ctx: SpawnCtx): AgentHandle {
    const ch = new EventChannel<AgentEvent>();
    const startedAt = Date.now();
    const leafId = spec.id;

    // 1) Synchronous pre-spawn event — visible even if cursor-agent binary is missing.
    ch.push({ t: 'spawn', leafId, agent: 'cursor', model: spec.model, ts: Date.now() });

    // Resolve prompt with optional rules prefix.
    const basePrompt =
      spec.rulesPrefix !== false && ctx.rulesPrefix ? ctx.rulesPrefix + spec.task : spec.task;
    const prompt = ctx.structuredOutput
      ? basePrompt + '\n' + jsonFallbackPromptSuffix(ctx.structuredOutput.jsonSchema)
      : basePrompt;

    const args = ['--output-format', 'stream-json'];
    if (spec.model) args.push('--model', spec.model);
    args.push('-p', prompt);

    let doneEmitted = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let watchdogTimer: NodeJS.Timeout | undefined;
    let stderrBuf = '';
    let lastAssistantText: string | undefined;
    let resolveResult!: (r: LeafResult) => void;
    const doneP = new Promise<LeafResult>((res) => {
      resolveResult = res;
    });

    const clearWatchdog = (): void => {
      if (watchdogTimer) {
        clearTimeout(watchdogTimer);
        watchdogTimer = undefined;
      }
    };

    const finalize = (status: LeafStatus, exitCode: number, errorMsg?: string): void => {
      if (doneEmitted) return;
      doneEmitted = true;
      clearWatchdog();
      if (killTimer) clearTimeout(killTimer);
      const base: LeafResult = {
        leafId,
        status,
        exitCode,
        startedAt,
        endedAt: Date.now(),
        ...(errorMsg ? { error: errorMsg } : {}),
      };
      let result: LeafResult = base;
      if (lastAssistantText !== undefined) {
        result = { ...result, finalAssistantText: lastAssistantText };
        if (ctx.structuredOutput && status === 'done') {
          const parsed = jsonBlockFromText(lastAssistantText);
          if (parsed !== null) {
            result = { ...result, structuredOutputValue: parsed };
          } else {
            result = {
              ...result,
              status: 'error',
              exitCode: 1,
              error: 'cursor: structured output requested but no JSON block found in final assistant message',
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
      child = _spawn('cursor-agent', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: ctx.cwd });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ch.push({ t: 'error', leafId, error: `cursor-agent spawn failed: ${msg}`, ts: Date.now() });
      finalize('error', 127, msg);
      return buildHandle();
    }

    // Watchdog: 30s from spawn with no stdout event → abort + finalize error.
    watchdogTimer = setTimeout(() => {
      if (doneEmitted) return;
      ch.push({ t: 'error', leafId, error: 'cursor-agent stall', ts: Date.now() });
      aborted = false;
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
      finalize('error', 124, 'cursor-agent stall');
    }, WATCHDOG_MS);
    // Unref the watchdog so it never keeps the event loop alive on its own.
    watchdogTimer.unref?.();

    // Guard against unhandled 'error' events (ENOENT is the classic case).
    child.on('error', (err: NodeJS.ErrnoException) => {
      const isEnoent = err && err.code === 'ENOENT';
      const msg = isEnoent
        ? 'cursor-agent binary not found'
        : `cursor-agent process error: ${err?.message ?? String(err)}`;
      ch.push({ t: 'error', leafId, error: msg, ts: Date.now() });
      finalize('error', 127, msg);
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        // Any stdout line resets the watchdog.
        clearWatchdog();
        let msg: CursorMsg;
        try {
          msg = JSON.parse(line) as CursorMsg;
        } catch {
          ch.push({ t: 'error', leafId, error: `malformed json: ${line}`, ts: Date.now() });
          return;
        }
        handleCursorMsg(msg);
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
          ? `cursor-agent exited with code ${exitCode}: ${stderrBuf.trim()}`
          : `cursor-agent exited with code ${exitCode}`;
        ch.push({ t: 'error', leafId, error: err, ts: Date.now() });
        finalize('error', exitCode, err);
      }
    });

    function handleCursorMsg(msg: CursorMsg): void {
      switch (msg.type) {
        case 'message': {
          // Default role: 'assistant' when omitted; skip non-assistant chatter.
          const role = (msg.role ?? 'assistant') as string;
          if (role !== 'assistant') return;
          const content =
            typeof msg.content === 'string'
              ? msg.content
              : typeof msg.text === 'string'
                ? msg.text
                : '';
          if (content.length === 0) return;
          lastAssistantText = content;
          ch.push({ t: 'message', leafId, role: 'assistant', content, ts: Date.now() });
          return;
        }

        case 'tool_call': {
          const name = (msg.name ?? msg.tool ?? 'unknown') as string;
          const args = (msg.args ?? msg.input) as unknown;
          ch.push({ t: 'tool', leafId, name, args, ts: Date.now() });
          return;
        }

        case 'tool_result': {
          const name = (msg.name ??
            msg.tool ??
            (typeof msg.tool_use_id === 'string' ? msg.tool_use_id : 'unknown')) as string;
          const result = (msg.result ?? msg.output) as unknown;
          ch.push({ t: 'tool-res', leafId, name, result, ts: Date.now() });
          // Best-effort edit extraction.
          if (isEditTool(name) && result && typeof result === 'object') {
            const r = result as Record<string, unknown>;
            const file = pickString(r, ['file', 'path', 'filename']);
            const added = pickNumber(r, ['added', 'added_lines', 'linesAdded']);
            const removed = pickNumber(r, ['removed', 'removed_lines', 'linesRemoved']);
            if (file && (added !== undefined || removed !== undefined)) {
              ch.push({
                t: 'edit',
                leafId,
                file,
                added: added ?? 0,
                removed: removed ?? 0,
                ts: Date.now(),
              });
            }
          }
          return;
        }

        case 'error': {
          const errText =
            (typeof msg.message === 'string' && msg.message) ||
            (typeof msg.error === 'string' && msg.error) ||
            'cursor-agent reported error';
          ch.push({ t: 'error', leafId, error: errText, ts: Date.now() });
          return;
        }

        case 'done':
          // Defer finalization until process exit so exitCode is accurate.
          return;

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
          try {
            stdin.write(input + '\n');
          } catch {
            /* pipe may be closed — swallow */
          }
          ch.push({ t: 'steer', leafId, content: input, ts: Date.now() });
        },
        async abort(_reason?: string) {
          if (doneEmitted) return;
          aborted = true;
          clearWatchdog();
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

function isEditTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === 'edit' ||
    n === 'edit-file' ||
    n === 'edit_file' ||
    n === 'write' ||
    n === 'write-file' ||
    n === 'write_file' ||
    n.startsWith('edit:') ||
    n.startsWith('str_replace')
  );
}

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

export default cursorAdapter;
