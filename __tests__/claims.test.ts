import { describe, it, expect } from 'vitest';
import { literalPrefix, claimsOverlap, assertNoOverlaps } from '../core/claims';

describe('literalPrefix', () => {
  it('returns the whole string when there are no glob metacharacters', () => {
    expect(literalPrefix('data/foo/bar.json')).toBe('data/foo/bar.json');
  });

  it('truncates at the first * wildcard', () => {
    expect(literalPrefix('data/shard-*/file')).toBe('data/shard-');
  });

  it('truncates at the first { brace-expansion character', () => {
    expect(literalPrefix('data/{a,b}/x')).toBe('data/');
  });
});

describe('claimsOverlap', () => {
  it('returns false for claims under different literal prefixes', () => {
    expect(claimsOverlap(['data/a/**'], ['data/b/**'])).toBe(false);
  });

  it('returns true when one claim nests under the other', () => {
    expect(claimsOverlap(['data/a/**'], ['data/a/b.json'])).toBe(true);
  });

  it('returns true when one literal prefix contains the other', () => {
    expect(claimsOverlap(['data/a/*'], ['data/a/'])).toBe(true);
  });

  it('returns false when either side is empty (no claim)', () => {
    expect(claimsOverlap([], ['data/a'])).toBe(false);
    expect(claimsOverlap(['data/a'], [])).toBe(false);
    expect(claimsOverlap([], [])).toBe(false);
  });
});

describe('assertNoOverlaps', () => {
  it('does not throw when no leaves overlap', () => {
    expect(() =>
      assertNoOverlaps([
        { id: 'x', claims: ['a/**'] },
        { id: 'y', claims: ['b/**'] },
      ]),
    ).not.toThrow();
  });

  it('throws with both conflicting leaf ids in the message', () => {
    try {
      assertNoOverlaps([
        { id: 'x', claims: ['a/**'] },
        { id: 'y', claims: ['a/b'] },
      ]);
      throw new Error('expected assertNoOverlaps to throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('x');
      expect(msg).toContain('y');
    }
  });
});
