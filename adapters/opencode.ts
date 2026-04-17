import {
  spawn as defaultSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventChannel, type AgentAdapter, type AgentHandle, type SpawnCtx } from './index';
import type { AgentEvent, LeafResult, LeafSpec, LeafStatus } from '../core/types';

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

// ---- opencode ACP message shapes (subset; unknown fields tolerated) ----
type AcpMsg =
  | { kind: 'message'; role?: 'user' | 'assistant' | string; content?: string; [k: string]: unknown }
  | { kind: 'tool'; name?: string; args?: unknown; [k: string]: unknown }
  | { kind: 'tool_result'; name?: string; result?: unknown; [k: string]: unknown }
  | { kind: 'error'; message?: string; [k: string]: unknown }
  | { kind: 'done'; [k: string]: unknown }
  | { kind: string; [k: string]: unknown };

const opencodeAdapter: AgentAdapter = {
  name: 'opencode',
  spawn(spec: LeafSpec, ctx: SpawnCtx): AgentHandle {
    const ch = new EventChannel<AgentEvent>();
    const startedAt = Date.now();
    const leafId = spec.id;

    // 1) Synchronous pre-spawn event — visible even if the binary is missing.
    ch.push({ t: 'spawn', leafId, agent: 'opencode', model: spec.model, ts: Date.now() });

    // Resolve prompt with optional rules prefix.
    const prompt =
      spec.rulesPrefix !== false && ctx.rulesPrefix ? ctx.rulesPrefix + spec.task : spec.task;

    // opencode acp --model <provider/id> -p "<task>"
    const args = ['acp'];
    if (spec.model) args.push('--model', spec.model);
    args.push('-p', prompt);

    let doneEmitted = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let stderrBuf = '';
    let resolveResult!: (r: LeafResult) => void;
    const doneP = new Promise<LeafResult>((res) => {
      resolveResult = res;
    });

    const finalize = (status: LeafStatus, exitCode: number, errorMsg?: string): void => {
      if (doneEmitted) return;
      doneEmitted = true;
      if (killTimer) clearTimeout(killTimer);
      const result: LeafResult = {
        leafId,
        status,
        exitCode,
        startedAt,
        endedAt: Date.now(),
        ...(errorMsg ? { error: errorMsg } : {}),
      };
      ch.push({ t: 'done', leafId, result, ts: Date.now() });
      ch.close();
      resolveResult(result);
    };

    let child: ChildProcess | ChildProcessWithoutNullStreams;
    try {
      child = _spawn('opencode', args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: ctx.cwd });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ch.push({ t: 'error', leafId, error: `opencode spawn failed: ${msg}`, ts: Date.now() });
      finalize('error', 127, msg);
      return buildHandle();
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      const isEnoent = err && err.code === 'ENOENT';
      const msg = isEnoent
        ? 'opencode binary not found'
        : `opencode process error: ${err?.message ?? String(err)}`;
      ch.push({ t: 'error', leafId, error: msg, ts: Date.now() });
      finalize('error', 127, msg);
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        let msg: AcpMsg;
        try {
          msg = JSON.parse(line) as AcpMsg;
        } catch {
          ch.push({ t: 'error', leafId, error: `malformed json: ${line}`, ts: Date.now() });
          return;
        }
        handleAcpMsg(msg);
      });
      rl.on('error', () => {
        /* readline errors bubble via child error/exit — avoid double-emission */
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
          ? `opencode exited with code ${exitCode}: ${stderrBuf.trim()}`
          : `opencode exited with code ${exitCode}`;
        ch.push({ t: 'error', leafId, error: err, ts: Date.now() });
        finalize('error', exitCode, err);
      }
    });

    function handleAcpMsg(msg: AcpMsg): void {
      switch (msg.kind) {
        case 'message': {
          const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : null;
          if (!role) return;
          const content = typeof msg.content === 'string' ? msg.content : '';
          if (content.length === 0) return;
          ch.push({ t: 'message', leafId, role, content, ts: Date.now() });
          return;
        }

        case 'tool': {
          const name = (msg.name ?? 'unknown') as string;
          const args = msg.args as unknown;
          ch.push({ t: 'tool', leafId, name, args, ts: Date.now() });
          return;
        }

        case 'tool_result': {
          const name = (msg.name ?? 'unknown') as string;
          const result = msg.result as unknown;
          ch.push({ t: 'tool-res', leafId, name, result, ts: Date.now() });
          // Best-effort edit extraction.
          if (result && typeof result === 'object') {
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
            (typeof msg.message === 'string' && msg.message) || 'opencode reported error';
          ch.push({ t: 'error', leafId, error: errText, ts: Date.now() });
          return;
        }

        case 'done':
          // Defer finalization until process exit so exitCode is accurate.
          return;

        default:
          // Unknown kinds are ignored silently.
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
          const line = JSON.stringify({ kind: 'send-message', content: input }) + '\n';
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

export default opencodeAdapter;
