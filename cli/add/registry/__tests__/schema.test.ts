import { describe, expect, it } from 'vitest';
import {
  registryConfigSchema,
  registryItemSchema,
  registrySchema,
} from '../schema';

describe('registryItemSchema', () => {
  it('parses a minimal valid item', () => {
    const result = registryItemSchema.safeParse({
      name: 'ui-harness-trio',
      type: 'taskflow:harness',
    });
    expect(result.success).toBe(true);
  });

  it('rejects taskflow:file without target', () => {
    const result = registryItemSchema.safeParse({
      name: 'x',
      type: 'taskflow:file',
      files: [{ path: 'harness/x.ts', type: 'taskflow:file', content: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown file type', () => {
    const result = registryItemSchema.safeParse({
      name: 'x',
      type: 'taskflow:harness',
      files: [{ path: 'harness/x.ts', type: 'taskflow:bogus', content: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('registrySchema', () => {
  it('rejects duplicate item names', () => {
    const result = registrySchema.safeParse({
      name: '@acme',
      homepage: 'https://acme.example',
      items: [
        { name: 'dup', type: 'taskflow:harness' },
        { name: 'dup', type: 'taskflow:harness' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts unique item names', () => {
    const result = registrySchema.safeParse({
      name: '@acme',
      homepage: 'https://acme.example',
      items: [
        { name: 'a', type: 'taskflow:harness' },
        { name: 'b', type: 'taskflow:harness' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('registryConfigSchema', () => {
  it('rejects keys that do not start with @', () => {
    const result = registryConfigSchema.safeParse({
      acme: 'https://r.example/{name}.json',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a URL template without {name}', () => {
    const result = registryConfigSchema.safeParse({
      '@acme': 'https://r.example/registry.json',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid namespaced config', () => {
    const result = registryConfigSchema.safeParse({
      '@acme': 'https://r.example/{name}.json',
    });
    expect(result.success).toBe(true);
  });
});
