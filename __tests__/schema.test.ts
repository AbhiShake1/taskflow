import { describe, it, expect } from 'vitest';
import { SpecSchema, LeafSpecSchema, StageSpecSchema } from '../factory/schema';

const validSpec = {
  name: 'pipeline',
  root: {
    stage: 'pipeline',
    steps: [
      {
        stage: 'discover',
        steps: [
          {
            leaf: 'emit-nums',
            agent: 'claude-code' as const,
            model: 'sonnet',
            task: 'Emit the numbers 1..30 as a JSON array.',
            claims: ['data/pipeline/nums.json'],
          },
        ],
      },
      {
        stage: 'compute',
        parallel: true,
        expand: { count: 3, as: 'i' },
        steps: [
          {
            leaf: 'square-{i}',
            agent: 'claude-code' as const,
            model: 'sonnet',
            task: 'Square chunk {i} of the nums array.',
            claims: ['data/pipeline/chunk-{i}.json'],
          },
        ],
      },
      {
        stage: 'aggregate',
        steps: [
          {
            leaf: 'sum-all',
            agent: 'claude-code' as const,
            model: 'sonnet',
            task: 'Sum all chunk squares and write summary.json.',
            claims: ['data/pipeline/summary.json'],
          },
        ],
      },
    ],
  },
};

describe('SpecSchema — happy path', () => {
  it('accepts the full example spec', () => {
    const result = SpecSchema.safeParse(validSpec);
    expect(result.success).toBe(true);
  });

  it('round-trips: parsed value deep-equals input', () => {
    const parsed = SpecSchema.parse(validSpec);
    expect(parsed).toEqual(validSpec);
  });
});

describe('SpecSchema — rejections', () => {
  it('rejects a node with BOTH leaf and stage keys', () => {
    const bad = {
      name: 'x',
      root: {
        stage: 'root',
        steps: [
          {
            leaf: 'x',
            stage: 'x',
            agent: 'pi',
            task: 't',
          },
        ],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a stage with both expand AND foreach', () => {
    const bad = {
      name: 'x',
      root: {
        stage: 'root',
        expand: { count: 2, as: 'i' },
        foreach: { items: ['a', 'b'], as: 'x' },
        steps: [
          { leaf: 'l', agent: 'pi', task: 't' },
        ],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a stage with both expand AND repeat', () => {
    const bad = {
      name: 'x',
      root: {
        stage: 'root',
        expand: { count: 2, as: 'i' },
        repeat: 3,
        steps: [{ leaf: 'l', agent: 'pi', task: 't' }],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects expand.count = 0', () => {
    const bad = {
      name: 'x',
      root: {
        stage: 'root',
        expand: { count: 0, as: 'i' },
        steps: [{ leaf: 'l', agent: 'pi', task: 't' }],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects non-integer expand.count', () => {
    const bad = {
      name: 'x',
      root: {
        stage: 'root',
        expand: { count: 2.5, as: 'i' },
        steps: [{ leaf: 'l', agent: 'pi', task: 't' }],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects agent not in the enum (e.g. gpt-4)', () => {
    const bad = {
      name: 'x',
      root: {
        stage: 'root',
        steps: [{ leaf: 'l', agent: 'gpt-4', task: 't' }],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a leaf missing task', () => {
    const bad = {
      name: 'x',
      root: {
        stage: 'root',
        steps: [{ leaf: 'l', agent: 'pi' }],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a leaf with empty task', () => {
    const bad = {
      name: 'x',
      root: {
        stage: 'root',
        steps: [{ leaf: 'l', agent: 'pi', task: '' }],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a stage missing steps', () => {
    const bad = {
      name: 'x',
      root: { stage: 'root' },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a stage with empty steps', () => {
    const bad = {
      name: 'x',
      root: { stage: 'root', steps: [] },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a top-level spec missing root', () => {
    const bad = { name: 'x' };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects foreach with empty items', () => {
    const bad = {
      name: 'x',
      root: {
        stage: 'root',
        foreach: { items: [], as: 'x' },
        steps: [{ leaf: 'l', agent: 'pi', task: 't' }],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty name', () => {
    const bad = {
      name: '',
      root: {
        stage: 'root',
        steps: [{ leaf: 'l', agent: 'pi', task: 't' }],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a name containing whitespace', () => {
    const bad = {
      name: 'has space',
      root: {
        stage: 'root',
        steps: [{ leaf: 'l', agent: 'pi', task: 't' }],
      },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-stage root (root that looks like a leaf)', () => {
    const bad = {
      name: 'x',
      root: { leaf: 'l', agent: 'pi', task: 't' },
    };
    expect(SpecSchema.safeParse(bad).success).toBe(false);
  });
});

describe('LeafSpecSchema / StageSpecSchema — direct', () => {
  it('LeafSpecSchema accepts a minimal valid leaf', () => {
    const r = LeafSpecSchema.safeParse({
      leaf: 'l',
      agent: 'pi',
      task: 't',
    });
    expect(r.success).toBe(true);
  });

  it('StageSpecSchema accepts a stage with foreach', () => {
    const r = StageSpecSchema.safeParse({
      stage: 's',
      foreach: { items: ['a', 1, 'b'], as: 'x' },
      steps: [{ leaf: 'l', agent: 'pi', task: 't' }],
    });
    expect(r.success).toBe(true);
  });

  it('StageSpecSchema accepts a stage with repeat', () => {
    const r = StageSpecSchema.safeParse({
      stage: 's',
      repeat: 3,
      steps: [{ leaf: 'l', agent: 'pi', task: 't' }],
    });
    expect(r.success).toBe(true);
  });
});
