import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '@mistriwork/engine/host';
import { checkAnomalies } from '../src/server/anomalies.js';
import { hydrateEphemeralSqlite, maybeStaticImportTarget } from '../src/server/cli/ephemeralImport.js';
import { getPrompt, listPrompts } from '../src/server/mcp/prompts.js';
import { loadConfigEnvMeta } from '../src/server/mcp.js';

const ROOT = new URL('../', import.meta.url).pathname;

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'src/server/index.ts', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? ''),
    };
  }
}

describe('1.0.0-rc.23 features', () => {
  test('anomalies catches negative-measure and future-timestamp while sparing signed balance columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-rc23-anom-'));
    try {
      const dbPath = join(dir, 'ledger.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE invoice (
          id INTEGER PRIMARY KEY,
          total REAL NOT NULL,
          quantity INTEGER NOT NULL,
          balance REAL NOT NULL,
          created_at TIMESTAMP NOT NULL
        );
        INSERT INTO invoice (id, total, quantity, balance, created_at) VALUES
          (1, 120.50, 3, -40.00, '2026-01-15T10:00:00Z'),
          (2, -15.00, 1, -15.00, '2099-05-01T00:00:00Z');
      `);
      db.close();

      const reg = new Registry();
      reg.add({ id: 'ledger', name: 'ledger', url: dbPath, source: 'config' });
      reg.setActive('ledger');
      try {
        const { adapter, schema } = await reg.open('ledger');
        const report = await checkAnomalies(adapter, schema, 'ledger');
        const rules = report.findings.map((f) => `${f.rule}:${f.columns.join(',')}`);
        assert.ok(rules.includes('negative-measure:total'), `expected negative-measure on total, got ${rules.join('; ')}`);
        assert.ok(!rules.includes('negative-measure:balance'), 'signed balance column must not trigger negative-measure');
        assert.ok(rules.includes('future-timestamp:created_at'), `expected future-timestamp on created_at, got ${rules.join('; ')}`);
      } finally {
        await reg.closeAll();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ephemeralImport hydrates CSV/NDJSON directories and .sql dumps with inferred PKs and <stem>_id foreign keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-rc23-import-'));
    try {
      const exportsDir = join(dir, 'exports');
      const dumpFile = join(dir, 'dump.sql');
      mkdirSync(exportsDir, { recursive: true });
      writeFileSync(
        join(exportsDir, 'customers.csv'),
        'id,name,email\n1,"Harbour Freight",ops@example.com\n2,"Dry Creek",billing@example.com\n',
        'utf8',
      );
      writeFileSync(
        join(exportsDir, 'orders.ndjson'),
        `${[
          JSON.stringify({ id: 101, customer_id: 1, total: 250.5, status: 'paid' }),
          JSON.stringify({ id: 102, customer_id: 2, total: 90.0, status: 'open' }),
        ].join('\n')}\n`,
        'utf8',
      );
      writeFileSync(
        dumpFile,
        `
        SET statement_timeout = 0;
        CREATE TABLE country (code TEXT PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO country (code, name) VALUES ('AU', 'Australia'), ('NZ', 'New Zealand');
      `,
        'utf8',
      );

      assert.equal(maybeStaticImportTarget(exportsDir), true);
      assert.equal(maybeStaticImportTarget(dumpFile), true);
      assert.equal(maybeStaticImportTarget('postgres://localhost/app'), false);
      assert.equal(maybeStaticImportTarget('./app.sqlite'), false);

      const imported = hydrateEphemeralSqlite(exportsDir);
      try {
        assert.equal(imported.tableCount, 2);
        assert.equal(imported.fkCount, 1);
        const reg = new Registry();
        reg.add({ id: imported.label, name: imported.label, url: imported.dbPath, source: 'config' });
        reg.setActive(imported.label);
        try {
          const { schema } = await reg.open(imported.label);
          assert.equal(schema.foreignKeys.length, 1);
          assert.equal(schema.foreignKeys[0]?.from.table, 'orders');
          assert.equal(schema.foreignKeys[0]?.to.table, 'customers');
        } finally {
          await reg.closeAll();
        }
      } finally {
        imported.cleanup();
      }

      const cliRes = runCli([exportsDir, '--no-config', '--query', 'orders customer_id.name = "Harbour Freight"', '--format', 'tsv']);
      assert.equal(cliRes.status, 0, cliRes.stderr);
      assert.match(cliRes.stdout, /101\t1\t250\.5\tpaid/);

      const dumpRes = runCli([dumpFile, '--no-config', '--query', 'country code = AU', '--format', 'tsv']);
      assert.equal(dumpRes.status, 0, dumpRes.stderr);
      assert.match(dumpRes.stdout, /AU\tAustralia/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI --verify-ddl validates candidate DDL, enforces --fail-on for introduced lint, and supports --format json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-rc23-ddl-'));
    try {
      const dbPath = join(dir, 'app.db');
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE invoice (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customer(id), total REAL NOT NULL);
        CREATE INDEX idx_inv_cust ON invoice (customer_id);
      `);
      db.close();

      const okSql = join(dir, 'ok.sql');
      writeFileSync(okSql, 'ALTER TABLE customer ADD COLUMN tier TEXT;\n', 'utf8');
      const okRes = runCli([dbPath, '--no-config', '--verify-ddl', okSql]);
      assert.equal(okRes.status, 0, okRes.stderr);
      assert.match(okRes.stdout, /ok\s+Verified 1 DDL statement/);
      assert.match(okRes.stdout, /\+ customer: added column\(s\) tier/);

      const jsonRes = runCli([dbPath, '--no-config', '--verify-ddl', okSql, '--format', 'json']);
      assert.equal(jsonRes.status, 0, jsonRes.stderr);
      const parsed = JSON.parse(jsonRes.stdout) as { valid: boolean; statements: number };
      assert.equal(parsed.valid, true);
      assert.equal(parsed.statements, 1);

      const lintSql = join(dir, 'unindexed_fk.sql');
      writeFileSync(
        lintSql,
        'CREATE TABLE payment (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoice(id));\n',
        'utf8',
      );
      const failLint = runCli([dbPath, '--no-config', '--verify-ddl', lintSql, '--fail-on', 'high']);
      assert.equal(failLint.status, 1, 'unindexed FK should exit 1 under --fail-on high');
      assert.match(failLint.stdout, /New lint findings/);

      const badSql = join(dir, 'bad.sql');
      writeFileSync(badSql, 'ALTER TABLE missing_table ADD COLUMN x TEXT;\n', 'utf8');
      const badRes = runCli([dbPath, '--no-config', '--verify-ddl', badSql]);
      assert.equal(badRes.status, 1);
      assert.match(badRes.stdout, /FAIL\s+DDL verification failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compare-environments MCP prompt computes structural schema drift across sibling tiers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-rc23-prompt-'));
    try {
      const localDb = join(dir, 'local.db');
      const stagingDb = join(dir, 'staging.db');
      const db1 = new DatabaseSync(localDb);
      db1.exec('CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tier TEXT);');
      db1.close();
      const db2 = new DatabaseSync(stagingDb);
      db2.exec('CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL);');
      db2.close();

      const rawCfg = JSON.stringify({
        connections: [
          { name: 'shop-local', url: localDb, database: 'shop', env: 'local' },
          { name: 'shop-staging', url: stagingDb, database: 'shop', env: 'staging' },
        ],
      });
      const reg = new Registry();
      reg.add({ id: 'shop-local', name: 'shop-local', url: localDb, source: 'config' });
      reg.add({ id: 'shop-staging', name: 'shop-staging', url: stagingDb, source: 'config' });
      reg.setActive('shop-local');
      loadConfigEnvMeta(reg, rawCfg);
      try {
        let listed: Array<{ name: string }> = [];
        listPrompts((msg) => {
          if ('result' in msg) listed = (msg.result as { prompts?: Array<{ name: string }> })?.prompts ?? [];
        });
        assert.ok(listed.some((p) => p.name === 'compare-environments'));

        let promptText = '';
        await getPrompt(reg, { name: 'compare-environments', arguments: { from: 'shop@local', to: 'shop@staging' } }, (msg) => {
          if ('result' in msg) {
            const messages =
              (msg.result as { messages?: Array<{ content: { text?: string; resource?: { text?: string } } }> })?.messages ?? [];
            promptText = messages.map((m) => m.content.text ?? m.content.resource?.text ?? '').join('\n');
          }
        });
        assert.match(promptText, /customer/);
        assert.match(promptText, /tier/);
        assert.match(promptText, /verify_ddl/);
      } finally {
        await reg.closeAll();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
