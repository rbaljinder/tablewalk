#!/usr/bin/env node
/**
 * The static checks, in one command (`npm run check`): types, lint, the client's own checks, the import boundary and
 * formatting. Each runs even when an earlier one fails, so one pass names everything; the exit code is the first failure's.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;
const steps = [
  ['tsc', [node, '--max-old-space-size=4096', 'node_modules/typescript/bin/tsc', '--noEmit']],
  ['oxlint', ['npx', 'oxlint']],
  ['client types', [node, '--max-old-space-size=4096', 'test/check-client-types.mjs']],
  ['client geometry', [node, 'test/check-client-geometry.mjs']],
  ['client motion', [node, 'test/check-client-motion.mjs']],
  ['client host', [node, 'test/check-client-host.mjs']],
  ['client shape', [node, 'test/check-client-shape.mjs']],
  ['client type', [node, 'test/check-client-type.mjs']],
  ['client space', [node, 'test/check-client-space.mjs']],
  ['client copy', [node, 'test/check-client-copy.mjs']],
  ['boundary', [node, 'scripts/check-boundary.mjs']],
  ['oxfmt', ['npx', 'oxfmt', '--check', '{src,test,e2e,scripts,desktop}/**/*.{ts,tsx,js,mjs,cjs,mts}', '{*,config/*}.{ts,mjs,js,cjs,mts}']],
];
let status = 0;
for (const [label, [command, ...args]] of steps) {
  console.log(`# ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`# ${label} failed`);
    status ||= result.status ?? 1;
  }
}
process.exit(status);
