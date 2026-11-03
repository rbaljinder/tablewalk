#!/usr/bin/env node
/**
 * The seam, held: this repository imports the framework only by what the INSTALLED packages publish.
 *
 *   - every `@mistriwork/<engine|kit|ui>` specifier in the sources is in that package's `exports` as installed (the
 *     published map is the contract, not a path inside node_modules);
 *   - no relative import leaves the repository, and none names a node_modules path;
 *   - nothing imports a framework package that is not a dependency (`@mistriwork/mistri` is not this repository's).
 *
 * A specifier the package does not publish is a gap in the framework, to be fixed there (a host-list entry), never
 * patched around here.
 */
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEPENDENCIES = new Set(['@mistriwork/engine', '@mistriwork/kit', '@mistriwork/ui']);
const exportsOf = new Map();
for (const name of DEPENDENCIES) {
  const manifest = join(ROOT, 'node_modules', name, 'package.json');
  if (!existsSync(manifest)) {
    console.error(`check-boundary: ${name} is not installed; run npm ci.`);
    process.exit(2);
  }
  exportsOf.set(name, Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).exports ?? {}));
}

/** Does an `exports` map publish this subpath (`./client/core.js`), counting `./x/*` patterns? */
function published(keys, subpath) {
  return keys.some((key) => key === subpath || (key.endsWith('/*') && subpath.startsWith(key.slice(0, -1))));
}

const files = globSync('{src,test,e2e,scripts,desktop}/**/*.{ts,tsx,js,mjs,cjs,mts}', { cwd: ROOT }).filter(
  (file) => !file.includes('node_modules/') && !file.startsWith('desktop/build/') && !file.startsWith('e2e/.tmp/'),
);
const problems = [];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*)(['"])([^'"\n]+)\1/g;
for (const file of files.sort()) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  for (const [, , specifier] of text.matchAll(SPECIFIER)) {
    const scoped = /^(@mistriwork\/[a-z-]+)(\/.*)?$/.exec(specifier);
    if (scoped) {
      const [, name, rest] = scoped;
      if (!DEPENDENCIES.has(name)) problems.push(`${file}: ${specifier} — ${name} is not a dependency of the database browser`);
      else if (!published(exportsOf.get(name), rest ? `.${rest}` : '.'))
        problems.push(`${file}: ${specifier} — not in the installed ${name}'s exports`);
    } else if (specifier.startsWith('.')) {
      const target = resolve(dirname(join(ROOT, file)), specifier);
      if (relative(ROOT, target).startsWith('..')) problems.push(`${file}: ${specifier} leaves the repository`);
    } else if (/node_modules\//.test(specifier)) problems.push(`${file}: ${specifier} reaches into node_modules`);
  }
}
if (problems.length) {
  console.error(`check-boundary: ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-boundary: ${files.length} files import the framework only by what its packages publish.`);
