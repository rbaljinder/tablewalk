/**
 * `tablewalk journal`: makes the store a writable connection's Undo history is kept in, so that Undo and `revert` still
 * reach the writes made before a restart (the last 50 per connection, for 7 days).
 *
 * It is a step of its own because the engine creates nothing when a connection opens: the store is two reserved tables
 * in the business database, and a person decides to have them. Without them the journal is the process's alone, as
 * before. Only a connection a config marks `"writable": true` keeps a journal, so only one is provisioned; a database
 * named on the command line is read-only and is refused, as `tablewalk seed` refuses it.
 */
import { browserSections } from './browserCommands.js';

const USAGE = 'tablewalk journal [<db> | --db <target> | --config <path>] [--connection <name>]';
/** The exit codes: 1 could not run, 2 refused (read-only, or not a database this can keep a journal in). */
const EXIT = { ok: 0, couldNot: 1, refused: 2 };
/* The start's own flags this command takes, and whether each has a value (the same ones `tablewalk seed` takes). */
const PASSED: Record<string, boolean> = { '--db': true, '-d': true, '--config': true, '--no-config': false };

export async function runJournal(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const fail = (why: string, code = EXIT.couldNot) => {
    console.error(`tablewalk journal: ${why}`);
    return code;
  };
  if (argv[0] === '--help' || argv[0] === '-h') {
    write(
      `${USAGE}\n\n` +
        "Makes the store that keeps a writable connection's Undo history, so Undo reaches the writes made before a restart:\n" +
        'the last 50 per connection, for 7 days. Two reserved tables in that database; the same command again changes nothing.\n' +
        'Without them, Undo history lasts as long as the process. Only a connection whose config says "writable": true has one.',
    );
    return EXIT.ok;
  }
  let connection: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flag = arg.split('=')[0]!;
    if (flag === '--connection') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (value === undefined || value.startsWith('-')) return fail(`--connection needs a value. ${USAGE}`);
      connection = value;
    } else if (flag in PASSED) {
      rest.push(arg);
      if (PASSED[flag] && !arg.includes('=')) {
        const value = argv[++i];
        if (value === undefined || value.startsWith('-')) return fail(`${arg} needs a value. ${USAGE}`);
        rest.push(value);
      }
    } else if (arg.startsWith('-')) {
      return fail(`"${arg}" is not an option of journal. ${USAGE}`);
    } else rest.push(arg);
  }

  const [{ parseArgs }, { readStartupConfig }, { targetConnection }, host] = await Promise.all([
    import('@mistriwork/engine/server/cli/args.js'),
    import('@mistriwork/engine/server/cli/config.js'),
    import('@mistriwork/engine/server/migrate/target.js'),
    import('@mistriwork/engine/host'),
  ]);
  const opts = parseArgs(rest);
  if (opts.unknown) return fail(`unknown option "${opts.unknown}". ${USAGE}`);
  const registry = new host.Registry();
  // The config's own announcements ("2 connection(s) from …") are not this command's answer.
  const log = console.log;
  console.log = () => {};
  try {
    await readStartupConfig(opts, registry, browserSections);
    const argument = opts.target
      ? registry.add({ name: host.redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' }).id
      : undefined;
    const target = targetConnection(registry, { connection, argument }, undefined, 'journal');
    if (target.http) return fail(`"${target.name}" is an HTTP API; it keeps no journal.`, EXIT.refused);
    if (target.writable !== true)
      return fail(
        `"${target.name}" is read-only, and only a writable connection keeps an Undo journal. Give the connection "writable": true in its config — ` +
          'a database named on the command line is always read-only.',
        EXIT.refused,
      );
    const url = target.url;
    const done = /^postgres(ql)?:\/\//i.test(url)
      ? await host.provisionPostgresWriteJournal(url)
      : host.provisionSqliteWriteJournal(await sqliteFile(url));
    write(
      done.provisioned
        ? `${target.name}: Undo journal made. A restart now keeps its last 50 writes, for 7 days.`
        : `${target.name}: Undo journal already in place.`,
    );
    return EXIT.ok;
  } catch (error) {
    return fail((error as Error).message);
  } finally {
    console.log = log;
    await registry.closeAll();
  }
}

/** A SQLite connection's file: `sqlite:<path>` and a bare path name the same one. */
async function sqliteFile(url: string): Promise<string> {
  const { resolve } = await import('node:path');
  return resolve(url.replace(/^sqlite:(\/\/)?/i, ''));
}
