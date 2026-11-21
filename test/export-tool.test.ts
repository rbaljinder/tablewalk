/**
 * The `export` tool: a result streamed to a file instead of into a reply. In-process, over a disposable SQLite
 * database, so the files it writes are read back and compared with the rows that were seeded.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { Registry } from '@mistriwork/engine/host';
import { agentTools, runTool } from '../src/server/mcp/registry.js';
import { exportDirectory, handlers, EXPORT_BATCH } from '../src/server/mcp/tools/export.js';

const dir = mkdtempSync(join(tmpdir(), 'tablewalk-export-'));
const BIG_ID = '9007199254740993'; // 2^53 + 1
const registry = new Registry();
const written: string[] = [];

type Answer = {
  connection: string;
  path: string;
  format: string;
  rows: number;
  bytes: number;
  columns: Array<{ name: string; type: string }>;
  truncated: boolean;
  paging: string;
  sample: Array<Record<string, unknown>>;
  hint: string;
  note?: string;
};

async function exportOf(args: Record<string, unknown>): Promise<Answer> {
  const reply = await runTool(registry, 'export', { connection: 'bulk', ...args });
  assert.equal(reply.isError, false, reply.content[0].text);
  const answer = reply.structuredContent as unknown as Answer;
  written.push(answer.path);
  return answer;
}

const refusal = async (args: Record<string, unknown>) => {
  const reply = await runTool(registry, 'export', { connection: 'bulk', ...args });
  assert.equal(reply.isError, true, 'expected a refusal');
  return reply.content[0].text;
};

/** The rows of an RFC 4180 file, quotes and embedded breaks honored. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += c;
  }
  return rows;
}

// Exports land in tmpdir()/tablewalk-exports, which a real run keeps. Point
// tmpdir() at this file's own folder so the gate's leak check finds nothing.
const realTmp = process.env.TMPDIR;

before(async () => {
  process.env.TMPDIR = dir;
  const bulk = new DatabaseSync(join(dir, 'bulk.db'));
  bulk.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, label TEXT, note TEXT, qty INTEGER);
    CREATE TABLE tricky (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE wide (id INTEGER PRIMARY KEY, label TEXT);
    INSERT INTO wide VALUES (1, 'small'), (${BIG_ID}, 'big');
    INSERT INTO tricky VALUES (1, 'plain'), (2, 'a,b'), (3, 'say "hi"'), (4, 'two' || char(10) || 'lines'), (5, NULL), (6, ''), (7, '=SUM(A1)');`);
  bulk.exec('BEGIN');
  const insert = bulk.prepare('INSERT INTO item VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= 25_000; i++) insert.run(i, `item-${i}`, i % 7 === 0 ? null : `n${i}`, i * 2);
  bulk.exec('COMMIT');
  bulk.close();
  registry.add({ id: 'bulk', name: 'bulk', url: join(dir, 'bulk.db'), source: 'config' });
  registry.setActive('bulk');
  await registry.open('bulk');
});

after(() => {
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  for (const path of written) rmSync(path, { force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('a keyset export of more than one batch holds every row once, in order, and says how it paged', async () => {
  assert.ok(25_000 > EXPORT_BATCH * 2);
  const out = await exportOf({ query: 'item', name: 'keyset' });
  assert.equal(out.paging, 'keyset');
  assert.equal(out.rows, 25_000);
  assert.equal(out.truncated, false);
  assert.deepEqual(
    out.columns.map((c) => c.name),
    ['id', 'label', 'note', 'qty'],
  );
  assert.equal(out.bytes, statSync(out.path).size);
  assert.match(out.path, /tablewalk-exports[\\/]bulk-keyset-\d{8}-\d{6}\.csv$/);
  assert.match(out.hint, /read_csv_auto/);
  assert.equal(out.sample.length, 5);
  const lines = parseCsv(readFileSync(out.path, 'utf8'));
  assert.deepEqual(lines[0], ['id', 'label', 'note', 'qty']);
  assert.equal(lines.length, 25_001);
  lines.slice(1).forEach((row, i) => {
    assert.equal(row[0], String(i + 1));
    assert.equal(row[3], String((i + 1) * 2));
    assert.equal(row[2], (i + 1) % 7 === 0 ? '' : `n${i + 1}`);
  });
});

test('limit, show and sort are honored by a query export', async () => {
  const out = await exportOf({ query: 'item show label sort qty desc', limit: 12_000, name: 'top' });
  assert.equal(out.rows, 12_000);
  const lines = parseCsv(readFileSync(out.path, 'utf8'));
  assert.deepEqual(lines[0], ['label']);
  assert.equal(lines[1][0], 'item-25000');
  assert.equal(lines[12_000][0], `item-${25_000 - 11_999}`);
});

test('csv, ndjson and json each round-trip the exact rows, nulls and quoting included', async () => {
  const seeded = [
    { id: 1, body: 'plain' },
    { id: 2, body: 'a,b' },
    { id: 3, body: 'say "hi"' },
    { id: 4, body: 'two\nlines' },
    { id: 5, body: null },
    { id: 6, body: '' },
    { id: 7, body: '=SUM(A1)' },
  ];
  const csv = await exportOf({ query: 'tricky', name: 'tricky-csv' });
  const parsed = parseCsv(readFileSync(csv.path, 'utf8')).slice(1);
  assert.deepEqual(
    parsed.map(([id, body]) => ({ id: Number(id), body })),
    seeded.map((r) => ({ id: r.id, body: r.body ?? '' })),
  );
  assert.match(readFileSync(csv.path, 'utf8'), /\r\n5,\r\n6,""\r\n/, 'null is empty and an empty string is quoted');

  const nd = await exportOf({ query: 'tricky', format: 'ndjson', name: 'tricky-nd' });
  assert.match(nd.path, /\.ndjson$/);
  assert.deepEqual(
    readFileSync(nd.path, 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l)),
    seeded,
  );

  const json = await exportOf({ query: 'tricky', format: 'json', name: 'tricky-json' });
  assert.deepEqual(JSON.parse(readFileSync(json.path, 'utf8')), seeded);
  assert.equal(json.rows, 7);

  const empty = await exportOf({ query: 'tricky id > 99', format: 'json', name: 'tricky-none' });
  assert.deepEqual(JSON.parse(readFileSync(empty.path, 'utf8')), []);
});

test('an id past 2^53 stays a string in every format', async () => {
  const nd = await exportOf({ query: 'wide', format: 'ndjson', name: 'wide-nd' });
  const rows = readFileSync(nd.path, 'utf8').trimEnd().split('\n');
  assert.equal(JSON.parse(rows[1]).id, BIG_ID);
  const csv = await exportOf({ query: 'wide', name: 'wide-csv' });
  assert.equal(parseCsv(readFileSync(csv.path, 'utf8'))[2][0], BIG_ID);
});

test('a sql export is one read, and says so when the cap cut it short', async () => {
  const all = await exportOf({ sql: 'select id, label from item order by id', name: 'sql-all' });
  assert.equal(all.paging, 'single');
  assert.equal(all.rows, 25_000);
  assert.equal(all.truncated, false);
  assert.deepEqual(
    all.columns.map((c) => c.name),
    ['id', 'label'],
  );

  // The user's own limit is theirs, not a truncation.
  const some = await exportOf({ sql: 'select id from item order by id', limit: 10, name: 'sql-ten' });
  assert.equal(some.rows, 10);
  assert.equal(some.truncated, false);

  // 150k rows from a recursive CTE: past the 100,000-row cap.
  const capped = await exportOf({
    sql: 'with recursive n(i) as (select 1 union all select i + 1 from n where i < 150000) select i from n',
    name: 'sql-cap',
  });
  assert.equal(capped.rows, 100_000);
  assert.equal(capped.truncated, true);
  assert.match(capped.note ?? '', /query|WHERE/);
});

test('a name is a stem: a path is refused, anything else is reduced to [a-z0-9-_]', async () => {
  for (const name of ['../evil', 'a/b', '..', 'x\\y']) {
    assert.match(await refusal({ query: 'wide', name }), /name/, name);
  }
  const out = await exportOf({ query: 'wide', name: 'My Report!' });
  assert.match(out.path, /bulk-my-report-\d{8}-\d{6}\.csv$/);
  assert.equal(join(out.path, '..'), exportDirectory());
});

test('arguments: exactly one of query or sql, a known format', async () => {
  assert.match(await refusal({}), /exactly one/);
  assert.match(await refusal({ query: 'wide', sql: 'select 1' }), /exactly one/);
  assert.match(await refusal({ query: 'wide', format: 'xml' }), /format/);
  assert.match(await refusal({ query: 'nonesuch' }), /export/);
});

test('a file is never overwritten: the same name in the same second gets a suffix', async () => {
  const names = new Set<string>();
  for (let i = 0; i < 3; i++) names.add((await exportOf({ query: 'wide', name: 'same' })).path);
  assert.equal(names.size, 3);
  for (const p of names) assert.ok(existsSync(p));
});

test('compress: "gzip" writes .csv.gz, bytes is the size on disk, and it gunzips to the same rows', async () => {
  const out = await exportOf({ query: 'item', compress: 'gzip', name: 'zipped' });
  assert.match(out.path, /\.csv\.gz$/);
  assert.equal(out.rows, 25_000);
  assert.equal(out.bytes, statSync(out.path).size);
  const csv = gunzipSync(readFileSync(out.path)).toString('utf8');
  assert.equal(parseCsv(csv).length, 25_001);
  assert.ok(out.bytes < csv.length, 'smaller than the text');
  const nd = await exportOf({ query: 'wide', format: 'ndjson', compress: 'gzip', name: 'zipped-nd' });
  assert.match(nd.path, /\.ndjson\.gz$/);
  assert.equal(gunzipSync(readFileSync(nd.path)).toString('utf8').trimEnd().split('\n').length, 2);
  assert.match(await refusal({ query: 'wide', compress: 'zip' }), /compress/);
});

test('a failure part-way removes the partial file', async () => {
  const { adapter, schema, id } = await registry.open('bulk').then((o) => ({ ...o, id: 'bulk' }));
  let reads = 0;
  const failing = new Proxy(adapter, {
    get(target, key, receiver) {
      if (key === 'query') {
        return (request: never) => (++reads === 2 ? Promise.reject(new Error('the disk caught fire')) : target.query(request));
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const before = new Set(readdirSync(exportDirectory()));
  await assert.rejects(handlers.export({ registry, args: { query: 'item', name: 'doomed' }, adapter: failing, schema, id }), /caught fire/);
  const left = readdirSync(exportDirectory()).filter((f) => !before.has(f) && f.includes('doomed'));
  assert.deepEqual(left, []);
});

test('a third concurrent export is refused, and the slot comes back when one finishes', async () => {
  const { adapter, schema } = await registry.open('bulk');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = new Proxy(adapter, {
    get(target, key, receiver) {
      if (key === 'runSql') {
        return async (request: never) => {
          await gate;
          return target.runSql!(request);
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const call = (name: string) => handlers.export({ registry, args: { sql: 'select 1 as one', name }, adapter: slow, schema, id: 'bulk' });
  const first = call('slow-a');
  const second = call('slow-b');
  await assert.rejects(call('slow-c'), /At most 2 exports/);
  release();
  for (const done of await Promise.all([first, second])) written.push(done.path as string);
  const again = await call('slow-d');
  written.push(again.path as string);
});

test('a read-only connection lists export with the reading tools, and the explore profile keeps it', async () => {
  const names = agentTools(registry).map((t) => t.name);
  assert.ok(names.includes('export'));
  assert.ok(names.indexOf('export') < names.indexOf('record'), 'listed among the reads');
  const tool = agentTools(registry).find((t) => t.name === 'export')!;
  assert.deepEqual(tool.annotations, {
    title: 'Export to a file',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  });

  // Untrusted HTTP listeners neither list nor run export.
  assert.ok(!agentTools(registry, { trusted: false }).some((t) => t.name === 'export'));
  const denied = await runTool(registry, 'export', { connection: 'bulk', query: 'wide' }, { trusted: false });
  assert.equal(denied.isError, true);
  assert.equal(denied._meta?.['tablewalk/code'], 'forbidden');

  // Every exported row is counted in stats.rowsRead and in rowsReadThisSession.
  const before = (
    (await runTool(registry, 'connections', {})).structuredContent!.connections as Array<{ id: string; rowsReadThisSession: number }>
  ).find((c) => c.id === 'bulk')!.rowsReadThisSession;
  const exported = await exportOf({ query: 'wide', name: 'counted' });
  assert.equal((exported as unknown as { stats: { rowsRead: number } }).stats.rowsRead, 2);
  const after = (
    (await runTool(registry, 'connections', {})).structuredContent!.connections as Array<{ id: string; rowsReadThisSession: number }>
  ).find((c) => c.id === 'bulk')!.rowsReadThisSession;
  assert.equal(after, before + 2);
});
