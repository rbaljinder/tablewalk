/**
 * What a start loads, counted.
 *
 * `main` imports each mode where it reaches it (cli/browserMain.ts), and the bin entry re-exports nothing. Both were
 * once otherwise, and every start — `--help`, and the `--mcp` an agent's client spawns every session — loaded the whole
 * server before a flag was read. Milliseconds are the wrong thing to hold on a shared machine; the modules a start
 * loads are deterministic, so the ceilings are counts, and the named modules are the ones a mode has no business
 * loading. A module is named by its path inside its package (`server/mcp.ts`), whether it is this package's source or
 * the engine's published build.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'src/server/index.ts');

/* This package's `src/x.ts`, and an installed framework package's `dist/x.js`, both read as `x.ts`. */
const SRC = new RegExp(`^${new URL('../src/', import.meta.url).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
const PUBLISHED = /^file:\/\/.*\/node_modules\/@mistriwork\/[^/]+\/dist\//;
const named = (urls: string[]): string[] =>
  urls
    .filter((url) => SRC.test(url) || PUBLISHED.test(url))
    .map((url) => url.replace(SRC, '').replace(PUBLISHED, '').replace(/\.js$/, '.ts'));

/** A load hook in the process itself: it sees every module, whichever loader resolved it. */
const hookFor = (list: string, extra = '') =>
  `data:text/javascript,${encodeURIComponent(`
    import { registerHooks } from 'node:module'; import { writeFileSync } from 'node:fs';
    const seen = new Set();
    registerHooks({ load(url, context, next) { seen.add(url); return next(url, context); } });
    process.on('exit', () => writeFileSync(${JSON.stringify(list)}, [...seen].join('\\n')));${extra}`)}`;

/** Every module a start loads, by the time it exits. */
function loaded(args: string[], input = ''): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-startup-'));
  const list = join(directory, 'modules.txt');
  try {
    const result = spawnSync(process.execPath, ['--import', hookFor(list), '--import', import.meta.resolve('tsx'), BIN, ...args], {
      cwd: ROOT,
      input,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, TABLEWALK_OPEN: '0', MISTRI_OPEN: '0' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return named(readFileSync(list, 'utf8').split('\n'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every module a serving start loads by the time it listens, then stopped. */
async function served(args: string[]): Promise<string[]> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-startup-'));
  const list = join(directory, 'modules.txt');
  try {
    const child = spawn(
      process.execPath,
      ['--import', hookFor(list, "process.on('SIGTERM', () => process.exit(0));"), '--import', import.meta.resolve('tsx'), BIN, ...args],
      { cwd: ROOT, env: { ...process.env, TABLEWALK_OPEN: '0', MISTRI_OPEN: '0' } },
    );
    let said = '';
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stderr.on('data', (chunk) => (said += chunk));
    child.stdout.on('data', (chunk) => {
      said += chunk;
      if (/Listening/.test(said)) child.kill('SIGTERM');
    });
    await exited;
    clearTimeout(timer);
    assert.match(said, /Listening/, said);
    return named(readFileSync(list, 'utf8').split('\n'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/* Ceilings, from the monorepo's measurements (36 for --help, 172 for --mcp, 250 for serving) and this package's own: the
   counts here are 35, 36, 175 and 244. A jump past one is a module reached again that a mode should leave to the one
   that needs it. `--mcp` is 175, not 172, since the server modules take the engine's names from its host entry point
   (`@mistriwork/engine/host`): one module that re-exports them, and the few modules behind it that the deeper paths did not
   reach in this mode. */
const HELP_CEILING = 36;
const VERSION_CEILING = 70;
const MCP_CEILING = 175;
const SERVE_CEILING = 250;

const oneTable = (t: { after(fn: () => void): void }): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-startup-db-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'one.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT)');
  db.close();
  return file;
};

test('--help and --version load the flag parser, not the server', (t) => {
  const help = loaded(['--help']);
  t.diagnostic(`--help loaded ${help.length} modules`);
  assert.ok(help.length <= HELP_CEILING, `--help loaded ${help.length} modules:\n${help.join('\n')}`);
  assert.ok(help.includes('server/cli/args.ts'));
  const version = loaded(['--version']);
  t.diagnostic(`--version loaded ${version.length} modules`);
  assert.ok(version.length <= VERSION_CEILING, `--version loaded ${version.length} modules`);
  for (const modules of [help, version]) {
    assert.ok(!modules.includes('server/connections.ts'), 'a print-and-exit flag opened the connection registry');
    assert.ok(!modules.includes('server/http/server.ts'), 'a print-and-exit flag loaded the HTTP server');
  }
});

test('--mcp loads the MCP tools, not the HTTP server, the auth store or the tenant host', (t) => {
  const file = oneTable(t);
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'startup', version: '0' } },
  });
  const mcp = loaded(['--mcp', '--no-config', '--db', file], `${initialize}\n`);
  t.diagnostic(`plain MCP startup loaded ${mcp.length} modules`);
  assert.ok(mcp.includes('server/mcp.ts'), 'the MCP server itself was not loaded; the probe is broken');
  for (const absent of [
    'server/http/server.ts',
    'server/http/handler.ts',
    'server/auth/auth.ts',
    'server/cli/serve.ts',
    'server/cli/tenant.ts',
    'server/cli/appMcpMode.ts',
    'server/devclient.ts',
    'server/commands/businessCommandLoader.ts',
    'server/jobs/jobHost.ts',
    'server/app/appValidation.ts',
    'server/app/appTransitions.ts',
    'shared/app.ts',
    // The browser refuses an App on its name alone, so it never loads one, and it has no App authoring tools.
    'server/cli/apps.ts',
    'server/app/apps.ts',
    'server/app/appBuild.ts',
    'server/scaffold.ts',
    // The App framework's config sections (email, identity, webhooks, search, analytics): read only with a config file.
    'server/serviceConnections.ts',
  ]) {
    assert.ok(!mcp.includes(absent), `--mcp loaded ${absent}`);
  }
  assert.ok(mcp.length <= MCP_CEILING, `--mcp loaded ${mcp.length} modules:\n${mcp.join('\n')}`);
});

test('serving one database loads the database browser, not the App framework', async (t) => {
  const file = oneTable(t);
  const serve = await served(['--no-config', '--db', file, '--port', '0']);
  t.diagnostic(`a database browser start loaded ${serve.length} modules`);
  assert.ok(serve.includes('server/http/browserHandler.ts'), "the database browser's dispatcher was not loaded; the probe is broken");
  for (const absent of [
    // The App framework's dispatcher, its gate and server, and what they alone read.
    'server/http/server.ts',
    'server/http/handler.ts',
    'server/http/gate.ts',
    'server/auth/auth.ts',
    'shared/app.ts',
    'server/app/apps.ts',
  ]) {
    assert.ok(!serve.includes(absent), `a database browser start loaded ${absent}`);
  }
  for (const part of ['server/embed/', 'server/api/'])
    assert.ok(!serve.some((module) => module.startsWith(part)), `a database browser start loaded ${part}*`);
  assert.ok(serve.length <= SERVE_CEILING, `a database browser start loaded ${serve.length} modules:\n${serve.join('\n')}`);
});
