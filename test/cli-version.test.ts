/*
 * `tablewalk --version` prints this package's version, not the engine's: the two are separate numbers, and the one a
 * person reports in a bug is the one in the package they installed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/server/index.ts', import.meta.url));
const own = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8' });

test('--version and -v print the tablewalk package version', () => {
  for (const flag of ['--version', '-v']) {
    const result = run(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), own);
  }
});

test('--write-pool is refused, not silently accepted', () => {
  const result = run('--write-pool', '4', '--demo');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--write-pool is an App option/);
});
