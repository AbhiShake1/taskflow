// Shared helpers for the "structured output" contract.
//
// Two mechanisms exist in this codebase:
//
//   1. Native tool-use (claude-code only at the moment). The SDK takes an
//      MCP tool definition, the model calls it with a typed input, and the
//      adapter captures that input as the structured-output value. This is the
//      reliable path and the reason the contract exists at all.
//
//   2. Prompt-engineering fallback (codex, cursor, opencode, pi). Until each
//      of those providers grows a first-class structured-output mode in this
//      repo, the adapter appends a schema-shaped instruction to the prompt
//      and scrapes the final assistant message for a ```json ... ``` block.
//
// The validation step (zod `.parse`) happens in the fluent API layer, not
// here — the engine and adapters must stay free of a zod dependency.

/**
 * Build the natural-language instruction we append to a task prompt when we
 * cannot use a native tool-use round-trip. The model is told to place a JSON
 * code block at the very end of its final message, matching the supplied
 * schema. Callers join this onto `spec.task` with a blank line in between.
 */
export function jsonFallbackPromptSuffix(jsonSchema: Record<string, unknown>): string {
  const schemaJson = JSON.stringify(jsonSchema, null, 2);
  return [
    '',
    '---',
    'IMPORTANT: When you are done, your final message MUST end with a single',
    'fenced JSON code block conforming to this JSON Schema. Do not emit any',
    'text after the closing ``` fence.',
    '',
    'JSON Schema:',
    '```json',
    schemaJson,
    '```',
    '',
    'Your final message should end with:',
    '```json',
    '{ ... your structured result here ... }',
    '```',
  ].join('\n');
}

/**
 * Extract the LAST ```json ... ``` fenced block from an arbitrary text blob
 * and parse it. Tolerant of:
 *   - surrounding prose
 *   - leading/trailing whitespace
 *   - multiple fences (takes the last — the model's "final answer")
 *   - language tag variants (`json`, `JSON`, no tag)
 *
 * Returns the parsed value on success. Returns `null` if no JSON block is
 * found OR JSON.parse throws. Callers treat `null` as "no structured output
 * produced" and fail the session.
 */
export function jsonBlockFromText(text: string): unknown | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Collect every fenced block; prefer ones tagged json, fall back to untagged.
  const fenceRe = /```(\w+)?\n([\s\S]*?)```/g;
  type Block = { lang: string | undefined; body: string };
  const blocks: Block[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    blocks.push({ lang: m[1]?.toLowerCase(), body: m[2] });
  }

  if (blocks.length === 0) {
    // No fences at all — last-ditch: try to parse the whole text.
    return tryParse(text);
  }

  // Prefer the last json-tagged block; if none, the last untagged-or-other.
  const jsonBlocks = blocks.filter((b) => b.lang === 'json');
  const candidate = jsonBlocks.length > 0 ? jsonBlocks[jsonBlocks.length - 1] : blocks[blocks.length - 1];
  return tryParse(candidate.body);
}

function tryParse(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Thrown by the fluent API when the adapter reports a done-but-missing
 * structured output (adapter couldn't parse / model never called the tool /
 * schema validation failed). The engine itself never throws this — it comes
 * up from `session()` in api/index.ts.
 */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly leafId: string,
    public readonly cause_?: unknown,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}
