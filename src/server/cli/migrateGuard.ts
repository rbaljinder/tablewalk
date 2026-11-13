/**
 * `tablewalk migrate up | baseline | repair` write DDL, so they ask what `tablewalk seed` asks: that the connection
 * says `"writable": true`. The engine's `migrate` reads the connection it runs against and does not look at the flag;
 * the guard is here so the browser stands on its own whether or not the engine one day does.
 *
 * It reads the connection the way the command does (the same flags, the same config, the same one-connection rule),
 * and answers nothing for anything it cannot read: a bad flag, no database, an unknown name. Those are the engine's to
 * say, in its words, and the command refuses them before it opens a thing.
 */
import { parseArgs } from '@mistriwork/engine/server/cli/args.js';
import { readStartupConfig } from '@mistriwork/engine/server/cli/config.js';
import { Registry, redact } from '@mistriwork/engine/server/connections.js';
import { targetConnection } from '@mistriwork/engine/server/migrate/target.js';
import { browserSections } from './browserCommands.js';

/** The subcommands that change a database. status, validate, diff, check, squash and new only read, or write a file. */
const WRITING = new Set(['up', 'baseline', 'repair']);

/** Migrate's own flags, and whether each takes a value: the start's parser would take them for mistakes. */
const MIGRATE_FLAGS: Record<string, boolean> = {
  '--app': true,
  '--migrations': true,
  '--history-table': true,
  '--connection': true,
  '--tool': true,
  '--schema-file': true,
  '--dev-url': true,
  '--dry-run': false,
  '--repeatable': false,
  '--json': false,
};

/** Why `migrate <argv>` may not run, or null when it may (or is not this guard's to judge). */
export async function migrateWriteRefusal(argv: readonly string[]): Promise<string | null> {
  if (!WRITING.has(argv[0] ?? '')) return null;
  /* A dry run prints the SQL and changes nothing. */
  if (argv.includes('--dry-run')) return null;
  let connection: string | undefined;
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const flag = arg.split('=')[0];
    if (flag in MIGRATE_FLAGS) {
      const takes = MIGRATE_FLAGS[flag];
      let value: string | undefined;
      if (takes && arg.includes('=')) value = arg.slice(arg.indexOf('=') + 1);
      else if (takes) value = argv[++i];
      if (flag === '--connection') connection = value;
      continue;
    }
    rest.push(arg);
  }
  const registry = new Registry();
  const log = console.log;
  console.log = () => {};
  try {
    const opts = parseArgs(rest);
    if (opts.unknown) return null;
    await readStartupConfig(opts, registry, await browserSections());
    const argument = opts.target
      ? registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' }).id
      : undefined;
    const target = targetConnection(registry, { connection, argument });
    if (target.http || target.writable === true) return null;
    return (
      `"${target.name}" is read-only, and migrate ${argv[0]} writes to the database. Give the connection "writable": true in tablewalk.json — ` +
      'a database named on the command line is always read-only.'
    );
  } catch {
    return null;
  } finally {
    console.log = log;
    await registry.closeAll().catch(() => {});
  }
}
