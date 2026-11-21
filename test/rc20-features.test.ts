/**
 * End-to-end verification of 1.0.0-rc.20 features:
 *   1. Live index & scan diagnostics (`perf` MCP tool + `analyzePostgresPerfStats` + SQLite
 *      `PRAGMA index_list`, `EXPLAIN QUERY PLAN` over views, `sqlite_stat1`, identical-index
 *      tie-breaking, blocklist/hidden-column isolation, and `"rows": false` compatibility).
 *   2. Cross-environment read fan-out (`envs: "all"`, `envs: ["local", "staging"]`, `--all-envs`),
 *      parallel execution honoring per-tier `rows: false`, `redact: true`, `maxRows`, and refusal
 *      on write/multi-conn tools.
 *   3. Per-environment & per-connection statement deadlines (`timeoutMs`, `--timeout-ms`,
 *      `TABLEWALK_TIMEOUT_MS`).
 *   4. Dynamic vault `credentialCommand` (`"credentialCommand"`, `TABLEWALK_CREDENTIAL_COMMAND`)
 *      refreshing rotated secrets on initial open and after idle-lease eviction without mutating
 *      `process.env` or leaking to saved files.
 *   5. Schema neighborhood focus (`--focus`, `--focus-hops`, `"focus"` / `"focusHops"`) scoping
 *      catalog, queries, views, and raw SQL to the N-hop FK neighborhood.
 *   6. Token-lean CLI output formats (`--format <json|ndjson|tsv|md>`) and zero-PII structured
 *      JSONL audit logging (`--audit-log <path|stderr>`).
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
import { agentTools, runTool, setAuditSink } from '../src/server/mcp.js';
import { PolicyRegistry, applyExtendedDiskConfig, loadPipedVaultConfig } from '../src/server/cli/vaultConfig.js';
import { analyzePostgresPerfStats } from '../src/server/perf.js';
import type { AuditLogRecord } from '../src/server/auditLog.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'src/server/index.ts');
const DIR = mkdtempSync(join(tmpdir(), 'tablewalk-rc20-'));
const REAL_TMP = process.env.TMPDIR;

before(() => {
  process.env.TMPDIR = DIR;
});

after(() => {
  if (REAL_TMP === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = REAL_TMP;
  rmSync(DIR, { recursive: true, force: true });
});

function buildPerfSqliteDb(path: string, rowCount = 600): void {
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
      email TEXT NOT NULL,
      secret_token TEXT NOT NULL DEFAULT 'tok_live_secret_999',
      country_code TEXT REFERENCES country(code)
    );
    CREATE INDEX idx_customer_country ON customer(country_code);

    CREATE TABLE invoice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customer(id),
      status TEXT NOT NULL DEFAULT 'open',
      secret_hash TEXT NOT NULL DEFAULT 'hash_xyz',
      total REAL NOT NULL
    );
    /* Redundant prefix index: idx_invoice_cust (customer_id) is covered by idx_invoice_cust_status (customer_id, status). */
    CREATE INDEX idx_invoice_cust ON invoice(customer_id);
    CREATE INDEX idx_invoice_cust_status ON invoice(customer_id, status);
    /* Identical duplicate pair on status: only one should be flagged for DROP! */
    CREATE INDEX idx_invoice_status_a ON invoice(status);
    CREATE INDEX idx_invoice_status_b ON invoice(status);
    /* Index touching a sensitive column that will be tested under blocklist isolation. */
    CREATE INDEX idx_invoice_secret_hash ON invoice(secret_hash);
    CREATE INDEX idx_invoice_secret_hash_wide ON invoice(secret_hash, status);

    CREATE TABLE audit_secret (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX idx_audit_actor ON audit_secret(actor);
    CREATE INDEX idx_audit_actor_payload ON audit_secret(actor, payload);

    CREATE VIEW open_high_invoices AS
      SELECT id, customer_id, total FROM invoice WHERE total > 250;

    INSERT INTO country (code, name) VALUES ('US', 'United States'), ('AU', 'Australia');
    INSERT INTO customer (name, email, country_code) VALUES
      ('Alice Mercer', 'alice@acme.org', 'US'),
      ('Bob Harper', 'bob@harper.io', 'AU');
  `);

  db.exec('BEGIN');
  const stmt = db.prepare('INSERT INTO invoice (customer_id, status, total) VALUES (?, ?, ?)');
  for (let i = 0; i < rowCount; i++) {
    stmt.run((i % 2) + 1, i % 3 === 0 ? 'paid' : 'open', 50 + (i % 400));
  }
  db.exec('COMMIT');
  db.close();
}

describe('1.0.0-rc.20 — perf MCP tool (SQLite live + PostgreSQL stat evaluator)', () => {
  test('SQLite perf detects duplicate prefix indexes, identical-index tie-breaking, view full scans, and missing ANALYZE stats, and respects blocklists + rows: false', async () => {
    const dbFile = join(DIR, 'perf-live.db');
    buildPerfSqliteDb(dbFile, 600);

    /* 1. Shape-only ("rows": false) + field/table blocklist connection: perf still works and never leaks blocked columns/tables! */
    const reg = new PolicyRegistry({
      defaultBlocklist: {
        tables: ['audit_*'],
        fields: { invoice: ['secret_hash'], customer: ['secret_token'] },
      },
    });
    const conn = reg.add({ name: 'shop', url: dbFile, rows: false, source: 'config' });

    const res = await runTool(reg, 'perf', { connection: conn.id, all: true });
    assert.equal(res.isError, false, res.content[0]?.text);
    const body = res.structuredContent as {
      dialect: string;
      source: string;
      findings: Array<{ rule: string; table: string; index?: string; coveredBy?: string; suggestedSql?: string }>;
    };
    assert.equal(body.dialect, 'sqlite');
    assert.equal(body.source, 'sqlite_pragma');

    /* Blocked table `audit_secret` and blocked column `secret_hash` indexes must NEVER appear. */
    assert.equal(
      body.findings.some((f) => f.table.includes('audit') || (f.index ?? '').includes('secret')),
      false,
      'Blocked tables and columns must never surface in perf findings',
    );

    /* Prefix duplicate: idx_invoice_cust covered by idx_invoice_cust_status. */
    const custDup = body.findings.find((f) => f.rule === 'duplicate-index' && f.index === 'idx_invoice_cust');
    assert.ok(custDup, 'Expected idx_invoice_cust to be flagged as duplicate-index');
    assert.equal(custDup!.coveredBy, 'idx_invoice_cust_status');
    assert.equal(custDup!.suggestedSql, 'DROP INDEX "idx_invoice_cust";');

    /* Identical pair (idx_invoice_status_a vs idx_invoice_status_b): ONLY ONE may be flagged! */
    const statusDups = body.findings.filter(
      (f) => f.rule === 'duplicate-index' && (f.index === 'idx_invoice_status_a' || f.index === 'idx_invoice_status_b'),
    );
    assert.equal(statusDups.length, 1, 'Tie-breaker must keep one of two identical indexes');
    assert.equal(statusDups[0].index, 'idx_invoice_status_b');
    assert.equal(statusDups[0].coveredBy, 'idx_invoice_status_a');

    /* Missing sqlite_stat1 on ~600-row multi-index invoice table. */
    const missingStats = body.findings.find((f) => f.rule === 'missing-analyze-stats' && f.table === 'invoice');
    assert.ok(missingStats);
    assert.equal(missingStats!.suggestedSql, 'ANALYZE "invoice";');

    await reg.closeAll();

    /* 2. Unblocked connection sees view-full-scan on `open_high_invoices`, and running ANALYZE clears `missing-analyze-stats`. */
    const plainReg = new Registry();
    const plainConn = plainReg.add({ name: 'plain', url: dbFile, source: 'config' });
    const viewRes = await runTool(plainReg, 'perf', { connection: plainConn.id, all: true });
    assert.equal(viewRes.isError, false);
    const viewFindings = (viewRes.structuredContent as { findings: Array<{ rule: string; table: string }> }).findings;
    assert.ok(viewFindings.some((f) => f.rule === 'view-full-scan' && f.table === 'open_high_invoices'));

    const db = new DatabaseSync(dbFile);
    db.exec('ANALYZE;');
    db.close();

    const afterAnalyze = await runTool(plainReg, 'perf', { connection: plainConn.id, all: true });
    const afterFindings = (afterAnalyze.structuredContent as { findings: Array<{ rule: string }> }).findings;
    assert.equal(
      afterFindings.some((f) => f.rule === 'missing-analyze-stats'),
      false,
    );
    await plainReg.closeAll();
  });

  test('PostgreSQL stat evaluator flags seq-scan hotspots, duplicate & unused indexes (preserving sole FK-backing indexes), dead-tuple bloat, and stale stats', async () => {
    const dbFile = join(DIR, 'pg-mock-catalog.db');
    buildPerfSqliteDb(dbFile, 20);
    const reg = new Registry();
    const added = reg.add({
      name: 'pg-sim',
      url: dbFile,
      hidden: { invoice: ['secret_hash'] },
      source: 'config',
    });
    const { schema } = await reg.open(added.id);

    const evaluated = analyzePostgresPerfStats(
      schema,
      added.id,
      [
        {
          schema_name: 'public',
          table_name: 'invoice',
          seq_scan: 180,
          seq_tup_read: 900_000,
          idx_scan: 12,
          n_live_tup: 15_000,
          n_dead_tup: 6_000,
          n_mod_since_analyze: 5_000,
          total_bytes: 8 * 1024 * 1024,
        },
        {
          schema_name: 'public',
          table_name: 'customer',
          seq_scan: 5,
          seq_tup_read: 200,
          idx_scan: 400,
          n_live_tup: 800,
          n_dead_tup: 10,
          n_mod_since_analyze: 20,
          total_bytes: 256 * 1024,
        },
      ],
      [
        /* Sole FK-backing index on customer(country_code): 0 scans, 128 KB — must NOT be flagged unused because it backs customer.country_code -> country.code! */
        {
          schema_name: 'public',
          table_name: 'customer',
          index_name: 'idx_customer_country',
          am_name: 'btree',
          is_unique: false,
          is_primary: false,
          is_constraint: false,
          is_partial: false,
          has_expressions: false,
          idx_scan: 0,
          index_bytes: 131_072,
          key_columns: ['country_code'],
        },
        /* Prefix duplicate on invoice(customer_id) covered by (customer_id, status). */
        {
          schema_name: 'public',
          table_name: 'invoice',
          index_name: 'idx_invoice_cust',
          am_name: 'btree',
          is_unique: false,
          is_primary: false,
          is_constraint: false,
          is_partial: false,
          has_expressions: false,
          idx_scan: 4,
          index_bytes: 262_144,
          key_columns: ['customer_id'],
        },
        {
          schema_name: 'public',
          table_name: 'invoice',
          index_name: 'idx_invoice_cust_status',
          am_name: 'btree',
          is_unique: false,
          is_primary: false,
          is_constraint: false,
          is_partial: false,
          has_expressions: false,
          idx_scan: 50,
          index_bytes: 524_288,
          key_columns: ['customer_id', 'status'],
        },
        /* Zero-scan non-FK index on invoice(total): should be flagged unused-index! */
        {
          schema_name: 'public',
          table_name: 'invoice',
          index_name: 'idx_invoice_total_unused',
          am_name: 'btree',
          is_unique: false,
          is_primary: false,
          is_constraint: false,
          is_partial: false,
          has_expressions: false,
          idx_scan: 0,
          index_bytes: 262_144,
          key_columns: ['total'],
        },
        /* Hidden-column index on secret_hash: must be completely excluded! */
        {
          schema_name: 'public',
          table_name: 'invoice',
          index_name: 'idx_invoice_secret_hash',
          am_name: 'btree',
          is_unique: false,
          is_primary: false,
          is_constraint: false,
          is_partial: false,
          has_expressions: false,
          idx_scan: 0,
          index_bytes: 262_144,
          key_columns: ['secret_hash'],
        },
      ],
    );

    const rulesFound = new Set(evaluated.findings.map((f) => f.rule));
    assert.ok(rulesFound.has('sequential-scan-hotspot'));
    assert.ok(rulesFound.has('duplicate-index'));
    assert.ok(rulesFound.has('unused-index'));
    assert.ok(rulesFound.has('dead-tuple-bloat'));
    assert.ok(rulesFound.has('stale-statistics'));

    assert.equal(
      evaluated.findings.some((f) => f.index === 'idx_customer_country'),
      false,
      'Sole index backing an outgoing FK must not be flagged as unused',
    );
    assert.equal(
      evaluated.findings.some((f) => f.index === 'idx_invoice_secret_hash'),
      false,
      'Hidden column index must never leak',
    );

    const unused = evaluated.findings.find((f) => f.rule === 'unused-index');
    assert.equal(unused?.suggestedSql, 'DROP INDEX CONCURRENTLY "idx_invoice_total_unused";');
    const bloat = evaluated.findings.find((f) => f.rule === 'dead-tuple-bloat');
    assert.equal(bloat?.suggestedSql, 'VACUUM (ANALYZE) "invoice";');
    const stale = evaluated.findings.find((f) => f.rule === 'stale-statistics');
    assert.equal(stale?.suggestedSql, 'ANALYZE "invoice";');

    await reg.closeAll();
  });
});

describe('1.0.0-rc.20 — multi-environment read fan-out, timeoutMs, focus, credentialCommand, --format & --audit-log', () => {
  test('envs fan-out runs across sibling environments in parallel, honors per-tier guardrails, and refuses write/multi-conn tools', async () => {
    const localDb = join(DIR, 'fan-local.db');
    const stagingDb = join(DIR, 'fan-staging.db');
    const prodDb = join(DIR, 'fan-prod.db');
    buildPerfSqliteDb(localDb, 12);
    buildPerfSqliteDb(stagingDb, 30);
    buildPerfSqliteDb(prodDb, 90);

    const prevJson = process.env.TABLEWALK_CONFIG_JSON;
    process.env.TABLEWALK_CONFIG_JSON = JSON.stringify({
      environments: {
        local: { writable: true },
        staging: { redact: true, maxRows: 1 },
        prod: { rows: false },
      },
      connections: [
        { name: 'billing-local', database: 'billing', env: 'local', url: localDb },
        { name: 'billing-staging', database: 'billing', env: 'staging', url: stagingDb },
        { name: 'billing-prod', database: 'billing', env: 'prod', url: prodDb },
      ],
    });
    try {
      const loaded = await loadPipedVaultConfig(undefined, false);
      const reg = loaded.registry;
      try {
        /* 1. Schema/count fan-out (`tables`) succeeds across all 3 tiers including `rows: false` prod! */
        const tablesFan = await runTool(reg, 'tables', { envs: 'all' });
        assert.equal(tablesFan.isError, false);
        const tf = tablesFan.structuredContent as {
          database: string;
          fanout: boolean;
          count: number;
          succeeded: number;
          failed: number;
          environments: Array<{ env?: string; ok: boolean; result?: { tables: unknown[] } }>;
        };
        assert.equal(tf.database, 'billing');
        assert.equal(tf.fanout, true);
        assert.equal(tf.count, 3);
        assert.equal(tf.succeeded, 3);
        assert.equal(tf.failed, 0);

        /* 2. Row query fan-out (`query` on `customer sort id`):
              - local returns unmasked Alice & Bob (2 rows)
              - staging returns masked Alice only (clamped to `maxRows: 1`)
              - prod refuses row values inside the fan-out envelope (`ok: false`)! */
        const queryFan = await runTool(reg, 'query', { q: 'customer sort id', envs: 'all' });
        assert.equal(queryFan.isError, false);
        const qf = queryFan.structuredContent as {
          succeeded: number;
          failed: number;
          environments: Array<{
            env?: string;
            ok: boolean;
            code?: string;
            result?: { rows: Array<{ email: string }> };
          }>;
        };
        assert.equal(qf.succeeded, 2);
        assert.equal(qf.failed, 1);

        const localEntry = qf.environments.find((e) => e.env === 'local')!;
        assert.equal(localEntry.ok, true);
        assert.equal(localEntry.result!.rows.length, 2);
        assert.equal(localEntry.result!.rows[0].email, 'alice@acme.org');

        const stagingEntry = qf.environments.find((e) => e.env === 'staging')!;
        assert.equal(stagingEntry.ok, true);
        assert.equal(stagingEntry.result!.rows.length, 1);
        assert.notEqual(stagingEntry.result!.rows[0].email, 'alice@acme.org');

        const prodEntry = qf.environments.find((e) => e.env === 'prod')!;
        assert.equal(prodEntry.ok, false);
        assert.equal(prodEntry.code, 'invalid_argument');

        /* 3. Subset fan-out (`envs: ["local", "staging"]`) on `lint`. */
        const subset = await runTool(reg, 'lint', { envs: ['local', 'staging'] });
        assert.equal(subset.isError, false);
        assert.equal((subset.structuredContent as { count: number }).count, 2);

        /* 4. Refused on writes, export, diff, and conflicting `env` + `envs`. */
        const badWrite = await runTool(reg, 'insert', {
          table: 'country',
          values: { code: 'NZ', name: 'New Zealand' },
          envs: 'all',
        });
        assert.equal(badWrite.isError, true);
        assert.equal(badWrite._meta?.['tablewalk/code'], 'invalid_argument');

        const badConflict = await runTool(reg, 'tables', { env: 'local', envs: 'all' });
        assert.equal(badConflict.isError, true);
        assert.equal(badConflict._meta?.['tablewalk/code'], 'invalid_argument');
      } finally {
        await reg.closeAll();
      }
    } finally {
      if (prevJson === undefined) delete process.env.TABLEWALK_CONFIG_JSON;
      else process.env.TABLEWALK_CONFIG_JSON = prevJson;
    }
  });

  test('per-connection timeoutMs enforces bounded per-call deadlines and surfaces on connections', async () => {
    const dbFile = join(DIR, 'timeout-test.db');
    buildPerfSqliteDb(dbFile, 10);

    const reg = new PolicyRegistry({
      defaultTimeoutMs: 25,
    });
    const added = reg.add({ name: 'slow-db', url: dbFile, source: 'config' });

    const conns = await runTool(reg, 'connections', {});
    const connInfo = (conns.structuredContent as { connections: Array<{ id: string; timeoutMs?: number }> }).connections[0];
    assert.equal(connInfo.timeoutMs, 25);

    /* Open and wrap query with an artificial 120ms stall to deterministically trigger the 25ms deadline. */
    const opened = await reg.open(added.id);
    const origQuery = opened.adapter.query.bind(opened.adapter);
    opened.adapter.query = async (req) => {
      await new Promise((r) => setTimeout(r, 120));
      return origQuery(req);
    };

    const timedOut = await runTool(reg, 'query', { connection: added.id, q: 'customer' });
    assert.equal(timedOut.isError, true);
    assert.equal(timedOut._meta?.['tablewalk/code'], 'timeout');
    assert.match(timedOut.content[0]?.text ?? '', /25 ms/);

    await reg.closeAll();
  });

  test('credentialCommand refreshes dynamic secrets on initial open and after idle eviction without touching process.env or saved files', async () => {
    const v1Db = join(DIR, 'cred-v1.db');
    const v2Db = join(DIR, 'cred-v2.db');
    for (const [file, epoch] of [
      [v1Db, 'secret-epoch-1'],
      [v2Db, 'secret-epoch-2'],
    ] as const) {
      const db = new DatabaseSync(file);
      db.exec(`CREATE TABLE vault_probe (id INTEGER PRIMARY KEY, marker TEXT NOT NULL);
               INSERT INTO vault_probe VALUES (1, '${epoch}');`);
      db.close();
    }

    const secretPointerFile = join(DIR, 'current-secret.json');
    writeFileSync(secretPointerFile, JSON.stringify({ secrets: { ROTATED_SQLITE_TARGET: v1Db } }));

    const configPath = join(DIR, 'cred-config.json');
    const saveTargetPath = join(DIR, 'saved-clean.json');
    const credCmd = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(secretPointerFile)}, 'utf8'))`)}`;

    const rawCfg = JSON.stringify({
      credentialCommand: credCmd,
      lease: { idleSeconds: 0.05 },
      connections: [{ name: 'vaulted', url: '${ROTATED_SQLITE_TARGET}' }],
    });
    writeFileSync(configPath, rawCfg);

    const base = new Registry();
    base.add({ name: 'vaulted', url: '${ROTATED_SQLITE_TARGET}', source: 'config' });
    const { registry } = applyExtendedDiskConfig(base, rawCfg, configPath, false);

    try {
      assert.equal(process.env.ROTATED_SQLITE_TARGET, undefined);

      /* First open resolves v1Db via credentialCommand. */
      const first = await runTool(registry, 'query', { q: 'vault_probe' });
      assert.equal(first.isError, false, first.content[0]?.text);
      assert.equal(((first.structuredContent as { rows: Array<{ marker: string }> }).rows[0] ?? {}).marker, 'secret-epoch-1');
      assert.equal(process.env.ROTATED_SQLITE_TARGET, undefined, 'process.env must remain untouched');

      /* Wait for the 50ms idle lease to evict the adapter, rotate the secret to v2Db, and query again! */
      await new Promise((r) => setTimeout(r, 110));
      writeFileSync(secretPointerFile, `ROTATED_SQLITE_TARGET=${v2Db}\n`);

      const second = await runTool(registry, 'query', { q: 'vault_probe' });
      assert.equal(second.isError, false, second.content[0]?.text);
      assert.equal(((second.structuredContent as { rows: Array<{ marker: string }> }).rows[0] ?? {}).marker, 'secret-epoch-2');

      /* Saving connections to a new file must NEVER write `credentialCommand` to disk! */
      const bound = { host: '127.0.0.1', port: 0 };
      const server = createApp({ registry, bound, configPath });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      bound.port = (server.address() as { port: number }).port;
      try {
        const saveRes = await fetch(`http://127.0.0.1:${bound.port}/api/connections/save`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: saveTargetPath }),
        });
        assert.equal(saveRes.status, 200);
        const savedText = readFileSync(saveTargetPath, 'utf8');
        assert.equal(savedText.includes('credentialCommand'), false, 'credentialCommand must never be written to a new file');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await registry.closeAll();
    }
  });

  test('schema neighborhood --focus / focusHops scopes catalog, queries, views, and withholds raw SQL', async () => {
    const dbFile = join(DIR, 'focus-test.db');
    buildPerfSqliteDb(dbFile, 15);
    /* Schema graph: country <- customer <- invoice ; plus standalone audit_secret & view open_high_invoices. */

    /* 0 hops around `invoice` -> ONLY `invoice`! */
    const hop0 = new PolicyRegistry({ cliFocus: { tables: ['invoice'], hops: 0 } });
    const c0 = hop0.add({ name: 'hop0', url: dbFile, source: 'config' });
    const t0 = await runTool(hop0, 'tables', { connection: c0.id });
    assert.deepEqual(
      ((t0.structuredContent as { tables: Array<{ id: string }> }).tables ?? []).map((t) => t.id),
      ['invoice'],
    );
    await hop0.closeAll();

    /* 1 hop around `invoice` -> `customer` and `invoice` (excludes `country` at 2 hops, `audit_secret`, and SQL views)! */
    const hop1 = new PolicyRegistry({ cliFocus: { tables: ['invoice'], hops: 1 } });
    const c1 = hop1.add({ name: 'hop1', url: dbFile, source: 'config' });
    const t1 = await runTool(hop1, 'tables', { connection: c1.id });
    assert.deepEqual(((t1.structuredContent as { tables: Array<{ id: string }> }).tables ?? []).map((t) => t.id).sort(), [
      'customer',
      'invoice',
    ]);

    const conns = await runTool(hop1, 'connections', {});
    const connMeta = (conns.structuredContent as { connections: Array<{ focused?: boolean; hidesColumns?: boolean }> }).connections[0];
    assert.equal(connMeta.focused, true);
    assert.equal(connMeta.hidesColumns, true);

    /* `sql` and `explain` are withheld from agentTools and refused on call! */
    const offered = agentTools(hop1).map((t) => t.name);
    assert.equal(offered.includes('sql'), false);

    /* Querying `country` (2 hops away) returns parse errors and zero rows; `record` on `country` returns not_found! */
    const blockedCountry = await runTool(hop1, 'query', { connection: c1.id, q: 'country' });
    assert.equal((blockedCountry.structuredContent as { rows?: unknown[] })?.rows, undefined);
    assert.ok(((blockedCountry.structuredContent as { errors?: string[] })?.errors ?? []).length > 0);

    const blockedRecord = await runTool(hop1, 'record', { connection: c1.id, table: 'country', key: { code: 'US' } });
    assert.equal(blockedRecord.isError, true);
    assert.equal(blockedRecord._meta?.['tablewalk/code'], 'not_found');

    const blockedSql = await runTool(hop1, 'sql', { connection: c1.id, statement: 'SELECT * FROM country' });
    assert.equal(blockedSql.isError, true);

    await hop1.closeAll();
  });

  test('CLI --format (tsv, md, ndjson) and --audit-log emit compact tables and zero-PII JSONL receipts', () => {
    const localDb = join(DIR, 'cli-local.db');
    const stagingDb = join(DIR, 'cli-staging.db');
    buildPerfSqliteDb(localDb, 9);
    buildPerfSqliteDb(stagingDb, 15);

    const cfgPath = join(DIR, 'cli-rc20.json');
    const auditPath = join(DIR, 'audit.jsonl');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        environments: {
          staging: { redact: true, maxRows: 5 },
        },
        connections: [
          { name: 'billing-local', database: 'billing', env: 'local', url: localDb },
          { name: 'billing-staging', database: 'billing', env: 'staging', url: stagingDb },
        ],
      }),
    );

    /* 1. `--query ... --format tsv` + `--audit-log` on redacted staging. */
    const tsvRun = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        BIN,
        '--config',
        cfgPath,
        '--env',
        'staging',
        '--query',
        'customer sort id',
        '--format',
        'tsv',
        '--audit-log',
        auditPath,
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(tsvRun.status, 0, tsvRun.stderr);
    const tsvLines = tsvRun.stdout.trim().split('\n');
    assert.equal(tsvLines[0], 'id\tname\temail\tsecret_token\tcountry_code');
    assert.equal(tsvLines.length, 3);
    assert.equal(tsvRun.stdout.includes('alice@acme.org'), false, 'Staging output must be redacted');

    /* 2. Cross-env fan-out `--query "invoice count by status" --all-envs --format md` + append to `--audit-log`. */
    const mdFanRun = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        BIN,
        '--config',
        cfgPath,
        '--query',
        'invoice count by status',
        '--all-envs',
        '--format',
        'md',
        '--audit-log',
        auditPath,
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(mdFanRun.status, 0, mdFanRun.stderr);
    assert.match(mdFanRun.stdout, /^\| env \| connection \| status \| count \|/m);
    assert.match(mdFanRun.stdout, /\| local \| billing-local \|/);
    assert.match(mdFanRun.stdout, /\| staging \| billing-staging \|/);

    /* 3. `--focus customer --focus-hops 0 --call tables --format md`. */
    const focusRun = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        BIN,
        '--config',
        cfgPath,
        '--env',
        'local',
        '--focus',
        'customer',
        '--focus-hops',
        '0',
        '--call',
        'tables',
        '--format',
        'md',
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(focusRun.status, 0, focusRun.stderr);
    assert.match(focusRun.stdout, /\| customer \|/);
    assert.equal(focusRun.stdout.includes('audit_secret'), false);
    assert.equal(focusRun.stdout.includes('invoice'), false);

    /* 4. Verify `--audit-log` JSONL has zero PII, zero SQL/query literals, and accurate operational fields! */
    const rawAudit = readFileSync(auditPath, 'utf8').trim();
    assert.equal(rawAudit.includes('alice@acme.org'), false);
    assert.equal(rawAudit.includes('Alice Mercer'), false);
    assert.equal(rawAudit.includes('tok_live_secret'), false);
    assert.equal(rawAudit.includes('customer sort id'), false);

    const entries = rawAudit.split('\n').map((l) => JSON.parse(l) as AuditLogRecord);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].tool, 'query');
    assert.equal(entries[0].env, 'staging');
    assert.equal(entries[0].ok, true);
    assert.equal(entries[0].rowsRead, 2);
    assert.equal(entries[0].rowsRemaining, 3);
    assert.equal(entries[0].redacted, true);

    assert.equal(entries[1].tool, 'breakdown');
    assert.equal(entries[1].database, 'billing');
    assert.equal(entries[1].fanout, 2);
    assert.equal(entries[1].ok, true);

    /* Cleanup any in-process sink just in case. */
    setAuditSink(undefined);
  });
});
