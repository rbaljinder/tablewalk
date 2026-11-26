---
title: Getting started
description: Open a SQLite file or a PostgreSQL database in tablewalk with one command, and find your way around the first page.
---

tablewalk is one command that serves a database browser on your own machine.

```sh
npx tablewalk ./data/app.db
```

<!-- Remove with the next note once the browser-only release is published. -->
> Until the browser-only release is published, `npx tablewalk@next` is the current build.

It needs Node.js 24.22.1 or newer, and there is no build step. The server prints the address it listens on, `http://localhost:4111` by default, bound to `127.0.0.1` so nothing beyond your machine can reach it.

## What you can open

| You type | What it opens |
| --- | --- |
| `npx tablewalk` | Nothing yet: the page asks for a connection |
| `npx tablewalk --demo` | A throwaway sample database in your temp directory, opened in a browser |
| `npx tablewalk ./app.db` | A SQLite file (`.db`, `.sqlite`, `.sqlite3`, or `sqlite:<path>`) |
| `npx tablewalk ./dump.sql` or `./exports/` | A `.sql` dump, or `.csv` / `.tsv` / `.ndjson` files and folders hydrated into an ephemeral read-only SQLite database with inferred keys and `<stem>_id` foreign keys |
| `npx tablewalk postgres://user@host:5432/db` | A PostgreSQL database (`postgresql://` works too) |
| `npx tablewalk --db "$DATABASE_URL"` | The same, as a flag; `DATABASE_URL` alone works when no config names connections |
| `npx tablewalk --config team.json` | Every connection a [config file](/docs/connections/) lists |

SQLite (plus `.sql`, CSV/TSV and NDJSON exports) and PostgreSQL are the databases tablewalk reads. MySQL and MariaDB are refused with a message that says so.

Add `--open` to have it open your browser, and `--port <n>` to listen somewhere other than 4111.

## With no database named

Run `npx tablewalk` alone and the page offers the sample database or a form to connect one. A connection added here is read-only. Only a [config file](/docs/connections/) can make one writable.

![The welcome page: "Follow the data", with buttons to open the sample database or connect one](/shots/connect.webp?v=6)

## The first page

Once a database is open, the home page reads the schema for you: the tables it centers on, the ones that record events, the longest chain of references, and starter tables to walk from, alongside one-click launchers for **Check shape & perf** and **Join paths**. Under that is an interactive entity diagram of every table and foreign key — hover any table card to illuminate its foreign-key neighborhood. The sidebar filters by **All**, **Tables** or **Views** with approximate row counts, and the query bar at the top takes [a question in one line](/docs/query/).

![The home page of the sample database: what the schema centers on, the sidebar of tables, and the query bar](/shots/home.webp?v=6)

From here:

- Click a table to see its rows, then a row to see [the record and everything related to it](/docs/browsing/).
- Click **Check shape & perf** or **Join paths** (or press `⌘K`) to inspect missing foreign-key indexes, live scan and index health, data anomalies, and shortest multi-hop joins.
- Press `⌘K` to jump to any table, page, sibling environment or recent query.
- Press `?` for the query language, with examples that run against your own tables.
- Press `⌘⇧↵` (or click **SQL**) to open the syntax-highlighted SQL workbench with schema-aware autocomplete, `.sql` folder workspaces, inline `:param` inputs, and execution plans.
- Choose **Preferences** in the `···` menu for the look: **Folio** (warm archival paper and deep forest-green links) by default, with **Instrument** (Stone, Graphite, Fog, Slate, Ink), **Braun**, **Broadsheet**, **Obsidian**, **Gallery**, **Lumen** and more, light or dark.
- Choose **Take the tour** in the `···` menu for a short walk through the screen.

## Next

- [Browsing](/docs/browsing/): tables, records, and walking between them.
- [Query language](/docs/query/): filters, paths through foreign keys, counts and dates.
- [MCP](/docs/mcp/): the same database for a coding agent.
