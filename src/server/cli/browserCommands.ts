/**
 * The database browser's commands, and the sections of a config file it reads.
 *
 * `migrate` and `seed` are the engine's, run here with no App: `--app` is refused with the `npx @mistriwork/mistri` command
 * that takes it, and `migrate stores` and `migrate files` are not offered. The App framework's own `migrate` and
 * `seed` are these with an App's part handed in (in the mistri package). `journal` is this
 * binary's own: the one store the browser keeps, which `migrate stores` would have made.
 */
import type { ConfigSections } from '@mistriwork/engine/server/configSections.js';
import type { Subcommands } from '@mistriwork/engine/server/cli/subcommand.js';

/**
 * The engine's sections, with every other kind kept unread: a config file names the App framework's services
 * beside the databases (an email service, an identity provider), and the browser, serving none of them, keeps
 * them as written so that a save from its connection manager does not delete them. A maker, so that a start which
 * reads no config file never loads them.
 */
export const browserSections = async (): Promise<ConfigSections> => ({
  ...(await import('@mistriwork/engine/server/cacheService.js')).CACHE_SECTIONS,
  others: 'keep',
});

export const BROWSER_COMMANDS: Subcommands = {
  /* Schema changes, as versioned SQL files. */
  migrate: {
    run: async (argv) => {
      /* up, baseline and repair write DDL: refused unless the connection is writable, as seed is (migrateGuard.ts). */
      const refusal = await (await import('./migrateGuard.js')).migrateWriteRefusal(argv);
      if (refusal) {
        console.error(`tablewalk migrate: ${refusal}`);
        return 1;
      }
      return (await import('@mistriwork/engine/server/migrate/cli.js')).runMigrate(argv, undefined, await browserSections());
    },
  },
  /* Rows to look at in a writable database. */
  seed: { run: async (argv) => (await import('@mistriwork/engine/server/seed/cli.js')).runSeed(argv, undefined, await browserSections()) },
  /* The store a writable connection's Undo history is kept in, so a restart does not forget it. */
  journal: { run: async (argv) => (await import('./journalCommand.js')).runJournal(argv) },
};
