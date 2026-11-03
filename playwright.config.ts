/**
 * The browser suite.
 *
 * `npm test` covers the server, the adapters and the pure client modules. None of it can see a `null` printed under a
 * table, a row that looks clickable and is not, a frozen column with a hairline gap through which the scrolling content
 * flickers, or a completion list that opens off the bottom of the screen. Every one of those was found by looking at the
 * page, and this config exists so that looking at the page is something CI can do.
 *
 * It runs behind `npm run e2e` rather than in `npm test` because it needs a browser download, which is not a thing to
 * put in the default path of a tool whose pitch is "one command, no setup".
 *
 *   npx playwright install chromium   once, per machine
 *   npm run e2e                       thereafter
 *
 * The server, the databases and the config file it reads are all built here. Nothing outside `e2e/.tmp` is written, and
 * `.demo/` is never read — what a previous `npm run demo` left on disk is not something a test should depend on.
 *
 * `npm run e2e` is `scripts/test-e2e.mjs`, which runs this config twice: once for the `owned` project, several workers
 * wide and with no shared server, and once for the `shared` project, one worker. `scripts/e2e-lanes.mjs` derives which
 * project a spec belongs to and says why. A bare `npx playwright test` is the single serial run of everything; the engine comes
 * from npm, so its servers send `dist/client` and `npm run build` must have run first. `scripts/test-e2e.mjs` builds the client once and sets `MISTRI_BUILT_CLIENT=1`,
 * which the servers inherit and which makes them send `dist/client`; a spec that needs the source says
 * `e2e-client: source` and runs unbuilt.
 */
import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { buildFixtures, CONFIG, SEEN_TOUR, TMP, writeSeenTour } from './e2e/support/fixtures';
import { lanes } from './scripts/e2e-lanes.mjs';

const lane = process.env.TABLEWALK_E2E_LANE;
const { owned, shared } = lanes();

/** A lane as `testMatch`: the exact files, anchored, rather than a glob that could quietly match one more. */
function laneMatch(files: string[]): RegExp {
  return new RegExp(`[\\\\/](?:${files.map((file) => file.slice('e2e/'.length).replace(/\./g, '\\.')).join('|')})$`);
}

/**
 * A port nobody is listening on, chosen once. Hard-coding one means the suite fights whatever the developer left running,
 * and `--port 0` is no help because the point of choosing is knowing the number. A child process is the only way to ask
 * the OS this question synchronously, which is what a config body needs.
 */
function freePort(): number {
  return Number(
    execFileSync(process.execPath, [
      '-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ])
      .toString()
      .trim(),
  );
}

/* This file is evaluated more than once: the runner reads it, and so does every worker process it forks. Both halves
   below have to happen exactly once, and the environment is what carries the answer across the fork. The port, because a
   worker that picked its own would point the browser at a port nothing is serving. The fixtures, because building them
   starts by deleting the directory, which on worker startup would pull the databases out from under a server that has
   them open. Built here rather than in `globalSetup` because Playwright starts `webServer` before global setup, and the
   server opens its first database at boot. */
if (!process.env.TABLEWALK_E2E_PORT) {
  buildFixtures();
  process.env.TABLEWALK_E2E_PORT = String(freePort());
}
const port = Number(process.env.TABLEWALK_E2E_PORT);

/* Written once, by whichever process built the fixtures. Every test gets it as `storageState`; the few that build their
   own context ask for it by name. Without it every test is a first load, and the tour would put a modal scrim over the
   whole suite. */
if (!existsSync(SEEN_TOUR)) writeSeenTour(`http://127.0.0.1:${port}`);

export default defineConfig({
  testDir: './e2e',
  /* Outside e2e/.tmp, which buildFixtures() deletes at the start of every run. */
  outputDir: './e2e/.results',
  /* Pinned to the browser, not the lane, so the committed baselines stay the baseline whatever the lanes are called. */
  snapshotPathTemplate: '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}-chromium{-snapshotSuffix}{ext}',
  /* One worker, and not for tidiness. tablewalk's server holds one active connection for the whole process — the client
     switches it with POST /api/connections/select and every later request uses whatever that left behind. Two browsers
     on two databases therefore fight over one global. That binds the `shared` project below, which is why this stays the
     default for anyone who runs `npx playwright test` by hand. `scripts/test-e2e.mjs` raises it for the `owned` project,
     whose specs each start a server of their own. */
  workers: 1,
  fullyParallel: false,
  /* No retries. A retried browser test is a flaky test wearing a disguise. */
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  /* More time on CI, not more attempts. */
  timeout: process.env.CI ? 40_000 : 20_000,
  expect: { timeout: process.env.CI ? 15_000 : 7_000 },

  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    /* Wide enough that the sixteen-column fixture still overflows and the three-column one does not. */
    viewport: { width: 1280, height: 900 },
    /* Figures and dates are written in the browser's locale; the specs read "1,234" and "Mar 5, 2026". */
    locale: 'en-US',
    storageState: SEEN_TOUR,
  },

  projects: [
    { name: 'owned', testMatch: laneMatch(owned), use: { ...devices['Desktop Chrome'] } },
    { name: 'shared', testMatch: laneMatch(shared), use: { ...devices['Desktop Chrome'] } },
  ],

  /* The `owned` lane gets no server at all: a spec that lands in that lane while secretly wanting the shared one then
     fails at once on a refused connection, instead of quietly racing whichever other spec is switching the active
     connection. The partition is a claim, and this is the run checking it. */
  webServer:
    lane === 'owned'
      ? []
      : [
          {
            command: `npx tsx src/server/index.ts --config ${CONFIG} --port ${port}`,
            url: `http://127.0.0.1:${port}/`,
            /* Never reuse: a server someone left running is pointed at their own database. */
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 30_000,
            env: {
              /* Record layouts are stored under XDG_CONFIG_HOME. Without this the suite reads — and writes — the layouts
                 of whoever is running it. */
              XDG_CONFIG_HOME: `${TMP}/xdg`,
              TABLEWALK_OPEN: '0',
            },
          },
        ],
});
