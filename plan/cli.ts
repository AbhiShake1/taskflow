#!/usr/bin/env tsx
// CLI entry: `npm run plan -- <taskflow-file.ts>`
//
// Parses the file purely as AST, builds a PlanRoot, and mounts the static
// Ink preview. No LLM calls; the user's module is never executed.

import { resolve } from 'node:path';
import { planFromFile } from './ast';
import { renderPlan } from './render';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    // eslint-disable-next-line no-console
    console.error('usage: npm run plan -- <taskflow-file.ts>');
    process.exit(2);
  }
  const root = planFromFile(resolve(file));
  renderPlan(root);
}

void main();
