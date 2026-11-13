/**
 * A write through the browser's HTTP and one through its MCP are one physical history: each can Undo the other.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry, history } from '@mistriwork/engine/host';
import { clearJournal } from '@mistriwork/engine/server/journal.js';
import { createApp } from './support/createApp.js';
import { runTool } from '../src/server/mcp.js';

const physical = 'physical_items';

test('recorded HTTP and MCP writes share physical history and can undo each other', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-recorded-http-'));
  const owner = `${basename(directory)}-ops`;
  const db = new DatabaseSync(join(directory, 'ops.db'));
  db.exec(`CREATE TABLE ${physical} (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE);`);
  db.prepare(`INSERT INTO ${physical} (id, name) VALUES (1, ?), (2, ?)`).run('ops original', 'ops second');
  const registry = new Registry();
  registry.add({ id: owner, name: owner, url: join(directory, 'ops.db'), source: 'config', writable: true });
  registry.setActive(owner);
  await registry.open(owner);
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const call = async (path: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ conn: owner, ...body }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const successful = (reply: { status: number; body: any }) => {
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.ok(!reply.body.errors?.length, JSON.stringify(reply.body));
    return reply.body;
  };
  const row = () => db.prepare(`SELECT * FROM ${physical} WHERE id = 1`).get() as { name: string } | undefined;
  try {
    const saved = successful(await call('/api/update', { table: physical, key: { id: 1 }, values: { name: 'HTTP saved' } }));
    const preview = await runTool(registry, 'revert', { connection: owner });
    assert.equal(preview.isError, false);
    assert.ok(preview.structuredContent);
    assert.equal((preview.structuredContent.next as { id: number }).id, saved.undoId);
    const reverted = await runTool(registry, 'revert', { connection: owner, confirm: true, expectedId: saved.undoId });
    assert.equal(reverted.isError, false);
    assert.equal(reverted.structuredContent?.reverted, true);
    assert.equal(row()?.name, 'ops original');
    const changed = await runTool(registry, 'update', { connection: owner, table: physical, key: { id: 1 }, set: { name: 'MCP saved' } });
    assert.equal(changed.isError, false, changed.content[0]?.text);
    assert.equal(changed.structuredContent?.affected, 1);
    assert.equal(row()?.name, 'MCP saved');
    const entry = history(owner)[0];
    assert.equal(successful(await call('/api/revert')).next.id, entry.id);
    assert.equal(successful(await call('/api/revert', { confirm: true, expectedId: entry.id })).reverted, true);
    assert.equal(row()?.name, 'ops original');
    assert.deepEqual(history(owner), []);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(owner);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
