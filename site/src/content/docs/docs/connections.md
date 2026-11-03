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

Connections appear in the picker at the top of the page, and each opens when it is first used, so naming eight databases does not dial eight databases. The browser is sent a name, a dialect and a redacted address, never a password.

## A connection's fields

| Field | What it does |
| --- | --- |
| `name` | The name in the picker, and the first segment of every [address](/docs/browsing/#addresses). |
| `url` | A SQLite path (`.db`, `.sqlite`, `.sqlite3`, `sqlite:<path>`) or a `postgres://` URL. |
| `schemas` | PostgreSQL only: the schemas to read. All user schemas when left out. |
| `writable` | `true` allows [writes](/docs/writing/) on this connection. Off by default, and enforced by the server. |
| `rows` | `false` makes the connection shape-only: the catalog, counts, plans and lint answer, and anything that would return a value from a row is refused. |
| `hidden` | Columns to leave out everywhere, by table: `{ "account": ["password_hash"], "*": ["*_token"] }`. A query naming one is refused, and so is raw SQL on that connection. |
| `pool` | PostgreSQL only: `{ "read": 8 }` connections that may read at once (default 4, at most 64). |
| `replicas` | PostgreSQL only: read replica URLs. Lists and counts read from them in turn; a record, every write and the catalog stay on the primary. |
| `migrations` | Where `tablewalk migrate` finds its files: `{ "dir": "db/migrations", "table": "flyway_schema_history" }`. |

`rows` and `hidden` are enforced at the adapter, so the page, the export and every [MCP](/docs/mcp/) tool obey them at once. A database role without `SELECT` on a column is stronger still.

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
