#!/usr/bin/env node
/**
 * Bundles a TypeScript test entry with esbuild and runs it in Node.
 * Keeps the headless-browser harness for anything visual, and gives the pure
 * simulation code (track maths, physics, music theory) a sub-second test loop.
 *
 *   node tools/run-test.mjs tests/track.test.ts
 */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = resolve(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(), 'vh-test-'));
const outfile = join(dir, 'bundle.mjs');

await build({
  entryPoints: [entry],
  bundle: true,
  outfile,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // three ships ESM; bundling it keeps the single-instance guarantee.
  external: [],
  logLevel: 'error',
});

try {
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
