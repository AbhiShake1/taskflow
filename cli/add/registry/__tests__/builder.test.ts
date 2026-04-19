import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildUrlAndHeadersForRegistryItem } from '../builder';
import {
  RegistryMissingEnvironmentVariablesError,
  RegistryNotConfiguredError,
} from '../errors';

describe('buildUrlAndHeadersForRegistryItem', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
    }
  });

  it('resolves bare name via built-in @taskflow default URL', () => {
    delete process.env.REGISTRY_URL;
    delete process.env.TASKFLOW_REGISTRY_URL;
    const built = buildUrlAndHeadersForRegistryItem('button', null);
    expect(built).toEqual({
      url: 'https://taskflow.sh/r/button.json',
      headers: {},
    });
  });

  it('honors TASKFLOW_REGISTRY_URL for built-in namespace', () => {
    delete process.env.REGISTRY_URL;
    process.env.TASKFLOW_REGISTRY_URL = 'http://localhost:4242/r';
    const built = buildUrlAndHeadersForRegistryItem('button', null);
    expect(built?.url).toBe('http://localhost:4242/r/button.json');
  });

  it('resolves @acme/btn against user-registered string template with ${ENV} in URL', () => {
    process.env.TASKFLOW_TEST_NS = 'v1';
    const built = buildUrlAndHeadersForRegistryItem('@acme/btn', {
      registries: {
        '@acme': 'https://r.acme.com/${TASKFLOW_TEST_NS}/{name}.json',
      },
    });
    expect(built).toEqual({
      url: 'https://r.acme.com/v1/btn.json',
      headers: {},
    });
  });

  it('resolves @acme/btn object form with ${ENV} in headers', () => {
    process.env.TASKFLOW_TEST_TOKEN = 'secret';
    const built = buildUrlAndHeadersForRegistryItem('@acme/btn', {
      registries: {
        '@acme': {
          url: 'https://r.acme.com/{name}.json',
          headers: { Authorization: 'Bearer ${TASKFLOW_TEST_TOKEN}' },
        },
      },
    });
    expect(built?.url).toBe('https://r.acme.com/btn.json');
    expect(built?.headers).toEqual({ Authorization: 'Bearer secret' });
  });

  it('appends params to URL', () => {
    process.env.TASKFLOW_TEST_VER = 'latest';
    const built = buildUrlAndHeadersForRegistryItem('@acme/btn', {
      registries: {
        '@acme': {
          url: 'https://r.acme.com/{name}.json',
          params: { v: '${TASKFLOW_TEST_VER}' },
        },
      },
    });
    expect(built?.url).toBe('https://r.acme.com/btn.json?v=latest');
  });

  it('throws MissingEnvVars when object-entry header has unset var', () => {
    delete process.env.TASKFLOW_TEST_TOKEN;
    expect(() =>
      buildUrlAndHeadersForRegistryItem('@acme/btn', {
        registries: {
          '@acme': {
            url: 'https://r.acme.com/{name}.json',
            headers: { Authorization: 'Bearer ${TASKFLOW_TEST_TOKEN}' },
          },
        },
      }),
    ).toThrow(RegistryMissingEnvironmentVariablesError);
  });

  it('throws RegistryNotConfigured for unknown namespace', () => {
    expect(() =>
      buildUrlAndHeadersForRegistryItem('@unknown/btn', { registries: {} }),
    ).toThrow(RegistryNotConfiguredError);
  });

  it('returns null when input is a URL', () => {
    expect(
      buildUrlAndHeadersForRegistryItem('https://host.example/x.json', null),
    ).toBeNull();
  });

  it('returns null when input is a local path', () => {
    expect(buildUrlAndHeadersForRegistryItem('./local.json', null)).toBeNull();
  });
});
