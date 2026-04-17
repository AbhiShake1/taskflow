import { z } from 'zod';

/**
 * Zod schema for the harness YAML spec format.
 *
 * These types describe the RAW YAML input (templated ids, unresolved fan-out
 * directives). The emitter later translates these into the resolved runtime
 * shapes in harness/core/types.ts. Keep the two type trees independent.
 */

export type AgentName = 'claude-code' | 'pi' | 'codex' | 'cursor' | 'opencode';

export type RawLeafSpec = {
  leaf: string;
  agent: AgentName;
  model?: string;
  task: string;
  claims?: string[];
  timeoutMs?: number;
  rulesPrefix?: boolean;
};

export type RawStageSpec = {
  stage: string;
  parallel?: boolean;
  expand?: { count: number; as: string };
  foreach?: { items: (string | number)[]; as: string };
  repeat?: number;
  steps: RawNode[];
};

export type RawNode = RawLeafSpec | RawStageSpec;

export type Spec = {
  name: string;
  rulesFile?: string;
  root: RawStageSpec;
};

export const AgentNameSchema = z.enum([
  'claude-code',
  'pi',
  'codex',
  'cursor',
  'opencode',
]);

/**
 * A leaf node:
 * - has a `leaf` key (string id, may contain template placeholders)
 * - MUST NOT have a `stage` key (enforced by refinement below)
 * - has a required, non-empty `task`
 */
export const LeafSpecSchema: z.ZodType<RawLeafSpec> = z
  .object({
    leaf: z.string().min(1, 'leaf id must be non-empty'),
    agent: AgentNameSchema,
    model: z.string().min(1).optional(),
    task: z.string().min(1, 'leaf task is required and must be non-empty'),
    claims: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    rulesPrefix: z.boolean().optional(),
    // Forbid the `stage` discriminator from appearing on leaves.
    stage: z.undefined().optional(),
  })
  .strict()
  .transform((v) => {
    // Strip the sentinel `stage: undefined` so the parsed value matches the
    // declared RawLeafSpec exactly (no phantom key).
    const { stage: _stage, ...rest } = v as RawLeafSpec & { stage?: undefined };
    return rest as RawLeafSpec;
  });

/**
 * Recursive node schema — a node is either a leaf or a stage.
 * We union by presence of the `leaf` / `stage` key rather than using
 * z.discriminatedUnion so we can keep template-friendly string ids.
 */
export const NodeSchema: z.ZodType<RawNode> = z.lazy(() =>
  z.union([LeafSpecSchema, StageSpecSchema]),
);

/**
 * A stage node:
 * - has a `stage` key (string id, may contain template placeholders)
 * - MUST NOT have a `leaf` key
 * - has a required, non-empty `steps` array
 * - at most one of `expand` / `foreach` / `repeat` may be set
 */
export const StageSpecSchema: z.ZodType<RawStageSpec> = z.lazy(() =>
  z
    .object({
      stage: z.string().min(1, 'stage id must be non-empty'),
      parallel: z.boolean().optional(),
      expand: z
        .object({
          count: z
            .number()
            .int('expand.count must be an integer')
            .min(1, 'expand.count must be >= 1'),
          as: z.string().min(1, 'expand.as must be non-empty'),
        })
        .strict()
        .optional(),
      foreach: z
        .object({
          items: z
            .array(z.union([z.string(), z.number()]))
            .min(1, 'foreach.items must be non-empty'),
          as: z.string().min(1, 'foreach.as must be non-empty'),
        })
        .strict()
        .optional(),
      repeat: z
        .number()
        .int('repeat must be an integer')
        .min(1, 'repeat must be >= 1')
        .optional(),
      steps: z.array(NodeSchema).min(1, 'stage steps must be non-empty'),
      // Forbid the `leaf` discriminator from appearing on stages.
      leaf: z.undefined().optional(),
    })
    .strict()
    .refine(
      (s) => {
        const n =
          (s.expand !== undefined ? 1 : 0) +
          (s.foreach !== undefined ? 1 : 0) +
          (s.repeat !== undefined ? 1 : 0);
        return n <= 1;
      },
      {
        message:
          'at most one of `expand`, `foreach`, `repeat` may be set on a stage',
        path: ['expand'],
      },
    )
    .transform((v) => {
      const { leaf: _leaf, ...rest } = v as RawStageSpec & {
        leaf?: undefined;
      };
      return rest as RawStageSpec;
    }),
);

/**
 * Top-level spec. `root` is always a stage (enforced by using StageSpecSchema
 * rather than NodeSchema).
 */
export const SpecSchema: z.ZodType<Spec> = z
  .object({
    name: z
      .string()
      .min(1, 'name must be non-empty')
      .refine((s) => !/\s/.test(s), { message: 'name must not contain whitespace' }),
    rulesFile: z.string().min(1).optional(),
    root: StageSpecSchema,
  })
  .strict();
