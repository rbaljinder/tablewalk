/**
 * The fixture server, one per worker.
 *
 * `playwright.config.ts` starts one server for the whole suite — the browser over the fixture databases — and a
 * tablewalk process holds one active connection, so every spec that addresses it runs one at a time
 * (scripts/e2e-lanes.mjs). A spec that imports `test` from here addresses a server of its worker's own instead: on a
 * port reserved when this module loads, over copies of the fixture databases in a `mkdtemp` directory, with a config
 * store of its own. Nothing is shared with another worker, so such a spec runs in the parallel lane.
 *
 * The server starts before the worker's first test and stops with the worker. It is `baseURL`, so
 * `page.goto('/demo')` and support/app's `open()` read as they did against the config's server. It is marked as having
 * shown its tour, as the config's `seen-tour.json` marks the config's.
 *
 * The paths below are this worker's copies — a spec that asks the database what the page should say asks the one its
 * server serves.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './spawned';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as shared from './fixtures';
import { test as harness } from './harness';

export { expect } from './harness';
export type { Locator, Page } from './harness';
export { DEMO, EDGE, EDGE_LONG_LEN, SCRATCH, WIDE } from './fixtures';

export type ServerKind = 'explorer';

/* Reserved as the module loads, in whichever process loads it: the runner lists the tests too, and a worker's constants
   must be the same ones its spec read at the top of the file. Closed before the server binds it, as the config's own
   `freePort` is. */
function freePort(): number {
  /* Without the worker's NODE_OPTIONS: Playwright's loader, inherited, left the child's answer empty. */
  const answer = Number(
    execFileSync(
      process.execPath,
      ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"],
      { env: { PATH: process.env.PATH ?? '' } },
    )
      .toString()
      .trim(),
  );
  if (!Number.isInteger(answer) || answer <= 0) throw new Error('No free port was found for a fixture server.');
  return answer;
}
const origin = (at: number) => `http://127.0.0.1:${at}`;

/* The runner loads every spec to list its tests, and starts no server: only a worker reserves a port and makes a directory. */
const worker = process.env.TEST_WORKER_INDEX !== undefined;
if (worker) mkdirSync(shared.TMP, { recursive: true });
const HOME = worker ? mkdtempSync(join(shared.TMP, 'own-')) : join(shared.TMP, 'own-runner');
const PORT = worker ? freePort() : 0;

/** This worker's server. */
export const EXPLORER = origin(PORT);

/* This worker's copies of the fixture databases (support/fixtures.ts says what each is for), made as the module loads: a
   spec may ask one what to expect while its tests are being listed, before any server starts. The runner, which lists
   them too, reads the originals — the same rows. */
const copy = (from: string) => {
  if (!worker) return from;
  const to = join(HOME, basename(from));
  cpSync(from, to);
  return to;
};
export const DEMO_DB = copy(shared.DEMO_DB);
export const WIDE_DB = copy(shared.WIDE_DB);
export const SCRATCH_DB = copy(shared.SCRATCH_DB);
export const EDGE_DB = copy(shared.EDGE_DB);

/** The server's config store (XDG_CONFIG_HOME): saved filters, layouts and pages land there. */
export const configHome = () => join(HOME, 'xdg-explorer');

/** A browser that has seen the tour on this worker's server: for a context a test builds itself. */
export function seenTour() {
  return { cookies: [], origins: [{ origin: origin(PORT), localStorage: [{ name: 'mistri.tour.v1', value: 'done' }] }] };
}

async function start(): Promise<() => Promise<void>> {
  const config = join(HOME, 'tablewalk.json');
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        connections: [
          { name: 'demo', url: DEMO_DB },
          { name: 'wide', url: WIDE_DB },
          { name: 'scratch', url: SCRATCH_DB, writable: true },
          { name: 'edge', url: EDGE_DB },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('src/server/index.ts'), '--config', config, '--port', String(PORT)],
    {
      env: { ...process.env, TABLEWALK_OPEN: '0', XDG_CONFIG_HOME: configHome() },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  };
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => finish(new Error(`The server did not start: ${log}`)), 30_000);
      const ready = () => {
        if (log.includes('Listening on ')) finish();
      };
      const exited = () => finish(new Error(`The server exited during startup: ${log}`));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stdout!.off('data', ready);
        child.off('exit', exited);
        if (error) fail(error);
        else done();
      };
      child.stdout!.on('data', ready);
      child.once('exit', exited);
      ready();
    });
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

// Playwright reads a fixture's dependencies from the destructured first argument, so the empty pattern is the contract.
/* oxlint-disable eslint/no-empty-pattern */
export const test = harness.extend<object, { own: void }>({
  own: [
    async ({}, use) => {
      const stop = await start();
      try {
        await use();
      } finally {
        await stop();
      }
    },
    { scope: 'worker', auto: true, timeout: 90_000 },
  ],
  baseURL: async ({}, use) => {
    await use(origin(PORT));
  },
  storageState: async ({}, use) => {
    await use(seenTour());
  },
});
