/**
 * The database browser keeps its connection inventory and bootstraps with none, without opening a database to say so.
 * (An App's scope over the same registry is the App framework's.)
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Registry } from '@mistriwork/engine/host';
import { createApp } from './support/createApp.js';

async function listening(registry: Registry, run: (base: string) => Promise<void>) {
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run(`http://${bound.host}:${bound.port}`);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
  }
}

const get = (base: string, path: string) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(2_000) });

test('the browser preserves the connection inventory without opening a database', { timeout: 5_000 }, async (t) => {
  const registry = new Registry();
  registry.add({ id: 'workbench', name: 'Workbench database', url: '/missing/workbench.db', source: 'config', writable: true });
  const opened = t.mock.method(registry, 'open', async () => {
    throw new Error('Unexpected database open');
  });
  const expected = JSON.parse(JSON.stringify(registry.list()));
  await listening(registry, async (base) => {
    const runtime = await get(base, '/api/runtime');
    assert.equal(runtime.status, 200);
    assert.deepEqual(await runtime.json(), { appConfigured: false });
    const response = await get(base, '/api/connections');
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.deepEqual(metadata.connections, expected);
    assert.equal(metadata.active, 'workbench');
    assert.equal(opened.mock.callCount(), 0);
  });
});

test('an empty browser can bootstrap without a database', { timeout: 5_000 }, async (t) => {
  const registry = new Registry();
  const opened = t.mock.method(registry, 'open', async () => {
    throw new Error('Unexpected database open');
  });
  await listening(registry, async (base) => {
    const runtime = await get(base, '/api/runtime');
    assert.equal(runtime.status, 200);
    assert.deepEqual(await runtime.json(), { appConfigured: false });
    const schema = await get(base, '/api/schema');
    assert.equal(schema.status, 409);
    await schema.text();
    const connections = await get(base, '/api/connections');
    assert.equal(connections.status, 200);
    assert.deepEqual((await connections.json()).connections, []);
    assert.equal(opened.mock.callCount(), 0);
  });
});
