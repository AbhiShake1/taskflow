import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RegistryMissingEnvironmentVariablesError } from '../errors';
import {
  extractEnvVarsFromRegistryConfig,
  extractEnvVarsFromString,
  validateRegistryConfig,
} from '../validator';

describe('extractEnvVarsFromString', () => {
  it('collects all ${VAR} tokens', () => {
    expect(extractEnvVarsFromString('a ${FOO} b ${BAR} c')).toEqual(['FOO', 'BAR']);
  });

  it('ignores bare $FOO', () => {
    expect(extractEnvVarsFromString('a $FOO b')).toEqual([]);
  });

  it('returns empty array when no tokens', () => {
    expect(extractEnvVarsFromString('no tokens')).toEqual([]);
  });

  it('returns duplicates in scan order', () => {
    expect(extractEnvVarsFromString('${A}${B}${A}')).toEqual(['A', 'B', 'A']);
  });
});

describe('extractEnvVarsFromRegistryConfig', () => {
  it('handles string entries', () => {
    expect(extractEnvVarsFromRegistryConfig('https://r/${TOKEN}/{name}.json')).toEqual([
      'TOKEN',
    ]);
  });

  it('traverses url + params + headers and dedupes', () => {
    const entry = {
      url: 'https://r/${NS}/{name}.json',
      params: { v: '${VER}', n: 'x' },
      headers: {
        Authorization: 'Bearer ${TOKEN}',
        'X-Req-By': '${USER}',
      },
    };
    const names = extractEnvVarsFromRegistryConfig(entry);
    expect(new Set(names)).toEqual(new Set(['NS', 'VER', 'TOKEN', 'USER']));
  });

  it('returns empty when no vars', () => {
    expect(
      extractEnvVarsFromRegistryConfig({ url: 'https://r/{name}.json' }),
    ).toEqual([]);
  });
});

describe('validateRegistryConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
    }
  });

  it('throws MissingEnvVars when string entry has unset var', () => {
    delete process.env.TASKFLOW_TEST_TOKEN;
    expect(() =>
      validateRegistryConfig('@acme', 'https://r/${TASKFLOW_TEST_TOKEN}/{name}.json'),
    ).toThrow(RegistryMissingEnvironmentVariablesError);
  });

  it('passes when string entry var is set', () => {
    process.env.TASKFLOW_TEST_TOKEN = 'abc';
    expect(() =>
      validateRegistryConfig('@acme', 'https://r/${TASKFLOW_TEST_TOKEN}/{name}.json'),
    ).not.toThrow();
  });

  it('throws MissingEnvVars when object entry has unset var', () => {
    delete process.env.TASKFLOW_TEST_TOKEN;
    expect(() =>
      validateRegistryConfig('@acme', {
        url: 'https://r/{name}.json',
        headers: { Authorization: 'Bearer ${TASKFLOW_TEST_TOKEN}' },
      }),
    ).toThrow(RegistryMissingEnvironmentVariablesError);
  });

  it('passes when all object-entry vars are set', () => {
    process.env.TASKFLOW_TEST_TOKEN = 'abc';
    process.env.TASKFLOW_TEST_VER = 'v1';
    expect(() =>
      validateRegistryConfig('@acme', {
        url: 'https://r/{name}.json',
        params: { v: '${TASKFLOW_TEST_VER}' },
        headers: { Authorization: 'Bearer ${TASKFLOW_TEST_TOKEN}' },
      }),
    ).not.toThrow();
  });

  it('treats empty string env var as missing', () => {
    process.env.TASKFLOW_TEST_TOKEN = '';
    expect(() =>
      validateRegistryConfig('@acme', 'https://r/${TASKFLOW_TEST_TOKEN}/{name}.json'),
    ).toThrow(RegistryMissingEnvironmentVariablesError);
  });

  it('reports all missing var names in the error', () => {
    delete process.env.TASKFLOW_TEST_A;
    delete process.env.TASKFLOW_TEST_B;
    try {
      validateRegistryConfig('@acme', {
        url: 'https://r/${TASKFLOW_TEST_A}/{name}.json',
        headers: { Authorization: '${TASKFLOW_TEST_B}' },
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryMissingEnvironmentVariablesError);
      const names = (err as RegistryMissingEnvironmentVariablesError).varNames;
      expect(new Set(names)).toEqual(new Set(['TASKFLOW_TEST_A', 'TASKFLOW_TEST_B']));
    }
  });
});
