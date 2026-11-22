---
title: Connections and config
description: Name several databases in a tablewalk.json, keep passwords out of it, and control what each connection may show and do.
---

A `tablewalk.json` names the databases tablewalk can open, and how far each one may be read or written.

```json
{
  "connections": [
    { "name": "app (local)", "url": "postgres://localhost/app", "schemas": ["public"], "writable": true },
    { "name": "production",  "url": "postgres://reader:${PROD_PASSWORD}@prod/app", "rows": false },
    { "name": "cache",       "url": "./var/cache.sqlite" }
  ]
}
```

tablewalk looks for `./tablewalk.json`, then `./.tablewalk.json`, then `$XDG_CONFIG_HOME/tablewalk/connections.json`. `--config <path>` names a file, and `--no-config` ignores them all. A relative path in the file is read from the file's folder.

Connections appear in the picker at the top of the page, and each opens when it is first used, so naming eight databases does not dial eight databases. Connections that share a logical `database` (declared with `"database"` and `"env"`, or inferred from names like `app-local`, `app_staging`, `app (prod)`) form a segmented environment switcher in the top bar that preserves your current table, query or record as you switch tiers, plus **Compare envs** in the SQL editor and **All envs** fan-out in the Agent console. The browser is sent a name, a dialect and a redacted address, never a password.

## A connection's fields

| Field | What it does |
| --- | --- |
| `name` | The name in the picker, and the first segment of every [address](/docs/browsing/#addresses). |
| `url` | A SQLite path (`.db`, `.sqlite`, `.sqlite3`, `sqlite:<path>`) or a `postgres://` URL. |
| `database` / `env` | Optional logical database group (`"billing"`) and environment (`"local"`, `"staging"`, `"prod"`), grouping sibling environments across the UI and MCP (`billing@staging`). |
| `schemas` | PostgreSQL only: the schemas to read. All user schemas when left out. |
| `writable` | `true` allows [writes](/docs/writing/) on this connection. Off by default, and enforced by the server. |
| `rows` | `false` makes the connection shape-only: the catalog, counts, plans and lint answer, and anything that would return a value from a row is refused. |
| `hidden` | Columns to leave out everywhere, by table: `{ "account": ["password_hash"], "*": ["*_token"] }`. A query naming one is refused, and so is raw SQL on that connection. |
| `blocklist` | Tables and fields withheld from agents and queries: `{ "tables": ["audit_*", "*_secrets"], "fields": { "*": ["*_token"], "customer": ["tax_id"] } }` (top-level, per `environments` tier, or per connection). Blocked tables, database SQL views (`CREATE VIEW`), blocked fields and foreign keys touching them disappear from the catalog and are refused across every tool, configured view and write; `sql`, `explain` and `verify_ddl` are withheld and refused. |
| `redact` / `redactColumns` | `true` deterministically and idempotently masks emails, phones, names, addresses, tokens and any extra `redactColumns` (`["notes", "customer.ssn"]`) on every row read (`query`, `views`, `breakdown`, `profile`, `record`, `find`, `fixture`, `export`) while withholding raw `sql`, `explain` and `verify_ddl`. |
| `maxRows` | Session row-egress ceiling per connection (`5000`): clamps per-call limits to the remaining budget and refuses further row reads with `limit` once exhausted. |
| `timeoutMs` | Per-call statement deadline in milliseconds (`2500` or `"2.5s"`), top-level, per `environments` tier, or per connection. |
| `focus` / `focusHops` | Scope a connection's catalog, queries, views, records, exports and writes to `focus` tables (`["invoice", "customer"]`) and their N-hop foreign-key neighborhood (`focusHops`, `0` to `5`, default `1`), withholding unrelated tables and raw SQL. |
| `credentialCommand` | Shell command executed on the operator's machine before opening or re-opening an idle-evicted connection (`"vault kv get -format=json secret/db"`), returning JSON (`{ "secrets": { ... } }` or `{ "KEY": "VALUE" }`) or `.env` lines into isolated in-memory `${VAR}` expansion without touching `process.env` or disk. |
| `lease` | Bound connection lifetime (`120`, `"5m"`, or `{ "idleSeconds": 30, "maxSeconds": 300, "exitOnExpire": true }`), top-level, per `environments` tier, or per connection: lowers PostgreSQL `minIdle` to `0`, closes idle adapters after `idleSeconds`, and expires the session at `maxSeconds`. |
| `pool` | PostgreSQL only: `{ "read": 8, "idleSeconds": 300, "minIdle": 2 }` (`read` 1 to 64, default 4; `idleSeconds` 1 to 86400, default 300 or `TABLEWALK_POOL_IDLE`; `minIdle` 0 to 64, default 2 warm readers). |
| `replicas` | PostgreSQL only: read replica URLs. Lists and counts read from them in turn; a record, every write and the catalog stay on the primary. |
| `backstop` | Leave it out. `"rls"` marks a connection that signs in as a tenant App's restricted role, which sees no tenant row, so tablewalk refuses it at start (and `tablewalk journal` and `--mcp` with it), by name. Use the owner's URL instead. |
| `migrations` | Where `tablewalk migrate` finds its files: `{ "dir": "db/migrations", "table": "flyway_schema_history" }`. |

A top-level `"environments"` object (`"local"`, `"dev"`, `"test"`, `"staging"`, `"replica"`, `"prod"`, or custom `env` names) sets shared `writable`, `rows`, `lease`, `blocklist`, `redact` / `redactColumns`, `maxRows`, `timeoutMs` and `focus` / `focusHops` defaults across every connection in that tier, with explicit per-connection fields taking precedence.

`rows`, `hidden`, `blocklist`, `focus`, `redact`, `maxRows` and `timeoutMs` are enforced at the adapter and registry, so the page, the export and every [MCP](/docs/mcp/) tool obey them at once. A database role without `SELECT` on a table or column is stronger still.

A config can also be piped from a secret vault with `--config -`, `--config <(vault ...)`, or `TABLEWALK_CONFIG_JSON`, carrying in-memory `"secrets"` or `"dotenv"` variables (or `"credentialCommand"` / `TABLEWALK_CREDENTIAL_COMMAND`) that resolve `${VAR}` placeholders without touching `process.env`, the keychain or disk, or reinforced with `TABLEWALK_BLOCKLIST`, `TABLEWALK_BLOCKED_TABLES`, `TABLEWALK_BLOCKED_FIELDS`, `TABLEWALK_REDACT`, `TABLEWALK_REDACT_COLUMNS`, `TABLEWALK_MAX_ROWS`, `TABLEWALK_TIMEOUT_MS`, `TABLEWALK_FOCUS` and `TABLEWALK_LEASE`.

## Passwords

A connection string is a credential, so tablewalk tries not to hold one. A password can come from four places, tried in this order:

| Where | How |
| --- | --- |
| Environment | `"url": "postgres://app:${PROD_PASSWORD}@db/app"`. An unset variable stops the server rather than sending an empty password. |
| macOS keychain | Looked up by connection name, through the built-in `security` tool. |
| Credentials file | `$XDG_CONFIG_HOME/tablewalk/credentials.json`, refused unless its mode is `0600`. |
| Inline in the URL | Works, and the page warns about it, because it ends up in shell history. |

A connection added from the page stores its password in the keychain (or the `0600` file), never in the saved URL, so the connection list can be shared.

## Adding a connection from the page

Open **Connections…** from the `···` menu, or the gear beside the connection picker, to add, edit or remove a connection and save the list to a file. Changes apply to the running session until you save.

On loopback the page is trusted as the operator: a URL may use `${VARIABLES}`, a password may come from the keychain, and a SQLite file may be opened by path. When the server is bound beyond loopback or answers to an `--allowed-host` name, none of that is accepted from the page: a URL is used exactly as written, a private or loopback host is refused, a connection from the config file cannot be pointed elsewhere, and nothing is saved. Put those connections in `tablewalk.json` on the server instead.

## Saved SQL

The same file can carry named SQL statements, offered above the SQL editor and in `⌘K`:

```json
{ "queries": [{ "name": "Customers over their limit", "connection": "app (local)",
                "sql": "select c.name, sum(i.total) as invoiced from customer c join invoice i on i.customer_id = c.id group by c.id having sum(i.total) > c.credit_limit" }] }
```

Leave out `connection` to offer the statement on every database. A statement from the file is marked **Defined in tablewalk.json** and cannot be deleted from the page. The file can also carry `views`, `pages` and `layouts`: see [Pages, layouts and views](/docs/pages/#sharing-them-with-a-team).

## An API instead of a database

`--openapi <spec>` reads a REST API that has an OpenAPI 3 spec, drafting a description of its lists and items in memory. `--api-url` sets the base URL when the spec does not give a usable one, and `--api-token-env <NAME>` sends `$NAME` as a bearer token. It is read-only, and filters, sorting and paging are only those the API documents.

```sh
npx tablewalk --openapi https://api.example.com/openapi.json --api-token-env API_TOKEN
```
