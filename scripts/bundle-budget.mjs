#!/usr/bin/env node
/**
 * The client's size, held to a ceiling. Run by `npm run build`, after Vite.
 *
 * What a first visit must download before anything paints is the page's entry script, the chunk the page preloads,
 * everything that script imports statically, and its stylesheet; parts loaded on demand (components/onDemand.tsx) come
 * later and are not counted. That weight only ever grew before anyone held it.
 *
 * The ceilings sit a little above what ships today, so an ordinary change passes and a new dependency pulled into the
 * entry does not. Raising one is allowed; it is a decision, made in this file, with the reason beside it — and moving the
 * new weight behind `onDemand` is usually the better answer. The values are the ones the monorepo held when the browser
 * left it (rc.12); the kit's own page weighs in them, so a kit bump that moves them says so here.
 *
 * What the page then does with those bytes — how long a click takes to answer, whether anything moves under the reader —
 * is the framework's to budget (its test/built-client-vitals.mjs).
 *
 *   node scripts/bundle-budget.mjs          check dist/client
 *   node scripts/bundle-budget.mjs --print  say the sizes, check nothing
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLIENT = join(ROOT, 'dist/client');

/* Bytes, per first page. Brotli is what a browser is sent (the server prefers the `.br` beside each file); raw is what it
   parses and compiles. The Workbench is the kit's shell page and the Workbench's own chunk, which the shell loads the
   moment it shows the Workbench. The style ceilings rose with rc.17 (raw 378_860 to 384_000, brotli 51_800 to 52_300): the
   kit's stylesheet is larger than rc.14's by about 3 KB, and this package added no CSS.
   They rose again for 1.0.0-rc.13, on kit rc.49 (script raw 1_287_900 to 1_318_000; style raw 384_000 to 440_000,
   brotli 52_300 to 58_000). The browser's own look is now Instrument in Fog and moss (looks/native.css), drawn in the
   first stylesheet on purpose so the first paint is already in it rather than flashing the kit's tokens: the Workbench
   chunk's sheet went from about 10 KB to 50 KB with it, Inter's and Plex Mono's faces included. The kit's own sheet grew
   by about 13 KB and its script by about 38 KB from rc.17 to rc.49; this package's script barely moved. */
export const BUDGET = {
  workbench: { script: { raw: 1_318_000, br: 361_400 }, style: { raw: 440_000, br: 58_000 } },
};

/* The chrome's words in a language besides English (src/client/copy/<lang>.ts), one chunk each, which only a reader of
   that language fetches. English stays in the entry, so these are no surface's first paint; each is held on its own, so a
   language cannot grow into a second catalog unnoticed. */
export const LOCALE_BUDGET = { raw: 4_000, br: 1_600 };

/** Each language's words chunk, raw and in brotli. */
export function localeSizes(client = CLIENT) {
  const sizes = {};
  for (const file of readdirSync(join(client, 'assets'))) {
    const language = /^copy\.([a-z]{2,3})-[\w-]+\.js$/.exec(file)?.[1];
    if (!language) continue;
    const bytes = readFileSync(join(client, 'assets', file));
    sizes[language] = { raw: bytes.length, br: brotliCompressSync(bytes).length };
  }
  return sizes;
}

/** The first page, and the chunks past it that it loads at once. */
export const SURFACES = { workbench: { page: 'index.workbench.html', chunks: [] } };

/**
 * A first visit's files: the page's entry, the chunks it preloads and any named here, what they import statically, and
 * the page's stylesheets.
 * @param {keyof typeof SURFACES} surface
 */
export function firstPaint(surface = 'workbench', client = CLIENT) {
  const { page, chunks } = SURFACES[surface];
  const html = readFileSync(join(client, page), 'utf8');
  const local = (path) => join(client, path.replace(/^\//, ''));
  const scripts = new Set();
  const pending = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => local(match[1]));
  pending.push(...[...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((match) => local(match[1])));
  const assets = readdirSync(join(client, 'assets'));
  for (const name of chunks) {
    const file = assets.find((file) => new RegExp(`^${name}-[\\w-]{8}\\.js$`).test(file));
    if (!file) throw new Error(`The build has no ${name} chunk.`);
    pending.push(join(client, 'assets', file));
  }
  while (pending.length) {
    const file = pending.pop();
    if (scripts.has(file)) continue;
    scripts.add(file);
    /* Static imports only, as the minifier writes them (`from"./x.js"`, `import"./x.js"`); `import("./x.js")` is a part
       loaded on demand. */
    for (const [, path] of readFileSync(file, 'utf8').matchAll(/(?:\bfrom|\bimport)\s*"(\.\/[^"]+\.js)"/g)) {
      pending.push(join(dirname(file), path));
    }
  }
  const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => local(match[1]));
  const measure = (files) =>
    files.reduce(
      (sum, file) => ({
        raw: sum.raw + statSync(file).size,
        br: sum.br + (existsSync(`${file}.br`) ? statSync(`${file}.br`) : statSync(file)).size,
      }),
      { raw: 0, br: 0 },
    );
  return { scripts: [...scripts], styles, script: measure([...scripts]), style: measure(styles) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(join(CLIENT, 'index.html'))) {
    console.error('Build the client first: npm run build.');
    process.exit(1);
  }
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
  const over = [];
  for (const surface of /** @type {Array<keyof typeof SURFACES>} */ (Object.keys(SURFACES))) {
    const shipped = firstPaint(surface);
    for (const kind of ['script', 'style']) {
      for (const measure of ['raw', 'br']) {
        const size = shipped[kind][measure],
          ceiling = BUDGET[surface][kind][measure];
        console.log(`${surface} ${kind} ${measure}: ${kb(size)} of ${kb(ceiling)}`);
        if (size > ceiling)
          over.push(
            `the ${surface} first paint's ${kind} is ${kb(size)} ${measure === 'br' ? 'in brotli' : 'raw'}, over its ${kb(ceiling)} ceiling`,
          );
      }
    }
  }
  for (const [language, sizes] of Object.entries(localeSizes())) {
    for (const measure of /** @type {const} */ (['raw', 'br'])) {
      console.log(`words ${language} ${measure}: ${kb(sizes[measure])} of ${kb(LOCALE_BUDGET[measure])}`);
      if (sizes[measure] > LOCALE_BUDGET[measure])
        over.push(
          `the ${language} words are ${kb(sizes[measure])} ${measure === 'br' ? 'in brotli' : 'raw'}, over their ${kb(LOCALE_BUDGET[measure])} ceiling`,
        );
    }
  }
  if (over.length && !process.argv.includes('--print')) {
    console.error(
      `Bundle budget: ${over.join('; ')}. Move the new weight behind components/onDemand.tsx, or raise the ceiling in scripts/bundle-budget.mjs and say why.`,
    );
    process.exitCode = 1;
  }
}
