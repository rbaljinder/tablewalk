/**
 * The standalone browser keeps every table and its tools: the database browser serves the whole connection, raw SQL
 * included. (An App serves only its declared resources, which is the App framework's to hold.)
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { clearJournal } from '@mistriwork/engine/server/journal.js';
import { createApp } from './support/createApp.js';

const connection = 'declared-resources';
const secret = 'UNDECLARED-ROW-CONTENT';

test('the standalone browser keeps every table and its tools', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-declared-'));
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  const path = join(directory, 'atlas.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE service (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE incident (id INTEGER PRIMARY KEY, name TEXT NOT NULL, service_id INTEGER REFERENCES service(id));
    CREATE TABLE audit_note (id INTEGER PRIMARY KEY, name TEXT NOT NULL, incident_id INTEGER REFERENCES incident(id));
    INSERT INTO service VALUES (1, 'Identity');
    INSERT INTO incident VALUES (1, 'Login outage', 1);
  `);
  db.prepare('INSERT INTO audit_note VALUES (1, ?, 1)').run(secret);
  db.close();
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Atlas database', url: path, source: 'config', writable: true });
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const call = async (route: string, body?: Record<string, unknown>) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${route}${body ? '' : `?conn=${connection}`}`, {
        signal: AbortSignal.timeout(5_000),
        ...(body
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conn: connection, ...body }) }
          : {}),
      });
      return { status: response.status, body: JSON.parse(await response.text()) };
    };
    const schema = await call('/api/schema');
    assert.ok(schema.body.tables.some((table: { id: string }) => table.id === 'audit_note'));
    const rows = await call('/api/query', { table: 'audit_note' });
    assert.equal(rows.status, 200, JSON.stringify(rows.body));
    assert.equal(rows.body.rows[0].name, secret);
    const sql = await call('/api/sql', { text: 'SELECT name FROM audit_note' });
    assert.equal(sql.status, 200, JSON.stringify(sql.body));
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(connection);
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});
