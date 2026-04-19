import { z } from 'zod';

export const registryItemTypeSchema = z.union([
  z.literal('taskflow:harness'),
  z.literal('taskflow:plugin'),
  z.literal('taskflow:rules'),
  z.literal('taskflow:config-patch'),
  z.literal('taskflow:utils'),
  z.literal('taskflow:example'),
  z.literal('taskflow:file'),
]);
export type RegistryItemType = z.infer<typeof registryItemTypeSchema>;

const baseFileFields = {
  path: z.string().min(1),
  content: z.string().optional(),
  target: z.string().optional(),
} as const;

const fileRequiringTarget = z.object({
  ...baseFileFields,
  target: z.string().min(1),
});

const fileOptionalTarget = z.object(baseFileFields);

export const registryItemFileSchema = z.discriminatedUnion('type', [
  fileRequiringTarget.extend({ type: z.literal('taskflow:file') }),
  fileRequiringTarget.extend({ type: z.literal('taskflow:rules') }),
  fileOptionalTarget.extend({ type: z.literal('taskflow:harness') }),
  fileOptionalTarget.extend({ type: z.literal('taskflow:plugin') }),
  fileOptionalTarget.extend({ type: z.literal('taskflow:config-patch') }),
  fileOptionalTarget.extend({ type: z.literal('taskflow:utils') }),
  fileOptionalTarget.extend({ type: z.literal('taskflow:example') }),
]);
export type RegistryItemFile = z.infer<typeof registryItemFileSchema>;

export const registryItemSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1),
  type: registryItemTypeSchema,
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  requiredAdapters: z.array(z.string()).optional(),
  requiredEnv: z.array(z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  registryDependencies: z.array(z.string()).optional(),
  files: z.array(registryItemFileSchema).optional(),
  config: z
    .object({
      scope: z.string().optional(),
      plugins: z.array(z.string()).optional(),
    })
    .optional(),
  envVars: z.record(z.string(), z.string()).optional(),
  docs: z.string().optional(),
  categories: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type RegistryItem = z.infer<typeof registryItemSchema>;

export const registrySchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().min(1),
    homepage: z.string(),
    items: z.array(registryItemSchema).min(1),
  })
  .refine(
    (r) => new Set(r.items.map((i) => i.name)).size === r.items.length,
    { message: 'registry items must have unique names' },
  );
export type Registry = z.infer<typeof registrySchema>;

const urlWithName = z
  .string()
  .refine((s) => s.includes('{name}'), { message: 'registry URL must contain {name}' });

export const registryConfigItemSchema = z.union([
  urlWithName,
  z.object({
    url: urlWithName,
    params: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
export type RegistryConfigItem = z.infer<typeof registryConfigItemSchema>;

export const registryConfigSchema = z.record(
  z.string().startsWith('@'),
  registryConfigItemSchema,
);
export type RegistryConfig = z.infer<typeof registryConfigSchema>;

export const taskflowJsonSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal('1'),
  harnessDir: z.string().default('.agents/taskflow/harness'),
  rulesDir: z.string().default('.agents/taskflow/rules'),
  aliases: z.record(z.string(), z.string()).optional(),
  registries: registryConfigSchema.optional(),
});
export type TaskflowJson = z.infer<typeof taskflowJsonSchema>;

export const lockItemSchema = z.object({
  source: z.string().min(1),
  resolvedCommit: z.string().optional(),
  sha256: z.string().optional(),
  type: registryItemTypeSchema,
  dependencies: z.array(z.string()).optional(),
});
export type LockItem = z.infer<typeof lockItemSchema>;

export const lockSchema = z.object({
  version: z.literal('1'),
  items: z.record(z.string(), lockItemSchema),
});
export type Lock = z.infer<typeof lockSchema>;
