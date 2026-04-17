#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SpecSchema } from './schema';
import { emit } from './emit';

const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: npm run build <spec.yml>');
  process.exit(2);
}

const spec = SpecSchema.parse(parseYaml(readFileSync(specPath, 'utf8')));
// Seed the emit scope with `{cwd}` = the build-machine's repo root, so specs
// can write absolute-path references (`{cwd}/data/smoke/hello.txt`) without
// hard-coding the caller's filesystem layout. The value is inlined as a
// literal string at emit time, so the emitted TS is still deterministic for
// a given build invocation — callers relying on byte-stable output across
// machines should avoid `{cwd}`.
const initialScope = { cwd: process.cwd() };
const ts = emit(spec, basename(specPath), initialScope);
const outPath = specPath.replace(/\.spec\.ya?ml$/, '.ts');
if (outPath === specPath) {
  console.error('input must end with .spec.yaml or .spec.yml');
  process.exit(2);
}

writeFileSync(outPath, ts);
console.log(`wrote ${outPath}`);
