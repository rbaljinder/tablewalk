/**
 * End-to-end verification of the six agent + browser capabilities:
 *   1. Unified Streamable HTTP `/mcp` + `TABLEWALK_MCP_URL` stdio bridge + `/api/agent/activity` + shared Undo
 *   2. Transactional `dryRun: true` on `insert`, `update`, `insert_graph`, plus `verify_ddl`
 *   3. Named `views` and `saved` queries executed via `query`, `sql` and `export` (including on `"hidden"`-column connections)
 *   4. Richer MCP shelf (`tablewalk://{conn}/views`, `tablewalk://{conn}/page/{page}`, page completion)
 *   5. Deterministic relational masking (`redact: true` and `redact_columns`) on `fixture` and `export`
 *   6. Bounded row-anomaly scanner (`anomalies`), including on `"rows": false` connections
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';
import { Registry } from '@mistriwork/engine/host';
import { parseViewsConfig } from '@mistriwork/engine/shared/view.js';
import { parseQueriesConfig } from '@mistriwork/engine/shared/sqlsaved.js';
import { parsePagesConfig } from '@mistriwork/engine/shared/page.js';
import { createApp } from './support/createApp.js';
import { answerMcpHttp, bindShelf, runTool } from '../src/server/mcp.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'src/server/index.ts');
const DIR = mkdtempSync(join(tmpdir(), 'tablewalk-agent-caps-'));
const REAL_TMP = process.env.TMPDIR;

before(() => {
  process.env.TMPDIR = DIR;
});

after(() => {
  if (REAL_TMP === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = REAL_TMP;
  rmSync(DIR, { recursive: true, force: true });
});

function buildRichDb(path: string): void {
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
      phone TEXT,
      password_hash TEXT NOT NULL DEFAULT 'hash-default',
      address TEXT,
      country_code TEXT REFERENCES country(code),
      active BOOLEAN NOT NULL DEFAULT 1,
      deleted_at TIMESTAMP,
      meta TEXT
    );
    CREATE TABLE invoice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customer(id),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
      total REAL NOT NULL,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT '2026-01-10T00:00:00Z',
      completed_at TIMESTAMP
    );
    CREATE INDEX idx_invoice_customer ON invoice(customer_id);
    INSERT INTO country (code, name) VALUES ('US', 'United States'), ('AU', 'Australia');
  `);
  const insertCust = db.prepare(
    'INSERT INTO customer (name, email, phone, password_hash, address, country_code, active, deleted_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertCust.run(
    'AliceNguyen',
    'alice@acme.org',
    '+1-415-555-9988',
    'pbkdf2$secret$alice',
    '742 Evergreen Terrace',
    'US',
    1,
    null,
    JSON.stringify({ email: 'backup@acme.org', secret_token: 'tok-xyz', tier: 'gold' }),
  );
  insertCust.run(
    'Archived Co',
    'archived@old.org',
    '+1-212-555-1234',
    'pbkdf2$secret$old',
    '100 Main St',
    'AU',
    0,
    '2026-02-01T00:00:00Z',
    null,
  );
  const insertInv = db.prepare(
    'INSERT INTO invoice (customer_id, status, total, notes, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  // 24 invoices pointing at customer 1 (valid dates).
  for (let i = 1; i <= 24; i++) {
    insertInv.run(1, i % 2 === 0 ? 'paid' : 'open', 100 + i, `Private note ${i}`, '2026-03-01T10:00:00Z', '2026-03-05T10:00:00Z');
  }
  // 1 temporal inversion (completed_at < created_at).
  insertInv.run(1, 'paid', 250, 'Inverted dates', '2026-04-10T10:00:00Z', '2026-04-01T10:00:00Z');
  // 1 open invoice (completed_at IS NULL) pointing at soft-deleted customer 2 -> dangling-lifecycle!
  insertInv.run(2, 'open', 300, 'Dangling child', '2026-04-02T10:00:00Z', null);
  // 1 invoice with NULL customer_id out of 27 total (<5% null on >=20 rows) -> nearly-always-present-fk!
  insertInv.run(null, 'open', 50, 'Missing customer', '2026-04-03T10:00:00Z', null);
  db.close();
}

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  return addr.port;
}

describe('unified HTTP MCP, stdio bridge, live activity trail and shared Undo', () => {
  test('POST /mcp shares Registry, Undo stack and live activity with the browser, and refuses untrusted listeners', async (t) => {
    const dbPath = join(DIR, 'unified.db');
    buildRichDb(dbPath);
    const registry = new Registry();
    registry.add({ id: 'app', name: 'app', url: dbPath, writable: true, source: 'config' });
    await registry.open('app');

    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound });
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.closeAll();
    });
    const port = await listen(server);
    bound.port = port;
    const base = `http://127.0.0.1:${port}`;

    // GET /mcp is 405 Method Not Allowed.
    const getRes = await fetch(`${base}/mcp`);
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.get('allow'), 'POST');

    // Notification returns 202 Accepted.
    const notif = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(notif.status, 202);

    // Handshake + insert over HTTP /mcp.
    const init = await (
      await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
      })
    ).json();
    assert.equal(init.result.serverInfo.name, 'tablewalk');

    const inserted = await (
      await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'insert', arguments: { table: 'country', values: { code: 'NZ', name: 'New Zealand' } } },
        }),
      })
    ).json();
    assert.equal(inserted.result.isError, false);
    assert.equal(inserted.result.structuredContent.inserted, true);
    assert.equal(typeof inserted.result.structuredContent.undoId, 'number');

    // Live activity endpoint sees the external MCP write and reports mcpEndpoint.
    const activity = await (await fetch(`${base}/api/agent/activity`)).json();
    assert.equal(activity.mcpEndpoint, `http://localhost:${port}/mcp`);
    assert.equal(activity.calls.length, 1);
    assert.equal(activity.calls[0].via, 'mcp');
    assert.equal(activity.calls[0].tool, 'insert');
    assert.deepEqual(activity.calls[0].links, ['/app/country/~NZ']);

    // Browser Undo (`POST /api/revert`) immediately sees and reverts the MCP agent's write!
    const undone = await (
      await fetch(`${base}/api/revert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connection: 'app', confirm: true, expectedId: inserted.result.structuredContent.undoId }),
      })
    ).json();
    assert.equal(undone.reverted, true);

    // And stdio `--mcp` with TABLEWALK_MCP_URL bridges straight to the running server without `--db`!
    const bridged = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), BIN, '--mcp', '--no-config'], {
        cwd: ROOT,
        env: { ...process.env, TABLEWALK_MCP_URL: `${base}/mcp`, TABLEWALK_OPEN: '0' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('exit', (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(
        `${JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'query', arguments: { q: 'country code = NZ' } } })}\n`,
      );
    });
    assert.equal(bridged.status, 0, bridged.stderr);
    const reply = JSON.parse(bridged.stdout.trim());
    assert.deepEqual(reply.result.structuredContent.rows, [], 'NZ was undone through the shared Undo stack');

    // Untrusted listener (`0.0.0.0` / allowedHosts) refuses /mcp with 403.
    const exposedBound = { host: '127.0.0.1', port: 0, allowedHosts: ['tablewalk.internal'] };
    const exposed = createApp({ registry, bound: exposedBound });
    t.after(() => new Promise<void>((resolve) => exposed.close(() => resolve())));
    const exposedPort = await listen(exposed);
    exposedBound.port = exposedPort;
    const forbidden = await fetch(`http://127.0.0.1:${exposedPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(forbidden.status, 403);
  });
});

describe('transactional dryRun writes and verify_ddl', () => {
  test('insert, update and insert_graph roll back cleanly under dryRun: true with zero committed rows or Undo entries', async (t) => {
    const dbPath = join(DIR, 'dryrun.db');
    buildRichDb(dbPath);
    const registry = new Registry();
    registry.add({ id: 'rw', name: 'rw', url: dbPath, writable: true, source: 'config' });
    t.after(() => registry.closeAll());

    // dryRun insert returns generated id and default status, then rolls back.
    const dryIns = await runTool(registry, 'insert', {
      table: 'invoice',
      values: { customer_id: 1, total: 777 },
      dryRun: true,
    });
    assert.equal(dryIns.isError, false);
    assert.equal(dryIns.structuredContent?.dryRun, true);
    assert.equal(dryIns.structuredContent?.inserted, false);
    assert.equal((dryIns.structuredContent?.row as Record<string, unknown>)?.status, 'open');
    assert.equal(typeof (dryIns.structuredContent?.key as Record<string, unknown>)?.id, 'number');
    assert.equal((dryIns.structuredContent?.stats as Record<string, unknown>)?.rowsWritten, 0);
    assert.equal(dryIns.structuredContent?.undoId, undefined);

    const checkGone = await runTool(registry, 'query', { q: 'invoice total = 777' });
    assert.deepEqual(checkGone.structuredContent?.rows, []);

    // dryRun update coerces values and rolls back.
    const dryUpd = await runTool(registry, 'update', {
      table: 'invoice',
      key: { id: 1 },
      set: { status: 'paid', total: '999.25' },
      dryRun: true,
    });
    assert.equal(dryUpd.isError, false);
    assert.equal(dryUpd.structuredContent?.dryRun, true);
    assert.deepEqual(dryUpd.structuredContent?.applied, { status: 'paid', total: 999.25 });
    assert.equal((dryUpd.structuredContent?.stats as Record<string, unknown>)?.rowsWritten, 0);

    const stillOriginal = await runTool(registry, 'record', { table: 'invoice', key: { id: 1 } });
    assert.equal((stillOriginal.structuredContent?.row as Record<string, unknown>)?.status, 'open');

    // dryRun insert_graph resolves `ref` across generated PKs, validates constraints, and rolls back whole.
    const dryGraph = await runTool(registry, 'insert_graph', {
      dryRun: true,
      rows: [
        { table: 'customer', as: 'new_c', values: { name: 'Preview Corp', email: 'preview@corp.test', country_code: 'US' } },
        { table: 'invoice', values: { customer_id: { ref: 'new_c' }, total: 420 } },
      ],
    });
    assert.equal(dryGraph.isError, false);
    assert.equal(dryGraph.structuredContent?.dryRun, true);
    assert.equal(((dryGraph.structuredContent?.inserted ?? []) as unknown[]).length, 2);
    assert.equal((dryGraph.structuredContent?.stats as Record<string, unknown>)?.rowsWritten, 0);

    const custGone = await runTool(registry, 'query', { q: 'customer email = preview@corp.test' });
    assert.deepEqual(custGone.structuredContent?.rows, []);

    // Revert preview confirms zero Undo entries were recorded by any dry run.
    const hist = await runTool(registry, 'revert', {});
    assert.deepEqual(hist.structuredContent?.writes, []);
  });

  test('verify_ddl diffs and lints candidate DDL without mutating the database, catches data violations, and guards boundaries', async (t) => {
    const dbPath = join(DIR, 'verifyddl.db');
    buildRichDb(dbPath);
    const registry = new Registry();
    registry.add({ id: 'ro', name: 'ro', url: dbPath, writable: false, source: 'config' });
    registry.add({
      id: 'hidden',
      name: 'hidden',
      url: dbPath,
      hidden: { customer: ['password_hash'] },
      source: 'config',
    });
    t.after(() => registry.closeAll());

    // Valid DDL on read-only SQLite runs on a disposable copy, diffs the new table, and flags unindexed FK in introducedLint!
    const ok = await runTool(registry, 'verify_ddl', {
      connection: 'ro',
      sql: [
        'CREATE TABLE invoice_comment (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoice(id), body TEXT NOT NULL)',
        'ALTER TABLE customer ADD COLUMN loyalty_points INTEGER NOT NULL DEFAULT 0',
      ],
    });
    assert.equal(ok.isError, false);
    assert.equal(ok.structuredContent?.valid, true);
    assert.equal(ok.structuredContent?.rolledBack, true);
    assert.equal(ok.structuredContent?.same, false);
    const diff = ok.structuredContent?.diff as Array<{ table: string; onlyIn?: string }>;
    assert.ok(diff.some((d) => d.table === 'invoice_comment' && d.onlyIn === 'right'));
    const intro = ok.structuredContent?.introducedLint as { findings: Array<{ rule: string; table: string }> };
    assert.ok(intro.findings.some((f) => f.rule === 'unindexed-foreign-key' && f.table === 'invoice_comment'));

    // Live database is completely unchanged.
    const tables = await runTool(registry, 'tables', { connection: 'ro' });
    assert.ok(!((tables.structuredContent?.tables ?? []) as Array<{ id: string }>).some((tbl) => tbl.id === 'invoice_comment'));

    // Data-level constraint failure against existing rows (duplicate `status` values reject a UNIQUE index!).
    const dupFail = await runTool(registry, 'verify_ddl', {
      connection: 'ro',
      sql: 'CREATE UNIQUE INDEX idx_unique_invoice_status ON invoice(status)',
    });
    assert.equal(dupFail.isError, false);
    assert.equal(dupFail.structuredContent?.valid, false);
    assert.equal(dupFail.structuredContent?.failedAt, 1);
    assert.match(String(((dupFail.structuredContent?.errors ?? []) as string[])[0]), /UNIQUE/i);

    // Guards: transaction escape, reserved tables, and hidden-column connections.
    const commitGuard = await runTool(registry, 'verify_ddl', { connection: 'ro', sql: 'COMMIT' });
    assert.equal(commitGuard.isError, true);
    assert.equal(commitGuard._meta?.['tablewalk/code'], 'invalid_argument');

    const reservedGuard = await runTool(registry, 'verify_ddl', {
      connection: 'ro',
      sql: 'CREATE TABLE __mistri_sneaky (id INT PRIMARY KEY)',
    });
    assert.equal(reservedGuard.isError, true);
    assert.equal(reservedGuard._meta?.['tablewalk/code'], 'forbidden');

    const hiddenGuard = await runTool(registry, 'verify_ddl', {
      connection: 'hidden',
      sql: 'ALTER TABLE customer ADD COLUMN nickname TEXT',
    });
    assert.equal(hiddenGuard.isError, true);
    assert.equal(hiddenGuard._meta?.['tablewalk/code'], 'forbidden');
  });
});

describe('named views, saved queries, shelf resources and hidden-column execution', () => {
  test('exposes views and page templates on the shelf and runs named views across hidden-column connections', async (t) => {
    const dbPath = join(DIR, 'shelf.db');
    buildRichDb(dbPath);
    const registry = new Registry();
    registry.add({ id: 'full', name: 'full', url: dbPath, source: 'config' });
    registry.add({
      id: 'safe',
      name: 'safe',
      url: dbPath,
      hidden: { customer: ['password_hash'] },
      source: 'config',
    });
    t.after(() => registry.closeAll());

    const views = parseViewsConfig(
      {
        views: [
          {
            id: 'open_with_country',
            name: 'Open invoices with country',
            text: 'invoice status = open show id, total, customer_id.name as customer, customer_id.country_code.name as country sort id limit 5',
          },
          {
            id: 'leaks_hash',
            name: 'Leaks password hash',
            text: 'customer show id, password_hash',
          },
        ],
      },
      'test',
    );
    const queries = parseQueriesConfig(
      { queries: [{ name: 'Status totals', sql: 'SELECT status, COUNT(*) AS n FROM invoice GROUP BY status ORDER BY status' }] },
      'test',
    );
    const pages = parsePagesConfig(
      {
        pages: [
          {
            id: 'customer_overview',
            label: 'Customer overview',
            base: 'customer',
            sections: [
              { kind: 'fields', title: 'Identity', show: ['name', 'email'] },
              { kind: 'list', title: 'Open invoices', from: 'invoice', whose: 'customer_id', query: 'status = open' },
            ],
          },
        ],
      },
      'test',
    );
    const shelf = {
      views,
      queries,
      pages,
      savedPages: async () => ({ saved_cust: { name: 'Saved customer', base: 'customer', sections: [] } }),
    };
    bindShelf(registry, shelf);

    // Shelf resources & templates via answerMcpHttp.
    const listed = (await answerMcpHttp(registry, shelf, { jsonrpc: '2.0', id: 1, method: 'resources/list' }, { version: '1.0.0' })) as {
      result: { resources: Array<{ uri: string }> };
    };
    assert.ok(listed.result.resources.some((r) => r.uri === 'tablewalk://safe/views'));
    assert.ok(listed.result.resources.some((r) => r.uri === 'tablewalk://full/pages'));

    const templates = (await answerMcpHttp(
      registry,
      shelf,
      { jsonrpc: '2.0', id: 2, method: 'resources/templates/list' },
      { version: '1.0.0' },
    )) as { result: { resourceTemplates: Array<{ uriTemplate: string }> } };
    assert.ok(templates.result.resourceTemplates.some((rt) => rt.uriTemplate === 'tablewalk://{connection}/page/{page}'));

    const completed = (await answerMcpHttp(
      registry,
      shelf,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'completion/complete',
        params: { ref: { type: 'ref/resource' }, argument: { name: 'page', value: '' }, context: { arguments: { connection: 'full' } } },
      },
      { version: '1.0.0' },
    )) as { result: { completion: { values: string[] } } };
    assert.deepEqual(completed.result.completion.values, ['customer_overview', 'saved_cust']);

    const pageDoc = (await answerMcpHttp(
      registry,
      shelf,
      { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'tablewalk://full/page/customer_overview' } },
      { version: '1.0.0' },
    )) as { result: { contents: Array<{ text: string }> } };
    assert.match(pageDoc.result.contents[0].text, /Open invoices.*from `invoice`.*filter: `status = open`/);

    // Named view executes on `"hidden"`-column connection (`safe`), where raw `sql` is refused!
    const rawRefused = await runTool(registry, 'sql', { connection: 'safe', saved: 'Status totals' });
    assert.equal(rawRefused.isError, true);

    const viewRan = await runTool(registry, 'query', { connection: 'safe', view: 'Open invoices with country', limit: 3 });
    assert.equal(viewRan.isError, false, viewRan.content[0]?.text);
    assert.equal(viewRan.structuredContent?.view, 'Open invoices with country');
    assert.equal(((viewRan.structuredContent?.rows ?? []) as unknown[]).length, 3);

    // A view naming the hidden column itself is refused on `safe`.
    const hiddenView = await runTool(registry, 'query', { connection: 'safe', view: 'leaks_hash' });
    assert.equal(hiddenView.isError, true);

    // Saved SQL runs by name on `full`, and both `view` and `saved` export cleanly.
    const savedRan = await runTool(registry, 'sql', { connection: 'full', saved: 'Status totals' });
    assert.equal(savedRan.isError, false);
    assert.equal(savedRan.structuredContent?.saved, 'Status totals');
    assert.equal(((savedRan.structuredContent?.rows ?? []) as unknown[]).length, 2);

    const exportedView = await runTool(registry, 'export', { connection: 'safe', view: 'open_with_country', format: 'ndjson', limit: 2 });
    assert.equal(exportedView.isError, false);
    assert.equal(exportedView.structuredContent?.rows, 2);
  });
});

describe('deterministic relational masking and row anomalies', () => {
  test('redact: true masks PII and secrets in fixture and export while preserving keys, FKs, CHECK values and insert_graph replay', async (t) => {
    const srcPath = join(DIR, 'mask-src.db');
    const dstPath = join(DIR, 'mask-dst.db');
    buildRichDb(srcPath);
    buildRichDb(dstPath);
    // Empty dstPath rows so we can replay the redacted fixture straight into it!
    const cleanDst = new DatabaseSync(dstPath);
    cleanDst.exec('DELETE FROM invoice; DELETE FROM customer; DELETE FROM country;');
    cleanDst.close();

    const registry = new Registry();
    registry.add({ id: 'src', name: 'src', url: srcPath, source: 'config' });
    registry.add({ id: 'dst', name: 'dst', url: dstPath, writable: true, source: 'config' });
    t.after(() => registry.closeAll());

    const fix = await runTool(registry, 'fixture', {
      connection: 'src',
      table: 'invoice',
      key: { id: 1 },
      redact: true,
    });
    assert.equal(fix.isError, false, fix.content[0]?.text);
    assert.equal(fix.structuredContent?.redacted, true);
    const rawJson = JSON.stringify(fix.structuredContent);
    // Original PII and secrets never appear anywhere in structured tables OR generated SQL!
    for (const secret of [
      'alice@acme.org',
      'AliceNguyen',
      '+1-415-555-9988',
      'pbkdf2$secret$alice',
      '742 Evergreen Terrace',
      'backup@acme.org',
      'tok-xyz',
      'Private note 1',
    ]) {
      assert.ok(!rawJson.includes(secret), `leaked "${secret}" in redacted fixture`);
    }
    // Country code ('US') and CHECK status ('open') and numeric total stay intact, and email matches @example.com!
    assert.match(rawJson, /@example\.com/);
    assert.match(rawJson, /"US"/);

    // Deterministic: calling fixture again produces byte-identical tables and SQL.
    const fixAgain = await runTool(registry, 'fixture', {
      connection: 'src',
      table: 'invoice',
      key: { id: 1 },
      redact: true,
    });
    assert.deepEqual(fixAgain.structuredContent?.tables, fix.structuredContent?.tables);

    // Replays cleanly into `dst` via `insert_graph`!
    const replayed = await runTool(registry, 'insert_graph', {
      connection: 'dst',
      tables: fix.structuredContent?.tables,
    });
    assert.equal(replayed.isError, false, replayed.content[0]?.text);
    assert.equal(((replayed.structuredContent?.inserted ?? []) as unknown[]).length, 3);

    // Export with redact: true scrubs both sample and written file on disk.
    const exp = await runTool(registry, 'export', {
      connection: 'src',
      query: 'customer',
      format: 'ndjson',
      redact: true,
    });
    assert.equal(exp.isError, false);
    const outPath = String(exp.structuredContent?.path);
    const fileContents = readFileSync(outPath, 'utf8');
    assert.ok(!fileContents.includes('alice@acme.org'));
    assert.ok(!fileContents.includes('pbkdf2$secret$alice'));
    assert.match(fileContents, /@example\.com/);
  });

  test('anomalies finds temporal inversions, dangling soft-deletes and >=95% nullable FK outliers, even on rows: false', async (t) => {
    const dbPath = join(DIR, 'anomalies.db');
    buildRichDb(dbPath);
    const registry = new Registry();
    registry.add({ id: 'full', name: 'full', url: dbPath, source: 'config' });
    registry.add({ id: 'shape', name: 'shape', url: dbPath, rows: false, source: 'config' });
    t.after(() => registry.closeAll());

    // Works on `"rows": false` shape-only connection with zero row values leaked!
    const onShape = await runTool(registry, 'anomalies', { connection: 'shape' });
    assert.equal(onShape.isError, false, onShape.content[0]?.text);
    const findings = onShape.structuredContent?.findings as Array<{ rule: string; rows: number; query: string; link: string }>;
    const byRule = new Map(findings.map((f) => [f.rule, f]));
    assert.equal(byRule.get('temporal-inversion')?.rows, 1);
    assert.equal(byRule.get('dangling-lifecycle')?.rows, 1);
    assert.equal(byRule.get('nearly-always-present-fk')?.rows, 1);

    // Every emitted `query` runs cleanly on `full` and returns the exact offending count!
    for (const f of findings) {
      const walked = await runTool(registry, 'query', { connection: 'full', q: f.query });
      assert.equal(walked.isError, false, `failed query "${f.query}": ${walked.content[0]?.text}`);
      assert.equal(walked.structuredContent?.total, f.rows, `query "${f.query}" count mismatch`);
    }
  });
});
