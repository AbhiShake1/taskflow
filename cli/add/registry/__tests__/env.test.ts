import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandEnvVars } from '../env';

describe('expandEnvVars', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore process.env
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
    }
  });

  it('replaces ${FOO} with the env var value', () => {
    process.env.TASKFLOW_TEST_FOO = 'bar';
    expect(expandEnvVars('hello ${TASKFLOW_TEST_FOO} world')).toBe('hello bar world');
  });

  it('does NOT replace bare $FOO (only braced form supported)', () => {
    process.env.TASKFLOW_TEST_FOO = 'bar';
    expect(expandEnvVars('hello $TASKFLOW_TEST_FOO world')).toBe(
      'hello $TASKFLOW_TEST_FOO world',
    );
  });

  it('replaces undefined vars with empty string', () => {
    delete process.env.TASKFLOW_TEST_UNSET;
    expect(expandEnvVars('a=${TASKFLOW_TEST_UNSET}=b')).toBe('a==b');
  });

  it('replaces multiple occurrences', () => {
    process.env.TASKFLOW_TEST_X = '1';
    process.env.TASKFLOW_TEST_Y = '2';
    expect(expandEnvVars('${TASKFLOW_TEST_X}-${TASKFLOW_TEST_Y}-${TASKFLOW_TEST_X}')).toBe(
      '1-2-1',
    );
  });

  it('preserves special characters in replacement values', () => {
    process.env.TASKFLOW_TEST_SPECIAL = 'Bearer $abc/def:ghi?=&';
    expect(expandEnvVars('H=${TASKFLOW_TEST_SPECIAL}')).toBe(
      'H=Bearer $abc/def:ghi?=&',
    );
  });

  it('leaves string untouched when no placeholders', () => {
    expect(expandEnvVars('nothing to see here')).toBe('nothing to see here');
  });
});
