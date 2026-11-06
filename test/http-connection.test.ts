import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { draftDescription } from '@mistriwork/engine/adapters/http/httpDescription.js';
import { readOpenApi } from '@mistriwork/engine/adapters/http/openapi.js';
import { Registry } from '@mistriwork/engine/host';
import { loadConfig } from '@mistriwork/engine/server/connections.js';
import { createApp } from './support/createApp.js';
import { startFakeRest } from './support/fakeRest.js';
import { browserSections } from '../src/server/cli/browserCommands.js';

/* An HTTP connection on the database browser's server, over the wire: the engine holds the config and adapter rules
   (the connection file's fields, the credential at open); this holds what the browser's API answers and lists. */
const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
let api: Awaited<ReturnType<typeof startFakeRest>>;
let dir: string;
before(async () => {
  api = await startFakeRest();
  dir = mkdtempSync(join(tmpdir(), 'tablewalk-http-connection-'));
  writeFileSync(join(dir, 'desk.http.json'), JSON.stringify(draftDescription(readOpenApi(spec))));
});
after(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

const configWith = (...connections: unknown[]) => {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ connections }));
  return path;
};
const desk = (overrides: Record<string, unknown> = {}) => ({
  name: 'Desk',
  kind: 'http',
  url: `${api.origin}/v1`,
  description: 'desk.http.json',
  insecure: true,
  auth: { bearer: '${DESK_TEST_TOKEN}' },
  ...overrides,
});
async function registryFrom(path: string) {
  const registry = new Registry();
  for (const c of (await loadConfig(path, await browserSections()))!.connections) registry.add({ ...c, writable: false, source: 'config' });
  return registry;
}

test('over the wire, an API list has no total, a count is refused and a failing API is a 502', async () => {
  process.env.DESK_TEST_TOKEN = 'tok-wire-58';
  const registry = await registryFrom(configWith(desk(), desk({ name: 'Gone', url: `${api.origin}/nowhere` })));
  const bound = { host: '127.0.0.1', port: 0, allowedHosts: [] as string[] };
  const server = createApp({ registry, bound });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    bound.port = (server.address() as { port: number }).port;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${bound.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    const [deskId, goneId] = registry.list().map((each) => each.id);
    const run = await post('/api/run', { q: 'contacts', conn: deskId });
    assert.equal(run.status, 200);
    // The bar's default page, asked of the API as its own limit rather than cut from a larger answer.
    assert.equal(run.json.rows.length, 20);
    assert.equal(api.seen.at(-1)!.query.get('limit'), '20');
    assert.equal('total' in run.json || 'exactTotal' in run.json, false, 'an API list claims no total');
    assert.deepEqual(run.json.order.order, [], 'no default sort is sent to an API');
    assert.equal(api.seen.at(-1)!.query.has('sort'), false);

    const count = await post('/api/count', { table: 'contacts', conn: deskId });
    assert.equal(count.status, 400);
    assert.match(count.json.error, /reports no totals/);

    const failed = await post('/api/run', { q: 'contacts', conn: goneId });
    assert.equal(failed.status, 502);
    assert.match(failed.json.error, /GET \/contacts answered 404/);

    const listed = await (await fetch(`http://127.0.0.1:${bound.port}/api/connections`)).text();
    assert.match(listed, /"dialect":"http"/);
    assert.doesNotMatch(listed, /tok-wire/);
  } finally {
    server.close();
    server.closeAllConnections();
    await registry.closeAll();
    delete process.env.DESK_TEST_TOKEN;
  }
});
