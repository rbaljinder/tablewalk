/**
 * The database browser's main: `tablewalk <db>`, `--mcp`, `--lint`, `--diff`, the schema in words, and its own
 * `migrate` and `seed`. The `tablewalk` binary runs it (index.ts), and nothing else.
 *
 * Whatever is the App framework's — a command of its own, a flag that names an App or serves its API, a config file
 * that lists Apps — is refused before anything is read, with the `npx @mistriwork/mistri` command that runs it. There is no
 * handing over: the App framework is a binary of its own, which this package neither imports nor installs, and a
 * start that quietly ran the other product would be a second way to start it (no compatibility is kept before 1.0).
 *
 * Each mode is imported where the main reaches it. A static import of every mode once made `--help` load the whole
 * server, and `--mcp`, which an agent's client spawns every session, the HTTP server it never uses.
 * test/cli-startup.test.ts counts what each start loads.
 */
import { BROWSER_COMMANDS, browserSections } from './browserCommands.js';
import { APP_COMMAND_WORDS, BROWSER } from './usage.js';
import type { Main } from '@mistriwork/engine/server/cli/startup.js';
import { runSubcommand, subcommandIn } from '@mistriwork/engine/server/cli/subcommand.js';
import { setProduct } from '@mistriwork/engine/server/product.js';
import { browserVersion } from './version.js';

/** The command line as it was typed, for the `npx @mistriwork/mistri …` that runs it: each word quoted only where a shell needs it. */
const typed = (argv: readonly string[]) =>
  argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(' ');

/** Refuses a start that is the App framework's, naming the command that runs it. Exit 2, as a usage error. */
function refuseApp(what: string, argv: readonly string[]): void {
  console.error(
    `tablewalk: ${what} is the App framework's, a command of its own: npx @mistriwork/mistri ${typed(argv)}\n` +
      'tablewalk is the database browser; it serves no App.',
  );
  process.exitCode = 2;
}

/** The flag that makes a start the App framework's (engine cli/startup.ts `startFor`), as it is typed. */
function appFlagIn(opts: import('@mistriwork/engine/server/cli/args.js').Options): string {
  const flags: Array<[unknown, string]> = [
    [opts.apps?.length, '--app'],
    [opts.appEntry !== undefined, '--app-entry'],
    [opts.commands !== undefined, '--commands'],
    [opts.jobs !== undefined, '--jobs'],
    [opts.policy !== undefined, '--policy'],
    [opts.mounts !== undefined, '--mount'],
    [opts.appMcp, '--app-mcp'],
    [opts.apiReads, '--api-reads'],
    [opts.apiIntegers !== undefined, '--api-integers'],
    [opts.apiRequestsPerMinute !== undefined, '--api-requests-per-minute'],
    [opts.writeAuthority, '--write-authority'],
    [opts.bump, '--bump'],
    [opts.reindex !== undefined, '--reindex'],
    [opts.scaffoldApp !== undefined, '--scaffold-app'],
    [opts.dev, '--dev'],
    [opts.fromOpenapi !== undefined, '--from-openapi'],
    [opts.export !== undefined, `--export ${opts.export}`],
  ];
  return flags.find(([on]) => on)?.[1] ?? 'that start';
}

interface BrowserExtraArgs {
  rest: string[];
  connection?: string;
  env?: string;
  lease?: string;
  lazy?: boolean;
  query?: string;
  call?: string;
  args?: string;
  error?: string;
}

function extractBrowserExtraArgs(argv: readonly string[]): BrowserExtraArgs {
  const rest: string[] = [];
  const out: BrowserExtraArgs = { rest };
  const takeValue = (flag: string, next: string | undefined, idx: number): [string, number] | null => {
    if (next === undefined || (next.startsWith('-') && next !== '-')) {
      out.error ??= `${flag} requires a value.`;
      return null;
    }
    return [next, idx + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (arg === '--lazy') {
      out.lazy = true;
    } else if (arg === '--connection') {
      const got = takeValue(arg, argv[i + 1], i);
      if (got) [out.connection, i] = got;
    } else if (arg === '--env') {
      const got = takeValue(arg, argv[i + 1], i);
      if (got) [out.env, i] = got;
    } else if (arg === '--lease') {
      const got = takeValue(arg, argv[i + 1], i);
      if (got) [out.lease, i] = got;
    } else if (arg === '--query') {
      const got = takeValue(arg, argv[i + 1], i);
      if (got) [out.query, i] = got;
    } else if (arg === '--call') {
      const got = takeValue(arg, argv[i + 1], i);
      if (got) [out.call, i] = got;
    } else if (arg === '--args') {
      const got = takeValue(arg, argv[i + 1], i);
      if (got) [out.args, i] = got;
    } else {
      rest.push(arg);
    }
  }
  if (out.query !== undefined && out.call !== undefined) {
    out.error ??= 'Pass either --query or --call, not both.';
  }
  if (out.args !== undefined && out.call === undefined && out.query === undefined) {
    out.error ??= '--args goes with --call (or --query).';
  }
  return out;
}

export const main: Main = async () => {
  /* Before any flag is read: the variables both binaries read are said in this one's name (TABLEWALK_*). */
  setProduct('tablewalk', browserVersion());
  const rawArgv = process.argv.slice(2);
  const own = subcommandIn(BROWSER_COMMANDS, rawArgv);
  if (own) return runSubcommand(own, rawArgv.slice(1), 'tablewalk');
  /* A word that is the App framework's command (`tablewalk check`, `tablewalk dev`), unless a file of that name is
     here to open, as `./theme` without `show` always was. `serve` is no command of either: a start serves. */
  if (
    rawArgv[0] !== undefined &&
    [...APP_COMMAND_WORDS, 'serve'].includes(rawArgv[0]) &&
    !(await import('node:fs')).existsSync(rawArgv[0])
  ) {
    if (rawArgv[0] === 'serve') return refuseApp('serving an App', ['--app', '<dir>']);
    return refuseApp(`tablewalk ${rawArgv[0]}`, rawArgv);
  }

  const extra = extractBrowserExtraArgs(rawArgv);
  const argv = extra.rest;

  /* Past the commands, a start: the flag parser and what every start does are loaded now, and not for a command. */
  const [{ CHECK_VALIDATION, parseArgs }, { answeredFirst, configureProcess, startFor, SCHEMA_EXPORTS }] = await Promise.all([
    import('@mistriwork/engine/server/cli/args.js'),
    import('@mistriwork/engine/server/cli/startup.js'),
  ]);
  const opts = parseArgs(argv);
  if (process.env[CHECK_VALIDATION] === '1') return refuseApp('checking an App', ['check', ...rawArgv]);
  if (await answeredFirst(opts, BROWSER)) return;
  if (extra.error) {
    console.error(`tablewalk: ${extra.error}`);
    process.exitCode = 2;
    return;
  }
  /* --write-pool sizes an App's writer pool; the browser's writes run one at a time (configureWriteOrder below), so
     the engine's parser accepts it and nothing here would read it. */
  if (opts.writePool !== undefined) {
    console.error('tablewalk: --write-pool is an App option; the database browser writes one statement at a time.');
    process.exitCode = 2;
    return;
  }
  /* A format neither binary prints is a typo, said as one here, not sent to the App framework. */
  const format = opts.export?.toLowerCase();
  if (format !== undefined && !SCHEMA_EXPORTS.has(format) && !['brief', 'types', 'openapi', 'asyncapi'].includes(format)) {
    console.error(`tablewalk: --export takes md, mermaid or json — not "${opts.export}".`);
    process.exitCode = 1;
    return;
  }
  if (startFor(opts) === 'mistri') return refuseApp(appFlagIn(opts), rawArgv);
  /* A word one slip from an App command (`tablewalk chek`) and no file of that name: the near miss is mistri's. */
  if (opts.target && /^[a-z][a-z-]*$/.test(opts.target)) {
    const [{ existsSync }, { didYouMean }] = await Promise.all([import('node:fs'), import('@mistriwork/engine/server/cli/usage.js')]);
    /* The browser's own commands first, answered as this binary's; only then the App framework's, which are mistri's. */
    const own = existsSync(opts.target) ? '' : await didYouMean(opts.target, Object.keys(BROWSER_COMMANDS));
    const near = own || (existsSync(opts.target) ? '' : await didYouMean(opts.target, APP_COMMAND_WORDS));
    if (near) {
      const runner = own ? 'tablewalk ' : 'npx @mistriwork/mistri ';
      console.error(
        `tablewalk: "${opts.target}" is not a database here, and no file of that name is.${near.replace('Did you mean ', `Did you mean ${runner}`)}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const oneShotTool = extra.query !== undefined || Boolean(extra.call);
  /* Detect piped/FIFO/`TABLEWALK_CONFIG_JSON` config before `configNamesApps` touches `opts.config` (reading a FIFO
     twice would lose its contents). Avoids importing `vaultConfig.js` on ordinary starts. */
  const maybePiped =
    !opts.noConfig &&
    (opts.config === '-' ||
      opts.config === '/dev/stdin' ||
      Boolean(!opts.config && process.env.TABLEWALK_CONFIG_JSON?.trim()) ||
      Boolean(opts.config && /^\/(?:dev\/fd|proc\/self\/fd)\/\d+$/.test(opts.config)) ||
      (Boolean(opts.config) && Boolean((await import('node:fs')).statSync(opts.config!, { throwIfNoEntry: false })?.isFIFO())));

  /* A config file that lists Apps is the App framework's to serve, whatever the mode: a server serves them, and an
     App enrolled in a row policy is never read around. The file is read raw for that one question. */
  if (!maybePiped && (await (await import('@mistriwork/engine/server/cli/config.js')).configNamesApps(opts))) {
    return refuseApp('a config file that lists Apps', rawArgv);
  }
  configureProcess(opts, 'tablewalk');
  /* In MCP mode stdout is the protocol channel; in an export or one-shot query, the document — `--export md >> CLAUDE.md`
     must append a brief, not a brief with a startup banner stapled to its forehead. Every startup line goes to stderr,
     redirected here once rather than guarded at each call site. */
  const printing = opts.mcp || opts.export || opts.lint || opts.diff || oneShotTool;
  if (printing) console.log = (...args: unknown[]) => console.error(...args);
  if (opts.mcp && process.env.TABLEWALK_MCP_URL?.trim()) {
    const { bridgeMcpToHttp } = await import('./mcpMode.js');
    bridgeMcpToHttp(process.env.TABLEWALK_MCP_URL.trim());
    return;
  }

  const [{ Registry, redact }, { readStartupConfig }, { configLocations }, { configureWriteOrder }] = await Promise.all([
    import('@mistriwork/engine/host'),
    import('@mistriwork/engine/server/cli/config.js'),
    import('@mistriwork/engine/server/config/locations.js'),
    import('@mistriwork/engine/adapters/writeLanes.js'),
  ]);
  let registry = new Registry();
  let config: Awaited<ReturnType<typeof readStartupConfig>>;
  let mcpInputStream: NodeJS.ReadableStream | undefined;
  let startupMeta: { active?: string; only?: boolean; lazy?: boolean } = {};

  if (maybePiped) {
    const { loadPipedVaultConfig } = await import('./vaultConfig.js');
    try {
      const loaded = await loadPipedVaultConfig(opts.config, opts.mcp, extra.lease);
      if (loaded.namesApps) return refuseApp('a config file that lists Apps', rawArgv);
      registry = loaded.registry;
      mcpInputStream = loaded.remainingStdin;
      startupMeta = { active: loaded.active, only: loaded.only, lazy: loaded.lazy };
      if ((opts as { targetFromEnvironment?: boolean }).targetFromEnvironment && registry.list().length) {
        opts.target = '';
        (opts as { targetFromEnvironment?: boolean }).targetFromEnvironment = false;
      }
      config = {
        views: loaded.views,
        queries: loaded.queries,
        pages: loaded.pages,
        layouts: loaded.layouts,
        apps: [],
        appEnv: {},
      };
    } catch (err) {
      console.error(`tablewalk: ${(err as Error).message}`);
      await registry.closeAll().catch(() => {});
      process.exit(1);
    }
  } else {
    /* Config first, then the command line, so an explicitly named database is the one you land on even when a
       config file lists others. */
    config = await readStartupConfig(opts, registry, browserSections);
    if (config.loadedConfigText) {
      const { loadConfigEnvMeta } = await import('../mcp/toolkit.js');
      loadConfigEnvMeta(registry, config.loadedConfigText);
    }
    /* Checked inline here so plain `serve` and `--mcp` do not import `vaultConfig.js` + `blocklist.js`
       (test/cli-startup.test.ts holds plain `serve` at <= 260 modules). */
    const needsExtended =
      Boolean(extra.lease) ||
      Boolean(
        config.loadedConfigText &&
        /"(?:blocklist|blockedTables|blockedFields|blockedColumns|lease|secrets|dotenv|defaultConnection|active|lazy|only)"/.test(
          config.loadedConfigText,
        ),
      );
    if (needsExtended) {
      const { applyExtendedDiskConfig } = await import('./vaultConfig.js');
      try {
        const upgraded = applyExtendedDiskConfig(
          registry,
          config.loadedConfigText,
          config.configPath ?? 'tablewalk.json',
          opts.mcp,
          extra.lease,
        );
        registry = upgraded.registry;
        startupMeta = { active: upgraded.active, only: upgraded.only, lazy: upgraded.lazy };
      } catch (err) {
        console.error(`tablewalk: ${(err as Error).message}`);
        await registry.closeAll().catch(() => {});
        process.exit(1);
      }
    }
  }

  /* A connection under the row-security backstop signs in as a tenant App's restricted role, which sees no tenant
     row until a tenant is set: every table would open empty and say nothing of why. Only a tenant App reads through
     it, as mistri refuses the same of its Workbench. Refused before anything connects. */
  const fenced = registry.configs().find((each) => each.backstop === 'rls');
  if (fenced) {
    console.error(
      `tablewalk: connection "${fenced.name}" is under the row-security backstop ("backstop": "rls"); only a tenant App ` +
        "reads through it, and the database browser would see none of its tenant rows. Point it at the owner's URL instead, " +
        'or remove "backstop".',
    );
    await registry.closeAll();
    process.exitCode = 2;
    return;
  }
  // The database browser's writes run one at a time, the order its Undo needs (writeLanes.ts).
  configureWriteOrder('serial');
  /* The browser's agent tools — SQL, the schema, every table — take no App, since an App serves only its declared
     resources. Refused on the names alone. */
  if (opts.mcp && (config.apps.length || opts.apps?.length || opts.appEntry !== undefined)) {
    console.error(
      "--mcp is the database browser's agent interface and serves no App: an App serves only its declared resources, " +
        "through its own surfaces. Give --mcp a connection-only config, or serve a signed-in App's API with --app-mcp.",
    );
    await registry.closeAll();
    process.exit(1);
  }

  /* `--demo`: a throwaway database, built on the fly, so a fresh install has something to walk. Written into the
     OS temp directory, small and deterministic, and rebuilt each run so it never drifts from the schema this
     version knows. A real target named beside it wins, said rather than silently. */
  if (opts.demo) {
    if (opts.target) {
      console.log(`tablewalk: ignoring --demo because a database was named (${redact(opts.target)}).`);
    } else {
      const { demoDatabaseFile, makeDemoDatabase, seedDemoDatabase } = await import('@mistriwork/engine/server/demo.js');
      const file = demoDatabaseFile();
      makeDemoDatabase(file);
      seedDemoDatabase(file, { scale: 150 });
      opts.target = file;
      // Serving a demo without opening it would be handing someone a URL and hoping they paste it.
      if (!printing) opts.open = true;
      console.log('tablewalk: built a demo database — 11 tables to walk. Nothing of yours is touched.');
    }
  }
  /* `--openapi`: an API as a connection, straight from its spec (openapiDraft.ts). A command-line connection like a
     named database, and the active one unless a database is named too; a spec that cannot be served is a startup
     error. */
  if (opts.openapi !== undefined) {
    try {
      const { openapiConnection } = await import('@mistriwork/engine/server/openapiDraft.js');
      const api = await openapiConnection(opts.openapi, { apiUrl: opts.apiUrl, tokenEnv: opts.apiTokenEnv });
      const added = registry.add({ ...api, writable: false, source: 'argument' });
      if (!opts.target) registry.setActive(added.id);
    } catch (error) {
      console.error(`tablewalk: --openapi ${(error as Error).message}`);
      await registry.closeAll();
      process.exit(1);
    }
  } else if (opts.apiUrl !== undefined || opts.apiTokenEnv !== undefined) {
    console.error('tablewalk: --api-url and --api-token-env go with --openapi.');
    process.exit(1);
  }
  if (opts.target) {
    // Read-only, as everywhere: writes are a config's "writable": true.
    const added = registry.add({
      name: opts.demo ? 'demo' : redact(opts.target),
      url: opts.target,
      schemas: opts.schemas,
      source: 'argument',
    });
    registry.setActive(added.id);
  }

  if (extra.connection || extra.env || startupMeta.active || startupMeta.only) {
    const { applyStartupTargetSelection } = await import('./vaultConfig.js');
    try {
      await applyStartupTargetSelection(registry, {
        connection: extra.connection,
        env: extra.env,
        configActive: startupMeta.active,
        only: startupMeta.only,
      });
    } catch (err) {
      console.error(`tablewalk: ${(err as Error).message}`);
      await registry.closeAll().catch(() => {});
      process.exit(1);
    }
  }

  /* Nothing named a database. Every mode but the server needs one: `--export` prints a schema, `--lint` reads one,
     `--diff` compares two, and every MCP tool is a question about one, and an agent on stdio has no way to supply
     it — so those stop here, with the usage and the places a config was looked for. The server starts, and its
     page asks for a connection. */
  const nothingToOpen = !registry.list().length;
  if (nothingToOpen && printing) {
    console.log((await import('./usage.js')).USAGE);
    console.log(`\nLooked for a config file in:\n  ${configLocations(opts.config).join('\n  ')}`);
    process.exit(1);
  }

  if (oneShotTool) {
    const { runCliOneShot } = await import('./vaultConfig.js');
    return runCliOneShot(
      registry,
      { views: config.views, queries: config.queries, pages: config.pages },
      { query: extra.query, call: extra.call, args: extra.args, connection: extra.connection, env: extra.env },
    );
  }

  /* The active connection is opened eagerly unless `--lazy` (or a piped/leased MCP config with `lazy: true`)
     defers dialing until the agent's first tool call so MCP handshake answers immediately. */
  const skipEagerOpen = opts.mcp && (extra.lazy === true || startupMeta.lazy === true);
  if (!nothingToOpen && !skipEagerOpen) {
    try {
      const { schema } = await registry.open(registry.active!);
      console.log(
        `tablewalk: ${schema.label} (${schema.dialect}) — ${schema.tables.length} tables, ${schema.foreignKeys.length} foreign keys`,
      );
    } catch (err) {
      console.error(`Could not open the active connection:`);
      console.error(`  ${(err as Error).message}`);
      await registry.closeAll().catch(() => {});
      process.exit(1);
    }
  }

  if (opts.export) {
    const { exportSchemaText } = await import('./databaseOneShot.js');
    return exportSchemaText(opts.export, registry);
  }
  if (opts.diff) {
    const { diffConnections } = await import('./databaseOneShot.js');
    return diffConnections(opts.diff, registry);
  }
  if (opts.lint) {
    const { lintConnection } = await import('./databaseOneShot.js');
    return lintConnection(opts.lint, opts.failOn, registry);
  }
  if (opts.mcp) {
    const { serveMcpMode } = await import('./mcpMode.js');
    const { packageVersion } = await import('@mistriwork/engine/server/cli/usage.js');
    return serveMcpMode(
      opts,
      registry,
      { views: config.views, queries: config.queries, pages: config.pages },
      packageVersion,
      mcpInputStream,
    );
  }
  const { serveBrowser } = await import('./browserServe.js');
  await serveBrowser(opts, registry, config, nothingToOpen);
};
