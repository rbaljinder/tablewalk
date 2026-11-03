/**
 * Assemble the server half of the bundle.
 *
 * electron-builder packs this directory; it cannot pack the repository, because the repository's node_modules holds tsx,
 * typescript and Vite — a build toolchain that has no business in a shipped app and is larger than the app.
 *
 * So the runtime half is staged here first, laid out as `npm install tablewalk` leaves it: this package, packed with
 * `npm pack` (its `files` allowlist is exactly what the registry gets) and installed with `--omit=dev` together with what
 * it depends on from the registry — `@mistriwork/engine`, `kit` and `ui` at the versions package.json pins, and the
 * database driver they bring. Listing pg's dependency tree by hand in electron-builder's config was the alternative, and
 * it is wrong the first time pg gains a dependency.
 *
 * One quirk this pairs with, since package.json cannot hold a comment: `extraResources` in that file has *two* entries
 * pointing into this directory, and the second is not redundant. electron-builder excludes node_modules from an
 * extraResources copy no matter what filter you give it, and naming node_modules as its own `from` is what gets it in.
 * Without the second entry the build succeeds and ships an app where SQLite works and Postgres fails at the first
 * connection — which is why it was worth finding before shipping rather than after.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const ROOT = join(DESKTOP, '..');
const STAGE = join(DESKTOP, 'build', 'server');

const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

// The app version is the package's version. electron-builder reads this dir's package.json, not the root's, so without
// syncing it a 1.0.0 release would ship a desktop app that still calls itself whatever was hardcoded here.
const desktopPkgPath = join(DESKTOP, 'package.json');
const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, 'utf8'));
if (desktopPkg.version !== root.version) {
  desktopPkg.version = root.version;
  writeFileSync(desktopPkgPath, `${JSON.stringify(desktopPkg, null, 2)}\n`);
  console.log(`stage: synced desktop version to ${root.version}`);
}

console.log('stage: building the server');
run('npm', ['run', 'build'], ROOT);

console.log(`stage: ${STAGE}`);
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

console.log('stage: packing');
const packed = join(STAGE, '..', 'packed');
rmSync(packed, { recursive: true, force: true });
mkdirSync(packed, { recursive: true });
run('npm', ['pack', '--pack-destination', packed, '--silent'], ROOT);
const tarball = readdirSync(packed).find((name) => name.endsWith('.tgz'));
if (!tarball) throw new Error('stage: npm pack wrote no tarball.');

writeFileSync(
  join(STAGE, 'package.json'),
  `${JSON.stringify({ name: 'tablewalk-server', version: root.version, private: true, type: 'module' }, null, 2)}\n`,
);

console.log('stage: installing the package and its runtime dependencies');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', join(packed, tarball)], STAGE);
rmSync(packed, { recursive: true, force: true });

console.log('stage: done');
