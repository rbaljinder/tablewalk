/**
 * The database browser's answers to a driver failure and to an ordinary read or write: it keeps the database's own words
 * (an App's are sanitized, which is the App framework's to hold), and a write whose outcome cannot be confirmed says so.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry, type WriteTransaction } from '@mistriwork/engine/host';
import { createApp } from './support/createApp.js';
import type { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';

async function fixture(run: (base: string, registry: Registry) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-response-'));
  const path = join(directory, 'data.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT NOT NULL, team_id INTEGER REFERENCES team(id), sql TEXT);
    INSERT INTO team VALUES (1, 'Operations');
    INSERT INTO task VALUES (1, 'First task', 1, 'SELECT user-authored text');`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'fixture', name: 'Fixture', url: path, source: 'config', writable: true });
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run(`http://${bound.host}:${bound.port}`, registry);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

{
  test('the browser preserves read/rejection details for driver failures and truthful unknown CRUD', { timeout: 15_000 }, async (t) => {
    await fixture(async (base, registry) => {
      const opened = await registry.open('fixture');
      const adapter = opened.adapter as SqliteAdapter;
      const secret = 'SELECT secret FROM private.records; postgres://user:password@private-host/db';
      const requests = [
        ['query', '/api/query', { table: 'task' }, 500],
        ['runView', '/api/view/run', { view: { id: 'v', name: 'View', base: 'task', columns: [{ path: 'name' }] } }, 500],
        ['runBreakdown', '/api/breakdown', { def: { base: 'task', by: [], measures: [{ fn: 'count' }] } }, 200],
        ['update', '/api/update', { table: 'task', key: { id: 1 }, values: { name: 'Changed' } }, 200],
        ['insert', '/api/insert', { table: 'task', values: { name: 'Added' } }, 200],
        ['remove', '/api/delete', { table: 'task', key: { id: 1 }, confirm: true }, 200],
      ] as const;
      for (const [method, path, body, status] of requests) {
        const mutation = method === 'update' || method === 'insert' || method === 'remove';
        const transaction = adapter.transaction.bind(adapter);
        const mocked = mutation
          ? t.mock.method(adapter, 'transaction', <T>(run: (tx: WriteTransaction) => Promise<T>) =>
              transaction((tx) =>
                run({
                  ...tx,
                  [method]: async () => {
                    throw new Error(secret);
                  },
                }),
              ),
            )
          : t.mock.method(adapter, method, async () => {
              throw new Error(secret);
            });
        try {
          const response = await fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5_000),
          });
          assert.equal(response.status, status, path);
          const result = await response.json();
          const failure = result.errors?.[0] ?? { message: result.error, code: result.code };
          if (mutation) assert.match(failure.message, /outcome could not be confirmed/, path);
          else assert.equal(failure.message, secret, path);
          if (method === 'insert' || method === 'update') assert.equal(result.outcome, 'unknown');
        } finally {
          mocked.mock.restore();
        }
      }
      const transaction = adapter.transaction.bind(adapter);
      const rejected = t.mock.method(adapter, 'transaction', <T>(run: (tx: WriteTransaction) => Promise<T>) =>
        transaction((tx) =>
          run({
            ...tx,
            update: async () => {
              throw Object.assign(new Error(secret), { code: '23505' });
            },
          }),
        ),
      );
      try {
        const response = await fetch(`${base}/api/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: 'task', key: { id: 1 }, values: { name: 'Changed' } }),
          signal: AbortSignal.timeout(5_000),
        });
        const result = await response.json();
        assert.equal(result.outcome, 'rejected');
        assert.equal(result.errors[0].message, secret);
      } finally {
        rejected.mock.restore();
      }

      // The database browser's Undo keeps its words.
      const saved = await post(base, '/api/update', { table: 'task', key: { id: 1 }, values: { name: 'Undo this' } });
      const undoFailure = t.mock.method(adapter, 'transaction', async () => {
        throw new Error(secret);
      });
      try {
        const response = await fetch(`${base}/api/revert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true, expectedId: saved.undoId ?? 1 }),
          signal: AbortSignal.timeout(5_000),
        });
        const result = await response.json();
        assert.equal(result.reverted, false);
        assert.equal(result.errors[0].message, secret);
      } finally {
        undoFailure.mock.restore();
      }

      const referenceFailure = t.mock.method(adapter, 'count', async () => {
        throw new Error(secret);
      });
      try {
        const response = await fetch(`${base}/api/references`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: 'team', key: { id: 1 } }),
          signal: AbortSignal.timeout(5_000),
        });
        const result = await response.json();
        assert.equal(result.references[0].count, -1);
        assert.equal(result.references[0].error, secret);
      } finally {
        referenceFailure.mock.restore();
      }

      // The database browser journals a deletion after it commits: a journal that fails then leaves the outcome unknown.
      {
        let failedJournal: ReturnType<typeof t.mock.method> | undefined;
        const removeThenFailJournal = t.mock.method(adapter, 'transaction', <T>(run: (tx: WriteTransaction) => Promise<T>) =>
          transaction((tx) =>
            run({
              ...tx,
              remove: async (request) => {
                const result = await tx.remove(request);
                failedJournal = t.mock.method(Date.prototype, 'toISOString', () => {
                  throw Object.assign(new Error(secret), { code: '23505' });
                });
                return result;
              },
            }),
          ),
        );
        try {
          const response = await fetch(`${base}/api/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: 'task', key: { id: 1 }, confirm: true }),
            signal: AbortSignal.timeout(5_000),
          });
          const result = await response.json();
          assert.equal(result.deleted, null);
          assert.equal(result.outcome, 'unknown');
          assert.match(result.errors[0].message, /outcome could not be confirmed/);
        } finally {
          failedJournal?.mock.restore();
          removeThenFailJournal.mock.restore();
        }
        assert.equal((await adapter.query({ table: 'task', limit: 10, offset: 0 })).rows.length, 0);
      }

      const openFailure = t.mock.method(registry, 'open', async () => {
        throw new Error(secret);
      });
      try {
        const response = await fetch(`${base}/api/schema`, { signal: AbortSignal.timeout(5_000) });
        assert.equal(response.status, 500);
        const result = await response.json();
        assert.equal(result.error, secret);
      } finally {
        openFailure.mock.restore();
      }
    });
  });
}

async function post(base: string, path: string, body: object) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, path);
  const result = await response.json();
  assert.ok(!result.errors?.length, `${path}: ${JSON.stringify(result.errors)}`);
  return result;
}

{
  test('reads and writes preserve data with the correct diagnostic contract', { timeout: 15_000 }, async () => {
    await fixture(async (base) => {
      const view = { id: 'task-view', name: 'Tasks', base: 'task', columns: [{ path: 'id' }, { path: 'team_id.name' }] };
      const reads = [
        ['/api/query', { table: 'task', limit: 10 }],
        ['/api/run', { q: 'task' }],
        ['/api/run', { q: 'task show id, team_id.name' }],
        ['/api/view/run', { view }],
        ['/api/breakdown', { def: { base: 'task', by: [{ path: 'team_id' }], measures: [{ fn: 'count' }] } }],
        ['/api/breakdown', { text: 'task count by team_id' }],
      ] as const;
      for (const [path, request] of reads) {
        const result = await post(base, path, request);
        assert.ok(result.rows.length, path);
        assert.ok(result.columns.length, path);
        assert.ok(result.sql || result.explain, path);
      }
      const ordinary = await post(base, '/api/query', { table: 'task' });
      assert.equal(ordinary.rows[0].sql, 'SELECT user-authored text');
      const created = await post(base, '/api/insert', { table: 'task', values: { name: 'Added', team_id: 1 } });
      assert.ok(created.key.id);
      assert.equal('sql' in created, true);
      const updated = await post(base, '/api/update', { table: 'task', key: created.key, values: { name: 'Updated' } });
      assert.equal(updated.affected, 1);
      assert.equal(updated.applied.name, 'Updated');
      assert.ok(updated.undoId !== undefined);
      assert.equal('sql' in updated, true);
      const preview = await post(base, '/api/delete', { table: 'task', key: created.key });
      assert.equal(preview.deleted, false);
      assert.ok(preview.impact);
      const deleted = await post(base, '/api/delete', { table: 'task', key: created.key, confirm: true });
      assert.equal(deleted.deleted, true);
      assert.equal('sql' in deleted, true);
      for (const [path, method, request] of [
        ['/api/ddl?table=task', 'GET', undefined],
        ['/api/queries', 'GET', undefined],
        ['/api/agent/tools', 'GET', undefined],
        ['/api/sql', 'POST', { text: 'SELECT 1' }],
        ['/api/view/compile', 'POST', { view }],
        ['/api/agent/call', 'POST', { name: 'connections', arguments: {} }],
      ] as const) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Mistri-Mode': 'workbench',
          },
          ...(request ? { body: JSON.stringify(request) } : {}),
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(response.status, 200, path);
        await response.text();
      }
    });
  });
}
