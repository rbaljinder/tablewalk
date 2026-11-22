---
title: Browsing
description: Tables, records and the walk between them. Every foreign key is a link, in both directions, and every place has an address you can share.
---

In tablewalk a foreign key is a place you can go: from an invoice to its customer, and from the customer back to all of its invoices.

![A customer record: its fields, its invoices listed under them, and a Related rail counting every table that points at it](/shots/record.webp?v=3)

## A table

Click a table in the sidebar, or type its name in the query bar. The grid shows its rows, newest first where an indexed column allows it, and the sidebar scope bar above the table list filters between **All**, **Tables** and **Views** (plus **Focused** when `--focus` is active).

![The invoice table queried as "invoice total >= 500 sort total desc", with the query's parts as chips and inline quick filters above the grid](/shots/query.webp?v=3)

- **Quick filters** sit in one compact inline strip above the grid (`Filters` in the tab bar folds or unfolds them to give more vertical room to rows). The parts of the current query show as chips, and **+ Save this filter** keeps it as a view.
- **A column header** opens a menu: pin the column, sort (tinted in cobalt when active), filter by equals, greater than, less than, between, is empty or is not empty, open **Profile column…** (a floating popover with null share, distinct count, min/max range, and clickable top values that add an equality filter), open **Change impact…** (null count, index status, incoming foreign keys with `ON DELETE` rules, and migration consequences before altering or dropping), or — on a single-column foreign key — pick **Show from `<table>`** (`+ <fk>.<col>`) to pull a referenced column straight into the grid. Columns masked by `"redact": true` or `redactColumns` carry a `masked` pill in the header.
- **▸** at the start of a row expands it in place. Click the row to open its record.
- **Export** downloads CSV or JSON for this page or for every matching row, or lets you choose the columns first. **Agent: Copy this position** copies the place you are in for a coding agent.
- The pager sets how many rows a page holds.

![Profiling the status column on invoice: null percentage, distinct values, and clickable top value chips](/shots/profile.webp?v=4)

A table has tabs. **Rows** is the grid. **Definition** shows the table's stored DDL as the database holds it. **Diagram** draws the table with the tables it points at and the ones that point at it.

## A record

A record shows the row's fields (with a `masked` badge beside any field redacted on the connection). A foreign key value is a link to the row it names, with that row's table beside it. Under the fields, the rows that point at this one are listed by table, and the **Related** rail counts each table and the column it points through ("via invoice_id"), with the empty ones folded away. Click any of them to keep walking.

On a record:

- **Layout** arranges the record: which sections show, in what order, and how many related rows each list holds. See [Pages and layouts](/docs/pages/).
- **As a page →** opens the record as a [page](/docs/pages/), with its related lists as tabs.
- **Extract fixture…** walks foreign keys from this record (and optionally its child rows) in topological insert order, with a **Mask PII** toggle (`redact: true`), switching between ready-to-paste **SQL INSERTs** and **`insert_graph` JSON**.
- **Compare envs** (shown when sibling environments exist for the active database) reads the same primary key across every tier in parallel and renders a side-by-side field matrix highlighting missing rows and differing cell values.
- **Copy for agent** copies a short Markdown brief: the row, its table's columns, the path you took to it, and the [MCP](/docs/mcp/) call that reads it again.

## Walking back

Each step is kept on a trail, shown above the record, and **Back** returns along it. `Backspace` (or `⌘[`) steps back one place. Opened from a list, a record steps through that list with `j` and `k`, or with the arrows beside its name, in the list's order and past the end of its page. In the grid, `Space` glances at a row's record without leaving the list. All the keys are on [Keyboard](/docs/keyboard/).

## Checking the shape, live health and join paths

**Check the shape** (`⌘K`, the `···` menu, or **Check shape & perf** / **Join paths** on the home page) opens a diagnostics dialog over the active connection:

![Checking the shape of the sample database: schema findings with inline CREATE INDEX statements and Open in SQL](/shots/shapecheck.webp?v=3)

- **Schema & perf** runs the static catalog `lint`: keyless tables, unindexed foreign keys, references without an `ON DELETE` rule, and timestamps without a zone — with ready-to-run `CREATE INDEX` statements you can copy or **Open in SQL**.
- **Index & scan health** inspects live database statistics (`pg_stat_user_tables`, `pg_stat_user_indexes`, `pg_stat_activity`, `pg_locks` and `pg_blocking_pids` on PostgreSQL; `PRAGMA index_list`, `EXPLAIN QUERY PLAN` and `sqlite_stat1` on SQLite) to flag sequential-scan hotspots, unused or duplicate indexes, table bloat, stale planner stats, blocked lock waiters and long-running or idle-in-transaction sessions.
- **Data anomalies** runs bounded count-only checks for inverted timestamps (`shipped_at < created_at`), dangling soft-delete lifecycles, negative unsigned business measures (`total`, `quantity < 0`), future-dated audit timestamps (`created_at > tomorrow`), and nullable foreign keys that are almost always populated except for outlier rows.
- **Join paths** finds the shortest `to-one` and `to-many` routes between any two tables, marks whether each hop is indexed, and generates a `SELECT … JOIN …` statement you can copy or **Open in SQL**.
- **Environment drift** (when sibling environments exist) compares the active schema against any sibling tier (`staging`, `prod`) and generates directional draft `ALTER TABLE` migration SQL you can copy or **Verify in SQL**.

**Find a value** (`⌘K` or the `···` menu) sweeps text columns — and UUID columns when the input is a UUID — across every readable table, grouped by table with links straight to matching records.

## Addresses

Every place has an address in the path, so you can bookmark it or send it to someone with access to the same server. The first segment is the connection's name.

| Address | Opens |
| --- | --- |
| `/demo/customer` | the customer table |
| `/demo/customer/~42` | customer 42 |
| `/demo/customer/~42/~invoice:9` | invoice 9, reached from customer 42 |
| `/demo/customer!diagram` | a table's tab: `!rows`, `!ddl` or `!diagram` |
| `/demo/invoice%20total%20%3E%20500` | a query, written in the path |
| `/demo/@customer~42` | customer 42 as a [page](/docs/pages/) |

A composite key names each part: `/demo/invoice_line/~invoice_id=1001,line_no=2` (the browser shows it percent-encoded). The same list is in the app under `?` → **Links you can write**.

## Good to know

- On PostgreSQL the row counts in the sidebar are the catalog's estimates, so a large table costs nothing to list.
- A value larger than JavaScript can hold exactly (an id past 2^53) is shown as the database returned it, never rounded.
