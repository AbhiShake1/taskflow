import type { AgentEvent, LeafResult, LeafSpec, LeafUsage } from '../core/types';
import { AgentAdapter, AgentHandle, EventChannel, SpawnCtx } from './index';

/**
 * Claude Code adapter — in-process, streaming-input mode via `@anthropic-ai/claude-agent-sdk`.
 *
 * SDK surface (v0.2.111) actually used:
 *   - `query({ prompt, options })` returns a `Query` (AsyncGenerator<SDKMessage, void>)
 *   - `Query.interrupt()`, `Query.setPermissionMode()`, `Query.streamInput()`, `Query.close()`,
 *     `Query.rewindFiles()`
 *   - Messages are typed as `SDKAssistantMessage | SDKUserMessage | SDKResultMessage | ...`
 *
 * Mismatches with plan terminology:
 *   - Plan said `streamInput()` for steering — real API is exactly that (Async iterable of
 *     `SDKUserMessage`). To steer mid-session without clobbering the primary input stream,
 *     we own the input channel and push new user messages into it, rather than calling
 *     `streamInput()` with a new iterable.
 *   - Plan said `setPermissionMode` — matches real API. We default to `bypassPermissions` +
 *     `allowDangerouslySkipPermissions: true` so the leaf can actually act on its own.
 *   - Plan said `rewindFiles` — matches real API; not used here but available on the handle.
 *   - Cache-control: the SDK's `SDKUserMessage.message` is `MessageParam` from `@anthropic-ai/sdk`,
 *     whose content blocks accept `cache_control`. So we split the initial prompt into two blocks
 *     (rules prefix + task) and mark the rules block with `cache_control: { type: 'ephemeral',
 *     ttl: '1h' }` when a prefix is provided.
 */

type InboundMessage = {
  type: 'user';
  message: {
    role: 'user';
    content:
      | string
      | Array<
          | { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' } }
          | Record<string, unknown>
        >;
  };
  parent_tool_use_id: null;
  session_id?: string;
};

/**
 * Internal push-pull input stream used as the `prompt` AsyncIterable for the SDK.
 * We own this so that steer() can inject additional user messages after the first one.
 */
class InputStream implements AsyncIterable<InboundMessage> {
  private queue: InboundMessage[] = [];
  private resolvers: Array<(r: IteratorResult<InboundMessage>) => void> = [];
  private _closed = false;

  get closed(): boolean { return this._closed; }

  push(item: InboundMessage): void {
    if (this._closed) return;
    const r = this.resolvers.shift();
    if (r) { r({ value: item, done: false }); return; }
    this.queue.push(item);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const r of this.resolvers) r({ value: undefined as any, done: true });
    this.resolvers.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<InboundMessage> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this._closed)      return Promise.resolve({ value: undefined as any, done: true });
        return new Promise(res => this.resolvers.push(res));
      },
    };
  }
}

/** Normalize a BetaMessage content array (string or blocks) into a plain display string. */
function stringifyAssistantContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    // tool_use blocks are emitted separately as { t: 'tool', ... } events.
  }
  return parts.join('');
}

const claudeCodeAdapter: AgentAdapter = {
  name: 'claude-code',
  spawn(spec: LeafSpec, ctx: SpawnCtx): AgentHandle {
    const ch = new EventChannel<AgentEvent>();
    const startedAt = Date.now();
    let resolveResult!: (r: LeafResult) => void;
    const done = new Promise<LeafResult>(r => { resolveResult = r; });
    let settled = false;
    const settle = (r: LeafResult) => { if (!settled) { settled = true; resolveResult(r); } };

    // Fire spawn BEFORE awaiting the SDK call.
    ch.push({
      t: 'spawn', leafId: spec.id, agent: spec.agent, model: spec.model, ts: Date.now(),
    });

    // Build the initial user message. If rulesPrefix is provided AND spec.rulesPrefix !== false,
    // split the prompt into two content blocks so the rules block can be marked cacheable.
    const includeRules = spec.rulesPrefix !== false && !!ctx.rulesPrefix;
    const initial: InboundMessage = includeRules
      ? {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: ctx.rulesPrefix as string,
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
              { type: 'text', text: spec.task },
            ],
          },
        }
      : {
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: spec.task },
        };

    const input = new InputStream();
    input.push(initial);

    // Emit the user message we just sent as an AgentEvent too (for transcript fidelity).
    ch.push({
      t: 'message', leafId: spec.id, role: 'user',
      content: spec.task,
      ts: Date.now(),
    });

    // Wire an AbortController so SpawnCtx.signal (or our abort()) can tear down the SDK.
    const abortController = new AbortController();
    if (ctx.signal) {
      if (ctx.signal.aborted) abortController.abort();
      else ctx.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    // Pump the SDK asynchronously. Any error here is absorbed and normalized to an 'error' +
    // 'done' event — we never let an unhandled rejection bubble.
    let queryObj: any = null;
    let aborted = false;
    // Last-seen `SDKResultMessage.usage`, normalized to camelCase. Attached to the
    // LeafResult on the terminal `done` event so downstream consumers can verify that
    // Anthropic prompt-caching is actually firing (cacheReadInputTokens > 0 across
    // back-to-back runs that share a rulesPrefix).
    let lastUsage: LeafUsage | undefined;
    // Resolves once queryObj is constructed (so `abort()` can wait for it to exist before
    // calling interrupt()). Settles to null on init failure to unblock any waiters.
    let resolveReady!: (q: any) => void;
    const ready = new Promise<any>(r => { resolveReady = r; });

    (async () => {
      try {
        // Lazy-import so the rest of the harness doesn't pay for this dep unless used.
        const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
        const queryFn = sdk.query ?? sdk.default?.query;
        if (typeof queryFn !== 'function') {
          throw new Error('claude-agent-sdk: `query` export not found');
        }

        // Prefer the runner-supplied repo cwd when present; fall back to runDir.
        // The SDK otherwise creates its own sandbox temp dir and flattens paths,
        // so tool-written files never land in the repo.
        const repoCwd = ctx.cwd ?? ctx.runDir;
        queryObj = queryFn({
          prompt: input as AsyncIterable<any>,
          options: {
            model: spec.model,
            cwd: repoCwd,
            // Even with `cwd` set, the claude-code CLI scopes the Bash/Edit tools
            // to a permission-protected workspace. `additionalDirectories` adds
            // the repo root as an explicit additional write-allowed path — so
            // leaves writing via ABSOLUTE paths (which emitted tasks use via the
            // `{cwd}` template var) land in the real repo, not the SDK's
            // dash-flattened shadow directory.
            additionalDirectories: [repoCwd],
            abortController,
            // Leaf agents need to be able to act without human approval.
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
          },
        });
        resolveReady(queryObj);

        for await (const msg of queryObj as AsyncIterable<any>) {
          if (aborted) break;
          await normalizeMessage(msg, spec.id, ch);
          // End-of-turn: the SDK emits exactly one `SDKResultMessage` (discriminator
          // `type: 'result'`, subtype success|error_*) when the assistant is finished.
          // Until we close the input iterable, `query()` keeps awaiting further
          // streaming-input user messages and the underlying CLI subprocess never
          // exits — which hangs the leaf.
          if (msg && typeof msg === 'object' && (msg as any).type === 'result') {
            const u = extractUsage((msg as any).usage);
            if (u) lastUsage = u;
            input.close();
          }
        }

        if (aborted) return; // abort() handler will settle.
        const endedAt = Date.now();
        const result: LeafResult = {
          leafId: spec.id, status: 'done', exitCode: 0, startedAt, endedAt,
          ...(lastUsage ? { usage: lastUsage } : {}),
        };
        ch.push({ t: 'done', leafId: spec.id, result, ts: endedAt });
        ch.close();
        input.close();
        settle(result);
      } catch (err) {
        resolveReady(null);
        if (aborted) return;
        const endedAt = Date.now();
        const message = err instanceof Error ? err.message : String(err);
        ch.push({ t: 'error', leafId: spec.id, error: message, ts: endedAt });
        const result: LeafResult = {
          leafId: spec.id, status: 'error', exitCode: 1,
          error: message, startedAt, endedAt,
        };
        ch.push({ t: 'done', leafId: spec.id, result, ts: endedAt });
        ch.close();
        input.close();
        settle(result);
      }
    })();

    return {
      events: ch,

      async steer(inputText: string) {
        // After the SDK emits its terminal `SDKResultMessage` we close `input`, so any
        // `steer()` call arriving afterwards has nowhere to go. Best-effort: silently
        // drop instead of pushing into a closed queue. Callers who want loud failure
        // can inspect settled state via wait() resolution first.
        if (settled || input.closed) return;
        ch.push({ t: 'steer', leafId: spec.id, content: inputText, ts: Date.now() });
        // Push the new user message directly into our owned input stream. This is the
        // streaming-input equivalent of `Query.streamInput()` — same underlying channel,
        // but we retain ownership so we can keep pushing.
        input.push({
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: inputText },
        });
        // Also emit a transcript message for consumers.
        ch.push({
          t: 'message', leafId: spec.id, role: 'user', content: inputText, ts: Date.now(),
        });
      },

      async abort(_reason?: string) {
        if (settled) return;
        aborted = true;
        try { abortController.abort(); } catch { /* noop */ }
        // Wait (briefly) for the query object to be constructed so interrupt() is actually
        // dispatched to the SDK. If init failed, ready resolves to null and we skip it.
        const q = await ready.catch(() => null);
        try { if (q && typeof q.interrupt === 'function') await q.interrupt(); }
        catch { /* noop */ }
        try { if (q && typeof q.close === 'function') q.close(); }
        catch { /* noop */ }
        input.close();
        const endedAt = Date.now();
        const result: LeafResult = {
          leafId: spec.id, status: 'aborted', exitCode: 130, startedAt, endedAt,
        };
        ch.push({ t: 'done', leafId: spec.id, result, ts: endedAt });
        ch.close();
        settle(result);
      },

      wait: () => done,
    };
  },
};

/** Map one SDK message onto zero-or-more AgentEvents. */
async function normalizeMessage(msg: any, leafId: string, ch: EventChannel<AgentEvent>): Promise<void> {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'assistant': {
      // msg.message is a BetaMessage with .content: array of blocks.
      const content = stringifyAssistantContent(msg.message?.content);
      if (content) {
        ch.push({ t: 'message', leafId, role: 'assistant', content, ts: Date.now() });
      }
      // Surface tool_use blocks as separate tool events.
      const blocks: any[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const b of blocks) {
        if (b && b.type === 'tool_use' && typeof b.name === 'string') {
          ch.push({
            t: 'tool', leafId, name: b.name, args: b.input ?? {}, ts: Date.now(),
          });
        }
      }
      // Surface assistant-level error if present.
      if (msg.error) {
        ch.push({ t: 'error', leafId, error: String(msg.error), ts: Date.now() });
      }
      return;
    }

    case 'user': {
      // User messages echoed by the SDK (including tool_result blocks).
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_result') {
            const name = typeof b.tool_use_id === 'string' ? b.tool_use_id : 'tool';
            ch.push({
              t: 'tool-res', leafId, name, result: b.content ?? b, ts: Date.now(),
            });
          }
        }
      }
      // We already emitted an outgoing 'message' when we pushed — don't duplicate here.
      return;
    }

    case 'result': {
      // SDKResultMessage — is_error drives an error event; 'done' is emitted by the caller
      // once the async-iterator completes, so we don't emit done from here.
      if (msg.is_error) {
        const errText =
          Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join('; ')
          : typeof msg.subtype === 'string' ? msg.subtype
          : 'unknown error';
        ch.push({ t: 'error', leafId, error: errText, ts: Date.now() });
      }
      return;
    }

    // Stream events, system messages, status, hook progress, etc. — not mapped.
    default:
      return;
  }
}

/**
 * Translate the SDK's `SDKResultMessage.usage` (NonNullableUsage, derived from
 * `@anthropic-ai/sdk`'s BetaUsage) into our camelCase LeafUsage. The SDK field
 * names are snake_case (input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens). Returns undefined if the shape is missing entirely.
 */
function extractUsage(raw: unknown): LeafUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const pickNum = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const usage: LeafUsage = {
    inputTokens: pickNum(r.input_tokens),
    outputTokens: pickNum(r.output_tokens),
    cacheCreationInputTokens: pickNum(r.cache_creation_input_tokens),
    cacheReadInputTokens: pickNum(r.cache_read_input_tokens),
  };
  // Drop undefineds so JSON round-trips stay compact and tests can deep-equal.
  const out: LeafUsage = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  if (usage.cacheCreationInputTokens !== undefined) out.cacheCreationInputTokens = usage.cacheCreationInputTokens;
  if (usage.cacheReadInputTokens !== undefined) out.cacheReadInputTokens = usage.cacheReadInputTokens;
  return Object.keys(out).length ? out : undefined;
}

export default claudeCodeAdapter;
