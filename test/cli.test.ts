/**
 * The command line, run as a command.
 *
 * Every other suite imports a function. That leaves the one property a CLI
 * has to get right — that it *stops* — asserted nowhere, and it is exactly
 * what broke: `--help` and `--version` were never handled at all. They were
 * ignored, fell through to the "nothing to open" gate, and that gate printed
 * the usage and exited 1. The right text, the wrong exit code, and only by
 * accident.
 *
 * When the server learned to start with no connection, the accident became
 * `tablewalk --help` listening on port 4111 and waiting for a browser. No
 * unit test could have caught it, because the failure is a process that does
 * not exit.
 *
 * So these spawn the real thing. Every case has a timeout: a regression here
 * is a hang, and a suite that hangs is worse than one that fails.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { makeDemoDatabase } from './make-demo-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'src/server/index.ts');

interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI and wait for it to finish. Never longer than the timeout. */
function run(args: string[], timeout = 20_000): Promise<Ran> {
  return new Promise((resolve, reject) => {
    execFile('npx', ['tsx', ENTRY, ...args], { cwd: ROOT, timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      /* A timeout means it did not exit, which is the failure this file
           exists for — reported as itself rather than as an empty stdout. */
      if (err && (err as { killed?: boolean }).killed) {
        reject(new Error(`\`tablewalk ${args.join(' ')}\` did not exit within ${timeout}ms`));
        return;
      }
      resolve({
        code: (err as { code?: number } | null)?.code ?? 0,
        out: stdout,
        err: stderr,
      });
    });
  });
}

describe('the command line', () => {
  test('--help prints the usage and succeeds', async () => {
    const { code, out } = await run(['--help']);
    /* Zero. Help was asked for and given; that is not an error, and a CI step
       or a shell completion that checks the exit code should not be told it
       was. */
    assert.equal(code, 0);
    assert.match(out, /browse a relational database as a graph you walk/);
    assert.match(out, /--mcp/);
  });

  test('-h is the same', async () => {
    const { code, out } = await run(['-h']);
    assert.equal(code, 0);
    assert.match(out, /browse a relational database/);
  });

  test('--version prints a version and succeeds', async () => {
    const { code, out } = await run(['--version']);
    assert.equal(code, 0);
    assert.match(out.trim(), /^\d+\.\d+\.\d+/);
  });

  test('an unknown option is named, and refused', async () => {
    /* Ignored, once. Survivable only because the gate below it printed the
       usage — so a typo looked like it had been told something. With a server
       that starts on nothing, the same typo silently starts one on the
       default port and waits. */
    const { code, err } = await run(['--prot', '9999']);
    assert.equal(code, 1);
    assert.match(err, /unknown option "--prot"\. Did you mean --port\? tablewalk --help lists the options\./);
    // The one line that says what was wrong is not buried under seven hundred of usage (UX-17).
    assert.doesNotMatch(err, /browse a relational database/);
  });

  test("a near miss of the browser's own command is answered with its own", async () => {
    for (const [said, meant] of [
      ['migrat', 'migrate'],
      ['seeed', 'seed'],
    ]) {
      const { code, err } = await run([said, '--no-config']);
      assert.equal(code, 1);
      assert.match(err, new RegExp(`Did you mean tablewalk ${meant}\\?`));
      assert.doesNotMatch(err, /mistri/);
    }
  });

  test("a near miss of the App framework's command is still mistri's", async () => {
    const { code, err } = await run(['chek', '--no-config']);
    assert.equal(code, 1);
    assert.match(err, /Did you mean npx @mistriwork\/mistri check\?/);
  });

  test('--help fits one screen, and --help all is the whole usage (UX-17)', async () => {
    const short = await run(['--help']);
    assert.equal(short.code, 0);
    assert.ok(short.out.trim().split('\n').length <= 40, `--help is ${short.out.trim().split('\n').length} lines`);
    assert.match(short.out, /tablewalk --help all/);
    const all = await run(['--help', 'all']);
    assert.equal(all.code, 0);
    assert.match(all.out, /Changing the schema/);
    assert.ok(all.out.split('\n').length > short.out.split('\n').length * 5);
  });

  test('a mode that needs a database still refuses without one', async () => {
    /* The other half of the same decision: `--export` has nothing to print
       with no database, so it stops where it always did. */
    const { code, err } = await run(['--no-config', '--export', 'md']);
    assert.equal(code, 1);
    assert.match(err, /Looked for a config file in/);
  });

  test('--demo builds a sample database on the fly', async () => {
    /* `--demo` writes a throwaway database and, in a print-and-exit mode like
       --export, that is all it needs to do before printing its schema. It is
       the flag that gives a fresh install something to walk without a database
       of its own, so it must actually produce one. */
    const { code, out } = await run(['--demo', '--export', 'md', '--no-config']);
    assert.equal(code, 0);
    // The demo's shape: the tables the walk is built around.
    assert.match(out, /customer/);
    assert.match(out, /invoice/);
    assert.match(out, /work_order/);
  });

  test('--export prints the schema and exits', async () => {
    /* Its own database, built in a temp dir. This used to read `.demo/demo.db`,
       which exists on a machine where `npm run demo` has been run and does not
       exist in CI — the demo database is generated, not committed. The test
       passed locally and failed the moment it ran anywhere clean. */
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-cli-'));
    const db = join(dir, 'demo.db');
    makeDemoDatabase(db);
    try {
      const { code, out } = await run([db, '--export', 'md', '--no-config']);
      assert.equal(code, 0);
      /* Stdout carries the document and nothing else — `--export md >> CLAUDE.md`
       must append a brief, not a brief with a startup banner on it. */
      assert.match(out, /^#/m);
      assert.doesNotMatch(out, /Listening on/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migrate writes, so it asks for "writable": true', () => {
  /* One config, two connections over two files: the only difference between them is the flag. */
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-cli-migrate-'));
  const migrations = join(dir, 'migrations');
  const config = join(dir, 'tablewalk.json');
  /* Empty, so `up` has a clean start rather than a database it asks to be baselined first. */
  for (const file of ['ro.db', 'rw.db']) new DatabaseSync(join(dir, file)).close();
  mkdirSync(migrations);
  writeFileSync(join(migrations, 'V1__note.sql'), 'CREATE TABLE migrated_note (id INTEGER PRIMARY KEY);\n');
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { name: 'ro', url: join(dir, 'ro.db') },
        { name: 'rw', url: join(dir, 'rw.db'), writable: true },
      ],
    }),
  );
  const migrate = (sub: string, ...rest: string[]) => run(['migrate', sub, '--config', config, '--migrations', migrations, ...rest]);
  const tablesIn = (file: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare(`SELECT name FROM sqlite_master WHERE name = 'migrated_note'`).all() as unknown[]).length;
    } finally {
      db.close();
    }
  };

  for (const sub of ['up', 'baseline', 'repair']) {
    test(`${sub} on a read-only connection is refused, naming the flag, and nothing changes`, async () => {
      const { code, err } = await migrate(sub, '--connection', 'ro');
      assert.equal(code, 1);
      assert.match(err, /"ro" is read-only/);
      assert.match(err, /"writable": true/);
      assert.equal(tablesIn(join(dir, 'ro.db')), 0);
    });
  }

  test('a database named on the command line is always read-only', async () => {
    const { code, err } = await run(['migrate', 'up', join(dir, 'ro.db'), '--no-config', '--migrations', migrations]);
    assert.equal(code, 1);
    assert.match(err, /is read-only/);
    assert.equal(tablesIn(join(dir, 'ro.db')), 0);
  });

  test('status stays allowed on a read-only connection', async () => {
    /* Its exit code says there is a migration pending (for CI), which is not the refusal under test. */
    const { out, err } = await migrate('status', '--connection', 'ro');
    assert.doesNotMatch(err, /is read-only/);
    assert.match(out, /V1|pending/i);
  });

  test('up on a writable connection runs', async () => {
    const { code, err } = await migrate('up', '--connection', 'rw');
    assert.equal(code, 0, err);
    assert.equal(tablesIn(join(dir, 'rw.db')), 1);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));
});

describe("a connection under the row-security backstop is not the browser's to open", () => {
  /* Its url signs in as a tenant App's restricted role, which sees no tenant row without a tenant set: the browser
     would show every table empty. Nothing listens on these URLs; the refusal comes before anything connects. */
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-cli-backstop-'));
  const config = join(dir, 'tablewalk.json');
  new DatabaseSync(join(dir, 'plain.db')).close();
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { name: 'plain', url: join(dir, 'plain.db') },
        { name: 'fenced', url: 'postgres://app@127.0.0.1:1/shop', owner: 'postgres://owner@127.0.0.1:1/shop', backstop: 'rls' },
      ],
    }),
  );

  for (const mode of [[], ['--mcp']]) {
    test(`a start${mode.length ? ` with ${mode[0]}` : ''} is refused, naming the connection`, async () => {
      const { code, err } = await run(['--config', config, '--port', '0', ...mode]);
      assert.equal(code, 2, err);
      assert.match(err, /connection "fenced" is under the row-security backstop/);
      assert.match(err, /owner's URL/);
    });
  }

  after(() => rmSync(dir, { recursive: true, force: true }));
});
