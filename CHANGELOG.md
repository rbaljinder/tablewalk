# Changelog

## 1.0.0-rc.18

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.77`.

- PostgreSQL pools keep two warm reader connections by default (`"pool": { "minIdle": 2, "idleSeconds": 300 }` or
  `TABLEWALK_POOL_IDLE`), and `--auth-proxy-header` refuses proxied loopback requests that carry no user header while
  keeping `/healthz` and `/readyz` open ahead of the door.
- `POST /api/agent/call` defaults `connection` to the tab's resolved connection instead of `registry.active`, so Find a
  value, Check the shape and Agent console calls act on the database open in that tab, and `diff` honors `from`.
- On an HTTP listener reachable beyond loopback, `export` is withheld from `/api/agent/tools` and refused over
  `/api/agent/call`, `/api/connections/demo` is refused, and session connections are bounded.
- `export` reports `stats.rowsRead` and advances `rowsReadThisSession`; `fixture` and `record` refuse keyless tables,
  and `fixture` SQL qualifies non-default schemas and formats dates, byte arrays and JSON documents cleanly.
- The connection dialog's URL preview masks literal passwords even when host or port uses `${ENV}` or the user is empty,
  and preserves `${ENV}` in database names; the Agent console coerces integer and array arguments (`revert`,
  `insert_graph`, `delete_graph`, `record.keys`, `explain.params`) and links only `link` fields; raw SQL writes refresh
  cached views and Undo; `?look=` links can pick built-in kit looks as well as host looks.
- `tablewalk journal` resolves credentials and refuses in-memory SQLite and unsupported schemes before touching the
  filesystem; `--diff` and `--lint` close their connections and let stdout drain before exiting; the desktop app
  replaces its server and updates `lastDatabase` only after the new database opens, falling back to Welcome if a
  remembered file later fails.

## 1.0.0-rc.17

- A new MCP tool, `export`, writes a query or a read-only `SELECT` to a file (csv, ndjson or json, optionally gzipped)
  in `tablewalk-exports` under the temp directory, and answers with its path, counts and a sample, so an agent can
  pull data out without the rows passing through its context. `query` exports page by key with no row ceiling beyond
  `limit`; `sql` exports stop at 100,000 rows and say so. The server now offers twenty-four tools.

## 1.0.0-rc.16

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.65`.

- A tablet is its own width (761 to 1100 px), between the phone and the desk. The sidebar folds to its icon rail there
  instead of the phone's drawer, and a record keeps its side column instead of stacking it under the page.
- On a touch screen every control in a list and a record is a 44 px target at any width: a row, a column's sort and
  filter buttons, a removable chip's ×, and the search row.

## 1.0.0-rc.15

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.60`. `@mistriwork/ui` is now
drawn over UI SDK instead of Base UI, so the browser takes `@ui-sdk/core` and `@ui-sdk/react` as direct dependencies and
no longer depends on `@base-ui/react`.

### Looks

- The browser's own look is Instrument in the Graphite and cobalt palette: cool graphite greys with one cobalt accent,
  every text colour at 4.5:1 or more on every ground it sits on. Fog and moss, the former default, is one of Instrument's
  other palettes in Preferences; `?look=instrument&palette=fog` picks it.
- The first-visit tour dims what is outside its spotlight with a dark scrim instead of a wash of the ground, so the table
  list and the wordmark stay legible (4.5:1 or more) while the tour points at them.

### Fixes

- The page builder draws its box with the kit's dialog, the one its confirm, prompt and field-arranger dialogs already
  use, so nested Escape and focus stay in one library.
- The overflow menu's checkable rows (Preferences, Dark mode) no longer start with an empty tick column; the tick
  follows the label.

### Known gaps

- Preferences lists Graphite twice: once as Instrument's palette and once as the kit's own Graphite look.

## 1.0.0-rc.14

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.55`.

- A connection under the row-security backstop (`"backstop": "rls"`) is refused at start, by name, before anything
  connects. Its `url` signs in as a tenant App's restricted role, which sees no tenant row until a tenant is set, so
  every table would have opened empty without saying why. Point a connection at the owner's URL instead.
  `tablewalk journal` refuses one too.

## 1.0.0-rc.13

tablewalk, the database browser, now lives in its own repository and ships as its own
package, built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly
`1.0.0-rc.49`. Everything before this release (the browser's history up to 1.0.0-rc.12
included) is in the framework's changelog:
https://github.com/rbaljinder/mistri/blob/main/CHANGELOG.md

### Looks

- The browser's own look is Instrument in the Fog and moss palette: Inter for words, IBM Plex Mono for figures, a hairline
  measuring grid, near-monochrome grey with one moss accent. It is a sheet of this package (`looks/native.css`, in the
  first stylesheet, so it paints with the first load) over the kit's native tokens; the former native look is retired.
  Instrument's other palettes (Graphite, Stone, Slate, Ink) and Folio are host looks beside Blueprint and Console.
  `?look=instrument&palette=fog` still opens, as the default.
- Blueprint and Console are the kit's host looks (`registerHostLooks`): they are offered in Preferences beside the
  built-in looks, persist with the reader's look, and set `data-host-look` on the page. `?look=blueprint`,
  `?look=console` and `?look=default` still pick one from the address. Console names its data face with `--data-face`;
  Blueprint's condensed capitals are the kit's Barlow Semi Condensed.
### Undo and version

- Undo can outlive the process. `tablewalk journal` makes the store a writable connection keeps its write journal in (two reserved
  tables in its database): after a restart, Undo and `revert` still reach its last 50 writes, for 7 days. Without the store the
  journal is the process's alone, as before, and opening a connection makes nothing.
- `--version`, MCP's `serverInfo` and telemetry report this package's version through the engine's `setProduct`.

### Safety and correctness

- The SQL editor refuses a statement that touches tablewalk's own runtime tables, as the MCP `sql` tool already did.
- On a server reachable beyond this machine, removing a connection from the config file is refused unless the request
  comes from the machine running tablewalk.
- `migrate up`, `migrate baseline` and `migrate repair` need a writable connection, as `seed` does, and a mistyped
  `migrate` or `seed` suggests the right tablewalk command.
- An MCP tool's error carries a stable code in its result's `_meta`, so an agent can act on the kind of failure without
  reading the message.
- The Docker image and the desktop app install from the lockfile, and the desktop app offers DevTools only in a
  development run.

### Docs

- The README shows the startup warning tablewalk really prints, points to the App framework instead of describing it,
  recommends a read-only role on Postgres, and says to run `npx tablewalk@next` for the current build.

