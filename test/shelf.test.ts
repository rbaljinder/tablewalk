/**
 * The database MCP's resource shelf: it serves no App, so it shelves no App reference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { listResources, readResource } from '../src/server/mcp/shelf.js';

test('the database MCP lists no App reference and reads none', async () => {
  const registry = new Registry();
  let listed: { resources: Array<{ uri: string }> } | undefined;
  listResources(registry, { queries: [], pages: [] }, (reply) => {
    listed = (reply as { result: typeof listed }).result;
  });
  assert.deepEqual(listed!.resources, []);
  let answered: { error?: { message: string } } | undefined;
  await readResource(registry, { queries: [], pages: [] }, { uri: 'mistri://docs/topic/access-model' }, (reply) => {
    answered = reply as typeof answered;
  });
  assert.match(answered!.error!.message, /No resource at/);
});
