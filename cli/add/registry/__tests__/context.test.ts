import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRegistryContext,
  getRegistryHeadersFromContext,
  setRegistryHeaders,
} from '../context';

describe('registry context headers', () => {
  beforeEach(() => {
    clearRegistryContext();
  });

  afterEach(() => {
    clearRegistryContext();
  });

  it('returns empty object when no headers registered', () => {
    expect(getRegistryHeadersFromContext('https://example.com/a.json')).toEqual({});
  });

  it('returns headers for exact-prefix URL match', () => {
    setRegistryHeaders({
      'https://api.acme.com/': { Authorization: 'Bearer abc' },
    });
    expect(
      getRegistryHeadersFromContext('https://api.acme.com/harness/ui.json'),
    ).toEqual({ Authorization: 'Bearer abc' });
  });

  it('does not leak to a different prefix', () => {
    setRegistryHeaders({
      'https://api.acme.com/': { Authorization: 'Bearer acme' },
    });
    expect(
      getRegistryHeadersFromContext('https://api.other.com/x.json'),
    ).toEqual({});
  });

  it('merges multiple set calls for the same prefix', () => {
    setRegistryHeaders({
      'https://api.acme.com/': { Authorization: 'Bearer abc' },
    });
    setRegistryHeaders({
      'https://api.acme.com/': { 'X-Api-Key': 'k1' },
    });
    expect(
      getRegistryHeadersFromContext('https://api.acme.com/x.json'),
    ).toEqual({ Authorization: 'Bearer abc', 'X-Api-Key': 'k1' });
  });

  it('picks the longest matching prefix', () => {
    setRegistryHeaders({
      'https://api.acme.com/': { Authorization: 'Bearer short' },
      'https://api.acme.com/special/': { Authorization: 'Bearer long' },
    });
    expect(
      getRegistryHeadersFromContext('https://api.acme.com/special/x.json'),
    ).toEqual({ Authorization: 'Bearer long' });
    expect(
      getRegistryHeadersFromContext('https://api.acme.com/other/x.json'),
    ).toEqual({ Authorization: 'Bearer short' });
  });

  it('clearRegistryContext empties everything', () => {
    setRegistryHeaders({
      'https://api.acme.com/': { Authorization: 'Bearer abc' },
    });
    clearRegistryContext();
    expect(
      getRegistryHeadersFromContext('https://api.acme.com/x.json'),
    ).toEqual({});
  });

  it('returns a fresh object each call (not the stored one)', () => {
    setRegistryHeaders({
      'https://api.acme.com/': { Authorization: 'Bearer abc' },
    });
    const a = getRegistryHeadersFromContext('https://api.acme.com/x.json');
    a.Authorization = 'mutated';
    const b = getRegistryHeadersFromContext('https://api.acme.com/x.json');
    expect(b.Authorization).toBe('Bearer abc');
  });
});
