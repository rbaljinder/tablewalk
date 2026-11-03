/**
 * HTTP connections for the browser, each with its own directory, ports and
 * config; never the shared E2E config.
 *
 * `startHttpSource` is the fake Desk API of test/support/fakeRest.ts in this
 * process, its description drafted from the fixture spec, and a tablewalk
 * reading it whose token is a `${VAR}` reference.
 */
import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftDescription } from '@mistriwork/engine/adapters/http/httpDescription.js';
import { readOpenApi } from '@mistriwork/engine/adapters/http/openapi.js';
import { startFakeRest } from '../../test/support/fakeRest.js';

/** The token the config names by reference; a test asserts it never reaches the page. */
export const DESK_TOKEN = 'e2e-desk-token-3c9';

type Child = ReturnType<typeof spawn>;

async function reservePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function stopChild(child: Child | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
}

/* A process, started and waited on until its log says `ready`. */
async function started(what: string, args: string[], env: NodeJS.ProcessEnv, ready: string): Promise<Child> {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`${what} startup timed out: ${log}`)), 15_000);
      const check = () => {
        if (log.includes(ready)) done();
      };
      const failed = () => done(new Error(`${what} exited during startup: ${log}`));
      const done = (error?: Error) => {
        clearTimeout(timer);
        child.stdout!.off('data', check);
        child.off('exit', failed);
        child.off('error', done);
        if (error) reject(error);
        else resolve();
      };
      child.stdout!.on('data', check);
      child.once('exit', failed);
      child.once('error', done);
      check();
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return child;
}

const tablewalk = (config: string, port: number) => ['--import', 'tsx', 'src/server/index.ts', '--config', config, '--port', String(port)];

export async function startHttpSource() {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-http-browser-'));
  const api = await startFakeRest();
  let server: Child | undefined;
  const stop = async () => {
    await stopChild(server);
    await api.close();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const spec = JSON.parse(readFileSync('test/fixtures/http/openapi.json', 'utf8'));
    writeFileSync(join(directory, 'desk.http.json'), JSON.stringify(draftDescription(readOpenApi(spec))));
    const config = join(directory, 'connections.json');
    writeFileSync(
      config,
      JSON.stringify({
        connections: [
          {
            name: 'desk',
            kind: 'http',
            url: `${api.origin}/v1/`,
            description: 'desk.http.json',
            insecure: true,
            auth: { bearer: '${DESK_E2E_TOKEN}' },
          },
        ],
      }),
    );
    const port = await reservePort();
    server = await started(
      'HTTP source server',
      tablewalk(config, port),
      { ...process.env, DESK_E2E_TOKEN: DESK_TOKEN, XDG_CONFIG_HOME: join(directory, 'xdg'), TABLEWALK_OPEN: '0' },
      'Listening on ',
    );
    return { origin: `http://127.0.0.1:${port}`, api, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
