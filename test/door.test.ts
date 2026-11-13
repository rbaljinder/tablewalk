/**
 * The one door (the engine's http/trust.ts `doorRefusal`), sent to the database browser's dispatcher: every request it
 * makes the same refusals a dispatcher of any product makes. A foreign Host is answered as a foreign Host however much
 * else is wrong with the request, because the Host is asked first. The rule itself is the engine's to hold; this file
 * holds that the browser's dispatcher asks it.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import { Registry } from '@mistriwork/engine/host';
import { createApp } from './support/createApp.js';
import { BROWSER_DISPATCHERS } from '../src/server/http/dispatchers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FOREIGN = 'evil.example';
const STRANGER = 'http://evil.example';
const json = { 'content-type': 'application/json' };

type Answer = { status: number; body: string };

function ask(port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, connection: 'close' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function listening(server: Server): Promise<number> {
  if (!server.listening) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  return (server.address() as { port: number }).port;
}

type Asking = { headers: (home: string) => Record<string, string>; writing: boolean; admitted: boolean };
const DISPATCHER_CASES: Record<string, Asking> = {
  'a foreign Host, read': { headers: () => ({ host: FOREIGN }), writing: false, admitted: false },
  'a foreign Host, write': { headers: () => ({ host: FOREIGN, ...json }), writing: true, admitted: false },
  'a write from another page': { headers: (home) => ({ host: home, origin: STRANGER, ...json }), writing: true, admitted: false },
  'a form-encoded write from its own page': {
    headers: (home) => ({ host: home, origin: `http://${home}`, 'content-type': 'application/x-www-form-urlencoded' }),
    writing: true,
    admitted: false,
  },
  'a write from its own page': { headers: (home) => ({ host: home, origin: `http://${home}`, ...json }), writing: true, admitted: true },
  'a read from its own page': { headers: (home) => ({ host: home }), writing: false, admitted: true },
};

const READ = { path: '/api/connections' };
const WRITE = { path: '/api/query', body: '{}' };

describe('the dispatchers', () => {
  test('the one the router names is a module here', () => {
    assert.deepEqual(
      BROWSER_DISPATCHERS.map((each) => each.module),
      ['src/server/http/browserHandler.ts'],
    );
    for (const { module } of BROWSER_DISPATCHERS) assert.ok(existsSync(`${ROOT}${module}`), module);
  });

  test("src/server/http/browserHandler.ts: the door's refusals, in the door's order", async () => {
    const where: Bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry: new Registry(), bound: where });
    where.port = await listening(server);
    const port = where.port;
    try {
      const home = `127.0.0.1:${port}`;
      const sent = (asking: Asking, extra: Record<string, string> = {}) =>
        asking.writing
          ? ask(port, WRITE.path, { ...asking.headers(home), ...extra }, 'POST', WRITE.body)
          : ask(port, READ.path, { ...asking.headers(home), ...extra });
      const refused = await sent(DISPATCHER_CASES['a write from another page']);
      for (const [name, asking] of Object.entries(DISPATCHER_CASES)) {
        const answer = await sent(asking);
        if (asking.admitted) {
          assert.ok(answer.status !== 403 || !/Refused/.test(answer.body), `${name}: ${answer.status} ${answer.body}`);
          assert.notDeepEqual(answer, refused, `${name} is answered as a refusal: ${answer.status} ${answer.body}`);
        } else assert.equal(answer.status, 403, `${name}: ${answer.status} ${answer.body}`);
      }
      const foreign = await sent(DISPATCHER_CASES['a foreign Host, write']);
      const everythingWrong = await sent(DISPATCHER_CASES['a foreign Host, write'], {
        origin: STRANGER,
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain',
      });
      assert.deepEqual(everythingWrong, foreign, 'the Host is asked before the Origin, the fetch site and the body');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
