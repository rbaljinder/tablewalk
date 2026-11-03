/**
 * The package, for the checks that read the sources. The repository is one package, so `treeFiles('src/client')` walks
 * its own src/client (it walked every package's in the monorepo this was cut from).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** `{ name, dir, layer }` for each package, `dir` relative to the root. */
export const PACKAGES = [{ name: 'tablewalk', dir: '.', layer: 'browser' }];

/** The package a repository path is in, or undefined. */
export const packageOf = (file) => (file.startsWith('node_modules/') ? undefined : PACKAGES[0]);

/** The folders `<dir>/<sub>` that exist, as absolute paths. */
export function packageFolders(sub, root = ROOT) {
  return PACKAGES.map(({ dir }) => join(root, dir, sub)).filter((path) => existsSync(path));
}

/**
 * Every file under `<sub>`: `path` absolute, `rel` relative to `<sub>`, `repo` relative to the root, and the package.
 */
export function treeFiles(sub, { recursive = true, root = ROOT } = {}) {
  const out = [];
  for (const pkg of PACKAGES) {
    const base = join(root, pkg.dir, sub);
    if (!existsSync(base)) continue;
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (recursive) walk(path);
        } else out.push({ path, rel: relative(base, path).split('\\').join('/'), repo: relative(root, path).split('\\').join('/'), pkg });
      }
    };
    walk(base);
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
