/**
 * The browser suite, run as the two lanes `scripts/e2e-lanes.mjs` derives.
 *
 * Playwright has no per-project worker count, so the two lanes cannot be one invocation. They are two, behind this
 * script, which is what `npm run e2e` runs. `shared` runs one spec at a time: those specs address the server
 * `playwright.config.ts` starts, and one tablewalk process has one active connection. `owned` runs several at once —
 * each of its specs starts its own server on a `listen(0)` port over a `mkdtemp` database and shares nothing.
 *
 * The browser runs against the BUILT client: `npm run e2e` builds it once (`vite build`, a few seconds; skipped when
 * dist/client is newer than everything it is made from) and the servers are started with `MISTRI_BUILT_CLIENT=1`, which
 * sends dist/client the way the package does, instead of each server mounting its own Vite. A spec that needs the source —
 * it imports a client module by its source name, or rewrites one on its way to the page — says `e2e-client: source` in
 * its own text and runs in its lane's second pass, unbuilt. `npm run smoke` and a bare `npx playwright test` are unbuilt
 * too: the smoke run exists to catch an unbuilt client that throws.
 *
 *   npm run e2e                          the whole suite, both lanes
 *   npm run e2e -- --lanes               print the partition, run nothing
 *   npm run e2e -- e2e/grid.spec.ts      a filter, applied to both lanes
 *   npm run e2e -- --no-build            use the dist/client that is there
 *   TABLEWALK_E2E_WORKERS=2 …            override the owned lane's width
 *
 * Every pass runs even if an earlier one fails: a red shared lane should not hide what the owned lane would have said. The
 * exit code is the first failure's.
 */
import { spawnSync } from 'node:child_process';
import { globSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanes, sourceClientSpecs } from './e2e-lanes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* Three: the widest that ran clean on an eight-core, 16 GB machine. An owned worker is a browser and a tsx server. A fixed
   number keeps the gate the same shape everywhere (CI's two-core runners set it themselves). */
const width = Number(process.env.TABLEWALK_E2E_WORKERS) || 3;

const argv = process.argv.slice(2);
const { owned, shared } = lanes();

if (argv.includes('--lanes')) {
  console.log(`shared (${shared.length} specs, 1 worker):`);
  for (const file of shared) console.log(`  ${file}`);
  console.log(`owned (${owned.length} specs, ${width} workers):`);
  for (const file of owned) console.log(`  ${file}`);
  process.exit(0);
}

const noBuild = argv.includes('--no-build');
const rest = argv.filter((arg) => arg !== '--no-build');

/** The newest modification time under these paths (files, or directories walked). */
function newest(paths) {
  let latest = 0;
  for (const path of paths) {
    const stat = statSync(join(ROOT, path));
    if (!stat.isDirectory()) {
      latest = Math.max(latest, stat.mtimeMs);
      continue;
    }
    for (const file of globSync('**/*', { cwd: join(ROOT, path) })) {
      try {
        const at = statSync(join(ROOT, path, file));
        if (at.isFile()) latest = Math.max(latest, at.mtimeMs);
      } catch {
        /* removed while walking */
      }
    }
  }
  return latest;
}

/** `vite build`, unless dist/client is newer than everything the client is made from. Any file newer than the build — an
 * edit, a checkout, a new install — rebuilds; the cost of a wrong guess is a few seconds, never a stale page. */
function buildClient() {
  let stamp = 0;
  try {
    stamp = statSync(join(ROOT, 'dist/client/index.html')).mtimeMs;
  } catch {
    /* never built */
  }
  if (stamp && stamp > newest(['src/client', 'src/shared', 'vite.config.ts', 'package.json', 'package-lock.json'])) {
    console.log('# client: dist/client is current');
    return;
  }
  console.log('# client: vite build');
  const result = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('# client: the build failed');
    process.exit(result.status ?? 1);
  }
}

/** One lane. `TABLEWALK_E2E_LANE` is how the config knows whether to start the shared server; the `owned` lane runs
 * without it on purpose. */
function run(project, workers, files, source) {
  const flags = rest.filter((arg) => arg.startsWith('-')),
    filters = rest.filter((arg) => !arg.startsWith('-'));
  const declared = new Set(sourceClientSpecs(files));
  const mine = files.filter(
    (file) => declared.has(file) === source && (!filters.length || filters.some((filter) => file.includes(filter))),
  );
  const label = `${project} lane${source ? ' (source client)' : ''}`;
  if (!mine.length) {
    console.log(`\n# ${label}: nothing to run`);
    return 0;
  }
  console.log(`\n# ${label}: ${workers} worker${workers === 1 ? '' : 's'}, ${mine.length} specs`);
  /* Each pass writes its failures under its own folder: Playwright empties its output folder when a run starts. */
  const output = flags.some((arg) => arg.startsWith('--output'))
    ? []
    : [`--output=${join('e2e', '.results', `${project}${source ? '-source' : ''}`)}`];
  const result = spawnSync(
    'npx',
    ['playwright', 'test', `--project=${project}`, `--workers=${workers}`, ...output, '--pass-with-no-tests', ...flags, ...mine],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, TABLEWALK_E2E_LANE: project, ...(source ? {} : { MISTRI_BUILT_CLIENT: '1' }) },
    },
  );
  if (result.error) {
    console.error(`# ${project} lane: ${result.error.message}`);
    return 1;
  }
  /* A signal is not a status. A lane the OOM killer took reports `null`, and `?? 0` would have called that green. */
  return result.signal ? 1 : (result.status ?? 1);
}

if (!owned.length || !shared.length) {
  console.error(`A lane is empty (owned ${owned.length}, shared ${shared.length}); scripts/e2e-lanes.mjs is wrong.`);
  process.exit(2);
}
if (!noBuild) buildClient();
const results = [
  run('shared', 1, shared, false),
  run('shared', 1, shared, true),
  run('owned', width, owned, false),
  run('owned', width, owned, true),
];
process.exit(results.find((code) => code) ?? 0);
