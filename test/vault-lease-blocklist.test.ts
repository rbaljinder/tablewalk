/**
 * End-to-end verification of vault/piped configuration, connection leases,
 * table & field blocklists, lazy MCP startup, and fast one-shot CLI lookups:
 *   1. Table & field blocklist (`blocklist.tables`, `blocklist.fields`, wildcards,
 *      array shorthand, PK-covered table withholding, database SQL view withholding,
 *      FK pruning, configured views, find, profile, export, raw SQL withholding/refusal,
 *      write enforcement, and allowlisted Adapter / PolicyRegistry boundaries)
 *   2. Piped vault configs (`--config -`, `{ vault; cat; } | tablewalk --mcp --config -`
 *      for both JSON and `.env` headers, named FIFOs / `<(vault ...)`, `TABLEWALK_CONFIG_JSON`,
 *      single-connection shorthand, in-memory `secrets` / `dotenv`, `active` + `only: true`,
 *      `--lazy`, `--query`, `--call`, and CLI target inheritance of top-level `blocklist`)
 *   3. Connection leases (in-place `idleSeconds` eviction keeping `active` stable +
 *      transparent re-open, `maxSeconds` expiry refusal, and `--mcp --lease` clean auto-exit)
 *   4. HTTP browser blocklist enforcement + `POST /api/connections/save` preservation of
 *      top-level `blocklist`, `lease`, and existing `secrets`
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '@mistriwork/engine/host';
import { createApp } from './support/createApp.js';
import { agentTools, answerMcpHttp, bindShelf, runTool } from '../src/server/mcp.js';
import { PolicyRegistry, applyExtendedDiskConfig, parseLeaseSpec } from '../src/server/cli/vaultConfig.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'src/server/index.ts');
const DIR = mkdtempSync(join(tmpdir(), 'tablewalk-vault-lease-'));
const REAL_TMP = process.env.TMPDIR;

before(() => {
  process.env.TMPDIR = DIR;
});

after(() => {
  if (REAL_TMP === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = REAL_TMP;
  rmSync(DIR, { recursive: true, force: true });
});

function buildVaultTestDb(path: string, tag = 'staging'): void {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE country (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE customer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      tax_id TEXT NOT NULL DEFAULT '000-00-0000',
      password_hash TEXT NOT NULL DEFAULT 'pbkdf2$default',
      api_token TEXT NOT NULL DEFAULT 'tok_default',
      country_code TEXT REFERENCES country(code)
    );
    CREATE TABLE invoice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customer(id),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
      total REAL NOT NULL,
      internal_secret TEXT DEFAULT 'sec_inv_note'
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customer(id),
      event TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE internal_secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_name TEXT NOT NULL,
      raw_value TEXT NOT NULL
    );
    CREATE TABLE pk_token_map (
      access_token TEXT PRIMARY KEY,
      owner_label TEXT NOT NULL
    );
    /* Database SQL views over blocked tables and aliased blocked columns! */
    CREATE VIEW v_audit AS SELECT id, customer_id, event, payload FROM audit_log;
    CREATE VIEW v_customer AS SELECT id, email, tax_id AS ssn_code FROM customer;

    INSERT INTO country (code, name) VALUES ('US', 'United States'), ('CA', 'Canada');
    INSERT INTO customer (name, email, tax_id, password_hash, api_token, country_code)
      VALUES ('Alice Vault', 'alice@example.com', '999-11-2222', 'pbkdf2$supersecret', 'tok_live_98765', 'US');
    INSERT INTO invoice (customer_id, status, total, internal_secret)
      VALUES (1, 'open', 420.5, 'invoice-whisper-${tag}'),
             (1, 'paid', 125.0, 'invoice-paid-${tag}');
    INSERT INTO audit_log (customer_id, event, payload)
      VALUES (1, 'login', 'audit_secret_payload_${tag}');
    INSERT INTO internal_secrets (key_name, raw_value)
      VALUES ('master_key', 'top_secret_master_${tag}');
    INSERT INTO pk_token_map (access_token, owner_label)
      VALUES ('tok_pk_hidden', 'ops');
  `);
  db.close();
}

function runCliProcess(
  args: string[],
  options: { stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', BIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${options.timeoutMs ?? 15000}ms. stderr:\n${stderr}`));
    }, options.timeoutMs ?? 15000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

describe('1. Table & field blocklist enforcement across catalog, SQL views, reads, exports, writes, and PolicyRegistry', () => {
  const dbPath = join(DIR, 'blocklist.sqlite');
  let registry: Registry;

  before(async () => {
    buildVaultTestDb(dbPath, 'block');
    const base = new Registry();
    const rawConfig = JSON.stringify({
      blocklist: {
        tables: ['audit_*'],
        fields: { '*': ['*_token', 'password*'] },
      },
      connections: [
        {
          name: 'billing',
          url: dbPath,
          writable: true,
          blocklist: {
            tables: ['internal_secrets'],
            fields: { customer: ['tax_id'] },
          },
          blockedFields: ['invoice.internal_secret'],
        },
      ],
      views: [
        {
          name: 'safe_invoices',
          text: 'invoice show id, total, status, customer_id.name as customer sort id asc',
        },
        {
          name: 'leaky_tax_view',
          text: 'invoice show id, total, customer_id.tax_id as tax',
        },
        {
          name: 'leaky_audit_view',
          text: 'audit_log show id, event',
        },
      ],
    });
    const parsed = JSON.parse(rawConfig) as {
      connections: Array<{ name: string; url: string; writable: boolean }>;
    };
    const added = base.add({
      name: parsed.connections[0].name,
      url: parsed.connections[0].url,
      writable: true,
      source: 'config',
    });
    base.setActive(added.id);
    registry = applyExtendedDiskConfig(base, rawConfig, 'test-blocklist.json', true).registry;

    const { parseViewsConfig } = await import('@mistriwork/engine/shared/view.js');
    bindShelf(registry, {
      views: parseViewsConfig(JSON.parse(rawConfig), 'test-blocklist.json'),
      queries: [],
      pages: [],
    });
  });

  after(async () => {
    await registry.closeAll();
  });

  test('withholds raw SQL tools, database SQL views, blocked tables, PK-covered tables, blocked fields, FKs, and unlisted adapter methods', async () => {
    assert.ok(registry instanceof PolicyRegistry);

    const tools = agentTools(registry).map((t) => t.name);
    assert.ok(!tools.includes('sql'), 'sql must be withheld when blocklist is active');
    assert.ok(!tools.includes('explain'), 'explain must be withheld when blocklist is active');
    assert.ok(!tools.includes('verify_ddl'), 'verify_ddl must be withheld when blocklist is active');
    assert.ok(tools.includes('query'));
    assert.ok(tools.includes('insert'));

    const tablesRes = await runTool(registry, 'tables', {});
    assert.ok(!tablesRes.isError);
    const tableNames = ((tablesRes.structuredContent as { tables: Array<{ id: string }> }).tables ?? []).map((t) => t.id).sort();
    /* audit_log, internal_secrets, pk_token_map, AND database views v_audit + v_customer are ALL withheld! */
    assert.deepEqual(tableNames, ['country', 'customer', 'invoice']);

    /* PolicyRegistry guards dialedAdapter() and omits unlisted adapter methods (`triggers`, `privileges`, prototype methods). */
    assert.equal(registry.dialedAdapter('billing'), undefined, 'dialedAdapter must not expose raw adapter under blocklist');
    const { adapter } = await registry.open('billing');
    assert.equal(Object.getPrototypeOf(adapter), Object.prototype, 'Blocklisted adapter must be a plain allowlisted facade');
    assert.equal(adapter.triggers, undefined);
    assert.equal(adapter.triggerKeys, undefined);
    assert.equal(adapter.privileges, undefined);

    const connRes = await runTool(registry, 'connections', {});
    const connEntry = ((connRes.structuredContent as { connections: Array<{ hidesColumns?: boolean; tables?: number }> }).connections ??
      [])[0];
    assert.equal(connEntry?.hidesColumns, true);
    assert.equal(connEntry?.tables, 3);

    const custRes = await runTool(registry, 'table', { table: 'customer' });
    assert.ok(!custRes.isError);
    const custStruct = custRes.structuredContent as {
      columns: Array<{ name: string }>;
      ddl?: string;
      pointedAtBy: Array<{ table: string }>;
    };
    assert.deepEqual(
      custStruct.columns.map((c) => c.name),
      ['id', 'name', 'email', 'country_code'],
    );
    assert.ok(custStruct.ddl?.includes('"email"'));
    assert.ok(!custStruct.ddl?.includes('tax_id'), 'DDL must omit blocked tax_id');
    assert.ok(!custStruct.ddl?.includes('password_hash'), 'DDL must omit blocked password_hash');
    assert.ok(!custStruct.ddl?.includes('api_token'), 'DDL must omit blocked api_token');
    assert.deepEqual(
      custStruct.pointedAtBy.map((fk) => fk.table),
      ['invoice'],
      'Incoming FK from blocked audit_log must be pruned',
    );

    for (const withheldObject of ['audit_log', 'v_audit', 'v_customer']) {
      const res = await runTool(registry, 'table', { table: withheldObject });
      assert.equal(res.isError, true, `table "${withheldObject}" must be refused`);
    }

    /* Shelf schema resource must also omit every blocked table, database view, and column. */
    const { parseViewsConfig } = await import('@mistriwork/engine/shared/view.js');
    const shelfRead = await answerMcpHttp(
      registry,
      {
        views: parseViewsConfig(
          {
            views: [
              { name: 'safe_invoices', text: 'invoice show id, total, status, customer_id.name as customer sort id asc' },
              { name: 'leaky_tax_view', text: 'invoice show id, total, customer_id.tax_id as tax' },
              { name: 'leaky_audit_view', text: 'audit_log show id, event' },
            ],
          },
          'test',
        ),
        queries: [],
        pages: [],
      },
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'resources/read',
        params: { uri: 'tablewalk://billing/schema' },
      },
      { version: '1.0.0-test' },
    );
    const shelfText = JSON.stringify(shelfRead);
    for (const secretIdent of [
      'audit_log',
      'internal_secrets',
      'pk_token_map',
      'v_audit',
      'v_customer',
      'tax_id',
      'password_hash',
      'api_token',
      'internal_secret',
    ]) {
      assert.ok(!shelfText.includes(secretIdent), `Shelf schema must not leak "${secretIdent}"`);
    }
  });

  test('enforces blocklist across query, SQL views, configured views, record, find, profile, export, raw SQL, and writes', async () => {
    /* Allowed query omits blocked columns. */
    const qOk = await runTool(registry, 'query', { q: 'customer' });
    assert.ok(!qOk.isError);
    const qStruct = qOk.structuredContent as { columns: string[]; rows: Array<Record<string, unknown>> };
    assert.deepEqual(qStruct.columns, ['id', 'name', 'email', 'country_code']);
    assert.equal(qStruct.rows.length, 1);
    assert.equal('tax_id' in qStruct.rows[0], false);
    assert.equal('password_hash' in qStruct.rows[0], false);
    assert.equal('api_token' in qStruct.rows[0], false);

    /* Filtering on a blocked column, querying a blocked table, or querying a database SQL view fails! */
    for (const forbiddenQuery of ['customer tax_id = "999-11-2222"', 'audit_log', 'v_audit', 'v_customer']) {
      const res = await runTool(registry, 'query', { q: forbiddenQuery });
      const struct = res.structuredContent as { errors?: unknown[] } | undefined;
      assert.ok(res.isError || (struct?.errors?.length ?? 0) > 0, `Query "${forbiddenQuery}" must fail`);
    }

    /* Named configured views: safe view works, views touching blocked column or blocked table are refused. */
    const safeView = await runTool(registry, 'query', { view: 'safe_invoices' });
    assert.ok(!safeView.isError, safeView.content[0]?.text);
    assert.equal((safeView.structuredContent as { rows: unknown[] }).rows.length, 2);

    const leakyColView = await runTool(registry, 'query', { view: 'leaky_tax_view' });
    assert.equal(leakyColView.isError, true);

    const leakyTblView = await runTool(registry, 'query', { view: 'leaky_audit_view' });
    assert.equal(leakyTblView.isError, true);

    /* Record omits blocked fields and blocked incoming relationships. */
    const rec = await runTool(registry, 'record', { table: 'customer', key: { id: 1 } });
    assert.ok(!rec.isError);
    const recStruct = rec.structuredContent as {
      row: Record<string, unknown>;
      pointedAtBy: Array<{ table: string }>;
    };
    assert.equal(recStruct.row.name, 'Alice Vault');
    assert.equal('tax_id' in recStruct.row, false);
    assert.equal('password_hash' in recStruct.row, false);
    assert.deepEqual(
      recStruct.pointedAtBy.map((r) => r.table),
      ['invoice'],
    );

    /* `find` value sweep never searches blocked tables, blocked columns, OR database SQL views (`v_audit`, `v_customer`)! */
    for (const secretProbe of [
      '999-11-2222',
      'pbkdf2$supersecret',
      'tok_live_98765',
      'audit_secret_payload',
      'top_secret_master',
      'invoice-whisper',
    ]) {
      const found = await runTool(registry, 'find', { value: secretProbe });
      assert.ok(!found.isError);
      const matches = (found.structuredContent as { matches?: unknown[] }).matches ?? [];
      assert.equal(matches.length, 0, `find must not match blocked secret "${secretProbe}" (including via SQL views)`);
    }
    const foundAllowed = await runTool(registry, 'find', { value: 'Alice Vault' });
    assert.equal(((foundAllowed.structuredContent as { matches?: unknown[] }).matches ?? []).length, 1);

    /* `profile` omits blocked columns and refuses blocked tables and SQL views. */
    const prof = await runTool(registry, 'profile', { table: 'customer' });
    assert.ok(!prof.isError);
    const profCols = ((prof.structuredContent as { columns: Array<{ column: string }> }).columns ?? []).map((c) => c.column);
    assert.deepEqual(profCols, ['id', 'name', 'email', 'country_code']);
    assert.equal((await runTool(registry, 'profile', { table: 'audit_log' })).isError, true);
    assert.equal((await runTool(registry, 'profile', { table: 'v_customer' })).isError, true);

    /* `export` writes only allowed columns to disk and refuses database views. */
    const exp = await runTool(registry, 'export', { query: 'customer', format: 'json' });
    assert.ok(!exp.isError, exp.content[0]?.text);
    const expPath = (exp.structuredContent as { path: string }).path;
    const exportedJson = readFileSync(expPath, 'utf8');
    assert.ok(exportedJson.includes('Alice Vault'));
    assert.ok(!exportedJson.includes('999-11-2222'));
    assert.ok(!exportedJson.includes('pbkdf2$supersecret'));
    assert.ok(!exportedJson.includes('tok_live_98765'));
    assert.equal((await runTool(registry, 'export', { query: 'v_customer', format: 'csv' })).isError, true);

    /* Direct calls to raw SQL / DDL tools are refused even if invoked by name. */
    for (const [tool, args] of [
      ['sql', { statement: 'SELECT tax_id FROM customer' }],
      ['explain', { statement: 'SELECT * FROM audit_log' }],
      ['verify_ddl', { sql: 'ALTER TABLE customer ADD COLUMN nickname TEXT' }],
    ] as const) {
      const res = await runTool(registry, tool, args);
      assert.equal(res.isError, true, `${tool} must be refused on a blocklisted connection`);
    }

    /* Writes: allowed insert works and omits blocked default column; writes touching blocked fields or tables are refused. */
    const insOk = await runTool(registry, 'insert', {
      table: 'invoice',
      values: { customer_id: 1, status: 'open', total: 75.25 },
    });
    assert.ok(!insOk.isError, insOk.content[0]?.text);
    const insertedRow = (insOk.structuredContent as { row: Record<string, unknown> }).row;
    assert.equal(insertedRow.total, 75.25);
    assert.equal('internal_secret' in insertedRow, false);

    const updBlocked = await runTool(registry, 'update', {
      table: 'customer',
      key: { id: 1 },
      set: { tax_id: '111-22-3333' },
    });
    assert.equal(updBlocked.isError, true, 'Updating a blocked field must fail');

    const insBlockedTable = await runTool(registry, 'insert', {
      table: 'audit_log',
      values: { customer_id: 1, event: 'spoof', payload: 'x' },
    });
    assert.equal(insBlockedTable.isError, true, 'Inserting into a blocked table must fail');
  });

  test('applies top-level blocklist to CLI positional/--db targets (even with "connections": []) and later session connections', async () => {
    const topLevelConfigPath = join(DIR, 'toplevel-only.json');
    writeFileSync(
      topLevelConfigPath,
      JSON.stringify({
        blocklist: {
          tables: ['audit_*', 'internal_secrets'],
          fields: {
            '*': ['*_token', 'password*'],
            customer: ['tax_id'],
          },
        },
        connections: [],
      }),
    );

    /* Exact reviewer reproduction: `tablewalk --config toplevel.json <db> --query audit_log` must fail! */
    const blockedCli = await runCliProcess(['--config', topLevelConfigPath, dbPath, '--query', 'audit_log'], {
      env: { XDG_CONFIG_HOME: join(DIR, 'xdg-toplevel') },
    });
    const blockedCliParsed = blockedCli.code === 0 ? (JSON.parse(blockedCli.stdout) as { errors?: unknown[] }) : undefined;
    assert.ok(
      blockedCli.code !== 0 || (blockedCliParsed?.errors?.length ?? 0) > 0,
      'CLI positional target must enforce top-level blocklist on audit_log',
    );

    const allowedCli = await runCliProcess(['--config', topLevelConfigPath, dbPath, '--query', 'customer'], {
      env: { XDG_CONFIG_HOME: join(DIR, 'xdg-toplevel') },
    });
    assert.equal(allowedCli.code, 0, allowedCli.stderr);
    const custOut = JSON.parse(allowedCli.stdout) as { columns: string[] };
    assert.deepEqual(custOut.columns, ['id', 'name', 'email', 'country_code']);

    /* Session connections added later onto a PolicyRegistry inherit top-level defaultBlocklist (pruning audit_log, pk_token_map, and SQL views). */
    const sessionAdded = registry.add({ name: 'session-later', url: dbPath, source: 'session' });
    const sessionTables = await runTool(registry, 'tables', { connection: sessionAdded.id });
    assert.deepEqual(((sessionTables.structuredContent as { tables: Array<{ id: string }> }).tables ?? []).map((t) => t.id).sort(), [
      'country',
      'customer',
      'internal_secrets',
      'invoice',
    ]);
  });
});

describe('2. Piped vault configs, in-memory secrets, lazy MCP combined stdin (JSON & .env), FIFO, and fast CLI', () => {
  const stagingDb = join(DIR, 'vault-staging.sqlite');
  const prodDb = join(DIR, 'vault-prod.sqlite');
  const isolatedXdg = join(DIR, 'xdg-empty');

  before(() => {
    buildVaultTestDb(stagingDb, 'staging');
    buildVaultTestDb(prodDb, 'prod');
  });

  test('pipes multi-env vault JSON via --config - with in-memory secrets and runs fast --query on --env staging', async () => {
    const vaultPayload = JSON.stringify({
      dotenv: `# Vault injected variables\nVAULT_PROD_PATH="${prodDb}"\n`,
      secrets: {
        VAULT_STAGING_PATH: stagingDb,
      },
      blocklist: {
        tables: ['audit_*', 'internal_secrets'],
        fields: ['*_token', '*_secret', 'password*', 'customer.tax_id'],
      },
      connections: [
        { name: 'billing-staging', database: 'billing', env: 'staging', url: '${VAULT_STAGING_PATH}' },
        { name: 'billing-prod', database: 'billing', env: 'prod', url: '${VAULT_PROD_PATH}', rows: false },
      ],
    });

    const { code, stdout, stderr } = await runCliProcess(['--config', '-', '--env', 'staging', '--query', 'invoice status = open'], {
      stdin: vaultPayload,
      env: { XDG_CONFIG_HOME: isolatedXdg },
    });
    assert.equal(code, 0, `Expected exit 0, stderr:\n${stderr}`);
    const result = JSON.parse(stdout) as { columns: string[]; rows: Array<Record<string, unknown>> };
    assert.deepEqual(result.columns, ['id', 'customer_id', 'status', 'total']);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].total, 420.5);
    assert.equal('internal_secret' in result.rows[0], false);
    assert.equal(
      existsSync(isolatedXdg) ? readdirSync(isolatedXdg).length : 0,
      0,
      'Vault piped config must not write anything into XDG_CONFIG_HOME',
    );
  });

  test('supports combined stdin ({ vault; cat; } | tablewalk --mcp --config -) for BOTH JSON and .env headers without waiting for EOF', async () => {
    const mcpVaultConfig = JSON.stringify({
      secrets: {
        STAGING_URL: stagingDb,
        PROD_URL: prodDb,
      },
      active: 'billing@staging',
      only: true,
      lazy: true,
      lease: '30s',
      blocklist: {
        tables: ['audit_*', 'internal_secrets'],
        fields: ['*_token', '*_secret', 'password*', 'customer.tax_id'],
      },
      connections: [
        { name: 'billing-staging', database: 'billing', env: 'staging', url: '${STAGING_URL}' },
        { name: 'billing-prod', database: 'billing', env: 'prod', url: '${PROD_URL}' },
      ],
    });

    const rpcLines = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-test', version: '1.0' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'connections', arguments: {} } }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'query', arguments: { q: 'customer' } },
      }),
    ].join('\n');

    const { code, stdout, stderr } = await runCliProcess(['--mcp', '--config', '-'], {
      stdin: `${mcpVaultConfig}\n${rpcLines}\n`,
      env: { XDG_CONFIG_HOME: isolatedXdg },
    });

    assert.equal(code, 0, `MCP process should exit cleanly on stdin EOF. stderr:\n${stderr}`);
    const messages = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: number; result?: Record<string, unknown> });

    assert.ok(messages.find((m) => m.id === 1)?.result?.protocolVersion);
    const connsStruct = (
      messages.find((m) => m.id === 2)?.result as {
        structuredContent?: { connections: Array<{ id: string; tables?: number }> };
      }
    )?.structuredContent;
    assert.equal(connsStruct?.connections.length, 1);
    assert.equal(connsStruct?.connections[0]?.id, 'billing-staging');
    assert.equal(connsStruct?.connections[0]?.tables, undefined);

    const listedNames = ((messages.find((m) => m.id === 3)?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);
    assert.ok(!listedNames.includes('sql'));
    assert.ok(listedNames.includes('query'));

    const queryStruct = (
      messages.find((m) => m.id === 4)?.result as {
        structuredContent?: { columns: string[]; rows: unknown[] };
      }
    )?.structuredContent;
    assert.deepEqual(queryStruct?.columns, ['id', 'name', 'email', 'country_code']);
    assert.equal(queryStruct?.rows.length, 1);

    /* Now verify `.env` piped with `--mcp --config -` while keeping stdin open until RPC replies arrive! */
    const dotenvMcpChild = spawn(process.execPath, ['--import', 'tsx', BIN, '--mcp', '--config', '-', '--db', '${DOTENV_MCP_URL}'], {
      cwd: ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: isolatedXdg },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let dotenvStdout = '';
    dotenvMcpChild.stdout.setEncoding('utf8');
    const gotReply = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        dotenvMcpChild.kill('SIGKILL');
        reject(new Error('Piped .env --mcp --config - waited for EOF instead of answering live!'));
      }, 6000);
      dotenvMcpChild.stdout.on('data', (chunk: string) => {
        dotenvStdout += chunk;
        const lines = dotenvStdout.trim().split('\n').filter(Boolean);
        if (lines.length >= 2) {
          clearTimeout(t);
          resolve();
        }
      });
    });

    /* Write `.env` + RPC WITHOUT closing stdin (`end()` is NOT called yet)! */
    dotenvMcpChild.stdin.write(
      `# Vault .env header\nexport DOTENV_MCP_URL="${stagingDb}"\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query', arguments: { q: 'country' } } })}\n`,
    );
    await gotReply;
    dotenvMcpChild.stdin.end();
    const dotenvExit = await new Promise<number | null>((r) => dotenvMcpChild.on('close', r));
    assert.equal(dotenvExit, 0);
    const dotenvReplies = dotenvStdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { id: number; result?: { structuredContent?: { rows?: unknown[] } } });
    assert.equal(dotenvReplies.find((m) => m.id === 2)?.result?.structuredContent?.rows?.length, 2);
  });

  test('reads named FIFO (--config <fifo>) once without losing stream contents and supports TABLEWALK_CONFIG_JSON + --call', async () => {
    const fifoPath = join(DIR, 'vault.fifo');
    execFileSync('mkfifo', [fifoPath]);
    const fifoPayload = JSON.stringify({
      url: stagingDb,
      name: 'fifo-staging',
      env: 'staging',
      blocklist: {
        tables: ['audit_*', 'internal_secrets'],
        fields: ['*_token', '*_secret', 'password*', 'customer.tax_id'],
      },
    });

    const cliPromise = runCliProcess(['--config', fifoPath, '--call', 'table', '--args', JSON.stringify({ table: 'invoice' })], {
      env: { XDG_CONFIG_HOME: isolatedXdg },
    });
    await new Promise<void>((resolve, reject) => {
      const ws = createWriteStream(fifoPath, { encoding: 'utf8' });
      ws.on('error', reject);
      ws.end(fifoPayload, () => resolve());
    });

    const fifoRes = await cliPromise;
    assert.equal(fifoRes.code, 0, fifoRes.stderr);
    const tableInfo = JSON.parse(fifoRes.stdout) as { table: string; columns: Array<{ name: string }> };
    assert.equal(tableInfo.table, 'invoice');
    assert.deepEqual(
      tableInfo.columns.map((c) => c.name),
      ['id', 'customer_id', 'status', 'total'],
    );

    const envRes = await runCliProcess(['--call', 'schema_summary'], {
      env: {
        XDG_CONFIG_HOME: isolatedXdg,
        TABLEWALK_CONFIG_JSON: fifoPayload,
      },
    });
    assert.equal(envRes.code, 0, envRes.stderr);
    const summary = JSON.parse(envRes.stdout) as { tables: number };
    assert.equal(summary.tables, 3);
  });
});

describe('3. Connection leases: in-place idle eviction (keeping active stable), re-open, maxSeconds expiry, and MCP auto-exit', () => {
  const leaseDb = join(DIR, 'lease.sqlite');

  before(() => {
    buildVaultTestDb(leaseDb, 'lease');
  });

  test('evicts idle connections in place without moving active, re-opens on demand, and refuses after maxSeconds', async () => {
    const lease = parseLeaseSpec({ idleSeconds: 0.08, maxSeconds: 0.45, exitOnExpire: false }, 'test');
    const registry = new PolicyRegistry({ sessionLease: lease, mcpMode: false });
    registry.add({ name: 'first-db', url: leaseDb, source: 'config' });
    const second = registry.add({ name: 'leased-db', url: leaseDb, source: 'config' });
    registry.setActive(second.id);

    /* Sample `registry.active` on a tight 5ms interval across eviction & re-open to prove it never shifts to `first-db`. */
    const observedActive = new Set<string | null>();
    const watcher = setInterval(() => {
      observedActive.add(registry.active);
    }, 5);

    try {
      assert.equal(registry.list().find((c) => c.id === second.id)?.connected, false);

      const first = await runTool(registry, 'query', { q: 'country' });
      assert.ok(!first.isError);
      assert.equal(registry.list().find((c) => c.id === second.id)?.connected, true);

      /* Wait past idleSeconds (80ms) -> adapter is evicted in place. */
      await new Promise((r) => setTimeout(r, 160));
      assert.equal(registry.list().find((c) => c.id === second.id)?.connected, false, 'Idle connection must be closed after idleSeconds');
      assert.equal(registry.active, second.id);

      /* Query again while still inside maxSeconds (450ms) -> transparently re-opens! */
      const secondRun = await runTool(registry, 'query', { q: 'country' });
      assert.ok(!secondRun.isError, secondRun.content[0]?.text);
      assert.equal((secondRun.structuredContent as { rows: unknown[] }).rows.length, 2);

      /* Wait past maxSeconds -> connection closes and refuses further calls. */
      await new Promise((r) => setTimeout(r, 340));
      assert.equal(registry.list().find((c) => c.id === second.id)?.connected, false);

      const expired = await runTool(registry, 'query', { q: 'country' });
      assert.equal(expired.isError, true);
      assert.match(expired.content[0]?.text ?? '', /lease expired/i);

      assert.deepEqual([...observedActive], [second.id], 'active connection must never move during idle eviction');
    } finally {
      clearInterval(watcher);
      await registry.closeAll();
    }
  });

  test('--mcp --lease cleanly closes connections and exits 0 when lease expires even with stdin held open', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', BIN, leaseDb, '--mcp', '--lazy', '--lease', '250ms'], {
      cwd: ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: join(DIR, 'xdg-lease') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-idle', version: '1.0' } },
      })}\n`,
    );

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`--mcp --lease did not exit on expiry. stderr:\n${stderr}`));
      }, 6000);
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0);
    assert.match(stderr, /lease .* expired; closed all connections/i);
  });
});

describe('4. Piped .env breakdown CLI, HTTP browser blocklist enforcement, and Save config round-trip', () => {
  const envDb = join(DIR, 'dotenv-http.sqlite');

  before(() => {
    buildVaultTestDb(envDb, 'http');
  });

  test('supports piped .env text via --config - with --db ${VAR} and dispatches breakdown queries automatically', async () => {
    const dotenvStdin = `# Vault .env output\nexport VAULT_DB_TARGET="${envDb}"\n`;
    const { code, stdout, stderr } = await runCliProcess(
      ['--config', '-', '--db', '${VAULT_DB_TARGET}', '--query', 'invoice count by status sort status asc'],
      {
        stdin: dotenvStdin,
        env: { XDG_CONFIG_HOME: join(DIR, 'xdg-dotenv') },
      },
    );
    assert.equal(code, 0, stderr);
    const parsed = JSON.parse(stdout) as { rows: Array<Record<string, unknown>> };
    assert.equal(parsed.rows.length, 2);
  });

  test('enforces blocklist across HTTP routes and preserves top-level blocklist, lease, and existing secrets on Save', async () => {
    const configPath = join(DIR, 'save-roundtrip.json');
    const newSavePath = join(DIR, 'save-new-target.json');
    const initialJson = JSON.stringify(
      {
        secrets: {
          HTTP_DB_PATH: envDb,
        },
        lease: {
          idleSeconds: 45,
          maxSeconds: 600,
        },
        blocklist: {
          tables: ['audit_*', 'internal_secrets'],
          fields: ['*_token', '*_secret', 'password*'],
        },
        connections: [
          {
            name: 'web-blocked',
            database: 'billing',
            env: 'staging',
            url: envDb,
            blocklist: {
              fields: { customer: ['tax_id'] },
            },
          },
        ],
      },
      null,
      2,
    );
    writeFileSync(configPath, initialJson);

    const baseReg = new Registry();
    const added = baseReg.add({ name: 'web-blocked', url: envDb, source: 'config' });
    baseReg.setActive(added.id);
    const { registry } = applyExtendedDiskConfig(baseReg, initialJson, configPath, false);

    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, configPath });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    bound.port = port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const schemaRes = await fetch(`${base}/api/schema`);
      assert.equal(schemaRes.status, 200);
      const schemaJson = (await schemaRes.json()) as { tables: Array<{ id: string; columns: Array<{ name: string }> }> };
      assert.deepEqual(schemaJson.tables.map((t) => t.id).sort(), ['country', 'customer', 'invoice']);
      const customerCols = schemaJson.tables.find((t) => t.id === 'customer')?.columns.map((c) => c.name);
      assert.deepEqual(customerCols, ['id', 'name', 'email', 'country_code']);

      const queryOk = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'query', arguments: { q: 'customer' } },
        }),
      });
      assert.equal(queryOk.status, 200);
      const queryJson = (await queryOk.json()) as {
        result: { isError?: boolean; structuredContent: { rows: Array<Record<string, unknown>> } };
      };
      assert.ok(!queryJson.result.isError);
      assert.equal('tax_id' in queryJson.result.structuredContent.rows[0], false);

      /* 1. Save in place: top-level `blocklist`, `lease`, and on-disk `secrets` + per-connection `database`/`env`/`blocklist` all survive! */
      const saveInPlace = await fetch(`${base}/api/connections/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: configPath }),
      });
      assert.equal(saveInPlace.status, 200);
      const savedDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown> & {
        connections: Array<Record<string, unknown>>;
      };
      assert.deepEqual(savedDisk.blocklist, {
        tables: ['audit_*', 'internal_secrets'],
        fields: ['*_token', '*_secret', 'password*'],
      });
      assert.deepEqual(savedDisk.lease, { idleSeconds: 45, maxSeconds: 600 });
      assert.deepEqual(savedDisk.secrets, { HTTP_DB_PATH: envDb });
      assert.equal(savedDisk.connections[0]?.database, 'billing');
      assert.equal(savedDisk.connections[0]?.env, 'staging');
      assert.deepEqual(savedDisk.connections[0]?.blocklist, { fields: { customer: ['tax_id'] } });

      /* 2. Save to a brand-new path: top-level `blocklist` and `lease` still survive, while `secrets` is NOT copied to a new file! */
      const saveNew = await fetch(`${base}/api/connections/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newSavePath }),
      });
      assert.equal(saveNew.status, 200);
      const savedNewDisk = JSON.parse(readFileSync(newSavePath, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(savedNewDisk.blocklist, {
        tables: ['audit_*', 'internal_secrets'],
        fields: ['*_token', '*_secret', 'password*'],
      });
      assert.deepEqual(savedNewDisk.lease, { idleSeconds: 45, maxSeconds: 600 });
      assert.equal(savedNewDisk.secrets, undefined, 'Secrets must not be written when saving to a brand-new path');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.closeAll();
    }
  });
});
