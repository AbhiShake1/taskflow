import {
  spawn as defaultSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventChannel, type AgentAdapter, type AgentHandle, type SpawnCtx } from './index';
import type { AgentEvent, LeafResult, LeafSpec, LeafStatus } from '../core/types';
// Structured output (2026-04): pi CLI has no native schema flag. The RPC mode
// we use emits JSONL events but no schema-constrained output channel.
// Tracking: badlogic/pi-mono#1086. Until then we use prompt-engineered JSON
// via structured-output.ts.
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

// ---- pi RPC message shapes (best-effort; unknown fields are tolerated) ----
type PiMsg =
  | { type: 'agent_start'; session_id?: string; [k: string]: unknown }
  | { type: 'agent_end'; [k: string]: unknown }
  | { type: 'turn_start'; turn_id?: string | number; [k: string]: unknown }
  | {
      type: 'turn_end';
      turn_id?: string | number;
      role?: string;
      content?: string;
      [k: string]: unknown;
    }
  | {
      type: 'message_update';
      role?: string;
      content?: string;
      delta?: string;
      turn_id?: string | number;
      [k: string]: unknown;
    }
  | {
      type: 'tool_execution_start';
      name?: string;
      tool?: string;
      args?: unknown;
      input?: unknown;
      call_id?: string;
      [k: string]: unknown;
    }
  | {
      type: 'tool_execution_end';
      name?: string;
      tool?: string;
      result?: unknown;
      output?: unknown;
      call_id?: string;
      [k: string]: unknown;
    }
  | { type: 'queue_update'; [k: string]: unknown }
  | { type: 'error'; message?: string; error?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

const piAdapter: AgentAdapter = {
  name: 'pi',
  spawn(spec: LeafSpec, ctx: SpawnCtx): AgentHandle {
    const ch = new EventChannel<AgentEvent>();
    const startedAt = Date.now();
    const leafId = spec.id;

    // 1) Synchronous pre-spawn event — visible even if pi binary is missing.
    ch.push({ t: 'spawn', leafId, agent: 'pi', model: spec.model, ts: Date.now() });

    // Resolve prompt with optional rules prefix.
    const basePrompt =
      spec.rulesPrefix !== false && ctx.rulesPrefix ? ctx.rulesPrefix + spec.task : spec.task;
    // Prompt-engineering fallback for structured output.
    const prompt = ctx.structuredOutput
      ? basePrompt + '\n' + jsonFallbackPromptSuffix(ctx.structuredOutput.jsonSchema)
      : basePrompt;

    // --allow-home opts out of omp/pi's default home-sandbox: without it, pi auto-
    // switches cwd to a temp directory, so any files it writes end up outside the
    // repo. Passing the explicit `cwd` to _spawn then anchors it to the repo root.
    const args = ['--mode', 'rpc', '--allow-home', '-p', prompt];
    if (spec.model) args.push('--model', spec.model);

    // Buffered assistant content, keyed by turn id (or '_' when pi omits it).
    const turnBuffers = new Map<string, string>();
    const keyFor = (turn: unknown): string =>
      typeof turn === 'string' || typeof turn === 'number' ? String(turn) : '_';

    let doneEmitted = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let stderrBuf = '';
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
              error: 'pi: structured output requested but no JSON block found in final assistant message',
            };
          }
        }
      }
      ch.push({ t: 'done', leafId, result, ts: Date.now() });
      ch.close();
      resolveResult(result);
    };

    const piBin = process.env.HARNESS_PI_BIN ?? 'pi';
    let child: ChildProcess | ChildProcessWithoutNullStreams;
    try {
      child = _spawn(piBin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: ctx.cwd });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ch.push({ t: 'error', leafId, error: `${piBin} spawn failed: ${msg}`, ts: Date.now() });
      finalize('error', 127, msg);
      return buildHandle();
    }

    // Guard against unhandled 'error' events (ENOENT is the classic case).
    child.on('error', (err: NodeJS.ErrnoException) => {
      const isEnoent = err && err.code === 'ENOENT';
      const msg = isEnoent
        ? `${piBin} binary not found in PATH`
        : `${piBin} process error: ${err?.message ?? String(err)}`;
      ch.push({ t: 'error', leafId, error: msg, ts: Date.now() });
      finalize('error', 127, msg);
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        let msg: PiMsg;
        try {
          msg = JSON.parse(line) as PiMsg;
        } catch {
          ch.push({ t: 'error', leafId, error: `malformed json: ${line}`, ts: Date.now() });
          return;
        }
        handlePiMsg(msg);
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
          ? `pi exited with code ${exitCode}: ${stderrBuf.trim()}`
          : `pi exited with code ${exitCode}`;
        ch.push({ t: 'error', leafId, error: err, ts: Date.now() });
        finalize('error', exitCode, err);
      }
    });

    function handlePiMsg(msg: PiMsg): void {
      switch (msg.type) {
        case 'agent_start':
          // session id is internal; we already emitted synthetic spawn.
          return;

        case 'message_update': {
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

        case 'turn_end': {
          if (msg.role && msg.role !== 'assistant') {
            // Still clear any buffer for this turn (non-assistant turns don't emit).
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

        case 'turn_start':
        case 'queue_update':
          return;

        case 'tool_execution_start': {
          const name = (msg.name ?? msg.tool ?? 'unknown') as string;
          const args = (msg.args ?? msg.input) as unknown;
          ch.push({ t: 'tool', leafId, name, args, ts: Date.now() });
          return;
        }

        case 'tool_execution_end': {
          const name = (msg.name ?? msg.tool ?? 'unknown') as string;
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
            'pi reported error';
          ch.push({ t: 'error', leafId, error: errText, ts: Date.now() });
          return;
        }

        case 'agent_end':
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
          const line = JSON.stringify({ type: 'steer', message: input }) + '\n';
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
        // Path B: pi/omp's RPC mode receives its prompt via `-p` argv (single-shot
        // pattern) and exits when the agent emits `agent_end`; our wait() defers
        // resolution to child 'exit' so by the time the engine could call
        // continueAfterDone the subprocess is dead and the stdin pipe is closed.
        // Even though steer() writes JSON-RPC mid-run, post-exit resume is not
        // supported by the binary — re-spawn is the only honest path.
        continueAfterDone: async (_text: string) => {
          throw new Error(
            'pi: subprocess closed after terminal turn; continueAfterDone unavailable — engine should fallback to re-spawn',
          );
        },
        supportsResume: false,
      };
    }

    return buildHandle();
  },
};

/**
 * Returns true when a tool name represents a file-edit or file-write operation.
 * The allow-list covers camelCase, kebab-case, snake_case, and namespace-prefixed
 * variants used by different agent protocols so the TUI can auto-synthesize an
 * `edit` event for its diff view without requiring callers to normalize names first.
 */
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

/**
 * Returns the value of the first key in `keys` that maps to a non-empty string
 * in `obj`. Used to normalize inconsistently named fields across agent protocols
 * where the same logical field may appear under different names.
 */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Returns the value of the first key in `keys` that maps to a finite number
 * in `obj`. Mirrors `pickString` for numeric fields with inconsistent naming
 * across agent protocols.
 */
function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

export default piAdapter;
