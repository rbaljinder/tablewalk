/**
 * The API, over the wire.
 *
 * Every other suite reaches past the server: it builds an adapter, calls a
 * function, and asserts what came back. That leaves the whole HTTP layer —
 * status codes, the two error vocabularies, and the security check that
 * decides whether a request is allowed to happen at all — asserted nowhere. A
 * guard that is only ever called with a hand-built fake request is a guard
 * nobody has proved is wired in, and that is exactly the guard worth proving.
 *
 * So this suite starts a real server on a real socket and drives it with
 * `fetch`. Two things follow.
 *
 * The house rule applies as it does everywhere else: assert the refusal *and*
 * assert that nothing happened. A 403 proves the server said no; a row count
 * afterwards proves it meant it.
 *
 * And the vocabularies are pinned deliberately rather than described. tablewalk
 * answers `{ error }` when the request could not be carried out and
 * `{ errors: [{ message, at? }] }` when the person typing made a mistake in
 * the language — and several endpoints answer **200 with `errors`**, because a
 * statement the database refused is the user's to fix and belongs beside the
 * editor rather than in a failed request. Which endpoint does which is a
 * decision the client depends on, so each one is written down here.
 */
import { test, before, after, describe } from 'node:test';
import { toolCounts } from '../src/server/mcp.js';
import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './support/createApp.js';
import { parseHostList } from '@mistriwork/engine/server/http/trust.js';
import { Registry, loadConfig } from '@mistriwork/engine/server/connections.js';
import { parseViewsConfig } from '@mistriwork/engine/shared/view.js';
import { parseQueriesConfig } from '@mistriwork/engine/shared/sqlsaved.js';
import { makeDemoDatabase } from './make-demo-db.js';
import { browserSections } from '../src/server/cli/browserCommands.js';

/* Its own files rather than the ones the other suites build. `node --test`
   gives each file its own process, and two processes opening one SQLite handle
   race — see the same note at the top of language.test.ts. Made for this run
   and removed after it — never `.demo/`, where a developer's demo databases
   and credentials are. */
const DB_DIR = mkdtempSync(join(tmpdir(), 'tablewalk-http-db-'));
const RO_DB = join(DB_DIR, 'http-readonly.db');
const RW_DB = join(DB_DIR, 'http-writable.db');

/** A password that must never appear in anything the server sends. */
const SECRET = 'hunter2';

/**
 * The record `crossOriginRefusal` compares the `Host` header against.
 *
 * Mutable, and filled in after `listen`: the port is the kernel's to choose,
 * and hardcoding 4111 means the suite fails on a machine where a developer
 * already has tablewalk running.
 */
const bound = { host: '127.0.0.1', port: 0, allowedHosts: [] as string[] };

/** A second listener, standing in for the container-behind-a-proxy case. */
const proxied = {
  host: '127.0.0.1',
  port: 0,
  allowedHosts: parseHostList('tablewalk.internal, proxy.example:8080'),
};

let server: Server;
let proxyServer: Server;
let registry: Registry;
let tmp: string;
let configPath: string;

/**
 * One answer, unpacked.
 *
 * `json` is deliberately loose. What these tests assert is the shape the
 * server chose, so declaring that shape up front would be assuming the thing
 * under test.
 */
interface Answer {
  status: number;
  text: string;
  contentType: string;
  json: any;
  /* Carried so a test can ask which connection answered — the one thing that
     tells a reply from the right database apart from a reply from the wrong
     one. Empty for the `node:http` path, which does not need it. */
  headers: Headers;
}

function answer(status: number, contentType: string, text: string, headers = new Headers()): Answer {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined; // A static file. The JSON assertions do not apply to it.
  }
  return { status, contentType, text, json, headers };
}

const at = (where: { port: number }, path: string) => `http://127.0.0.1:${where.port}${path}`;

async function unwrap(res: Response): Promise<Answer> {
  return answer(res.status, res.headers.get('content-type') ?? '', await res.text(), res.headers);
}

async function getFrom(where: { port: number }, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return unwrap(await fetch(at(where, path), { headers }));
}

async function postTo(where: { port: number }, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return unwrap(
    await fetch(at(where, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** A GET, the way the page makes one. */
const get = (path: string, headers: Record<string, string> = {}) => getFrom(bound, path, headers);

/** A POST, the way the page makes one: JSON in, JSON out. */
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => postTo(bound, path, body, headers);

/**
 * A request with headers `fetch` will not send.
 *
 * Undici refuses to forward a `Host` of our choosing, and `Host` is the header
 * the DNS-rebinding half of the guard reads — so the test that matters most
 * for that check cannot be written with `fetch` at all. `node:http` sends what
 * it is given.
 */
function raw(where: { port: number }, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: where.port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => resolve(answer(res.statusCode ?? 0, String(res.headers['content-type'] ?? ''), text)));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** How many rows a table has right now, straight from the file. */
function rowsIn(file: string, sql: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

/** One value, straight from the file, so a write is confirmed outside the API. */
function valueIn(file: string, sql: string): unknown {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.values(db.prepare(sql).get() as Record<string, unknown>)[0];
  } finally {
    db.close();
  }
}

const CONFIG = {
  connections: [
    { name: 'readonly', url: RO_DB },
    /* The opt-in. Everything that writes is refused on the connection above
       and accepted on this one, which is the only difference between them. */
    { name: 'writable', url: RW_DB, writable: true },
    /* Never opened. It is here so the connection list has a credential in it,
       and every response can be searched for the password. */
    {
      name: 'remote',
      url: `postgres://alice:${SECRET}@db.example.com:5432/appdb`,
    },
  ],
  views: [
    {
      name: 'Invoice lines',
      text: 'invoice_line show invoice_id, sku, quantity',
    },
    /* A view whose base table does not exist. It must come back *with its
       reason* rather than be dropped from the list. */
    { name: 'Broken', base: 'nonesuch', columns: ['id'] },
  ],
  queries: [
    {
      name: 'Active customers',
      sql: 'select id, name from customer where active = 1',
    },
    { name: 'Writable only', sql: 'select 1', connection: 'writable' },
  ],
};

before(async () => {
  /* Layouts and the default config location both live under the user's config
     directory, and this suite writes to both. Pointed at a temp directory so a
     test run cannot touch the layouts of whoever is running it. */
  tmp = mkdtempSync(join(tmpdir(), 'tablewalk-http-'));
  process.env.XDG_CONFIG_HOME = join(tmp, 'config');

  makeDemoDatabase(RO_DB);
  makeDemoDatabase(RW_DB);
  /* One row the two databases disagree about, so "this ran against the
     connection I named" is provable rather than assumed. */
  const seed = new DatabaseSync(RW_DB);
  seed.exec(`INSERT INTO country VALUES ('ZZ','Zedland')`);
  seed.close();

  configPath = join(tmp, 'tablewalk.json');
  writeFileSync(configPath, JSON.stringify(CONFIG, null, 2));

  /* Built the way `main` builds it, config file and all, because "writable"
     is read from that file and a registry assembled by hand would be testing
     a permission model the shipped one does not use. */
  const config = await loadConfig(configPath, await browserSections());
  registry = new Registry();
  for (const c of config!.connections) {
    registry.add({
      name: c.name,
      url: c.url,
      writable: c.writable === true,
      source: 'config',
    });
  }
  registry.setActive('readonly');
  await registry.open('readonly');

  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  const views = parseViewsConfig(raw, configPath);
  const queries = parseQueriesConfig(raw, configPath);

  server = createApp({ registry, views, configPath, queries, bound });
  proxyServer = createApp({
    registry,
    views,
    configPath,
    queries,
    bound: proxied,
  });
  for (const [listener, record] of [
    [server, bound],
    [proxyServer, proxied],
  ] as const) {
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    assert.ok(address && typeof address === 'object', 'the listener has no port');
    record.port = address.port;
  }
});

after(async () => {
  /* `close` alone waits for keep-alive sockets to time out, and undici keeps
     them. Destroying them is what makes the teardown instant and the process
     actually exit. */
  for (const listener of [server, proxyServer]) {
    listener?.close();
    listener?.closeAllConnections();
  }
  await registry?.closeAll();
  rmSync(DB_DIR, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe('writing needs a connection that says so', () => {
  /* The gate the server can actually enforce. Write mode in the browser is an
     affordance; a guard in the browser is not a guard. Every one of these
     asserts the message *and* the row, because only the second one proves the
     refusal reached the database. */

  test('save acknowledgements identify their undo entry and stale Undo cannot revert a later write', async () => {
    const original = valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3');
    const update = (email: unknown) =>
      post('/api/update', {
        conn: 'writable',
        table: 'customer',
        key: { id: 3 },
        values: { email },
      });
    try {
      const first = await update('first@example.test');
      const second = await update('second@example.test');
      assert.equal(typeof first.json.undoId, 'number');
      assert.notEqual(first.json.undoId, second.json.undoId);
      const stale = await post('/api/revert', {
        conn: 'writable',
        confirm: true,
        expectedId: first.json.undoId,
      });
      assert.equal(stale.status, 409);
      assert.equal(valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3'), 'second@example.test');
      const undo = await post('/api/revert', {
        conn: 'writable',
        confirm: true,
        expectedId: second.json.undoId,
      });
      assert.equal(undo.json.reverted, true);
      assert.equal(valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3'), 'first@example.test');
      const again = await post('/api/revert', {
        conn: 'writable',
        confirm: true,
        expectedId: second.json.undoId,
      });
      assert.equal(again.status, 409);
      assert.equal(valueIn(RW_DB, 'SELECT email AS v FROM customer WHERE id=3'), 'first@example.test');
    } finally {
      await update(original);
    }
  });
});

describe('/api/sql', () => {
  test('a read comes back positional, with the statement that ran', async () => {
    const res = await post('/api/sql', {
      text: 'select id, name from customer order by id',
      limit: 3,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.columns, ['id', 'name']);
    /* Arrays, not objects. `select id, id` returns two columns with one name
       and an object can only hold one of them — the shape is the guarantee. */
    assert.ok(Array.isArray(res.json.rows[0]), 'rows are not positional');
    assert.deepEqual(res.json.rows[0], [1, 'Harbour Freight']);
    assert.equal(res.json.rows.length, 3);
    assert.equal(res.json.truncated, true);
    assert.equal(res.json.bounded, true);
    assert.match(res.json.sql.text, /select id, name from customer/);
    assert.equal(typeof res.json.ms, 'number');
  });

  test('a long read runs beside the server, not in it, and stops when the browser leaves (SQL-1)', async () => {
    /* Seconds of work in one statement. In the server's own process it held every other request until it was done;
       in a process of its own, as the MCP sql tool's reads run, the server answers meanwhile. */
    const leave = new AbortController();
    const running = fetch(at(bound, '/api/sql'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000) SELECT count(*) FROM c',
      }),
      signal: leave.signal,
    }).catch((error: Error) => error);
    await new Promise((done) => setTimeout(done, 300));
    const started = performance.now();
    const health = await get('/healthz');
    assert.equal(health.status, 200);
    assert.ok(performance.now() - started < 2000, `the server answered after ${Math.round(performance.now() - started)} ms`);
    leave.abort();
    assert.equal(((await running) as Error).name, 'AbortError');
  });

  test('two columns of the same name both survive the trip', async () => {
    const res = await post('/api/sql', {
      text: 'select id, id from customer limit 1',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.columns.length, 2);
    assert.equal(res.json.rows[0].length, 2);
  });

  test('a statement short of the limit is not reported as truncated', async () => {
    const res = await post('/api/sql', {
      text: 'select code from country',
      limit: 100,
    });
    assert.equal(res.json.rows.length, 3);
    assert.equal(res.json.truncated, false);
  });

  test('a stacked statement is refused as 200 with errors', async () => {
    /* Two things were asked for. Running the first and discarding the rest
       would be worse than refusing both, and the refusal belongs beside the
       editor rather than as a failed request. */
    const before = rowsIn(RO_DB, 'SELECT COUNT(*) AS n FROM customer');
    const res = await post('/api/sql', {
      text: 'select 1; drop table customer',
    });
    assert.equal(res.status, 200);
    assert.match(res.json.errors[0].message, /One statement at a time/);
    assert.equal(res.json.rows, undefined);
    assert.equal(rowsIn(RO_DB, 'SELECT COUNT(*) AS n FROM customer'), before);
  });

  test('a write is refused on a read-only connection, and nothing changes', async () => {
    const res = await post('/api/sql', {
      text: `update country set name = 'Owned' where code = 'AU'`,
      write: true,
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /is read-only/);
    assert.equal(valueIn(RO_DB, `SELECT name AS v FROM country WHERE code = 'AU'`), 'Australia');
  });

  test('a write without asking for write mode hits a handle that cannot write', async () => {
    /* The permission check is one gate; the read handle is the other, and this
       is the one that holds when a caller simply forgets the flag. SQLite
       enforces it at the file level, so its own message comes back — 200 with
       errors, because the statement is the user's to fix. */
    const res = await post('/api/sql', {
      conn: 'writable',
      text: `update country set name = 'Owned' where code = 'AU'`,
    });
    assert.equal(res.status, 200);
    assert.match(res.json.errors[0].message, /readonly|read-only/i);
    assert.equal(valueIn(RW_DB, `SELECT name AS v FROM country WHERE code = 'AU'`), 'Australia');
  });

  test('a write goes through on a writable connection', async () => {
    const res = await post('/api/sql', {
      conn: 'writable',
      text: `update country set name = 'Zedland Prime' where code = 'ZZ'`,
      write: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.affected, 1);
    // A write has no rows to bound, and says so rather than claiming it did.
    assert.equal(res.json.bounded, false);

    /* And it is history: listed with the others, marked as what it is. Raw
       SQL has no general inverse, so undo will not guess at one — but a
       write the history did not show was a write nobody could reason back
       from at all. */
    const listed = await post('/api/revert', { conn: 'writable' });
    assert.equal(listed.status, 200);
    const sql = (
      listed.json.writes as Array<{
        kind: string;
        revertible: boolean;
        summary: string;
        reason?: string;
      }>
    ).find((w) => w.kind === 'sql');
    assert.ok(sql, 'the raw write is in the history');
    assert.equal(sql!.revertible, false);
    assert.match(sql!.summary, /Ran SQL: update country set name/);
    assert.match(sql!.reason ?? '', /no general inverse/);
    assert.equal(valueIn(RW_DB, `SELECT name AS v FROM country WHERE code = 'ZZ'`), 'Zedland Prime');
  });

  test('an empty statement is a 400 with {error}, not an empty result', async () => {
    for (const text of ['', '   ', undefined]) {
      const res = await post('/api/sql', { text });
      assert.equal(res.status, 400, JSON.stringify(text));
      assert.equal(res.json.error, 'Nothing to run.');
    }
  });

  test("a broken statement comes back with the database's own message", async () => {
    const res = await post('/api/sql', { text: 'select * from nonesuch' });
    assert.equal(res.status, 200);
    assert.match(res.json.errors[0].message, /nonesuch/);
    // The infrastructure vocabulary must not appear: nothing was wrong with
    // the request, only with what it asked for.
    assert.equal(res.json.error, undefined);
  });
});

describe('reading', () => {
  test('/api/ddl says whether it is the real thing or a reconstruction', async () => {
    const res = await get('/api/ddl?table=customer');
    assert.equal(res.status, 200);
    assert.equal(res.json.table, 'customer');
    assert.match(res.json.sql, /CREATE TABLE customer/);
    // SQLite keeps the original statement, so this one is exact. Saying so is
    // the point: a reconstruction presented as authoritative is a lie that
    // bites the first time someone pastes it into a migration.
    assert.equal(res.json.exact, true);
  });

  test('/api/ddl on an unknown table is a 404, not an empty statement', async () => {
    for (const query of ['?table=nonesuch', '']) {
      const res = await get(`/api/ddl${query}`);
      assert.equal(res.status, 404, query);
      assert.match(res.json.error, /Unknown table/);
    }
  });

  test('/api/queries sends the statements this connection is meant to see', async () => {
    const mine = await get('/api/queries');
    assert.equal(mine.status, 200);
    assert.equal(mine.json.connection, 'readonly');
    assert.deepEqual(
      mine.json.queries.map((q: { name: string }) => q.name),
      ['Active customers'],
    );
    assert.equal(mine.json.queries[0].source, 'config');

    // The one scoped to another connection is not offered here, and is there.
    const theirs = await get('/api/queries?conn=writable');
    assert.deepEqual(
      theirs.json.queries.map((q: { name: string }) => q.name),
      ['Active customers', 'Writable only'],
    );
  });
});

describe('layouts', () => {
  test('a layout round-trips through the file the server owns', async () => {
    const empty = await get('/api/layouts');
    assert.equal(empty.status, 200);
    assert.equal(empty.json.connection, 'readonly');
    assert.deepEqual(empty.json.layouts, {});

    const saved = await post('/api/layouts', {
      table: 'customer',
      layout: { sections: [{ title: 'Money', fields: ['credit_limit'] }] },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json, { ok: true });

    const back = await get('/api/layouts');
    assert.deepEqual(back.json.layouts.customer.sections[0].fields, ['credit_limit']);
  });

  test('layouts are keyed by connection, not by table name', async () => {
    /* The same table name means different things on two databases, and a
       layout built for one quietly applying to the other is a record page that
       hides fields nobody hid. */
    const other = await get('/api/layouts?conn=writable');
    assert.deepEqual(other.json.layouts, {});
  });

  test('null removes a layout rather than storing an empty one', async () => {
    // "Reset to default" means no layout, so the derived one takes over again
    // — not an empty layout, which would render an empty record.
    const removed = await post('/api/layouts', {
      table: 'customer',
      layout: null,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual((await get('/api/layouts')).json.layouts, {});
  });

  test('a layout with no table, or a layout that is not an object, is a 400', async () => {
    const noTable = await post('/api/layouts', { layout: {} });
    assert.equal(noTable.status, 400);
    assert.equal(noTable.json.error, 'A layout needs a table.');

    const notAnObject = await post('/api/layouts', {
      table: 'customer',
      layout: 7,
    });
    assert.equal(notAnObject.status, 400);
    assert.match(notAnObject.json.error, /must be an object, or null to remove it/);
  });
});

describe('saved pages, persisted like layouts', () => {
  /* Pages were the one piece of built work living only in localStorage; the
     endpoints below are the layout endpoints' twins, so a page assembled in
     one browser is offered in every other. */
  test('a page round-trips through the file the server owns', async () => {
    assert.deepEqual((await get('/api/pages/saved')).json.pages, {});

    const saved = await post('/api/pages/save', {
      id: 'saved:customer:1',
      page: {
        id: 'saved:customer:1',
        name: 'Overview',
        base: 'customer',
        source: 'saved',
        sections: [{ kind: 'fields' }],
      },
    });
    assert.deepEqual(saved.json, { ok: true });

    const back = await get('/api/pages/saved');
    assert.equal(back.json.pages['saved:customer:1'].name, 'Overview');

    // Keyed by connection, like everything stored about one.
    assert.deepEqual((await get('/api/pages/saved?conn=writable')).json.pages, {});

    // Null removes, deleting the page everywhere rather than in one browser.
    await post('/api/pages/save', { id: 'saved:customer:1', page: null });
    assert.deepEqual((await get('/api/pages/saved')).json.pages, {});
  });

  test('a page with no id, or one that is not an object, is a 400', async () => {
    assert.equal((await post('/api/pages/save', { page: {} })).status, 400);
    assert.equal((await post('/api/pages/save', { id: 'x', page: 7 })).status, 400);
  });

  test('a failed pages-file write reports failure without claiming browser persistence', async () => {
    const previous = process.env.XDG_CONFIG_HOME;
    const blocked = join(tmp, 'not-a-config-directory');
    writeFileSync(blocked, 'This file cannot contain a pages store.');
    process.env.XDG_CONFIG_HOME = blocked;
    try {
      for (const page of [{ name: 'Unsaved' }, null]) {
        const response = await post('/api/pages/save', {
          id: 'saved:failure',
          page,
        });
        assert.equal(response.status, 500);
        assert.match(response.json.error, /pages file could not be written/);
        assert.doesNotMatch(response.json.error, /Saved in this browser/);
      }
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

describe('the agent endpoints, which are the MCP by another door', () => {
  test('the tool list is the stdio list, writes included where config allows', async () => {
    const res = await get('/api/agent/tools');
    const names = (res.json.tools as Array<{ name: string }>).map((t) => t.name);
    // This fixture has a writable connection, so the write tools appear.
    assert.ok(names.includes('schema_summary') && names.includes('update') && names.includes('insert'));
    assert.ok(names.includes('insert_graph') && names.includes('delete_graph'));
    assert.ok(names.includes('change_impact'));
    assert.ok(names.includes('revert'), 'undo is a write tool too');
    // The App authoring tools are the App framework's (`mistri observe --mcp` checks an App); this server serves none.
    assert.ok(!names.includes('validate_app') && !names.includes('scaffold_app'));
    // Derived, not hardcoded: the number moved once and this line was the lag.
    const { read, write } = toolCounts();
    assert.equal(names.length, read + write);
  });

  test('a call answers the MCP shape: structured content, stats, isError', async () => {
    const res = await post('/api/agent/call', {
      name: 'query',
      arguments: { q: 'customer limit 2' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.isError, false);
    assert.equal(res.json.structuredContent.rows.length, 2);
    assert.equal(res.json.structuredContent.stats.rowsRead, 2);
    // The text content is the structured answer serialised — the dual the spec asks for.
    assert.deepEqual(JSON.parse(res.json.content[0].text), res.json.structuredContent);
  });

  test('a tool error is a result, exactly as it is over stdio', async () => {
    const res = await post('/api/agent/call', {
      name: 'table',
      arguments: { table: 'nonesuch' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.isError, true);
    assert.match(res.json.content[0].text, /Unknown table/);
  });
});

describe('connections, over HTTP', () => {
  test('the list never carries a connection string', async () => {
    /* A connection string is a credential. Everything the browser receives
       goes through the public view, and this is the assertion that the trip
       actually happened. */
    const res = await get('/api/connections');
    assert.equal(res.status, 200);
    assert.equal(res.json.active, 'readonly');
    assert.ok(!res.text.includes(SECRET), `password reached the page: ${res.text}`);
    const remote = res.json.connections.find((c: { id: string }) => c.id === 'remote');
    assert.equal(remote.detail, 'alice@db.example.com:5432/appdb');
    assert.equal(remote.url, undefined);
    assert.equal(remote.dialect, 'postgres');
  });

  test('the list says which connections the server will accept writes for', async () => {
    // A write toggle offered on a connection the server will refuse is a
    // button that lies, so the flag has to reach the page.
    const res = await get('/api/connections');
    const flags = Object.fromEntries(res.json.connections.map((c: { id: string; writable: boolean }) => [c.id, c.writable]));
    assert.deepEqual(flags, { readonly: false, writable: true, remote: false });
  });

  test('selecting a connection opens it and answers with its schema', async () => {
    const res = await post('/api/connections/select', { id: 'writable' });
    assert.equal(res.status, 200);
    assert.equal(res.json.active, 'writable');
    assert.equal(res.json.schema.label, 'writable');

    // Put it back: everything after this reads from the read-only one.
    await post('/api/connections/select', { id: 'readonly' });
    assert.equal((await get('/api/connections')).json.active, 'readonly');
  });

  test('selecting, refreshing, updating or removing a name nobody has is a 404', async () => {
    for (const path of ['select', 'update', 'remove']) {
      const res = await post(`/api/connections/${path}`, { id: 'nonesuch' });
      assert.equal(res.status, 404, path);
      assert.equal(res.json.error, 'No connection called "nonesuch".');
    }
  });

  test('refreshing re-reads the catalog', async () => {
    const res = await post('/api/connections/refresh', { id: 'readonly' });
    assert.equal(res.status, 200);
    assert.equal(res.json.schema.label, 'readonly');
    assert.ok(res.json.schema.tables.length > 0);
  });

  test('refresh with no id refreshes whatever is active', async () => {
    const res = await post('/api/connections/refresh', {});
    assert.equal(res.status, 200);
    assert.equal(res.json.schema.label, 'readonly');
  });

  test('renaming a connection changes the session and not the file', async () => {
    const before = readFileSync(configPath, 'utf8');
    const res = await post('/api/connections/update', {
      id: 'remote',
      name: 'remote renamed',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.connections.find((c: { id: string }) => c.id === 'remote').name, 'remote renamed');
    /* A browser page silently editing a file on disk is a surprise nobody
       asked for. Making it permanent is /api/connections/save, and only that. */
    assert.equal(readFileSync(configPath, 'utf8'), before);

    await post('/api/connections/update', { id: 'remote', name: 'remote' });
  });

  test('a connection that will not open is kept, listed with its reason', async () => {
    /* "The add failed" and "nothing was added" are not the same thing, and
       here the first is the useful one: a mistyped password should leave the
       connection on screen to be corrected. It is also what already happens
       to a config-file connection that will not open. The list comes back
       with the error so the client can show the broken entry without a
       second request. */
    const res = await post('/api/connections', {
      name: 'missing',
      url: join(DB_DIR, 'definitely-not-here.db'),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.id, 'missing');
    assert.match(res.json.error, /missing:/);

    const inReply = res.json.connections.find((c: { id: string }) => c.id === 'missing');
    assert.ok(inReply, 'the reply did not carry the list it had just changed');
    assert.equal(inReply.connected, false);
    assert.ok(inReply.error);

    const listed = await get('/api/connections');
    const broken = listed.json.connections.find((c: { id: string }) => c.id === 'missing');
    assert.ok(broken, 'the failed connection vanished instead of being reported');
    assert.equal(broken.connected, false);
    assert.ok(broken.error);

    const removed = await post('/api/connections/remove', { id: 'missing' });
    assert.equal(removed.status, 200);
    assert.ok(!removed.json.connections.some((c: { id: string }) => c.id === 'missing'));
  });

  test('adding without a url is a 400 and adds nothing', async () => {
    const before = (await get('/api/connections')).json.connections.length;
    const res = await post('/api/connections', { name: 'nameless' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'A url is required.');
    assert.equal((await get('/api/connections')).json.connections.length, before);
  });

  test('testing a connection reports on it and adds nothing', async () => {
    /* Adding was the only way to find out whether a target worked, and a
       failed add leaves the entry behind on purpose — so a mistyped password
       is a correction rather than a retype. Right for adding, wrong for
       checking: somebody who is not sure yet should not have to tidy up after
       asking. */
    const before = (await get('/api/connections')).json.connections.length;

    const good = await post('/api/connections/test', { url: RO_DB });
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
    assert.equal(good.json.dialect, 'sqlite');
    /* The table count is what says it *read* the database rather than merely
       reached it — a URL that connects and cannot be introspected is not a
       working connection. */
    assert.ok(good.json.tables > 0);

    const bad = await post('/api/connections/test', {
      url: '/nowhere/does/not/exist.db',
    });
    assert.equal(bad.status, 200, 'a target that does not work is an answer, not a failed request');
    assert.equal(bad.json.ok, false);
    assert.ok(String(bad.json.error).length);

    const missing = await post('/api/connections/test', {});
    assert.equal(missing.status, 400);

    assert.equal((await get('/api/connections')).json.connections.length, before, 'and none of that added a connection');
  });

  test('saving writes the connections, and the writable flag only when true', async () => {
    const target = join(tmp, 'saved.json');
    const res = await post('/api/connections/save', { path: target });
    assert.equal(res.status, 200);
    assert.equal(res.json.path, target);
    assert.equal(res.json.count, 3);

    const written = JSON.parse(readFileSync(target, 'utf8')) as {
      connections: Array<{ name: string; url: string; writable?: boolean }>;
    };
    assert.deepEqual(
      written.connections.map((c) => c.name),
      ['readonly', 'writable', 'remote'],
    );
    // Absent means read-only. A file full of `"writable": false` would suggest
    // the flag is doing something.
    assert.equal('writable' in written.connections[0], false);
    assert.equal(written.connections[1].writable, true);
    /* An inline password does *not* get written back inline. `storeSecret`
       was written to move it to the keychain — or a 0600 file where there is
       no keychain — and nothing called it, so its own promise that "the URL
       that gets written to disk never contains the password" was not in
       force. A config file that leaks should be embarrassing, not a breach.

       The user survives; only the secret goes. */
    assert.ok(!written.connections[2].url.includes(SECRET), written.connections[2].url);
    assert.ok(written.connections[2].url.includes('@'), 'the rest of the URL is intact');
    assert.equal(res.json.secrets?.length, 1, 'and the answer says one was moved');
  });

  test('saving over a config file keeps its views and queries', async () => {
    /* The registry holds connections and nothing else, so building the file
       out of it alone deleted the `views` and `queries` a team had committed
       — and told the person who pressed the button that the file was written,
       not that half of it had gone. Only `connections` is rewritten now.

       Asserted against a copy, so the fixture survives the write. */
    const copy = join(tmp, 'copy.json');
    writeFileSync(copy, readFileSync(configPath, 'utf8'));
    const before = JSON.parse(readFileSync(copy, 'utf8')) as Record<string, unknown>;
    assert.ok((before.views as unknown[]).length);

    const res = await post('/api/connections/save', { path: copy });
    assert.equal(res.status, 200);

    const after = JSON.parse(readFileSync(copy, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(after.views, before.views);
    assert.deepEqual(after.queries, before.queries);
    // And the connections really were rewritten, so this is not passing by
    // having quietly done nothing at all.
    assert.equal((after.connections as unknown[]).length, 3);
  });

  test('an unknown key someone hand-added survives the write', async () => {
    /* The loader ignores keys it does not know, which is what lets the
       reference config carry a `_comment`. A save that dropped them would
       delete a block of prose the moment anyone used the connection manager. */
    const copy = join(tmp, 'commented.json');
    writeFileSync(copy, JSON.stringify({ _comment: ['keep me'], connections: [] }));
    await post('/api/connections/save', { path: copy });
    assert.deepEqual((JSON.parse(readFileSync(copy, 'utf8')) as { _comment: string[] })._comment, ['keep me']);
  });

  test('a file that is not valid JSON is reported, not overwritten', async () => {
    /* The dangerous case. Overwriting replaces something hand-edited with a
       machine-generated stub, so the person who typed a stray comma finds
       their views gone rather than their typo named. */
    const broken = join(tmp, 'broken.json');
    writeFileSync(broken, '{ "views": [], }');
    const res = await post('/api/connections/save', { path: broken });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /not valid JSON/);
    assert.equal(readFileSync(broken, 'utf8'), '{ "views": [], }');
  });

  test('a config file that does not exist yet is simply written', async () => {
    const fresh = join(tmp, 'fresh.json');
    const res = await post('/api/connections/save', { path: fresh });
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(readFileSync(fresh, 'utf8')) as { connections: unknown[] }).connections.length, 3);
  });

  test('a save that cannot be written is a 500 that names the path', async () => {
    const res = await post('/api/connections/save', {
      path: join(tmp, 'saved.json', 'nope.json'),
    });
    assert.equal(res.status, 500);
    assert.match(res.json.error, /Could not write/);
  });
});

describe('the connection manager trusts the browser only on loopback', () => {
  /* On loopback the browser is the operator and may do what the config file
     may. On a listener that answers to other names — the container-behind-a-
     proxy case `proxied` stands in for — the browser is anyone on the
     network, and each of those conveniences was a way out: an env reference
     sent this process's secrets to a host the caller named, a bare path read
     any SQLite file the server user could, a save wrote JSON wherever the
     body pointed, and an update redirected a config connection for every
     reader. The same body through the loopback listener still works. */
  const host = {
    host: 'tablewalk.internal',
    'content-type': 'application/json',
  };
  const exposed = (path: string, body: unknown) => raw(proxied, 'POST', path, host, JSON.stringify(body));

  test('a URL referencing the environment is refused, on add and on test', async () => {
    for (const path of ['/api/connections', '/api/connections/test']) {
      const res = await exposed(path, {
        name: 'leak',
        url: 'postgres://u:${HOME}@attacker.example/db',
      });
      assert.equal(res.status, 403, path);
      assert.match(res.json.error, /cannot reference environment variables/);
    }
    // No connection was added on the way to the refusal.
    assert.ok(!(await get('/api/connections')).json.connections.some((c: { name: string }) => c.name === 'leak'));
  });

  test('a SQLite file path is refused, in every spelling', async () => {
    for (const url of [RO_DB, `sqlite:${RO_DB}`, '/etc/passwd', 'thing.db']) {
      const res = await exposed('/api/connections', { name: 'file', url });
      assert.equal(res.status, 403, url);
      assert.match(res.json.error, /cannot open a SQLite file by path/);
    }
  });

  test('a network URL is still accepted, and used exactly as written', async () => {
    /* The refusal is of the forms that resolve something on this machine,
       not of adding connections. A plain URL to a host nobody is listening on
       is added, fails to open, and is listed with its reason like any other —
       and the reason is the driver's, not a missing password: nothing was
       looked up by name. */
    const res = await exposed('/api/connections', {
      name: 'plain',
      url: 'postgres://u@127.0.0.1:1/db',
    });
    assert.equal(res.status, 400, res.text);
    const listed = res.json.connections.find((c: { id: string }) => c.id === 'plain');
    assert.ok(listed, 'added, with its error');
    assert.doesNotMatch(listed.error ?? '', /keychain|credentials file/);
    // And it is dialled sealed: a loopback address is not this browser's to probe (untrustedDatabase.ts).
    assert.match(listed.error ?? '', /may not reach/);
    const probe = await exposed('/api/connections/test', {
      url: 'postgres://u@127.0.0.1:1/db',
    });
    assert.equal(probe.json.ok, false);
    assert.match(probe.json.error, /may not reach/);
    await post('/api/connections/remove', { id: 'plain' });
  });

  test('a config connection cannot be redirected, and saving is refused', async () => {
    const before = readFileSync(configPath, 'utf8');
    const moved = await exposed('/api/connections/update', {
      id: 'remote',
      url: 'postgres://u@attacker.example/db',
    });
    assert.equal(moved.status, 403);
    assert.match(moved.json.error, /comes from the config file/);

    const saved = await exposed('/api/connections/save', {
      path: join(tmp, 'stolen.json'),
    });
    assert.equal(saved.status, 403);
    assert.match(saved.json.error, /saved from the machine running tablewalk/);
    assert.equal(readFileSync(configPath, 'utf8'), before);
    assert.throws(() => readFileSync(join(tmp, 'stolen.json')), 'nothing was written where the body pointed');

    // A rename is still the client's to make; it redirects nothing.
    const renamed = await exposed('/api/connections/update', {
      id: 'remote',
      name: 'remote (proxied)',
    });
    assert.equal(renamed.status, 200);
    await post('/api/connections/update', { id: 'remote', name: 'remote' });
  });

  test("on loopback, the same forms are still the operator's to use", async () => {
    /* The guard is about who is on the other end, not about the forms. */
    const file = await post('/api/connections/test', { url: RO_DB });
    assert.equal(file.status, 200);
    assert.equal(file.json.ok, true);
  });
});

describe('a proxy that signs people in', () => {
  /* `--auth-proxy-header X-Forwarded-User`: the proxy's decision, carried
     in. From beyond loopback the header is required — a request without it
     skipped the proxy — and every write is journaled with who made it. */

  test('a write carries who made it into the journal, and whoami says so', async () => {
    const own = new Registry();
    own.add({ name: 'rw', url: RW_DB, writable: true, source: 'config' });
    own.setActive('rw');
    await own.open('rw');
    const where = {
      host: '127.0.0.1',
      port: 0,
      identityHeader: 'X-Forwarded-User',
    };
    const srv = createApp({ registry: own, bound: where });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    where.port = (srv.address() as { port: number }).port;
    try {
      const who = await getFrom(where, '/api/whoami', {
        'x-forwarded-user': 'ada@example.org',
      });
      assert.deepEqual(who.json, {
        who: 'ada@example.org',
        header: 'X-Forwarded-User',
        signedIn: false,
      });
      // Loopback without the header is the operator's own machine.
      assert.equal((await getFrom(where, '/api/whoami')).json.who, 'local');
      const wrote = await postTo(
        where,
        '/api/update',
        { table: 'country', key: { code: 'ZZ' }, values: { name: 'Zedland' } },
        { 'x-forwarded-user': 'ada@example.org' },
      );
      assert.equal(wrote.status, 200, wrote.text);
      const listed = await postTo(where, '/api/revert', {}, { 'x-forwarded-user': 'ada@example.org' });
      const last = (listed.json.writes as Array<{ kind: string; by?: string }>)[0];
      assert.equal(last.kind, 'update');
      assert.equal(last.by, 'ada@example.org');
    } finally {
      srv.close();
      srv.closeAllConnections();
    }
  });
});

describe('the view endpoints', () => {
  /* `/api/view/run` and `/api/view/compile` are heavily unit-tested through
     the compiler and had no HTTP coverage at all — including the two things
     only the endpoint does: answer errors with a 200 and an `errors` array
     rather than a status, and map a `PathError` to a 400. Both are contracts
     the client branches on. */

  const view = (extra: Record<string, unknown> = {}) => ({
    id: 'test',
    name: 'customer',
    base: 'customer',
    columns: [{ path: 'id' }, { path: 'name' }],
    limit: 5,
    ...extra,
  });

  test('compiling does not run anything', async () => {
    /* The SQL panel while a view is still being built: compiling is free and
       running is not, and a half-finished view is worth showing the statement
       for. */
    const res = await post('/api/view/compile', { view: view() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.errors, []);
    assert.match(res.json.sql.text, /SELECT/i);
    assert.equal(res.json.rows, undefined, 'compile returned rows');
  });
});

describe('the limit and offset clamps, over HTTP', () => {
  /* The clamps have unit tests. These prove the request path reaches them —
     an endpoint that read `body.limit` directly would pass every one of those
     unit tests and still send a million rows. */

  test('/api/sql is capped by the same ceiling', async () => {
    const res = await post('/api/sql', {
      text: 'select id from customer',
      limit: 1,
    });
    assert.equal(res.json.rows.length, 1);
    assert.equal(res.json.truncated, true);
  });
});

describe('reading a request body', () => {
  /* A keep-alive connection whose body was cut off at the cap still held the rest of it, unread: the next request on
     that socket was parsed out of the leftover bytes and hung or was reset (a live load test). The rest is read and
     dropped now, so the 413 leaves the connection clean and the next request on it is answered. Megabytes past the
     cap, so most of the body is still on its way when the cap is met. */

  test('a refresh does not close a connection out from under a query', async () => {
    /* Closing an adapter is not something the thing using it finds out about.
       A slow read in one tab and a `refresh` in another ended the client
       mid-query: a driver-level "connection closed" 500 on Postgres, a
       use-after-close on SQLite. Nothing counted who was using what.

       Both are started together and both must succeed. On SQLite the window
       is small, so this is a guard against the shape rather than a
       reproduction of the timing — which is the honest thing a test can be
       here, and better than the nothing that was here before. */
    const [read, refreshed] = await Promise.all([
      post('/api/run', { q: 'customer' }),
      post('/api/connections/refresh', { id: 'readonly' }),
    ]);
    assert.equal(read.status, 200, `the read failed: ${read.text.slice(0, 200)}`);
    assert.equal(refreshed.status, 200, `the refresh failed: ${refreshed.text.slice(0, 200)}`);
    assert.ok(read.json.rows.length, 'the read came back empty');

    // And the connection still works afterwards, which a half-closed adapter
    // would not.
    assert.equal((await post('/api/count', { table: 'customer' })).json.count, 5);
  });
});

describe('with no connections at all', () => {
  let empty: Server;
  const where = { host: '127.0.0.1', port: 0, allowedHosts: [] as string[] };

  before(async () => {
    empty = createApp({ registry: new Registry(), bound: where });
    await new Promise<void>((resolve) => empty.listen(0, '127.0.0.1', resolve));
    const address = empty.address();
    assert.ok(address && typeof address === 'object');
    where.port = address.port;
  });

  after(async () => {
    empty?.close();
    empty?.closeAllConnections();
  });

  test('the connection list is empty rather than an error', async () => {
    const res = await getFrom(where, '/api/connections');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.connections, []);
    assert.equal(res.json.active, null);
  });

  test('adding one makes it active, and the schema arrives', async () => {
    const added = await postTo(where, '/api/connections', {
      name: 'fresh',
      url: RO_DB,
    });
    assert.equal(added.status, 200);
    assert.equal(added.json.active, 'fresh');

    const schema = await getFrom(where, '/api/schema');
    assert.equal(schema.status, 200);
    assert.ok(schema.json.tables.length > 0);
  });

  test('and the last one can be removed again, back to nothing', async () => {
    /* The registry refused this while zero connections was a state the
       product had no screen for. It has one now, so the refusal was only a
       connection nobody could delete. */
    const res = await postTo(where, '/api/connections/remove', { id: 'fresh' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.connections, []);
    assert.equal(res.json.active, null);
    /* The page itself still being served is the browser suites' to prove: it is the built client, which this suite
       does not build. */
  });

  test('an add that cannot open does not become the active connection', async () => {
    /* `add` makes the first connection active before anything has tried to
       dial it. So a first add that then failed to open left the whole
       application pointed at a connection that had never worked — and every
       later request answering with its error, including requests meant for a
       connection that was added afterwards and worked fine. */
    const bad = await postTo(where, '/api/connections', {
      name: 'nope',
      url: '/no/such/directory/db.sqlite',
    });
    assert.equal(bad.status, 400);
    /* Still listed with its error, which is deliberate: a mistyped target
       should be a correction rather than a retype. */
    assert.ok(bad.json.connections.some((c: { id: string }) => c.id === 'nope'));
    assert.equal(bad.json.active, null);
    assert.equal((await getFrom(where, '/api/schema')).status, 409);

    /* And the one added after it works, rather than inheriting the wreck. */
    const good = await postTo(where, '/api/connections', {
      name: 'works',
      url: RO_DB,
    });
    assert.equal(good.status, 200);
    assert.equal(good.json.active, 'works');
    assert.equal((await getFrom(where, '/api/schema')).status, 200);

    await postTo(where, '/api/connections/remove', { id: 'nope' });
    await postTo(where, '/api/connections/remove', { id: 'works' });
  });

  test('and a failed add leaves a working active connection alone', async () => {
    await postTo(where, '/api/connections', { name: 'keeper', url: RO_DB });
    const bad = await postTo(where, '/api/connections', {
      name: 'dud',
      url: '/no/such/directory/db.sqlite',
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.active, 'keeper');
    assert.equal((await getFrom(where, '/api/schema')).status, 200);

    await postTo(where, '/api/connections/remove', { id: 'dud' });
    await postTo(where, '/api/connections/remove', { id: 'keeper' });
  });
});
