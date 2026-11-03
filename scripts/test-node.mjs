/**
 * The Node suite (`npm test`): every test/**\/*.test.ts under node:test, in two lanes.
 *
 * `parallel` is every file that owns whatever database it touches; `serial` is the files that still work in the one
 * database `TABLEWALK_TEST_PG` names (the live-engine blocks). The lane is read off the source — a file that names the
 * variable, directly or through a fixture it imports, and does not open a database of its own, runs serially by default —
 * so a new file reaching a shared engine is serial until it says otherwise, and the failure mode of the rule is slowness,
 * not a race. A file can ask for the serial lane with a `test-lane: serial` comment.
 *
 * Every case runs with a scratch TMPDIR and a config home of its own: none reaches the developer's ~/.config/tablewalk, its
 * auth stores or its saved credentials. What a lane leaves in the scratch directory (a folder, a server a case never
 * stopped) is reported, and fails the run.
 *
 *   node scripts/test-node.mjs                         both lanes
 *   node scripts/test-node.mjs test/sql.test.ts        named files (a serial file named here still runs serially)
 *   node scripts/test-node.mjs --lanes                 print the partition
 *   TABLEWALK_TEST_CONCURRENCY=4 …                     the parallel lane's width
 *
 * Any other flag goes to `node --test` (`--test-name-pattern`, `--test-only`).
 */
import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism, tmpdir } from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* The live engines a file may name. Read from the source, never inferred from `process.env`, so the partition does not
   change with the environment. */
const SHARED_ENGINES = ['TABLEWALK_TEST_PG', 'TABLEWALK_TEST_MYSQL'];
/* Helpers that give a file a database of its own: a file that reaches one is not sharing, whatever it says about the
   variable. */
const OWNED_DATABASE = ['uuidPostgresDatabase', 'dedicatedPostgresUrl', 'ownedPostgresDatabase'];
const DECLARED_SERIAL = 'test-lane: serial';

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** A file's code, plus the code of every module it imports from test/ (a helper is where the database usually is). */
function reach(file, seen = new Set()) {
  const absolute = resolve(ROOT, file);
  if (seen.has(absolute)) return '';
  seen.add(absolute);
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    return '';
  }
  let all = code(text);
  for (const [, specifier] of text.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = join(dirname(absolute), specifier).replace(/\.js$/, '.ts');
    if (!relative(join(ROOT, 'test'), target).startsWith('..')) all += reach(target, seen);
  }
  return all;
}

export function lanes() {
  const files = globSync('test/**/*.test.ts', { cwd: ROOT })
    .map((file) => file.split('\\').join('/'))
    .sort();
  const serial = [],
    parallel = [];
  for (const file of files) {
    const text = reach(file);
    const shares = SHARED_ENGINES.some((name) => text.includes(name)) && !OWNED_DATABASE.some((name) => text.includes(name));
    (shares || readFileSync(resolve(ROOT, file), 'utf8').includes(DECLARED_SERIAL) ? serial : parallel).push(file);
  }
  return { serial, parallel };
}

/** The tool caches Node and tsx keep under the temp directory: caches, not leaks. */
const TOOL_CACHES = [/^node-compile-cache$/, /^tsx-\d+$/];

/** What a lane left in its scratch directory, reported once; the directory is removed. */
export function leaks(scratch, label) {
  const found = [];
  /* A server a case never stopped holds the directory it was given. */
  const ps = spawnSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' });
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === process.pid || !match[2].includes(scratch)) continue;
    found.push(`process ${match[1]}: ${match[2].slice(0, 160)}`);
    try {
      process.kill(Number(match[1]), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  let entries = [];
  try {
    entries = readdirSync(scratch);
  } catch {
    /* none */
  }
  /* Grouped by the prefix a case gave its directory (`mkdtemp` adds six characters), so the report names the file. */
  const byPrefix = new Map();
  for (const name of entries) {
    if (TOOL_CACHES.some((cache) => cache.test(name))) continue;
    const prefix = name.replace(/[A-Za-z0-9]{6}$/, '');
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, count] of byPrefix) found.push(`${count} × ${prefix}…`);
  rmSync(scratch, { recursive: true, force: true });
  if (!found.length) return false;
  console.error(`# ${label}: left behind after the lane (a scratch directory or a server a case never stopped):`);
  for (const line of found) console.error(`#   ${line}`);
  return true;
}

/* Imported by nothing else, but the module must be importable for `lanes()` without starting a suite. */
if (process.argv[1] === fileURLToPath(import.meta.url)) main();

function main() {
  const argv = process.argv.slice(2);
  const named = argv.filter((arg) => !arg.startsWith('-') && arg.endsWith('.test.ts'));
  const rest = argv.filter((arg) => arg !== '--lanes' && !named.includes(arg));
  const partition = lanes();
  const wanted = new Set(named.map((file) => relative(ROOT, resolve(file)).split('\\').join('/')));
  const unknown = [...wanted].filter((file) => !partition.serial.includes(file) && !partition.parallel.includes(file));
  if (unknown.length) {
    console.error(`Not a test file of the suite: ${unknown.join(', ')}`);
    process.exit(2);
  }
  const only = (files) => (wanted.size ? files.filter((file) => wanted.has(file)) : files);
  const serial = only(partition.serial),
    parallel = only(partition.parallel);
  const width = Number(process.env.TABLEWALK_TEST_CONCURRENCY) || Math.max(2, availableParallelism() - 1);

  if (argv.includes('--lanes')) {
    console.log(`parallel (${parallel.length} files, concurrency ${width}):`);
    for (const file of parallel) console.log(`  ${file}`);
    console.log(`serial (${serial.length} files):`);
    for (const file of serial) console.log(`  ${file}`);
    process.exit(0);
  }

  const run = (files, concurrency, label) => {
    if (!files.length) {
      console.log(`# ${label}: nothing to run`);
      return 0;
    }
    console.log(`# ${label}: ${files.length} files, concurrency ${concurrency}`);
    const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-lane-'));
    /* Outside the scratch directory, so the leak check does not read it as left behind. */
    const configHome = mkdtempSync(join(tmpdir(), 'tablewalk-lane-config-'));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--test', '--test-timeout=120000', `--test-concurrency=${concurrency}`, ...rest, ...files],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CONFIG_HOME: configHome },
      },
    );
    rmSync(configHome, { recursive: true, force: true });
    const leaked = leaks(scratch, label);
    if (result.error) {
      console.error(`# ${label}: ${result.error.message}`);
      return 1;
    }
    /* A signal is not a status: a lane the OOM killer took reports `null`, and `?? 0` would have called that green. */
    const status = result.signal ? 1 : (result.status ?? 1);
    return status || (leaked && process.env.TABLEWALK_TEST_LEAKS !== 'report' ? 1 : 0);
  };

  /* The serial lane goes first, as it is the one that shares a live database; a red lane does not hide the other. */
  const results = [run(serial, 1, 'serial lane'), run(parallel, width, 'parallel lane')];
  process.exit(results.find((code) => code) ?? 0);
}
