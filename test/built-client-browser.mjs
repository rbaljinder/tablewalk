/**
 * The client as the package ships it, in a real browser.
 *
 * Every other browser suite runs the server under tsx, which serves the source tree through Vite: none of the build's
 * choices exist there — no content-named files, no compressed copies, no chunks loaded on demand. So this starts the
 * compiled server (`node dist/server/index.js --demo`) and looks at what it sends: the Workbench, from a cold cache and
 * again from a warm one. It fails on a console error or an uncaught page error anywhere, on a script or a stylesheet sent
 * uncompressed or without its year of caching, on a warm visit that downloads an asset again, on a chunk that fails to
 * load without the reload prompt taking its place, and on a first visit heavier than its ceiling. What the first visit
 * fetched is printed, compressed and not.
 *
 * Build first (`npm run build`). Its own server and temporary directory; nothing under e2e/.tmp, so it does not share the
 * browser suites' fixtures.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { readyBrowserChild } from './support/ownedBrowserChild.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const built = join(root, 'dist/server/index.js');
assert.ok(existsSync(built) && existsSync(join(root, 'dist/client/index.html')), 'Build the package first: npm run build.');
const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-built-client-'));
const IMMUTABLE = 'public, max-age=31536000, immutable';
/* What a cold first visit may take off the wire, page and assets, before the room paints. scripts/bundle-budget.mjs holds
   the first paint's own ceiling at build time, and this holds what a browser actually fetched for a real room. */
const FIRST_PAINT_WIRE_KB = 425;
/* The chunks the Workbench's page never fetches: the App framework's and the public pages'. */
const NEVER = ['/assets/chrome', '/assets/tenant', '/assets/public'];

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** The compiled server, as `npx tablewalk` would run it, answering once it says it listens. */
async function start(name, args, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [built, ...args, '--port', String(port)], {
    cwd: root,
    env: { ...process.env, TMPDIR: scratch, XDG_CONFIG_HOME: join(scratch, `${name}-xdg`), TABLEWALK_OPEN: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const owner = await readyBrowserChild(child, name);
  return { origin: `http://127.0.0.1:${port}`, stop: owner.stop };
}

/**
 * One visit, watched at the network: every static file the page fetched, how it came (the wire's bytes, the decoded
 * bytes, its encoding, its caching, whether the browser's cache answered), and every error it printed.
 */
async function visit(context, url, ready) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const files = new Map();
  const fromCache = new Set();
  /* A revalidated page reaches the page as the cached 200; the status the server actually sent — a 304 — is only in the
     extra-info event. */
  const wireStatus = new Map();
  cdp.on('Network.requestServedFromCache', ({ requestId }) => fromCache.add(requestId));
  cdp.on('Network.responseReceivedExtraInfo', ({ requestId, statusCode }) => wireStatus.set(requestId, statusCode));
  cdp.on('Network.responseReceived', ({ requestId, response }) => {
    const path = new URL(response.url).pathname;
    if (!response.url.startsWith(new URL(url).origin) || path.startsWith('/api/')) return;
    const headers = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    files.set(requestId, {
      path,
      status: response.status,
      headers,
      wire: 0,
      decoded: 0,
      cached: Boolean(response.fromDiskCache || response.fromMemoryCache || response.fromPrefetchCache),
    });
  });
  cdp.on('Network.dataReceived', ({ requestId, dataLength }) => {
    const file = files.get(requestId);
    if (file) file.decoded += dataLength;
  });
  cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
    const file = files.get(requestId);
    if (file) {
      file.wire = encodedDataLength;
      file.cached ||= fromCache.has(requestId);
    }
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.goto(url);
  await ready(page);
  await page.waitForLoadState('networkidle');
  for (const [requestId, file] of files) file.status = wireStatus.get(requestId) ?? file.status;
  return { page, errors, files: [...files.values()] };
}

function sizes(files) {
  const kb = (bytes) => Math.round(bytes / 102.4) / 10;
  const fetched = files.filter((file) => !file.cached && file.status === 200);
  return {
    files: fetched.length,
    wireKB: kb(fetched.reduce((n, f) => n + f.wire, 0)),
    decodedKB: kb(fetched.reduce((n, f) => n + f.decoded, 0)),
  };
}

/** Assets are compressed and kept; the page carries fresh, account-bound first-paint data. */
function assertShipped(label, files) {
  const page = files.find((file) => file.headers['content-type']?.startsWith('text/html'));
  assert.ok(page, `${label}: no page`);
  assert.equal(page.headers['cache-control'], 'private, no-store', `${label}: first-paint data is never cached`);
  assert.equal(page.headers.etag, undefined, `${label}: personal HTML has no reusable ETag`);
  assert.match(page.headers.vary ?? '', /Cookie/i, `${label}: the page varies by reader`);
  const assets = files.filter((file) => file.path.startsWith('/assets/'));
  assert.ok(
    assets.some((file) => file.path.endsWith('.js')) && assets.some((file) => file.path.endsWith('.css')),
    `${label}: a script and a stylesheet`,
  );
  for (const file of assets) {
    assert.equal(file.headers['cache-control'], IMMUTABLE, `${label}: ${file.path} is kept for a year`);
    /* A woff2 is brotli inside already: it is sent as it is. */
    if (file.decoded > 1024 && !file.path.endsWith('.woff2'))
      assert.equal(file.headers['content-encoding'], 'br', `${label}: ${file.path} arrives in brotli`);
  }
}

let browser;
const servers = [];
const report = {};
const budgetFailures = [];
async function stopServers() {
  const stopped = await Promise.allSettled(servers.map((server) => server.stop()));
  const failures = stopped.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Browser fixture teardown failed.',
    );
  rmSync(scratch, { recursive: true, force: true });
}
try {
  const workbench = await start('workbench', ['--demo', '--no-config']);
  servers.push(workbench);
  browser = await chromium.launch();

  const schema = (page) => page.locator('.diagram-schema > *').first().waitFor();
  const label = 'Workbench landing';
  const url = `${workbench.origin}/`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const cold = await visit(context, url, schema);
  assert.deepEqual(cold.errors, [], `${label}: errors on a cold visit`);
  assertShipped(label, cold.files);
  const faces = cold.files.filter((file) => file.path.endsWith('.woff2'));
  assert.deepEqual(faces, [], `${label}: only a page wearing a look with faces of its own fetches them`);
  const chunks = cold.files.filter((file) => /^\/assets\/.+\.js$/.test(file.path)).map((file) => file.path.replace(/-[\w-]{8}\.js$/, ''));
  await cold.page.close();
  const warm = await visit(context, url, schema);
  assert.deepEqual(warm.errors, [], `${label}: errors on a warm visit`);
  const again = warm.files.filter((file) => file.path.startsWith('/assets/') && !file.cached);
  assert.deepEqual(
    again.map((file) => file.path),
    [],
    `${label}: a warm visit fetched assets again`,
  );
  const page = warm.files.find((file) => file.headers['content-type']?.startsWith('text/html') || file.status === 304);
  assert.equal(page?.status, 200, `${label}: a warm visit gets fresh first-paint data`);
  assert.equal(page?.headers['cache-control'], 'private, no-store', `${label}: warm HTML remains private`);
  const { wireKB } = sizes(cold.files);
  if (wireKB > FIRST_PAINT_WIRE_KB)
    budgetFailures.push(`${label}: a cold first visit fetched ${wireKB} KB, over the ${FIRST_PAINT_WIRE_KB} KB ceiling`);
  const strays = chunks.filter((chunk) => NEVER.some((prefix) => chunk.startsWith(prefix)));
  assert.deepEqual(strays, [], `${label}: fetched another surface's chunk`);
  report[label] = {
    cold: sizes(cold.files),
    html: sizes(cold.files.filter((file) => file.headers['content-type']?.startsWith('text/html'))),
    chunks,
    warm: { fetched: warm.files.filter((f) => !f.cached).map((f) => `${f.path} ${f.status}`) },
  };
  await context.close();

  const broken = await browser.newContext();
  await broken.route(/\/assets\/Diagram-[\w-]+\.js$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>tablewalk</title>' }),
  );
  const failed = await visit(broken, `${workbench.origin}/`, (page) =>
    page.getByRole('alert').filter({ hasText: 'could not be loaded' }).waitFor(),
  );
  assert.ok(await failed.page.getByRole('button', { name: 'Reload' }).isVisible(), 'a failed chunk offers a reload');
  assert.deepEqual(
    failed.errors.filter(
      (error) =>
        !error.includes('chunk did not load') &&
        !error.includes('Failed to fetch dynamically imported module') &&
        !error.includes('MIME type'),
    ),
    [],
    'a failed chunk is the only error',
  );
  await broken.close();
  report['chunk failure'] = 'the reload prompt replaced the part';

  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(budgetFailures, [], 'cold first-visit wire budgets');
  console.log('Built client browser checks passed: compressed, content-named and cached assets, on-demand chunks, no errors.');
} finally {
  try {
    await browser?.close();
  } finally {
    await stopServers();
  }
}
