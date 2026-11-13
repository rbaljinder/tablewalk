/**
 * The database browser's resource wire: what an update, an insert and a delete acknowledge, the public Undo that follows
 * them, and the unknown outcome of a write whose commit acknowledgement is lost (never a success token, never a retry).
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry, type Adapter } from '@mistriwork/engine/host';
import { clearJournal } from '@mistriwork/engine/server/journal.js';
import { createApp } from './support/createApp.js';

type Reply = { status: number; body: any };
type Fixture = {
  adapter: Adapter;
  table: string;
  note: string;
  row(id?: number): Record<string, unknown> | undefined;
  call(path: string, body: Record<string, unknown>): Promise<Reply>;
};
const secret = 'PRIVATE_HTTP_CONTRACT_DRIVER';

async function fixture(run: (f: Fixture) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-http-contract-'));
  const owner = basename(directory);
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  const registry = new Registry();
  let server: Server | undefined;
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE physical_team(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE physical_item(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        team INTEGER REFERENCES physical_team(id), score INTEGER NOT NULL DEFAULT 7);
      CREATE TABLE physical_note(id INTEGER PRIMARY KEY, item INTEGER REFERENCES physical_item(id));
      INSERT INTO physical_team VALUES (1, 'North'), (2, 'South');
      INSERT INTO physical_item(id, name, team) VALUES (1, 'Alpha', 1), (2, 'Beta', 1), (3, 'Gamma', 2);
      INSERT INTO physical_note VALUES (1, 1);`);
    registry.add({ id: owner, name: owner, url: file, source: 'config', writable: true });
    const adapter = (await registry.open(owner)).adapter;
    const bound = { host: '127.0.0.1', port: 0 };
    server = createApp({ registry, bound });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({
      adapter,
      table: 'physical_item',
      note: 'physical_note',
      row: (id = 2) => {
        const row = db.prepare('SELECT * FROM physical_item WHERE id = ?').get(id);
        return row ? { ...row } : undefined;
      },
      call: async (path, body) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ conn: owner, ...body }),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    if (server) {
      const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    await registry.closeAll();
    db.close();
    clearJournal(owner);
    rmSync(directory, { recursive: true, force: true });
  }
}

function keys(body: any, expected: readonly string[]) {
  assert.deepEqual(Object.keys(body).sort(), [...expected].sort(), JSON.stringify(body));
}
function success(reply: Reply) {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.ok(!reply.body.errors?.length, JSON.stringify(reply.body));
  return reply.body;
}
function diagnostics(body: any) {
  assert.ok(Array.isArray(body.errors) && body.errors.length > 0, JSON.stringify(body));
  for (const error of body.errors) {
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    assert.ok(Object.keys(error).every((key) => ['message', 'code', 'at', 'fields'].includes(key)));
    if ('at' in error) assert.equal(typeof error.at, 'number');
    for (const field of error.fields ?? []) assert.deepEqual(Object.keys(field).sort(), ['field', 'message']);
  }
  for (const field of ['rows', 'columns', 'applied', 'undoId']) assert.equal(Object.hasOwn(body, field), false);
}
function projection(body: any, sql: boolean) {
  assert.equal(Object.hasOwn(body, 'sql'), sql);
  if (sql) {
    keys(body.sql, ['text', 'params']);
    assert.equal(typeof body.sql.text, 'string');
    assert.ok(Array.isArray(body.sql.params));
  }
}
function publicHistory(body: any) {
  assert.equal(body.reverted, false);
  assert.ok(Array.isArray(body.writes));
  for (const entry of body.writes) {
    assert.ok(
      Object.keys(entry).every((key) =>
        ['id', 'kind', 'at', 'summary', 'by', 'revertible', 'reason', 'undoState', 'blocksUndo'].includes(key),
      ),
      JSON.stringify(entry),
    );
    assert.equal(typeof entry.id, 'number');
    assert.equal(typeof entry.at, 'string');
    assert.equal(typeof entry.summary, 'string');
    assert.equal(typeof entry.revertible, 'boolean');
  }
  if (body.next) keys(body.next, ['id', 'kind', 'at', 'summary']);
}

// Throw only after SQLite has executed COMMIT, proving unknown is not rejected
// and is not safe to retry. A new disposable writer is used for every case.
function loseCommitAcknowledgement(adapter: Adapter) {
  const transaction = adapter.transaction!.bind(adapter);
  adapter.transaction = (run) =>
    transaction(async (tx) => {
      const result = await run(tx);
      const writer = Reflect.get(adapter, 'writeDb') as DatabaseSync;
      const exec = writer.exec.bind(writer);
      writer.exec = (sql) => {
        exec(sql);
        if (sql === 'COMMIT') throw new Error(secret);
      };
      return result;
    });
}

test('resource wire: ordinary update acknowledgements, legacy form, expected guard and public Undo', async () => {
  await fixture(async (f) => {
    const saved = success(
      await f.call('/api/update', {
        table: f.table,
        key: { id: 2 },
        values: { name: 'Saved' },
        column: 'name',
        value: 'Ignored',
        expected: { name: 'Beta' },
      }),
    );
    keys(saved, ['affected', 'applied', 'undoId', 'sql']);
    assert.equal(saved.affected, 1);
    assert.deepEqual(saved.applied, { name: 'Saved' });
    assert.equal(typeof saved.undoId, 'number');
    assert.equal(f.row()?.name, 'Saved');
    projection(saved, true);
    const stale = await f.call('/api/update', { table: f.table, key: { id: 2 }, values: { name: 'Stale' }, expected: { name: 'Beta' } });
    assert.equal(stale.status, 409);
    assert.equal(typeof stale.body.error, 'string');
    assert.equal(Object.hasOwn(stale.body, 'outcome'), false);
    assert.equal(f.row()?.name, 'Saved');
    {
      const preview = success(await f.call('/api/revert', {}));
      keys(preview, ['reverted', 'writes', 'next']);
      publicHistory(preview);
      assert.equal(preview.writes.length, 1);
      assert.equal(preview.next.id, saved.undoId);
      assert.equal(f.row()?.name, 'Saved', 'Undo preview cannot mutate');
      const wrong = await f.call('/api/revert', { confirm: true, expectedId: saved.undoId + 1 });
      assert.equal(wrong.status, 409);
      assert.equal(wrong.body.outcome, 'not_applied');
      assert.equal(wrong.body.reverted, false);
      const undone = success(await f.call('/api/revert', { confirm: true, expectedId: saved.undoId }));
      keys(undone, ['reverted', 'outcome', 'undone', 'steps']);
      assert.equal(undone.reverted, true);
      assert.equal(undone.outcome, 'applied');
      keys(undone.undone, ['id', 'kind', 'summary']);
      assert.equal(undone.undone.id, saved.undoId);
      assert.equal(f.row()?.name, 'Beta');
      assert.deepEqual(success(await f.call('/api/revert', {})), { reverted: false, writes: [] });
    }
    const legacy = success(await f.call('/api/update', { table: f.table, key: { id: 2 }, column: 'name', value: 'Legacy' }));
    assert.deepEqual(legacy.applied, { name: 'Legacy' });
    assert.equal(f.row()?.name, 'Legacy');
  });
});

test('resource wire: insert defaults and duplicate rejection; delete impact preview/confirm and restore', async () => {
  await fixture(async (f) => {
    const inserted = success(await f.call('/api/insert', { table: f.table, values: { id: 9, name: 'Created' } }));
    keys(inserted, ['key', 'row', 'applied', 'undoId', 'sql']);
    assert.deepEqual(inserted.key, { id: 9 });
    assert.deepEqual(inserted.row, { id: 9, name: 'Created', team: null, score: 7 });
    assert.deepEqual(inserted.applied, { id: 9, name: 'Created' });
    projection(inserted, true);
    const duplicate = await f.call('/api/insert', { table: f.table, values: { id: 9, name: 'Duplicate' } });
    assert.equal(duplicate.status, 409);
    diagnostics(duplicate.body);
    assert.equal(duplicate.body.outcome, 'rejected');
    assert.equal(f.row(9)?.name, 'Created');
    for (const confirm of [undefined, false]) {
      const preview = success(await f.call('/api/delete', { table: f.table, key: { id: 9 }, confirm }));
      keys(preview, ['impact', 'deleted']);
      assert.equal(preview.deleted, false);
      assert.deepEqual(preview.impact, [], 'zero-count incoming references are intentionally omitted');
      assert.equal(f.row(9)?.name, 'Created');
    }
    assert.equal(success(await f.call('/api/revert', {})).next.id, inserted.undoId);
    const deleted = success(await f.call('/api/delete', { table: f.table, key: { id: 9 }, confirm: true }));
    keys(deleted, ['impact', 'deleted', 'affected', 'undoId', 'sql']);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.affected, 1);
    assert.equal(f.row(9), undefined);
    projection(deleted, true);
    {
      const restored = success(await f.call('/api/revert', { confirm: true, expectedId: deleted.undoId }));
      assert.equal(restored.outcome, 'applied');
      assert.deepEqual(f.row(9), inserted.row);
      const uncreated = success(await f.call('/api/revert', { confirm: true, expectedId: inserted.undoId }));
      assert.equal(uncreated.outcome, 'applied');
      assert.equal(f.row(9), undefined);
    }
    const restricted = await f.call('/api/delete', { table: f.table, key: { id: 1 }, confirm: true });
    assert.equal(restricted.status, 409);
    assert.equal(restricted.body.deleted, false);
    assert.equal(restricted.body.outcome, 'rejected');
    assert.equal(restricted.body.impact[0].table, f.note);
    assert.equal(restricted.body.impact[0].count, 1);
    assert.deepEqual(restricted.body.impact[0].columns, ['item']);
    assert.ok(Array.isArray(restricted.body.impact[0].filter.groups));
    diagnostics(restricted.body);
    assert.equal(f.row(1)?.name, 'Alpha');
  });
});

for (const kind of ['update', 'insert', 'delete', 'revert'] as const) {
  test(`resource wire: ${kind} lost commit acknowledgement is unknown without a success token`, async () => {
    await fixture(async (f) => {
      const older = success(await f.call('/api/update', { table: f.table, key: { id: 2 }, values: { name: 'Earlier' } }));
      loseCommitAcknowledgement(f.adapter);
      const reply =
        kind === 'update'
          ? await f.call('/api/update', { table: f.table, key: { id: 2 }, values: { name: 'Uncertain' } })
          : kind === 'insert'
            ? await f.call('/api/insert', { table: f.table, values: { id: 9, name: 'Uncertain' } })
            : kind === 'delete'
              ? await f.call('/api/delete', { table: f.table, key: { id: 2 }, confirm: true })
              : await f.call('/api/revert', { confirm: true, expectedId: older.undoId });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.outcome, 'unknown');
      diagnostics(reply.body);
      for (const field of ['affected', 'key', 'row']) assert.equal(Object.hasOwn(reply.body, field), false);
      if (kind === 'delete') assert.equal(reply.body.deleted, null);
      if (kind === 'revert') {
        assert.equal(reply.body.reverted, false);
        assert.equal(reply.body.undone.id, older.undoId);
      }
      assert.equal(f.row(kind === 'insert' ? 9 : 2)?.name, kind === 'delete' ? undefined : kind === 'revert' ? 'Beta' : 'Uncertain');
      {
        const preview = success(await f.call('/api/revert', {}));
        publicHistory(preview);
        assert.equal(Object.hasOwn(preview, 'next'), false);
        assert.equal(preview.writes[0].undoState, 'unknown');
        assert.equal(preview.writes[0].revertible, false);
        const retry = await f.call('/api/revert', { confirm: true, expectedId: older.undoId });
        assert.equal(retry.status, 409);
        assert.equal(retry.body.outcome, 'not_applied');
      }
    });
  });
}
