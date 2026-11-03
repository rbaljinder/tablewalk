#!/usr/bin/env node
/**
 * Build the package: the server and shared modules with tsc (tsconfig.build.json) into dist/, the page with Vite
 * (vite.config.ts, over the installed @mistriwork/kit) into dist/client, then the bundle budget.
 *
 *   node scripts/build.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bin = (name) => join(ROOT, 'node_modules/.bin', name);
const run = (command, args) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });

rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
/* Checked: a build from a tag has not run `npm run check` first, and an emit that ignores a type error ships it. */
run(bin('tsc'), ['-p', 'tsconfig.build.json']);
run(bin('vite'), ['build', '--logLevel', 'warn']);

const expected = ['dist/server/index.js', 'dist/client/index.html', 'dist/client/index.workbench.html'];
const missing = expected.filter((file) => !existsSync(join(ROOT, file)));
if (missing.length) {
  console.error(`build: the build did not write ${missing.join(', ')}.`);
  process.exit(1);
}
run(process.execPath, ['scripts/bundle-budget.mjs']);
