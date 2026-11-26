# Changelog

## 1.0.0-rc.25

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.91`.

- **`Folio` as the Native Default Look:**
  - Promoted **`Folio`** (warm archival paper, printed book-style horizontal table rules, quiet near-black actions, deep
    forest-green foreign-key links, and warm charcoal dark mode) into `looks/native.css` so it paints on first load with
    zero extra stylesheet fetches.
  - Kept **`Instrument`** (`Stone`, `Graphite`, `Fog`, `Slate`, `Ink`) as selectable on-demand host looks alongside
    `Braun`, `Broadsheet`, `Obsidian`, `Blueprint`, `Console`, `Gallery`, `Lumen` and the rest of the shared Mistri themes.
- **SQL Workbench, `.sql` Workspaces, Syntax Highlighting & Autocomplete:**
  - **Dialect-Aware SQL Highlighting & Schema Autocomplete:** Added 5-color SQL syntax highlighting (PostgreSQL & SQLite)
    and upgraded autocomplete supporting tables, columns, statement-scoped aliases, CTE names, foreign-key-guided
    `JOIN … ON` clauses (including composite FKs), named `:params`, and dialect functions — silent inside strings and
    comments.
  - **Connection-Scoped `.sql` Workspaces (`--sql-dir` / `"sqlDir"`):** Attach a local `.sql` folder on disk (loopback,
    CLI `--sql-dir`, or `tablewalk.json` `"sqlDir"`, shared automatically across sibling environments of the same logical
    database) or **Import folder…** in the browser; manage subfolders and files, edit multiple scratch consoles and file
    tabs with `⌘S` save, and browse per-database execution **History**.
  - **Statement-at-Caret, Multi-Statement Scripts & Inline Parameters:** `⌘↵` runs your selection or the statement under
    the caret; multi-statement scripts add **Run script** (`POST /api/sql/script`) executing sequentially and stopping on
    the first error; `:param` and `{{param}}` placeholders open an inline parameter bar remembered per database.
  - **SQL Result Exports, Numeric Aggregates & Env Row Diff:** Copy SQL results as CSV, JSON, Markdown, `INSERT` or
    `IN (…)`, download `.csv`, view automatic numeric `sum / avg / min / max` aggregates, and toggle **Diff envs** inside
    **Compare envs** to see added, removed, and changed rows side by side.
- **Parameterized `.sql` Execution & Exports in MCP and CLI:**
  - **MCP `sql`, `export`, and Shelf:** Workspace `.sql` files appear on `tablewalk://{connection}/queries` with their
    required `:param` names listed, and both `sql` and `export` accept typed `params` (refusing missing parameters with
    `invalid_argument` naming the missing keys).
  - **CLI Syntactic Sugar (`--sql-file`, `--param`, `--out`):** Execute or export parameterized `.sql` files (on disk or
    from `--sql-dir` / `"sqlDir"`) directly from scripts and CI, inferring `.csv`, `.ndjson` / `.jsonl`, `.json`, and
    `.gz` compression from `--out` (or streaming `--format tsv|json|ndjson|md` to stdout when `--out` is omitted).
- **Table Grid Ergonomics:**
  - Right-click or `Shift+Click` any table cell for the **Cell Inspector** (pretty-printed JSON, UTC/local timestamp
    conversions, UUID inspection, multiline copy, and 1-click `=`, `!=`, `is empty` quick cell filters).
  - Added searchable **Columns** jump chooser for wide tables, **Copy…** (`CSV`, `TSV`, `JSON`, `Markdown`, `INSERT`,
    `IN (…)`) for visible rows, and a sticky **Grid Aggregates** (`sum / avg / min / max`) footer.
- **Mistri `1.0.0-rc.91` Platform Adoption:**
  - Added optional PostgreSQL pool timeouts (`connectTimeoutMs` / `queryTimeoutMs`) in `ConnectionDialog` and connection
    docs; adopted `@mistriwork/ui` `Tabs`, `Resizable`, `Button` and `@mistriwork/ui/charts/core.js` horizontal diagnostic
    and column-profile bars.

## 1.0.0-rc.24

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.77`.

- **Workbench Structural Host Looks (`Obsidian`, `Braun`, `Broadsheet`):**
  - **`Obsidian` (`?look=obsidian`):** Frameless matte outer shell with a floating rounded workspace island, elevated
    pill tabs, `6px` specular micro-bevel keycap controls, capsule foreign-key badges, small-caps `NULL`, and rounded
    constellation ER cards.
  - **`Braun` (`?look=braun`):** Bead-blasted anodized aluminum topbar and sidebar, recessed dark phosphor-jade LCD
    readout wells for both the query bar (`#query`) and SQL workbench (`.sql-input`), tactile 3D chicklet push-buttons
    with `:active` depression, an orange LED active-table indicator, and an International Orange `RUN` key while
    preserving exact SQL identifier casing.
  - **`Broadsheet` (`?look=broadsheet`):** Warm newsprint surfaces (mahogany inkwell in dark mode), editorial serif
    masthead and headings, `3px double` newspaper masthead rules on topbar and SQL drawer, dotted index leaders on
    record fields, borderless horizontal data tables, and claret burgundy + teal ink.
- **Desktop Record-Header Layout Hygiene:** `.record-heading` action buttons stay single-line (`white-space: nowrap`) and
  wrap cleanly across all built-in and kit looks on split-screen laptop viewports without colliding with the `Related`
  rail.

## 1.0.0-rc.23

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.77`.

- **Record Workflows & Command Palette Continuity:**
  - **1-Click `Extract fixture…` on Records:** Record headings add **Extract fixture…**, walking outgoing and optional
    incoming foreign keys via `fixture` with interactive **Include child rows** and **Mask PII** (`redact: true`)
    toggles, **SQL INSERTs** vs. **`insert_graph` JSON** switching, and 1-click **Copy fixture**.
  - **Cross-Environment Record Diff (`Compare envs`):** When sibling environments (`local`, `staging`, `prod`) exist for
    the active logical database, record headings add **Compare envs** to fan out `record` (`envs: "all"`) and render a
    side-by-side field matrix highlighting missing rows and differing cell values across tiers.
  - **Recent Queries & Breakdowns in `⌘K`:** Multi-token queries and breakdowns run in the query bar are stored in a
    bounded per-database ring (`mistri.recentQueries.v1`, shared across sibling environments) and offered directly in
    `⌘K`.
- **Migration Safety & DDL Verification:**
  - **Interactive `Verify DDL` in `SqlPane` & Column `Change impact…`:** The SQL editor adds **Verify DDL** alongside
    **Explain**, running candidate `CREATE` / `ALTER` / `DROP` / `COMMENT ON` DDL inside an isolated SQLite copy or
    rolled-back PostgreSQL transaction (`verify_ddl`) and rendering structural catalog diffs plus newly introduced
    `lint` findings. Grid column header menus (`.th-menu`) add **Change impact…** (`change_impact`) showing row count,
    null count, index status, incoming foreign keys with `ON DELETE` rules, and migration consequences.
  - **CLI `tablewalk --verify-ddl <path|->` & Draft Migration SQL in `Environment drift`:** Added one-shot
    `--verify-ddl <path|-> [--format json|md] [--fail-on high|medium|low]` for CI and agent preflight, plus directional
    draft `ALTER TABLE` migration SQL (**Copy migration SQL** / **Verify in SQL**) inside **Check the shape →
    Environment drift**.
- **Direct File & Folder Opening (`ephemeralImport`):** `tablewalk ./dump.sql`, `tablewalk ./orders.csv` (`.csv`,
  `.tsv`, `.ndjson`, `.jsonl`), and `tablewalk ./exports/` now hydrate a read-only ephemeral SQLite database on the fly
  with automatic numeric/real/text type inference, `id` primary keys, and validated `<stem>_id -> <parent>(id)` foreign
  keys so flat exports can be walked and queried immediately.
- **Expanded Data Anomalies & MCP Prompts:**
  - **`negative-measure` & `future-timestamp` Rules in `anomalies`:** Added zero-row-leak count checks for negative
    unsigned business measures (`total`, `quantity`, `price < 0`, excluding signed delta/balance columns) and
    future-dated past-event audit timestamps (`created_at`, `paid_at > tomorrow`).
  - **4th MCP Prompt (`compare-environments`) & Modernized Guided Walks:** Updated `orient`, `pre-migration-check` and
    `investigate-row` to guide agents through `perf`, `anomalies`, `verify_ddl` and `redact: true`, and added
    `compare-environments` (`from`, `to`) with pre-computed `diff` findings.

## 1.0.0-rc.22

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.77`.

- **Workbench Power & Multi-Environment Continuity:**
  - **Logical-Database Shared Browser Stores:** Saved SQL statements (`mistri.sql.v1`), table saved filters
    (`mistri.views.v1`), composed multi-table views (`mistri.composer.v1`), and pinned columns (`mistri.pins.v1`) now
    carry across sibling environments of the same logical `database` (`billing@local`, `billing@staging`,
    `billing@prod`).
  - **Inline Column Profile & 1-Click FK Column Pull:** Grid column header menus (`.th-menu`) add **Profile column…**
    (floating popover with null %, distinct count, min/max range, and clickable top values to filter by) and **Show from
    `<table>`** on single-column foreign keys (`+ customer_id.name`) to project joined columns without hand-typing `show`
    clauses.
  - **Per-Column `masked` Indicators:** `GET /api/connections/redacted` and `redactedColumnsByTable` badge grid headers
    and record field labels on `"redact": true` / `redactColumns` connections so deterministically masked PII is clear
    at a glance.
  - **Visual Execution Plans in `SqlPane` & Compiled SQL Bar:** Added **Explain** in the SQL editor (`SqlPane`) and
    **Plan** in the compiled SQL bar (`#explain-pane`), highlighting sequential scans vs. index seeks with latency and
    node counts.
- **Live Agent Co-Browsing & CLI Preflight:**
  - **Live MCP Topbar Pill & `Follow agent` Mode:** Loopback browser sessions show a live `MCP · N` activity pill in the
    topbar when external MCP clients call tools, and `AgentConsole` adds a **Follow agent** toggle that automatically
    walks the browser along incoming `record`, `query`, and `table` deep links.
  - **`tablewalk --check` Connection & Guardrail Preflight:** Dials configured connections (or `--connection` / `--env`),
    verifies credentials, reports latency, table/view/FK counts, and active guardrails (`--format json` or `md`), closes
    all sockets, and exits non-zero on failure.
  - **`--export agent` Compact Operational Brief:** Generates a token-lean Markdown brief for `CLAUDE.md` / `AGENTS.md`
    covering configured `db@env` postures, hub/event/join tables, deepest walk chain, key tables, and schema-specific
    `tablewalk` query examples.
- **Live PostgreSQL Lock & Query Contention Diagnostics (`perf`):** Extended `perf` with `lock-contention` (`high`) and
  `long-running-query` (`medium`) rules backed by `pg_stat_activity` + `pg_locks` + `pg_blocking_pids`, intersecting
  locked relations strictly with the policy-filtered schema and reading zero SQL text or row literals.
- **CI & Release Workflows:** Upgraded `actions/checkout` and `actions/setup-node` pins across GitHub Actions workflows
  to Node 24-native `v5.0.0`.

## 1.0.0-rc.21

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.77`.

- **Refined Instrument Pro** Workbench UI modernization across all four workspace pillars while reducing cold
  first-paint JavaScript:
  - **Workspace & Grid Density:** Single-line inline key-value quick-filter chips with a collapsible **Filters** toggle
    in the table tab bar (~80px of vertical height reclaimed above row 1), tightened topbar/breadcrumb/tab/result-head
    rhythm, sorted column header tinting, and a segmented sidebar scope bar (**All · Tables · Views**) plus a
    **Focused** table-count pill on neighborhood-scoped connections.
  - **Framed Floating Modals & Diagnostic Cockpit:** **Check the shape** and **Find a value** now open as bounded
    floating dialogs over a dimmed scrim carrying active `db@env` and `masked` posture badges; **Check the shape**
    upgrades to an underline tab bar with live severity-tinted count badges, inline monospace remediation SQL previews,
    1-click **Open in SQL** across schema/index findings, and generated multi-hop `SELECT … JOIN …` statements (**Copy
    JOIN SQL** / **Open in SQL**) in **Join paths**.
  - **Schema Landing & ER Viewport Polish:** De-duplicated connection titles above the overview ER diagram, accurate
    relational subtitles on runner-up starter chips, 1-click **Check shape & perf** and **Join paths** launchers on the
    landing header, and cobalt foreign-key neighborhood edge/node illumination on ER hover.
  - **Agent Console & SQL Split Ergonomics:** Instant tool search and 5-category grouping (*Schema & graph*, *Query &
    walk*, *Diagnostics & perf*, *Migrations & order*, *Safe writes*) across the twenty-eight MCP tools plus an **All
    envs** parallel read fan-out target pill in **Agent console**, and a drag-resizable top split handle plus 1-click
    **Compare envs** parallel `SELECT` fan-out tabs in the **SQL** drawer.

## 1.0.0-rc.20

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.77`.

- A new read-only MCP tool, `perf` (bringing the server to twenty-eight tools: twenty-two read-only and six writes),
  inspects live index, scan, bloat and planner-statistics health across PostgreSQL (`pg_stat_user_tables` and
  `pg_stat_user_indexes`: sequential-scan hotspots, duplicate prefix btree indexes, zero-scan non-constraint indexes,
  dead-tuple bloat and stale `ANALYZE` statistics with ready-to-run `DROP INDEX CONCURRENTLY`, `VACUUM (ANALYZE)` and
  `ANALYZE` SQL) and SQLite (`PRAGMA index_list`, `EXPLAIN QUERY PLAN` over views and `sqlite_stat1`), intersecting
  strictly with the policy-filtered schema and reading zero row values.
- Cross-environment read fan-out (`envs: "all"` or `envs: ["local", "staging"]` on read-only MCP tools, and `--all-envs`
  on `--query`, `--call` and `--batch`) executes a read across sibling environments of a logical database in parallel,
  honoring each environment's `rows`, `redact`, `blocklist`, `maxRows` and `timeoutMs` guardrails.
- Per-environment and per-connection statement deadlines (`"timeoutMs"`, `--timeout-ms <ms>`, `TABLEWALK_TIMEOUT_MS`)
  enforce bounded per-call caps across environments, and dynamic vault credential refresh (`"credentialCommand"`,
  `TABLEWALK_CREDENTIAL_COMMAND`) runs an operator-supplied command to refresh short-lived IAM or Vault secrets in
  memory before initial open and after idle-lease eviction without touching `process.env` or disk.
- Schema neighborhood focus (`--focus <tables>`, `--focus-hops <n>`, `"focus"` / `"focusHops"` in config,
  `TABLEWALK_FOCUS`, `TABLEWALK_FOCUS_HOPS`) scopes a connection's catalog, queries, views, records, exports and writes
  to the N-hop foreign-key neighborhood of focal tables while withholding unrelated domains and raw SQL.
- Token-lean CLI output formats (`--format <json|ndjson|tsv|md>` across `--query`, `--call` and `--batch`, including
  cross-environment fan-out tables) and zero-PII structured JSONL audit logging (`--audit-log <path|stderr>`,
  `TABLEWALK_AUDIT_LOG`) recording operational call metadata and row-movement receipts without row values, SQL text or
  secrets.
- Workbench refinements: **Check the shape** expands to a 5-tab diagnostic and relational cockpit adding **Index & scan
  health** (`perf` with 1-click **Copy SQL**) and **Join paths** (interactive `From` / `To` foreign-key path explorer
  with hop index status, **Copy index SQL** and 1-click **Walk rows**, also reachable directly from `⌘K` via **Find path
  between tables…**), plus `focused` and `timeoutMs` badges in **Connections**.

## 1.0.0-rc.19

Built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly `1.0.0-rc.77`.

- Environment-tier policies (`"environments"` in `tablewalk.json` or piped vault configs, keyed by `"local"`, `"dev"`,
  `"test"`, `"staging"`, `"replica"`, `"prod"` or custom `env` names) set shared `writable`, `rows`, `lease`,
  `blocklist`, `redact` / `redactColumns` and `maxRows` defaults across every connection in that tier, with explicit
  per-connection overrides and round-trip preservation on **Save to file**.
- Always-on connection redaction (`"redact": true`, `"redactColumns": [...]`, `--redact`, `TABLEWALK_REDACT`,
  `TABLEWALK_REDACT_COLUMNS`) deterministically and idempotently masks PII and secrets across `query`, joined `views`,
  `breakdown`, `profile`, `record`, `find`, `fixture`, `export` and HTTP reads while withholding raw `sql`, `explain`
  and `verify_ddl`.
- Session row-egress budgets (`"maxRows"`, `--max-rows <n>`, `TABLEWALK_MAX_ROWS`) cap total rows returned per
  connection across `query`, `breakdown`, `sql`, `find`, `fixture` and `export`, clamp per-call limits to the remaining
  budget, refuse further row reads with `limit` once exhausted, and surface `redactsRows`, `maxRows` and
  `rowsRemaining` across `connections`, `/api/connections`, `/api/agent/activity`, Connections and the Agent console.
- Guardrails can also be supplied directly from environment variables (`TABLEWALK_BLOCKLIST`,
  `TABLEWALK_BLOCKED_TABLES`, `TABLEWALK_BLOCKED_FIELDS`, `TABLEWALK_REDACT`, `TABLEWALK_REDACT_COLUMNS`,
  `TABLEWALK_MAX_ROWS`, `TABLEWALK_LEASE`) for zero-file CLI and MCP launches.
- A new read-only MCP tool, `path` (bringing the server to twenty-seven tools: twenty-one read-only and six writes),
  finds the shortest foreign-key paths between two tables across `to-one` and `to-many` hops, flags reverse hops
  missing a leading index with approximate rows scanned and ready-to-run `CREATE INDEX` DDL, and emits `queryHint`
  expressions.
- Multi-call CLI batch mode (`--batch [path|-]`) runs newline-delimited queries, breakdowns or JSON `{ "tool", "args" }`
  calls over one connection session (including single-pipe `{ vault get; cat calls.jsonl; } | tablewalk --config - --batch -`),
  streaming NDJSON lines to stdout before closing all connections; PostgreSQL keyset `export` now streams 25,000-row
  batches with overlapped prefetching.
- Workbench refinements: foreign-key dot-path (`customer_id.country_code.name`), `CHECK` vocabulary, boolean/date value
  and breakdown measure/period autocomplete in the query bar and `⌘/` **Ask** dialog (with active `@env` posture badge
  and live query/breakdown/joined-view preview); a 3-tab **Check the shape** dialog combining **Schema & perf**
  (approximate row counts and 1-click **Copy index SQL**), **Data anomalies** (1-click **Walk rows**) and **Environment
  drift** (`diff` against sibling environments); and `masked`, `restricted` and row-budget indicators across the
  topbar, Connections and Agent console.

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
- Loopback browser sessions now serve Streamable HTTP MCP directly at `POST /mcp` (and `tablewalk --mcp` bridges stdio
  to a running server when `TABLEWALK_MCP_URL` is set), sharing one `Registry`, Undo stack, row-egress counter and live
  MCP activity trail inside the Agent console.
- Two new read-only MCP tools bring the server to twenty-six tools: `anomalies` scans stored rows using bounded counts
  (working on `"rows": false` connections too) for temporal inversions, dangling soft-delete lifecycles and nullable FKs
  populated on >=95% of rows with null outliers; `verify_ddl` runs candidate migration DDL in an isolated SQLite copy or
  rolled-back PostgreSQL transaction and returns the resulting schema `diff` and newly introduced `lint` findings.
- `insert`, `update` and `insert_graph` accept `dryRun: true` to execute inside `BEGIN … ROLLBACK` and return coerced
  values, defaults, generated keys or real constraint errors without committing or recording Undo history.
- `fixture` and `export` accept `redact: true` (and `redact_columns`) to deterministically mask emails, phones, names,
  addresses and secrets while preserving primary keys, foreign keys, `CHECK` vocabularies and `varchar` lengths.
- Configured multi-table `views` and `queries` in `tablewalk.json` are exposed on the MCP shelf
  (`tablewalk://{connection}/views`, `tablewalk://{connection}/page/{page}`) and runnable by name in `query`, `sql` and
  `export` (with `views` working across `"hidden"`-column connections); **Copy brief for agent** (`⌘K` / `···`) copies a
  Markdown handoff of the current record, query or schema to the clipboard.
- Connections sharing a logical database across environments (`"database"` and `"env"` in `tablewalk.json`, or inferred
  from names like `billing-local`, `billing-staging`, `billing-prod`) group together in Connections, switch in place
  from the topbar, `⌘K` palette, SQL editor and Agent console while keeping the open table, query or record, and can be
  targeted by MCP tools with `env` or `db@env` / `@env` selectors (with implicit unaddressed writes to `prod` refused
  when non-production siblings exist).
- Piped vault configs (`--config -`, process-substitution FIFOs, `TABLEWALK_CONFIG_JSON`) load connections and inline
  `"secrets"` / `"dotenv"` variables in memory without writing to disk, support `--lazy` MCP handshake and fast one-shot
  `--query <q>` / `--call <tool> [--args <json>]` CLI lookups, enforce `"lease"` (`idleSeconds`, `maxSeconds`, `--lease`)
  with deterministic connection teardown on idle/expiry/EOF, and enforce top-level or per-connection `"blocklist"` rules
  (`tables` and `fields` wildcards) across every catalog, query, view, profile, export and write while refusing raw SQL.
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

