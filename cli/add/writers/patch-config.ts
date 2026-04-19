import { log } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Node,
  Project,
  SyntaxKind,
  type ArrayLiteralExpression,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'ts-morph';

export interface ConfigPatch {
  scope?: string;
  plugins?: string[];
}

function findTargetObject(sourceFile: SourceFile): ObjectLiteralExpression | undefined {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (expr.getText() === 'defineConfig') {
      const arg = call.getArguments()[0];
      if (arg && Node.isObjectLiteralExpression(arg)) return arg;
    }
  }
  const exportAssign = sourceFile.getExportAssignment((d) => !d.isExportEquals());
  if (exportAssign) {
    const expr = exportAssign.getExpression();
    if (Node.isObjectLiteralExpression(expr)) return expr;
    if (Node.isCallExpression(expr)) {
      const arg = expr.getArguments()[0];
      if (arg && Node.isObjectLiteralExpression(arg)) return arg;
    }
  }
  return undefined;
}

function applyScope(obj: ObjectLiteralExpression, scope: string): void {
  const existing = obj.getProperty('scope');
  if (existing && Node.isPropertyAssignment(existing)) {
    existing.setInitializer((writer) => writer.quote(scope));
    return;
  }
  obj.addPropertyAssignment({ name: 'scope', initializer: (writer) => writer.quote(scope) });
}

function collectIdentifierNames(array: ArrayLiteralExpression): Set<string> {
  const names = new Set<string>();
  for (const el of array.getElements()) {
    if (Node.isIdentifier(el)) names.add(el.getText());
    else if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
      names.add(el.getLiteralText());
    } else {
      names.add(el.getText());
    }
  }
  return names;
}

function applyPlugins(obj: ObjectLiteralExpression, plugins: string[]): void {
  const existing = obj.getProperty('plugins');
  if (existing && Node.isPropertyAssignment(existing)) {
    const init = existing.getInitializer();
    if (init && Node.isArrayLiteralExpression(init)) {
      const present = collectIdentifierNames(init);
      for (const name of plugins) {
        if (!present.has(name)) {
          init.addElement(name);
          present.add(name);
        }
      }
      return;
    }
  }
  obj.addPropertyAssignment({
    name: 'plugins',
    initializer: `[${plugins.join(', ')}]`,
  });
}

export async function applyConfigPatch(
  patch: ConfigPatch | undefined,
  opts: { cwd: string; dryRun: boolean; silent: boolean },
): Promise<void> {
  if (!patch || (patch.scope === undefined && (!patch.plugins || patch.plugins.length === 0))) {
    return;
  }

  const configPath = resolve(opts.cwd, '.agents/taskflow/config.ts');
  if (!existsSync(configPath)) return;

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
  });

  const sourceFile = project.addSourceFileAtPath(configPath);
  const original = sourceFile.getFullText();

  const target = findTargetObject(sourceFile);
  if (!target) {
    if (!opts.silent) {
      log.warn(`config patch: could not locate config object in ${configPath}`);
    }
    return;
  }

  if (patch.scope !== undefined && patch.scope !== '') {
    applyScope(target, patch.scope);
  }
  if (patch.plugins && patch.plugins.length > 0) {
    applyPlugins(target, patch.plugins);
  }

  const updated = sourceFile.getFullText();
  if (updated === original) return;

  if (opts.dryRun) {
    if (!opts.silent) {
      log.info(`would patch: ${configPath}`);
      process.stdout.write(`--- before\n${original}--- after\n${updated}`);
    }
    return;
  }

  sourceFile.saveSync();
  if (!opts.silent) log.success(`patched: ${configPath}`);
}
