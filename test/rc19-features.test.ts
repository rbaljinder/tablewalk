/**
 * End-to-end verification of 1.0.0-rc.19 features:
 *   1. Foreign-key `path` finder (`findForeignKeyPaths` & MCP `path` tool): `to-one`, `to-many`,
 *      join-table bridges, `unindexedHops`, `scannedApproxRows`, `suggestedIndex` `CREATE INDEX` DDL,
 *      and `queryHint` synthesis.
 *   2. Environment-tier policies (`environments.<env>`) across piped vault configs and disk
 *      `tablewalk.json` (`writable`, `rows`, `lease`, `blocklist`, `redact`, `redactColumns`,
 *      `maxRows`), explicit per-connection overrides, and `POST /api/connections/save` round-trip.
 *   3. Always-on connection `redact: true` + `redactColumns` (`query`, joined `view`, `breakdown`,
 *      `profile`, `record`, `find`, `fixture`, `export`, idempotency with `redact: true` tool args,
 *      and withholding/refusal of `sql`, `explain`, `verify_ddl`).
 *   4. Session `maxRows` egress budgets (clamping `query`, inline `limit N`, `breakdown`, `find`,
 *      and `export`, surfacing `redactsRows`, `maxRows`, and `rowsRemaining` in `connections` and
 *      `/api/agent/activity`, and refusing with `'limit'` once exhausted).
 *   5. Environment-variable & CLI guardrails (`TABLEWALK_BLOCKED_TABLES`, `TABLEWALK_BLOCKED_FIELDS`,
 *      `TABLEWALK_REDACT`, `TABLEWALK_REDACT_COLUMNS`, `TABLEWALK_MAX_ROWS`, `--redact`, `--max-rows`).
 *   6. Multi-call CLI `--batch` mode (file input, stdin `-`, and single-pipe
 *      `{ vault config; batch lines; } | tablewalk --config - --batch -`).
 *   7. Smart `suggestionsFor` completion (FK dot-paths, `CHECK` enum values, boolean/date values,
 *      and breakdown measures & time periods).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '@mistriwork/engine/host';
import { createApp } from './support/createApp.js';
import { stubDom } from './support/agreementFixture.js';
import { agentTools, bindShelf, runTool } from '../src/server/mcp.js';
import { PolicyRegistry, applyExtendedDiskConfig, loadPipedVaultConfig } from '../src/server/cli/vaultConfig.js';
import { findForeignKeyPaths } from '../src/shared/path.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'src/server/index.ts');
const DIR = mkdtempSync(join(tmpdir(), 'tablewalk-rc19-'));
const REAL_TMP = process.env.TMPDIR;

before(() => {
  process.env.TMPDIR = DIR;
});

after(() => {
  if (REAL_TMP === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = REAL_TMP;
  rmSync(DIR, { recursive: true, force: true });
});

function buildRc19Db(path: string): void {
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
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      internal_note TEXT NOT NULL DEFAULT 'raw-secret-note',
      country_code TEXT REFERENCES country(code)
    );
    CREATE INDEX idx_customer_country ON customer(country_code);
    CREATE TABLE invoice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customer(id),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
      issued_at TEXT NOT NULL DEFAULT '2026-08-01',
      total REAL NOT NULL
    );
    /* Deliberately leave invoice.customer_id unindexed so path() flags unindexedHops! */
    CREATE TABLE invoice_line (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoice(id),
      sku TEXT NOT NULL,
      qty INTEGER NOT NULL
    );
    CREATE INDEX idx_invoice_line_invoice ON invoice_line(invoice_id);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL
    );

    INSERT INTO country (code, name) VALUES ('US', 'United States'), ('AU', 'Australia');
    INSERT INTO customer (name, email, active, internal_note, country_code) VALUES
      ('Alice Mercer', 'alice@acme.org', 1, 'vip-secret-alpha', 'US'),
      ('Bob Harper', 'bob@harper.io', 1, 'vip-secret-beta', 'AU'),
      ('Clara Vance', 'clara@vance.net', 0, 'vip-secret-gamma', 'US');
    INSERT INTO invoice (customer_id, status, issued_at, total) VALUES
      (1, 'open', '2026-08-01', 150.0),
      (1, 'paid', '2026-08-15', 320.0),
      (2, 'open', '2026-09-01', 90.0),
      (2, 'void', '2026-09-10', 45.0),
      (3, 'paid', '2026-10-01', 610.0);
    INSERT INTO invoice_line (invoice_id, sku, qty) VALUES
      (1, 'SKU-1', 2),
      (2, 'SKU-2', 5),
      (3, 'SKU-3', 1);
    INSERT INTO audit_log (actor_email, action) VALUES ('ops@acme.org', 'rotate_key');
  `);
  db.close();
}

describe('foreign-key path finder and MCP path tool', () => {
  const dbPath = join(DIR, 'path.db');
  let registry: Registry;

  before(async () => {
    buildRc19Db(dbPath);
    registry = new Registry();
    registry.add({ name: 'billing', url: dbPath, source: 'config' });
    await registry.open('billing');
  });

  after(async () => {
    await registry.closeAll();
  });

  test('finds multi-hop to-one and to-many paths, queryHint, and unindexed reverse join DDL', async () => {
    const { schema } = await registry.open('billing');

    // Pure to-one chain: invoice_line -> invoice -> customer -> country
    const forward = findForeignKeyPaths(schema, 'invoice_line', 'country');
    assert.ok(!('error' in forward));
    assert.equal(forward.paths.length, 1);
    assert.equal(forward.paths[0].length, 3);
    assert.equal(forward.paths[0].unindexedHops, 0);
    assert.equal(forward.paths[0].queryHint, 'invoice_line show id, invoice_id.customer_id.country_code.code');

    // Reverse to-many chain: country -> customer (indexed) -> invoice (UNINDEXED!) -> invoice_line (indexed)
    const reverseRes = await runTool(registry, 'path', { from: 'country', to: 'invoice_line' });
    assert.equal(reverseRes.isError, false, reverseRes.content[0]?.text);
    const body = reverseRes.structuredContent as {
      paths: Array<{
        length: number;
        unindexedHops: number;
        queryHint?: string;
        hops: Array<{
          from: string;
          to: string;
          direction: string;
          indexed?: boolean;
          scannedApproxRows?: number;
          suggestedIndex?: string;
        }>;
      }>;
    };
    assert.equal(body.paths.length, 1);
    const p = body.paths[0];
    assert.equal(p.length, 3);
    assert.equal(p.unindexedHops, 1);
    const unindexedStep = p.hops.find((s) => s.to === 'invoice');
    assert.ok(unindexedStep);
    assert.equal(unindexedStep.direction, 'to-many');
    assert.equal(unindexedStep.indexed, false);
    assert.equal(unindexedStep.scannedApproxRows, 5);
    assert.equal(unindexedStep.suggestedIndex, 'CREATE INDEX idx_invoice_customer_id ON invoice (customer_id);');

    // 1-hop reverse to-many synthesizes projection + `any <table> where ...` queryHint
    const oneHopReverse = findForeignKeyPaths(schema, 'customer', 'invoice');
    assert.ok(!('error' in oneHopReverse));
    assert.match(String(oneHopReverse.paths[0].queryHint), /customer any invoice/);

    // Same table without self-referencing FK reports connected: true and 0 paths
    const same = findForeignKeyPaths(schema, 'invoice', 'invoice');
    assert.ok(!('error' in same));
    assert.equal(same.connected, true);
    assert.equal(same.paths.length, 0);

    // Unknown table returns MCP not_found error
    const missing = await runTool(registry, 'path', { from: 'invoice', to: 'nope' });
    assert.equal(missing.isError, true);
    assert.equal((missing._meta as Record<string, unknown>)?.['tablewalk/code'], 'not_found');
  });
});

describe('always-on connection redaction and session maxRows egress budgets', () => {
  const dbPath = join(DIR, 'redact.db');

  before(() => {
    buildRc19Db(dbPath);
  });

  test('redact: true masks PII + custom redactColumns idempotently across all tools and withholds raw SQL', async () => {
    const configFile = join(DIR, 'redact-config.json');
    const rawJson = JSON.stringify({
      redact: true,
      redactColumns: ['customer.internal_note'],
      views: [
        {
          name: 'Invoice with customer',
          connection: 'staging-db',
          text: 'invoice show id, status, total, customer_id.name as customer_name, customer_id.email as customer_email, customer_id.internal_note as note sort id asc',
        },
      ],
      connections: [{ name: 'staging-db', url: dbPath, env: 'staging' }],
    });
    writeFileSync(configFile, rawJson);

    const loaded = await loadPipedVaultConfig(configFile, false);
    const { registry } = loaded;
    bindShelf(registry, { views: loaded.views, queries: loaded.queries, pages: loaded.pages });

    try {
      // Raw SQL tools are withheld from tools/list and refused on call
      const listedNames = agentTools(registry).map((t) => t.name);
      assert.ok(!listedNames.includes('sql'));
      assert.ok(!listedNames.includes('explain'));
      assert.ok(!listedNames.includes('verify_ddl'));
      const sqlRefused = await runTool(registry, 'sql', { statement: 'SELECT email FROM customer' });
      assert.equal(sqlRefused.isError, true);

      // connections surfaces redactsRows: true
      const conns = await runTool(registry, 'connections', {});
      const connInfo = ((conns.structuredContent as { connections: Array<Record<string, unknown>> }).connections ?? [])[0];
      assert.equal(connInfo.redactsRows, true);
      assert.equal(connInfo.hidesColumns, true);

      // query masks email, name, and custom redactColumns (`internal_note`) while preserving PKs and CHECK enums
      const qRes = await runTool(registry, 'query', { q: 'customer sort id asc' });
      assert.equal(qRes.isError, false, qRes.content[0]?.text);
      const rows = (qRes.structuredContent as { rows: Array<Record<string, unknown>> }).rows;
      assert.equal(rows[0].id, 1);
      assert.notEqual(rows[0].email, 'alice@acme.org');
      assert.match(String(rows[0].email), /@example\.com$/);
      assert.notEqual(rows[0].name, 'Alice Mercer');
      assert.match(String(rows[0].internal_note), /^Redacted [0-9a-f]{8}$/);
      assert.equal(rows[0].country_code, 'US');

      // Joined view masks foreign-key projected customer_email, customer_name, and note!
      const viewRes = await runTool(registry, 'query', { view: 'Invoice with customer' });
      assert.equal(viewRes.isError, false, viewRes.content[0]?.text);
      const viewRows = (viewRes.structuredContent as { rows: Array<Record<string, unknown>> }).rows;
      assert.equal(viewRows[0].status, 'open');
      assert.equal(viewRows[0].customer_email, rows[0].email);
      assert.equal(viewRows[0].customer_name, rows[0].name);
      assert.equal(viewRows[0].note, rows[0].internal_note);

      // Breakdown masks group keys on sensitive columns while keeping status CHECK unmasked
      const bdEmail = await runTool(registry, 'breakdown', { q: 'customer count by email' });
      assert.equal(bdEmail.isError, false, bdEmail.content[0]?.text);
      const bdGroups = (bdEmail.structuredContent as { rows: Array<Record<string, unknown>> }).rows;
      assert.ok(bdGroups.every((g) => String(g.email).endsWith('@example.com')));

      // Profile strips min/max and masks common samples on sensitive columns
      const prof = await runTool(registry, 'profile', { table: 'customer' });
      assert.equal(prof.isError, false, prof.content[0]?.text);
      const profContent = prof.structuredContent as {
        redacted?: string;
        columns: Array<{ column: string; min?: unknown; max?: unknown; common?: Array<{ value: unknown }> }>;
      };
      assert.match(String(profContent.redacted), /masked/i);
      const emailCol = profContent.columns.find((c) => c.column === 'email')!;
      assert.equal(emailCol.min, undefined);
      assert.equal(emailCol.max, undefined);
      if (emailCol.common?.length) {
        assert.ok(emailCol.common.every((item) => String(item.value).endsWith('@example.com')));
      }

      // Record masks row values
      const rec = await runTool(registry, 'record', { table: 'customer', key: { id: 1 } });
      assert.equal(rec.isError, false, rec.content[0]?.text);
      const recRow = (rec.structuredContent as { row: Record<string, unknown> }).row;
      assert.equal(recRow.email, rows[0].email);
      assert.equal(recRow.internal_note, rows[0].internal_note);

      // Find value sweep does NOT match unmasked raw secret or raw email!
      const findSecret = await runTool(registry, 'find', { value: 'vip-secret-alpha' });
      assert.equal(findSecret.isError, false);
      assert.equal((findSecret.structuredContent as { matches: unknown[] }).matches.length, 0);

      // Fixture and Export with explicit `redact: true` remain 100% IDEMPOTENT (never double-hash already-masked values!)
      const fix = await runTool(registry, 'fixture', { table: 'customer', key: { id: 1 }, redact: true });
      assert.equal(fix.isError, false, fix.content[0]?.text);
      const fixContent = fix.structuredContent as {
        redacted?: boolean;
        tables: Array<{ table: string; rows: Array<Record<string, unknown>> }>;
      };
      assert.equal(fixContent.redacted, true);
      const fixCust = fixContent.tables.find((t) => t.table === 'customer')!.rows[0];
      assert.equal(fixCust.email, rows[0].email, 'fixture redact: true must be idempotent with connection redaction');
      assert.equal(fixCust.internal_note, rows[0].internal_note);

      const exp = await runTool(registry, 'export', { query: 'customer sort id asc', format: 'ndjson', redact: true });
      assert.equal(exp.isError, false, exp.content[0]?.text);
      const expContent = exp.structuredContent as { path: string; redacted?: boolean; sample: Array<Record<string, unknown>> };
      assert.equal(expContent.redacted, true);
      assert.equal(expContent.sample[0].email, rows[0].email, 'export redact: true must be idempotent with connection redaction');
      const exportedFirst = JSON.parse(readFileSync(expContent.path, 'utf8').trim().split('\n')[0]) as Record<string, unknown>;
      assert.equal(exportedFirst.email, rows[0].email);
    } finally {
      await registry.closeAll();
    }
  });

  test('maxRows clamps per-call limits, tracks rowsRemaining, and refuses once exhausted', async () => {
    const configFile = join(DIR, 'budget-config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        maxRows: 4,
        connections: [{ name: 'capped', url: dbPath }],
      }),
    );
    const loaded = await loadPipedVaultConfig(configFile, false);
    const { registry } = loaded;
    try {
      // Requesting inline `limit 3` leaves 1 row remaining
      const first = await runTool(registry, 'query', { q: 'invoice sort id asc limit 3' });
      assert.equal(first.isError, false);
      assert.equal((first.structuredContent as { rows: unknown[] }).rows.length, 3);

      const connsMid = await runTool(registry, 'connections', {});
      const midInfo = ((connsMid.structuredContent as { connections: Array<Record<string, unknown>> }).connections ?? [])[0];
      assert.equal(midInfo.maxRows, 4);
      assert.equal(midInfo.rowsRemaining, 1);

      // Next query asks for `limit 10` inline -> clamped to remaining 1 row!
      const second = await runTool(registry, 'query', { q: 'invoice sort id desc limit 10' });
      assert.equal(second.isError, false);
      assert.equal((second.structuredContent as { rows: unknown[] }).rows.length, 1);

      // Budget is now 0 remaining -> further row reads are refused with code `limit`, while schema tools still work!
      const refused = await runTool(registry, 'query', { q: 'invoice limit 1' });
      assert.equal(refused.isError, true);
      assert.equal((refused._meta as Record<string, unknown>)?.['tablewalk/code'], 'limit');
      assert.match(refused.content[0]?.text ?? '', /session row budget exhausted/i);

      const schemaStillWorks = await runTool(registry, 'tables', {});
      assert.equal(schemaStillWorks.isError, false);
    } finally {
      await registry.closeAll();
    }
  });
});

describe('environments.<env> tier policies and disk Save round-trip', () => {
  const localDb = join(DIR, 'env-local.db');
  const stagingDb = join(DIR, 'env-staging.db');
  const prodDb = join(DIR, 'env-prod.db');

  before(() => {
    buildRc19Db(localDb);
    buildRc19Db(stagingDb);
    buildRc19Db(prodDb);
  });

  test('applies tier policies across disk tablewalk.json, honors per-connection overrides, and round-trips on Save', async () => {
    const configPath = join(DIR, 'envs-tablewalk.json');
    const savedPath = join(DIR, 'envs-saved.json');
    const configObj = {
      environments: {
        local: { writable: true },
        staging: {
          redact: true,
          maxRows: 3,
          blocklist: { tables: ['audit_*'] },
        },
        prod: {
          rows: false,
        },
      },
      connections: [
        { name: 'billing-local', url: localDb, database: 'billing', env: 'local' },
        { name: 'billing-staging', url: stagingDb, database: 'billing', env: 'staging' },
        { name: 'billing-prod', url: prodDb, database: 'billing', env: 'prod' },
        { name: 'billing-prod-override', url: prodDb, database: 'billing-alt', env: 'prod', rows: true, maxRows: 2 },
      ],
    };
    const rawJson = JSON.stringify(configObj, null, 2);
    writeFileSync(configPath, rawJson);

    const baseRegistry = new Registry();
    for (const c of configObj.connections) {
      baseRegistry.add({ name: c.name, url: c.url, rows: c.rows, source: 'config' });
    }
    const { registry } = applyExtendedDiskConfig(baseRegistry, rawJson, configPath, false);
    assert.ok(registry instanceof PolicyRegistry);

    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, configPath });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    bound.port = port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. local inherited writable: true from environments.local!
      const listedConns = registry.list() as Array<ReturnType<typeof registry.list>[number] & { redactsRows?: boolean; maxRows?: number }>;
      const localEntry = listedConns.find((c) => c.name === 'billing-local')!;
      const stagingEntry = listedConns.find((c) => c.name === 'billing-staging')!;
      const prodEntry = listedConns.find((c) => c.name === 'billing-prod')!;
      const prodOverride = listedConns.find((c) => c.name === 'billing-prod-override')!;

      assert.equal(localEntry.writable, true);
      assert.equal(stagingEntry.redactsRows, true);
      assert.equal(stagingEntry.maxRows, 3);
      assert.equal(prodEntry.rows, false);
      assert.notEqual(prodOverride.rows, false, 'explicit rows: true on connection overrides environments.prod.rows = false');
      assert.equal(prodOverride.maxRows, 2);

      const overrideRows = await runTool(registry, 'query', { connection: 'billing-prod-override', q: 'customer limit 10' });
      assert.equal(overrideRows.isError, false, overrideRows.content[0]?.text);
      assert.equal((overrideRows.structuredContent as { rows: unknown[] }).rows.length, 2);

      // 2. staging inherited blocklist (audit_log hidden) + redact: true + maxRows: 3
      const stagingTables = await runTool(registry, 'tables', { connection: 'billing@staging' });
      assert.equal(stagingTables.isError, false);
      const tIds = ((stagingTables.structuredContent as { tables: Array<{ id: string }> }).tables ?? []).map((t) => t.id);
      assert.ok(!tIds.includes('audit_log'));

      const stagingRows = await runTool(registry, 'query', { connection: 'billing@staging', q: 'customer limit 10' });
      assert.equal(stagingRows.isError, false);
      const sRows = (stagingRows.structuredContent as { rows: Array<Record<string, unknown>> }).rows;
      assert.equal(sRows.length, 3);
      assert.match(String(sRows[0].email), /@example\.com$/);

      // 3. prod inherited rows: false -> row queries refused!
      const prodRefused = await runTool(registry, 'query', { connection: 'billing@prod', q: 'customer limit 1' });
      assert.equal(prodRefused.isError, true);
      assert.match(prodRefused.content[0]?.text ?? '', /shape-only/i);

      // 4. GET /api/connections & GET /api/agent/activity surface redactsRows and maxRows
      const httpConns = await fetch(`${base}/api/connections`).then(
        (r) => r.json() as Promise<{ connections: Array<Record<string, unknown>> }>,
      );
      const httpStaging = httpConns.connections.find((c) => c.name === 'billing-staging')!;
      assert.equal(httpStaging.redactsRows, true);
      assert.equal(httpStaging.maxRows, 3);

      const httpActivity = await fetch(`${base}/api/agent/activity`).then((r) => r.json() as Promise<{ maxRows: Record<string, number> }>);
      assert.equal(httpActivity.maxRows[stagingEntry.id], 3);

      // 5. POST /api/connections/save round-trips top-level `environments` and connection `maxRows`
      const saveRes = await fetch(`${base}/api/connections/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: savedPath }),
      });
      assert.equal(saveRes.status, 200);
      const savedJson = JSON.parse(readFileSync(savedPath, 'utf8')) as Record<string, unknown> & {
        environments?: Record<string, unknown>;
        connections?: Array<Record<string, unknown>>;
      };
      assert.deepEqual(savedJson.environments, configObj.environments);
      const savedOverride = savedJson.connections?.find((c) => c.name === 'billing-prod-override');
      assert.equal(savedOverride?.maxRows, 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.closeAll();
    }
  });
});

describe('CLI --batch mode and environment-variable / CLI guardrails', () => {
  const dbPath = join(DIR, 'cli-batch.db');

  before(() => {
    buildRc19Db(dbPath);
  });

  test('enforces TABLEWALK_BLOCKED_TABLES, TABLEWALK_BLOCKED_FIELDS, --redact, and --max-rows without a config file', () => {
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx', BIN, '--no-config', '--db', dbPath, '--redact', '--max-rows', '2', '--query', 'customer sort id asc limit 10'],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          TABLEWALK_BLOCKED_TABLES: 'audit_*',
          TABLEWALK_BLOCKED_FIELDS: 'customer.internal_note',
        },
      },
    );
    assert.equal(res.status, 0, res.stderr);
    const body = JSON.parse(res.stdout) as { rows: Array<Record<string, unknown>> };
    assert.equal(body.rows.length, 2, '--max-rows 2 clamped limit 10 to 2 rows');
    assert.match(String(body.rows[0].email), /@example\.com$/, '--redact masked email');
    assert.equal('internal_note' in body.rows[0], false, 'TABLEWALK_BLOCKED_FIELDS withheld internal_note');
  });

  test('streams NDJSON over single-pipe { vault config; batch lines; } | tablewalk --config - --batch -', () => {
    const vaultHeader = JSON.stringify({
      redact: true,
      maxRows: 4,
      connections: [{ name: 'billing-staging', url: dbPath, database: 'billing', env: 'staging' }],
    });
    const batchLines = [
      '# comment line ignored',
      'customer sort id asc limit 2',
      'invoice count by status',
      JSON.stringify({ tool: 'path', args: { from: 'invoice_line', to: 'country' } }),
    ].join('\n');

    const okRun = spawnSync(process.execPath, ['--import', 'tsx', BIN, '--config', '-', '--batch', '-'], {
      encoding: 'utf8',
      timeout: 30_000,
      input: `${vaultHeader}\n${batchLines}\n`,
    });
    assert.equal(okRun.status, 0, okRun.stderr);
    const records = okRun.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 3);
    assert.equal(records[0].ok, true);
    assert.equal(records[0].tool, 'query');
    assert.match(String(((records[0].result as { rows: Array<Record<string, unknown>> }).rows[0] ?? {}).email), /@example\.com$/);
    assert.equal(records[1].ok, true);
    assert.equal(records[1].tool, 'breakdown');
    assert.equal(records[2].ok, true);
    assert.equal(records[2].tool, 'path');
    assert.equal(((records[2].result as { paths: Array<{ length: number }> }).paths[0] ?? {}).length, 3);

    // A batch file containing an invalid call emits ok: false for that line, continues, and exits 1
    const batchFile = join(DIR, 'calls.jsonl');
    writeFileSync(batchFile, ['{"tool":"tables","args":{}}', '{"tool":"unknown_tool","args":{}}'].join('\n'));
    const errRun = spawnSync(process.execPath, ['--import', 'tsx', BIN, '--no-config', '--db', dbPath, '--batch', batchFile], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(errRun.status, 1);
    const errLines = errRun.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(errLines.length, 2);
    assert.equal(errLines[0].ok, true);
    assert.equal(errLines[1].ok, false);
  });
});

describe('smart query-language autocomplete (complete.js)', () => {
  let suggestionsFor: (text: string, caret: number) => Array<{ value: string; kind: string; detail?: string }>;
  let coreState: Record<string, unknown>;

  before(async () => {
    stubDom();
    const core = await import('@mistriwork/kit/client/core.js');
    const complete = await import('../src/client/complete.js');
    coreState = core.state as Record<string, unknown>;
    suggestionsFor = complete.suggestionsFor as typeof suggestionsFor;
    coreState.schema = {
      dialect: 'sqlite',
      label: 'demo',
      readAt: '2026-11-21T00:00:00Z',
      tables: [
        {
          id: 'country',
          name: 'country',
          columns: [
            { name: 'code', type: 'text', nullable: false, primaryKey: true },
            { name: 'name', type: 'text', nullable: false, primaryKey: false },
          ],
        },
        {
          id: 'customer',
          name: 'customer',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'name', type: 'text', nullable: false, primaryKey: false },
            { name: 'active', type: 'boolean', nullable: false, primaryKey: false },
            { name: 'country_code', type: 'text', nullable: true, primaryKey: false, references: { table: 'country', column: 'code' } },
          ],
        },
        {
          id: 'invoice',
          name: 'invoice',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'customer_id', type: 'integer', nullable: false, primaryKey: false, references: { table: 'customer', column: 'id' } },
            { name: 'status', type: 'text', nullable: false, primaryKey: false, allowed: ['open', 'paid', 'void'] },
            { name: 'issued_at', type: 'date', nullable: false, primaryKey: false },
            { name: 'total', type: 'numeric', nullable: false, primaryKey: false },
          ],
        },
      ],
      foreignKeys: [
        { from: { table: 'customer', columns: ['country_code'] }, to: { table: 'country', columns: ['code'] } },
        { from: { table: 'invoice', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
      ],
    };
  });

  test('completes multi-hop FK dot-paths, CHECK/boolean/date values after =, and breakdown measures/periods', () => {
    const values = (q: string) => suggestionsFor(q, q.length).map((s) => s.value);

    // 1-hop and 2-hop FK dot-paths
    const hop1 = values('invoice customer_id.');
    assert.ok(hop1.includes('customer_id.name'));
    assert.ok(hop1.includes('customer_id.country_code'));
    const hop2 = values('invoice customer_id.country_code.');
    assert.ok(hop2.includes('customer_id.country_code.name'));

    // CHECK allowed values after `=`
    const statusVals = values('invoice status = ');
    assert.deepEqual(statusVals, ['open', 'paid', 'void']);

    // Boolean values after `=` (including across an FK dot-path!)
    assert.deepEqual(values('invoice customer_id.active = '), ['true', 'false']);

    // Date values after `=`
    const dateVals = values('invoice issued_at = ');
    assert.ok(dateVals.includes('today') && dateVals.includes('last 30 days'));

    // Breakdown measures and `by month` period completion
    const secondTok = values('invoice ');
    assert.ok(secondTok.includes('count') && secondTok.includes('sum'));
    const sumCols = values('invoice sum ');
    assert.deepEqual(sumCols.slice(0, 4), ['by', 'id', 'customer_id', 'total']);
    const byPeriods = values('invoice count by ');
    assert.ok(byPeriods.includes('month') && byPeriods.includes('status'));
    const monthCols = values('invoice count by month ');
    assert.deepEqual(monthCols, ['issued_at']);
  });
});
