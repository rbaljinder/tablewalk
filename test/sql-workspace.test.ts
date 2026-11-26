import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '@mistriwork/engine/host';
import { createBrowserApp } from '../src/server/http/browserServer.js';
import { answerMcpHttp, bindShelf, setConnectionEnvMeta } from '../src/server/mcp.js';
import {
  deleteWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  renameWorkspaceFile,
  resolveWorkspaceFile,
  setConnectionSqlDir,
  writeWorkspaceFile,
} from '../src/server/sqlWorkspace.js';

describe('SQL workspace confinement and file operations', () => {
  let root: string;
  let outside: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'tw-sql-ws-'));
    outside = mkdtempSync(join(tmpdir(), 'tw-sql-outside-'));
    mkdirSync(join(root, 'billing'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'top.sql'), 'SELECT 1;\n');
    writeFileSync(join(root, 'billing', 'overdue.sql'), 'SELECT * FROM invoice WHERE total > :min;\n');
    writeFileSync(join(root, 'notes.txt'), 'not sql');
    writeFileSync(join(root, '.git', 'hidden.sql'), 'SELECT 0;');
    writeFileSync(join(outside, 'secret.sql'), 'SELECT 999;');
    symlinkSync(join(outside, 'secret.sql'), join(root, 'escape.sql'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('lists only .sql files inside root, skipping dot-dirs and non-sql files', () => {
    const files = listWorkspaceFiles(root);
    assert.deepEqual(
      files.map((f) => f.path),
      ['top.sql', 'billing/overdue.sql'],
    );
  });

  test('blocks traversal, absolute paths, non-.sql extensions, and symlink escapes', () => {
    assert.throws(() => resolveWorkspaceFile(root, '../secret.sql'), /Invalid workspace file path/);
    assert.throws(() => resolveWorkspaceFile(root, '/etc/passwd.sql'), /must be relative/i);
    assert.throws(() => resolveWorkspaceFile(root, 'notes.txt'), /\.sql extension/);
    assert.throws(() => resolveWorkspaceFile(root, '.git/hidden.sql'), /Invalid workspace file path/);
    assert.throws(() => readWorkspaceFile(root, 'escape.sql'), /Symlink escapes/);
  });

  test('creates, reads, renames, and deletes .sql files inside root', () => {
    const created = writeWorkspaceFile(root, 'reports/daily.sql', 'SELECT 42;\n');
    assert.equal(created.path, 'reports/daily.sql');
    assert.equal(created.folder, 'reports');
    assert.equal(readWorkspaceFile(root, 'reports/daily.sql').content, 'SELECT 42;\n');

    const moved = renameWorkspaceFile(root, 'reports/daily.sql', 'reports/weekly.sql');
    assert.equal(moved.to, 'reports/weekly.sql');
    assert.equal(readWorkspaceFile(root, 'reports/weekly.sql').content, 'SELECT 42;\n');

    deleteWorkspaceFile(root, 'reports/weekly.sql');
    assert.throws(() => readWorkspaceFile(root, 'reports/weekly.sql'), /not found/i);
  });
});

describe('SQL workspace HTTP routes, sibling sharing, MCP shelf, and /api/sql/script', () => {
  let tmp: string;
  let wsDir: string;
  let dbPath: string;
  let registry: Registry;
  let server: ReturnType<typeof createBrowserApp>;
  let baseUrl: string;

  const get = async (path: string) => {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'tw-sql-http-'));
    wsDir = join(tmp, 'sql');
    mkdirSync(join(wsDir, 'reports'), { recursive: true });
    writeFileSync(join(wsDir, 'reports', 'summary.sql'), 'SELECT count(*) AS total_customers FROM customer;');

    dbPath = join(tmp, 'shop.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, credit REAL NOT NULL);
      INSERT INTO customer VALUES (1, 'Ada', 100), (2, 'Grace', 250);
    `);
    db.close();

    registry = new Registry();
    const local = registry.add({ name: 'billing-local', url: dbPath, writable: true, source: 'config' });
    const prod = registry.add({ name: 'billing-prod', url: dbPath, writable: false, source: 'config' });
    setConnectionEnvMeta(registry, local.id, { database: 'billing', env: 'local' });
    setConnectionEnvMeta(registry, prod.id, { database: 'billing', env: 'prod' });
    registry.setActive(local.id);
    bindShelf(registry, { views: [], queries: [], pages: [] });

    server = createBrowserApp({ registry, bound: { host: '127.0.0.1', port: 0 } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.closeAll();
    rmSync(tmp, { recursive: true, force: true });
    try {
      rmdirSync(join(tmpdir(), 'tablewalk-exports'));
    } catch {
      /* ignore if non-empty or already removed */
    }
  });

  test('attaches workspace on loopback, shares across sibling envs, supports CRUD, and exposes files to MCP', async () => {
    const empty = await get('/api/sql/workspace?connection=billing-local');
    assert.equal(empty.status, 200);
    assert.equal(empty.json.attached, false);

    const attached = await post('/api/sql/workspace/attach', { connection: 'billing-local', dir: wsDir });
    assert.equal(attached.status, 200);
    assert.equal(attached.json.attached, true);
    assert.equal(attached.json.rootName, 'sql');
    assert.equal((attached.json.files as Array<{ path: string }>)[0].path, 'reports/summary.sql');

    // Sibling prod connection shares the same database workspace automatically.
    const sibling = await get('/api/sql/workspace?connection=billing-prod');
    assert.equal(sibling.status, 200);
    assert.equal(sibling.json.attached, true);
    assert.equal((sibling.json.files as Array<{ path: string }>)[0].path, 'reports/summary.sql');

    // Read, save, rename, delete over HTTP.
    const read = await get('/api/sql/files?connection=billing-local&path=reports/summary.sql');
    assert.equal(read.status, 200);
    assert.match(String(read.json.content), /total_customers/);

    const saved = await post('/api/sql/files', {
      connection: 'billing-local',
      path: 'scratch/check.sql',
      content: 'SELECT name FROM customer ORDER BY id;',
    });
    assert.equal(saved.status, 200);
    assert.equal((saved.json.file as { path: string }).path, 'scratch/check.sql');

    // MCP shelf lists workspace .sql files and runs them via `sql { saved }`.
    const shelfList = (await answerMcpHttp(
      registry,
      { views: [], queries: [], pages: [] },
      { jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} },
      { version: '1.0.0', trusted: true },
    )) as { result?: { resources?: Array<{ uri: string }> } };
    assert.ok(shelfList.result?.resources?.some((r) => r.uri === 'tablewalk://billing-local/queries'));

    const runSaved = (await answerMcpHttp(
      registry,
      { views: [], queries: [], pages: [] },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'sql', arguments: { connection: 'billing-local', saved: 'reports/summary.sql' } },
      },
      { version: '1.0.0', trusted: true },
    )) as { result?: { structuredContent?: { saved?: string; columns?: string[]; rows?: unknown[][] } } };
    assert.equal(runSaved.result?.structuredContent?.saved, 'reports/summary.sql');
    assert.deepEqual(runSaved.result?.structuredContent?.columns, ['total_customers']);
    assert.deepEqual(runSaved.result?.structuredContent?.rows, [[2]]);

    const renamed = await post('/api/sql/files/rename', {
      connection: 'billing-local',
      from: 'scratch/check.sql',
      to: 'scratch/check2.sql',
    });
    assert.equal(renamed.status, 200);

    const deleted = await post('/api/sql/files/delete', { connection: 'billing-local', path: 'scratch/check2.sql' });
    assert.equal(deleted.status, 200);

    const detached = await post('/api/sql/workspace/detach', { connection: 'billing-local' });
    assert.equal(detached.status, 200);
    assert.equal(detached.json.attached, false);
  });

  test('refuses attaching or writing workspace files when request is not trusted (non-loopback)', async () => {
    const nonLoopback = createBrowserApp({ registry, bound: { host: '0.0.0.0', port: 0 } });
    await new Promise<void>((resolve) => nonLoopback.listen(0, '127.0.0.1', resolve));
    const addr = nonLoopback.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}`;
    try {
      const attachRes = await fetch(`${url}/api/sql/workspace/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
        body: JSON.stringify({ conn: 'billing-local', dir: wsDir }),
      });
      assert.equal(attachRes.status, 403);
      const writeRes = await fetch(`${url}/api/sql/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
        body: JSON.stringify({ conn: 'billing-local', path: 'a.sql', content: 'SELECT 1;' }),
      });
      assert.equal(writeRes.status, 403);
    } finally {
      await new Promise<void>((resolve) => nonLoopback.close(() => resolve()));
    }
  });

  test('/api/sql/script executes multi-statement reads, stops on error, and gates writes by writable flag', async () => {
    const readRes = await post('/api/sql/script', {
      conn: 'billing-prod',
      text: 'SELECT count(*) AS n FROM customer;\nSELECT name FROM customer ORDER BY id;',
      limit: 50,
    });
    assert.equal(readRes.status, 200);
    const stmts = readRes.json.statements as Array<{ ok: boolean; rows?: unknown[][] }>;
    assert.equal(stmts.length, 2);
    assert.equal(stmts[0].ok, true);
    assert.deepEqual(stmts[0].rows, [[2]]);
    assert.deepEqual(stmts[1].rows, [['Ada'], ['Grace']]);

    // Stops on first failing statement.
    const errRes = await post('/api/sql/script', {
      conn: 'billing-prod',
      text: 'SELECT 1;\nSELECT * FROM nonexistent_table;\nSELECT 2;',
    });
    assert.equal(errRes.status, 200);
    assert.equal(errRes.json.stoppedAt, 1);
    assert.equal((errRes.json.statements as unknown[]).length, 2);

    // Read-only connection refuses write script.
    const refused = await post('/api/sql/script', {
      conn: 'billing-prod',
      text: "INSERT INTO customer VALUES (3, 'Alan', 500);",
      write: true,
    });
    assert.equal(refused.status, 403);

    // Writable connection runs multi-statement DML script.
    const writeRes = await post('/api/sql/script', {
      conn: 'billing-local',
      text: "INSERT INTO customer VALUES (3, 'Alan', 500);\nUPDATE customer SET credit = 550 WHERE id = 3;",
      write: true,
    });
    assert.equal(writeRes.status, 200);
    const wStmts = writeRes.json.statements as Array<{ ok: boolean; affected?: number }>;
    assert.equal(wStmts.length, 2);
    assert.equal(wStmts[0].ok, true);
    assert.equal(wStmts[1].ok, true);

    // Confirm setConnectionSqlDir directly too.
    setConnectionSqlDir(registry, 'billing-local', wsDir);
    const ws = await get('/api/sql/workspace?conn=billing-local');
    assert.equal(ws.json.attached, true);
  });

  test('MCP sql and export execute parameterized workspace .sql files with `params` and list required params on the shelf', async () => {
    writeFileSync(
      join(wsDir, 'reports', 'by_credit.sql'),
      'SELECT id, name, credit FROM customer WHERE credit >= :min_credit AND name != {{exclude_name}} ORDER BY id;',
    );
    setConnectionSqlDir(registry, 'billing-local', wsDir);

    // Shelf resource documents the `.sql` file AND its required parameters.
    const shelfRead = (await answerMcpHttp(
      registry,
      { views: [], queries: [], pages: [] },
      { jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'tablewalk://billing-local/queries' } },
      { version: '1.0.0', trusted: true },
    )) as { result?: { contents?: Array<{ text: string }> } };
    const shelfText = shelfRead.result?.contents?.[0]?.text ?? '';
    assert.match(shelfText, /## reports\/by_credit\.sql/);
    assert.match(shelfText, /`min_credit`.*`exclude_name`/);

    // Missing params is refused cleanly with the missing parameter names.
    const missing = (await answerMcpHttp(
      registry,
      { views: [], queries: [], pages: [] },
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'export', arguments: { connection: 'billing-local', saved: 'reports/by_credit.sql' } },
      },
      { version: '1.0.0', trusted: true },
    )) as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    assert.equal(missing.result?.isError, true);
    assert.match(missing.result?.content?.[0]?.text ?? '', /:min_credit.*:exclude_name/);

    // Running `sql` with bound `params` returns only matching rows.
    const sqlRes = (await answerMcpHttp(
      registry,
      { views: [], queries: [], pages: [] },
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'sql',
          arguments: {
            connection: 'billing-local',
            saved: 'reports/by_credit.sql',
            params: { min_credit: 200, exclude_name: 'Alan' },
          },
        },
      },
      { version: '1.0.0', trusted: true },
    )) as { result?: { structuredContent?: { rows?: unknown[][] } } };
    assert.deepEqual(sqlRes.result?.structuredContent?.rows, [[2, 'Grace', 250]]);

    // Running `export` with `saved` + `params` writes a filtered CSV file and returns its path + sample.
    const exportRes = (await answerMcpHttp(
      registry,
      { views: [], queries: [], pages: [] },
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'export',
          arguments: {
            connection: 'billing-local',
            saved: 'reports/by_credit.sql',
            params: { min_credit: 200, exclude_name: 'Ada' },
            format: 'csv',
            name: 'high_credit',
          },
        },
      },
      { version: '1.0.0', trusted: true },
    )) as { result?: { structuredContent?: { path?: string; rows?: number; format?: string } } };
    const outPath = exportRes.result?.structuredContent?.path;
    assert.ok(outPath, 'expected export file path');
    assert.equal(exportRes.result?.structuredContent?.format, 'csv');
    assert.equal(exportRes.result?.structuredContent?.rows, 2);
    try {
      const csv = readFileSync(outPath, 'utf8');
      assert.match(csv, /^id,name,credit\r?\n2,Grace,250\r?\n3,Alan,550\r?\n$/);
    } finally {
      unlinkSync(outPath);
    }
  });

  test('CLI --sql-file, --param, and --out export parameterized .sql files directly to .csv, .ndjson.gz, or stdout', async () => {
    const { execFileSync } = await import('node:child_process');
    const { gunzipSync } = await import('node:zlib');
    const sqlFile = join(wsDir, 'reports', 'by_credit.sql');
    writeFileSync(sqlFile, 'SELECT id, name, credit FROM customer WHERE credit >= :min_credit AND name != {{exclude_name}} ORDER BY id;');

    // 1. Direct disk --sql-file + repeatable --param + --out <file.csv>
    const outCsv = join(tmp, 'exports', 'high_credit.csv');
    const csvReceipt = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/server/index.ts',
          dbPath,
          '--no-config',
          '--sql-file',
          sqlFile,
          '--param',
          'min_credit=200',
          '--param',
          'exclude_name=Ada',
          '--out',
          outCsv,
        ],
        { encoding: 'utf8' },
      ),
    ) as { path: string; rows: number; format: string };
    assert.equal(csvReceipt.path, outCsv);
    assert.equal(csvReceipt.rows, 2);
    assert.equal(csvReceipt.format, 'csv');
    assert.match(readFileSync(outCsv, 'utf8'), /^id,name,credit\r?\n2,Grace,250\r?\n3,Alan,550\r?\n$/);

    // 2. Workspace-relative --sql-dir + --sql-file + --out <file.ndjson.gz>
    const outGz = join(tmp, 'exports', 'high_credit.ndjson.gz');
    const gzReceipt = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/server/index.ts',
          dbPath,
          '--no-config',
          '--sql-dir',
          wsDir,
          '--sql-file',
          'reports/by_credit.sql',
          '--param',
          'min_credit=300',
          '--param',
          'exclude_name=Nobody',
          '--out',
          outGz,
        ],
        { encoding: 'utf8' },
      ),
    ) as { path: string; rows: number; format: string };
    assert.equal(gzReceipt.path, outGz);
    assert.equal(gzReceipt.rows, 1);
    assert.equal(gzReceipt.format, 'ndjson');
    const ndjson = gunzipSync(readFileSync(outGz)).toString('utf8').trim();
    assert.deepEqual(JSON.parse(ndjson), { id: 3, name: 'Alan', credit: 550 });

    // 3. Stdout mode (--sql-file without --out) with --format tsv
    const tsv = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/server/index.ts',
        dbPath,
        '--no-config',
        '--sql-file',
        sqlFile,
        '--param',
        'min_credit=200',
        '--param',
        'exclude_name=Alan',
        '--format',
        'tsv',
      ],
      { encoding: 'utf8' },
    );
    assert.match(tsv, /Grace\t250/);
    assert.doesNotMatch(tsv, /Alan/);
  });
});
