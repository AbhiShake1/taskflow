import { describe, it, expect } from 'vitest';
import { jsonBlockFromText } from '../adapters/structured-output';

describe('jsonBlockFromText', () => {
  it('returns null for empty string', () => {
    expect(jsonBlockFromText('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(jsonBlockFromText(null as any)).toBeNull();
  });

  it('parses a standard ```json ... ``` block', () => {
    const text = 'Some prose\n```json\n{"a":1}\n```\nTrailing text';
    expect(jsonBlockFromText(text)).toEqual({ a: 1 });
  });

  it('picks the last json-tagged block when multiple are present', () => {
    const text = '```json\n{"a":1}\n```\n```json\n{"b":2}\n```';
    expect(jsonBlockFromText(text)).toEqual({ b: 2 });
  });

  // Branch: non-json-tagged fence — picks the last block regardless of lang tag.
  it('falls back to the last fence when no json-tagged block exists', () => {
    const text = '```ts\nconst x = 1;\n```\n```\n{"fallback":true}\n```';
    expect(jsonBlockFromText(text)).toEqual({ fallback: true });
  });

  // Branch: no fences at all — tries to parse the whole text as JSON.
  it('parses the whole text when there are no fences', () => {
    expect(jsonBlockFromText('{"direct":42}')).toEqual({ direct: 42 });
  });

  // Branch: tryParse returns null for invalid JSON (no-fence path).
  it('returns null when the whole text is not valid JSON and there are no fences', () => {
    expect(jsonBlockFromText('not json at all')).toBeNull();
  });

  // Branch: tryParse returns null for invalid JSON inside a fence.
  it('returns null when the fenced block contains invalid JSON', () => {
    const text = '```json\nnot valid json\n```';
    expect(jsonBlockFromText(text)).toBeNull();
  });

  it('is tolerant of uppercase JSON lang tag', () => {
    const text = '```JSON\n{"upper":true}\n```';
    expect(jsonBlockFromText(text)).toEqual({ upper: true });
  });
});
