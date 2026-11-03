# Working in this repo

tablewalk is a read-only-by-default database browser (SQLite, Postgres; MySQL/MariaDB
are paused)
that serves a web UI and speaks MCP to coding agents. `npx tablewalk <db>` is
the whole deployment — there is no build step for the person running it.

The framework it is built on (`@mistriwork/engine`, `@mistriwork/kit`,
`@mistriwork/ui`) lives in rbaljinder/mistri and is installed here from npm at
an exact version. Never import from a path inside `node_modules`; use a
published entry point (`scripts/check-boundary.mjs` enforces it). If the browser
needs something a package does not export, report it as a framework gap rather
than copying code in.

Maintainer working notes are not in the repository, which is public. A
maintainer may keep them in a local, gitignored `.notes/` folder. Never commit
anything under `.notes/`, and never link public documents to it. Commit messages
keep the `Co-Authored-By` trailer but never a `Claude-Session:` trailer, and
pull request descriptions never include the claude.ai session link. Leave
`.idea/` alone and never stage or reseed `.demo/`. Run `npm test` and the browser
suites sequentially because they share disposable `e2e/.tmp` fixtures.

## Architecture, in one paragraph

The **server** (`src/server`) is TypeScript, compiled to `dist/` by `npm run
build`. The **client** (`src/client`) is hand-written ES modules plus React
(`src/client/components`, TanStack Query), and imports the TypeScript under
`src/shared/` directly, so one rule says what a row is called and where a
condition ends on both sides. `vite.config.ts` (on `@mistriwork/kit/vite`)
bundles it into `dist/client` — minified, content-named, precompressed — and
`scripts/bundle-budget.mjs` holds the first-paint ceilings. Under tsx (`npm start`, every
test suite) the server sends `dist/client`, the last `npm run build`: nothing in
`src/server` runs Vite, and the engine's `devclient` serves the page through
Vite from source only when the engine itself runs from `.ts` (its own
workspace), not from the compiled copy in `node_modules`. So build once before
a browser suite, and again after a client edit. `test/check-client-types.mjs`
type-checks the client via JSDoc and `test/check-client-geometry.mjs` enforces
the zoom-aware ruler; `oxlint` catches a name used and never imported.

## Facts that are written in more than one place — keep them in sync

Each lives in the code **and** in prose (`README.md`, the `USAGE` string in
`src/server/cli.ts`). `test/prose.test.ts` enforces the tool count and names,
the read/write split, USAGE against the README flag list, and the dialect
keywords on every `npm test`.

- **MCP tool count and names.** Stated in `README.md`. The source of truth is
  `src/server/mcp.ts`. A read-only connection lists only the reading tools; a
  `"writable": true` connection also lists the writing ones.
- **Deep-link URL format.** Path routing (`pushState` + `popstate`), not hash
  routing. A record is `/{connection}/{table}/~{id}`, a page
  `/{connection}/@{page}~{id}`, and the query language stays in the path
  (`/demo/invoice%20total%20%3E%20500`). A `#/...` link is not read at all, so
  any `#/...` example in prose is stale.
- **Supported dialects.** SQLite (built in) and Postgres (`pg`), from
  `@mistriwork/engine`. MySQL/MariaDB is paused at 1.0: the engine refuses a
  `mysql://` URL with `MySQL is not supported; use PostgreSQL or SQLite.`
  Listed in the README Databases table and `package.json` keywords.
- **CLI flags.** The `USAGE` string and the README Options block must agree.
  `npx tsx src/server/index.ts --help` prints the live version.
- **The read-only / write-opt-in claim.** Browsing is read-only; editing is
  per-connection opt-in (`"writable": true`) and enforced by the server before a
  statement reaches the database. Every place that describes writes should say so.
- **Values that are not JavaScript numbers.** Ids past 2^53 come back as
  **strings** and must never be run through `Number()` for display. Both display
  formatters — `Cell` in `src/client/components/Grid.tsx` and `sayValue` in
  `src/client/components/valueModel.ts` — guard this; keep any new value
  renderer consistent. Covered by `e2e/grid.spec.ts`.

## After any client edit

`npm run build`, then `npm run smoke`: it walks the rooms in a real browser,
asserting each one paints and nothing throws. Nothing executes the client until
a browser does: a constructor-time throw in a shared module blanks whole views
while tsc and the unit suite stay green. Every e2e test also fails on any
uncaught page error (`e2e/support/harness.ts`).

## Gates

- `npm run check` — tsc, oxlint, client type and geometry checks, the import
  boundary, oxfmt. `npm test` — the Node suite in two lanes
  (`node scripts/test-node.mjs --lanes` prints the partition; a file that
  reaches the database named by `TABLEWALK_TEST_PG` runs serially). `npm run test:components` — Vitest in happy-dom.
- `npm run e2e` — Playwright, two lanes (`npm run e2e -- --lanes`): specs that
  start their own server on a `listen(0)` port run in parallel; specs that
  address the config server run one at a time. The build is `npm run build`,
  which ends in the bundle budget; `npm run test:built:browser` holds what a
  cold visit fetches.
- Do not overlap the heavy gates (Node suite, e2e, Docker, desktop).

## Before a release

- `npm run check`, `npm test` (add live Postgres via `TABLEWALK_TEST_PG` +
  `TABLEWALK_REQUIRE_LIVE=1`, seeded by `npm run
  seed:live`), `npm run test:components`, `npm run e2e` all green.
- The version in `package.json` and the `v*` tag must match (the release
  workflow refuses a mismatch), and `CHANGELOG.md` carries the release's entry.
- `npm pack --dry-run` — read the file list; the `files` allowlist is what ships.
- Bumping the `@mistriwork/*` pins moves all three together, always exact.

## Style

Match the surrounding code. Comments explain **why**, not what. The commit
messages and code comments here carry a lot of the "why" — read the nearby
ones before changing a thing that looks odd; it is usually load-bearing.
American English.
