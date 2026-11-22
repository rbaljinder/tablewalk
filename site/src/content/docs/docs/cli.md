---
title: Command line
description: Every command and option of the tablewalk CLI, from serving a database to checking its shape in CI, running migrations and seeding rows.
---

`tablewalk` serves a database browser, speaks MCP, checks a schema, migrates it and seeds it, all from one command.

```sh
npx tablewalk postgres://localhost/app --schema public --port 4200 --open
```

<!-- Remove with the next note once the browser-only release is published. -->
> Until the browser-only release is published, `npx tablewalk@next` is the current build.

`npx tablewalk --help` prints the short help, `--help all` prints everything, and `tablewalk <command> --help` prints one command's options. An option it does not recognize is an error, not a shrug: `tablewalk --prot 4111` says so rather than serving the default port.

## Commands

| Command | Does |
| --- | --- |
| `tablewalk` | Serves the browser and asks for a connection on the page |
| `tablewalk <sqlite-file>` or `<postgres-url>` | Serves that database |
| `tablewalk --demo` | Builds a throwaway sample database in the temp directory and opens it |
| `tablewalk <db> --mcp` | The database's tools for a coding agent, on stdio ([MCP](/docs/mcp/)) |
| `tablewalk <db> --export md` | Prints the schema, then exits |
| `tablewalk migrate <command>` | Changes the schema with versioned SQL files; `up` writes, so it needs `"writable": true` |
| `tablewalk seed [<db>]` | Fills a writable database with believable rows |
| `tablewalk journal [<db>]` | Keeps a writable connection's Undo history across restarts |

A path typed on the command line is relative to the current directory; a path written in `tablewalk.json` is relative to that file's folder.

## Choosing the database

| Option | |
| --- | --- |
| `-d, --db <target>` | A SQLite file path or a `postgres://` URL. `DATABASE_URL` is used when nothing else names a connection. |
| `--schema <name>` | PostgreSQL only; repeatable. All user schemas by default. |
| `--config <path\|->` | Read connections from this file, a process-substitution FIFO, or `-` for piped vault JSON or `.env` lines on stdin. See [Connections and config](/docs/connections/). |
| `--no-config` | Ignore any config file. |
| `--connection <name>` | Select the active connection at startup (`id`, `name`, or `db@env`). |
| `--env <name>` | Select the active environment at startup (`local`, `staging`, `prod`). |
| `--lease <duration>` | Bound connection lifetime (`120`, `5m`): close idle connections and expire when the lease ends (or set `TABLEWALK_LEASE`). |
| `--redact` | Deterministically mask sensitive PII and secret columns on every row read, withholding raw SQL (or set `TABLEWALK_REDACT=1`). |
| `--max-rows <n>` | Cap total rows read per connection in this session (or set `TABLEWALK_MAX_ROWS`). |
| `--timeout-ms <ms>` | Per-call statement deadline in milliseconds (or set `TABLEWALK_TIMEOUT_MS`). |
| `--focus <tables>` | Scope the catalog and queries to these tables and their foreign-key neighborhood (or set `TABLEWALK_FOCUS`). |
| `--focus-hops <n>` | With `--focus`: foreign-key hops to include, `0` to `5` (default `1`, or set `TABLEWALK_FOCUS_HOPS`). |
| `--audit-log <path\|stderr>` | Append zero-PII JSONL audit receipts for every tool call (or set `TABLEWALK_AUDIT_LOG`). |
| `--demo` | Build a throwaway sample database and open it. Nothing of yours is touched. |
| `--openapi <spec.json\|url>` | Serve the REST API a spec describes, read-only, drafted in memory. |
| `--api-url <url>` | With `--openapi`: the API's base URL, when the spec does not give a usable one. |
| `--api-token-env <name>` | With `--openapi`: send `$name` as a bearer token. |

## Serving

| Option | |
| --- | --- |
| `-p, --port <n>` | Port to listen on. Default 4111. |
| `--host <addr>` | Interface to bind. Default `127.0.0.1`, loopback only; anything wider prints a warning. |
| `--open` | Open a browser once the server is up. |
| `--allowed-host <name>` | Also answer for this `Host` header; repeatable. Needed behind a proxy, or in a container reached by name. |
| `--base-path <path>` | The path a reverse proxy serves tablewalk under, such as `/tools`. |

## Behind a proxy

See [Deploying](/docs/deploying/#behind-a-proxy) for when you need these.

| Option | |
| --- | --- |
| `--auth-proxy-header <name>` | The header a signing-in proxy sets with the user, such as `X-Forwarded-User`. Requests from beyond loopback must carry it, and every write is journaled with it. |
| `--auth-proxy-from <address\|CIDR>` | A peer beside loopback whose auth header is believed: the proxy's own address. |
| `--trust-proxy <address\|CIDR>` | A proxy whose `X-Forwarded-For` is believed about the client's address. Repeatable or comma-separated; loopback is always trusted. Not sign-in. |
| `--trust-proxy-hops <n>` | Behind a managed front end with no address to name: how many proxies append to `X-Forwarded-For`. |
| `--trust-proxy-cloudflare` | Read `CF-Connecting-IP` as the client. Only when the server is reachable through Cloudflare alone. |

## PostgreSQL and shutdown

| Option | |
| --- | --- |
| `--read-pool <n>` | Connections that may read at once, per database. Default 4, at most 64. |
| `--lock-timeout <s>` | Seconds a write waits for a row another transaction holds before it is refused. Default 5. |
| `--pooler <mode>` | `session` (default), or `transaction` behind PgBouncer in transaction mode or RDS Proxy. |
| `--drain-delay <s>` | Seconds `/readyz` answers 503 on SIGTERM before the listener closes. Default 0. |
| `--shutdown-grace <s>` | Seconds an unfinished response may hold the process after the drain. Default 10. |

## Agents

| Option | |
| --- | --- |
| `--mcp` | Speak MCP on stdio instead of serving HTTP. |
| `--lazy` | With `--mcp`: answer handshake and `tools/list` before dialing the database (automatic for piped `--config -`). |
| `--tools <name>` | One job's worth of tools: `explore`, `migrate`, `seed` or `full` (the default). |
| `--output-schema` | Advertise each tool's output shape. Off by default. |
| `--query <q>` | Run one query or breakdown in the query language, print the result, close all connections, and exit. |
| `--call <tool>` | Run one MCP tool by name, print the result, close all connections, and exit. |
| `--args <json>` | With `--call` or `--query`: JSON object of tool arguments. |
| `--batch [path\|-]` | Run newline-delimited queries, breakdowns or JSON `{"tool","args"}` calls over one session, print NDJSON, close all connections, and exit. |
| `--all-envs` | With `--query`, `--call` or `--batch`: run a read-only call across every environment of the target database in parallel. |
| `--format <fmt>` | With `--query`, `--call`, `--batch` or `--check`: output format (`json`, `ndjson`, `tsv` or `md`). |

## Checking connections and schemas

These print and exit, so they fit in CI and vault preflight scripts.

| Option | |
| --- | --- |
| `--check` | Dial configured connections (or the target `--connection` / `--env`), verify credentials and guardrails, print a readiness matrix (`--format json` or `md`), and exit. |
| `--export <fmt>` | The schema as `md`, `mermaid`, `json`, or `agent` (a compact operational brief for `CLAUDE.md` / `AGENTS.md`). |
| `--lint [fmt]` | What the shape will cost (missing keys, unindexed references, naive timestamps), as text or `json`. |
| `--fail-on <sev>` | With `--lint`: exit non-zero when a finding is at least `high`, `medium` or `low`. |
| `--diff <conn>` | Compare the active connection's shape with this one. Exits 1 when they differ, like `diff`. |

```sh
npx tablewalk --config ./tablewalk.json --check --format md
npx tablewalk "$DATABASE_URL" --lint --fail-on high
```

## migrate

Versioned SQL files in Flyway's format, forward only, for PostgreSQL and SQLite.

```sh
tablewalk migrate new add_payoff_quote   # writes the next V file
tablewalk migrate up                     # applies what is pending
```

| Command | Does |
| --- | --- |
| `new <name>` | Writes the next `V` file; with `--repeatable`, an `R__` file that runs again whenever it changes. |
| `status` | What is applied, what is pending, and changes made outside migrations. |
| `up` | Applies pending files in version order, each in its own transaction. |
| `validate` | Fails on a changed, missing, failed or pending file, or on drift. |
| `baseline` | Records an existing database as version 0, touching nothing. |
| `repair` | Removes failed entries, accepts changed files, marks missing ones deleted. |
| `diff <name>` | Writes the next `V` file: what the migrations lack to build `schema.sql`. |
| `check` | Fails (exit 2) when the migrations, applied to a scratch database, do not build `schema.sql`. |
| `squash` | Folds the `V` files into one `V1__baseline.sql`, before a database worth keeping exists. |

| Option | |
| --- | --- |
| `--migrations <dir>` | Where the files are. Default `migrations/`, or the connection's `"migrations": { "dir" }`. |
| `--history-table <name>` | The history table. Default `__mistri_schema_history`; `flyway_schema_history` takes over from Flyway. |
| `--connection <name>` | With several connections: which one. |
| `--dry-run` | With `up`, `baseline` or `repair`: print what would run and change nothing. |
| `--tool flyway` | Run the command with an installed Flyway instead, over the same files and history. |
| `--repeatable` | With `new`: an `R__` file. |
| `--schema-file <path>` | With `diff`, `check` or `squash`: the schema you want. Default `schema.sql` beside the migrations. |
| `--dev-url <url>` | With `diff`, `check` or `squash` on PostgreSQL: where two scratch databases are made and dropped (needs `CREATEDB`). |

`diff`, `check` and `squash` use Atlas's community build, pinned and checked by sha256, fetched on first use into `.tablewalk/bin`. A run holds a lock, so two deploys never migrate at once. `up`, `baseline` and `repair` write to the database, so they run only on a connection whose config says `"writable": true`; a database named on the command line is always read-only. `status`, `validate`, `diff`, `check`, `squash` and `new` do not need it, and neither does `--dry-run`. Exit codes: 1 could not run, 2 files and history disagree, 3 a migration failed.

## seed

```sh
tablewalk seed --config tablewalk.json --rows 100
```

Fills every table, parents before children, keeping `CHECK` values, keys, `NOT NULL` and unique columns valid. Statuses are spread over their states, dates fall across the last 90 days, and names, emails (`example.com`) and phone numbers (`555-01xx`) come from a small word list. It writes only to a connection marked `"writable": true`.

| Option | |
| --- | --- |
| `--rows <n>` | Rows per main table. Default 40. |
| `--seed <n>` | The same rows again, on the same day. |
| `--append` | Add to tables that already hold rows; otherwise a table with rows is refused. |

Exit codes: 1 could not run, 2 refused (read-only, or rows already there).

## journal

```sh
tablewalk journal --config tablewalk.json --connection shop
```

Makes the store that keeps a writable connection's [Undo](/docs/writing/#undo) history: two reserved tables in its database. With them, Undo and the MCP `revert` still reach the writes made before a restart, the last 50 per connection for 7 days. Opening a connection never makes them, and running the command again changes nothing. It works only on a connection marked `"writable": true`.

Exit codes: 1 could not run, 2 refused (read-only, or an HTTP API).

## Version and help

| Option | |
| --- | --- |
| `-h, --help` | The short help; `--help all` prints everything. |
| `-v, --version` | Print the version. |

## Environment

| Variable | |
| --- | --- |
| `DATABASE_URL` | One connection, when no config names any. |
| `TABLEWALK_CONFIG_JSON` | Inline JSON config in memory (for vault wrappers), when `--config` is not passed. |
| `TABLEWALK_BLOCKLIST`, `TABLEWALK_BLOCKED_TABLES`, `TABLEWALK_BLOCKED_FIELDS` | Blocklist JSON or comma-separated table and `table.field` wildcards, without a config file. |
| `TABLEWALK_REDACT`, `TABLEWALK_REDACT_COLUMNS`, `TABLEWALK_MAX_ROWS`, `TABLEWALK_LEASE` | Deterministic PII redaction, extra redacted columns, session row-egress ceiling, and connection lease duration. |
| `TABLEWALK_TIMEOUT_MS`, `TABLEWALK_FOCUS`, `TABLEWALK_FOCUS_HOPS`, `TABLEWALK_CREDENTIAL_COMMAND`, `TABLEWALK_AUDIT_LOG` | Per-call statement deadline, foreign-key neighborhood table focus, dynamic credential refresh command, and zero-PII JSONL audit log path or `stderr`. |
| `TABLEWALK_MCP_URL` | With `--mcp`: bridge stdio MCP calls to a running loopback server (`http://localhost:4111/mcp`). |
| `PORT` | The port, when no `--port` is given, as Cloud Run and most platforms set it. |
| `TABLEWALK_CONFIG`, `TABLEWALK_HOST`, `TABLEWALK_PORT` | In the [container image](/docs/deploying/) only: the config file, interface and port. |
| `TABLEWALK_ALLOWED_HOSTS` | Extra `Host` names, comma-separated. |
| `TABLEWALK_BASE_PATH` | The same as `--base-path`. |
| `TABLEWALK_AUTH_PROXY_HEADER`, `TABLEWALK_AUTH_PROXY_FROM` | The same as their flags. |
| `TABLEWALK_TRUST_PROXY`, `TABLEWALK_TRUST_PROXY_HOPS`, `TABLEWALK_TRUST_PROXY_CLOUDFLARE` | The same as their flags. |
| `TABLEWALK_READ_POOL`, `TABLEWALK_POOL_IDLE`, `TABLEWALK_LOCK_TIMEOUT`, `TABLEWALK_POOLER` | Pool size, idle window (1 to 86400 seconds), lock timeout and pooler mode. |
| `TABLEWALK_DRAIN_DELAY`, `TABLEWALK_SHUTDOWN_GRACE` | The same as their flags. |
| `TABLEWALK_DIAGNOSTICS=1` | Request diagnostics as JSON lines on stderr, with `X-Request-ID` headers. No URLs, bodies, SQL or identities. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Turns on OpenTelemetry traces, metrics and logs over OTLP/HTTP, with the other standard `OTEL_*` variables. No row values or SQL parameters are sent. |
| `XDG_CONFIG_HOME` | Where layouts, pages, credentials and the fallback config live. Default `~/.config`. |

`GET /healthz` and `/readyz` answer an orchestrator, under `--base-path` like every route.

## Apps are mistri's

tablewalk is the database browser. An App (pages, commands and policies over a database) is served by mistri. `tablewalk --app <dir>` is refused and names the command to run instead: `npx @mistriwork/mistri --app <dir>`.
