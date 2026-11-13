---
title: MCP for coding agents
description: tablewalk speaks the Model Context Protocol on stdio, giving a coding agent the schema, the rows and the walk between them, under the same read-only rules as the page.
---

`--mcp` gives a coding agent the same database you browse, over the Model Context Protocol on stdio.

```sh
npx tablewalk ./data/app.db --mcp
```

<!-- Remove with the next note once the browser-only release is published. -->
> Until the browser-only release is published, `npx tablewalk@next` is the current build.

## Connecting an agent

Most clients take a server as a command and its arguments:

```json
{
  "mcpServers": {
    "tablewalk": { "command": "npx", "args": ["tablewalk", "--mcp", "--config", "./tablewalk.json"] }
  }
}
```

Or name one database instead of a config file: `"args": ["tablewalk", "--mcp", "--db", "postgres://localhost/app"]`. In Claude Code:

```sh
claude mcp add tablewalk -- npx tablewalk --mcp --db postgres://localhost/app
```

Every answer carries a `link` the person beside the agent can open in the page, and says what it cost in rows and milliseconds. To see exactly what an agent receives, open **Agent console** from the `···` menu or `⌘K`: it runs the same tools by hand and shows each answer with its size in tokens.

![The Agent console running the record tool on customer 1, with the answer and its cost](/shots/agent.webp)

## The tools

Twenty-three tools: seventeen read-only, and six writes that are listed only when a connection is `"writable": true`. Every tool also takes `connection` when there is more than one.

### Reading

| Tool | What it answers | Example arguments |
| --- | --- | --- |
| `connections` | The configured connections: name, dialect, table count. The call to start with. | `{}` |
| `refresh` | Re-reads a connection's schema after a migration. | `{}` |
| `schema_summary` | Orientation in one call: the hubs, the event tables, the join tables, the deepest chain of references. | `{}` |
| `tables` | Every table with its column count, approximate rows, and whether it is a view. | `{}` |
| `table` | One table in full: columns, keys, DDL, and its foreign keys in both directions. | `{"table": "invoice"}` |
| `find` | Where a name or a value lives, across every table and column. | `{"value": "Harbour Freight"}` |
| `query` | Rows from the [query language](/docs/query/), a total, and the SQL it compiled to. | `{"q": "invoice total > 500 sort total desc", "limit": 10}` |
| `breakdown` | Counts and sums grouped by something. | `{"q": "invoice count by status"}` |
| `record` | One row, its human name, and everything that points at it. | `{"table": "customer", "key": {"id": 1}}` |
| `sql` | A read-only `SELECT` for what the language cannot say. | `{"statement": "select status, count(*) from invoice group by 1", "timeout_ms": 2000}` |
| `explain` | The planner's account of a statement, without running it. | `{"statement": "select * from invoice where customer_id = 1"}` |
| `profile` | What a table's columns hold: null share, distinct count, range, common values. | `{"table": "invoice"}` |
| `diff` | How two connections' shapes differ: tables, columns, types, keys, delete rules. | `{"from": "staging", "to": "production"}` |
| `order` | What has to exist first: tables in insert order, and the reverse for teardown. | `{"tables": ["invoice_line", "customer"]}` |
| `fixture` | One real row and everything it needs to exist, ready for `insert_graph`. | `{"table": "invoice", "key": {"id": 1001}, "children": true}` |
| `lint` | What the shape will cost: keyless tables, unindexed foreign keys, naive timestamps. | `{"severity": "high"}` |
| `change_impact` | What breaks if a table or column changes, asked before writing the migration. | `{"table": "customer", "column": "email"}` |

### Writing

Listed only when a connection is `"writable": true`, and refused on any other connection.

| Tool | What it does | Example arguments |
| --- | --- | --- |
| `update` | Sets columns on exactly one row, named by its whole primary key. | `{"table": "invoice", "key": {"id": 1001}, "set": {"status": "paid"}}` |
| `insert` | Adds one row and answers with what the database stored. | `{"table": "country", "values": {"code": "IS", "name": "Iceland"}}` |
| `delete` | Removes one row in two calls: the first reports what points at it, the second confirms. | `{"table": "invoice", "key": {"id": 1001}, "confirm": true}` |
| `insert_graph` | Inserts related rows in one transaction, all or none. A row names its parent by label. | `{"rows": [{"table": "customer", "as": "c1", "values": {"name": "Dry Creek"}}, {"table": "invoice", "values": {"customer_id": {"ref": "c1"}, "invoice_date": "2026-11-02", "total": 99.5}}]}` |
| `delete_graph` | Removes several rows in one transaction, children first. | `{"rows": [{"table": "invoice", "key": {"id": 1908}}], "confirm": true}` |
| `revert` | Shows the last write, then undoes it when confirmed with that preview's id. | `{"confirm": true, "expectedId": 12}` |

`delete` and `delete_graph` ask the person directly when the client supports it (MCP elicitation), and then ignore a `confirm` the model supplies. `insert_graph` and `delete_graph` are not journaled, so `revert` cannot undo them; `delete_graph` with the `teardown` an insert returned is the way back. A raw SQL write has no undo.

## Fewer tools for one job

`--tools` lists one job's worth of tools, which makes the listing an agent pays for on connect smaller. A profile only removes tools, and is enforced on every call, not only in the listing.

| Profile | Tools |
| --- | --- |
| `explore` | connections, refresh, schema_summary, tables, table, find, query, breakdown, sql, record, explain, profile |
| `migrate` | connections, refresh, schema_summary, tables, table, change_impact, lint, order, diff, profile, explain |
| `seed` | connections, refresh, schema_summary, tables, table, order, fixture, record, query, insert, insert_graph, delete_graph, revert |
| `full` | all of them (the default) |

`--output-schema` adds each tool's output shape to the listing. It is off by default because it doubles the listing's size, and the answers carry the same fields either way.

## Prompts and resources

Three prompts: `orient`, `pre-migration-check` (takes `tables`) and `investigate-row` (takes `table`). Resources an agent can read without running anything:

- `tablewalk://{connection}/schema`, the schema brief
- `tablewalk://{connection}/table/{table}`, one table
- `tablewalk://{connection}/queries`, the named SQL in your config file
- `tablewalk://{connection}/pages`, page definitions from the config file and pages saved from the browser

## When a call fails

A failed call is a normal result with `isError: true` and a sentence a model can act on. The sentence is for reading; to branch on it, read the `_meta` of the result, where `tablewalk/code` is one of:

| Code | Means | Usually |
| --- | --- | --- |
| `read_only` | the connection is not `"writable": true` | the operator's to change |
| `not_found` | a table, connection or tool that does not exist | ask `tables` or `connections` |
| `timeout` | the statement ran into its 30-second cap | ask a narrower question |
| `cancelled` | the client withdrew the call | nothing; it is over |
| `invalid_argument` | an argument is wrong, missing or contradicts another | fix the call |
| `forbidden` | not allowed here: a tool outside `--tools`, one of tablewalk's own tables, a capability the dialect lacks | do not retry |
| `limit` | past a bound the tool sets, such as more than 20 keys in one call | take less |
| `internal` | anything else, the database's or the server's | read the sentence |

```json
{ "isError": true, "content": [{ "type": "text", "text": "Cancelled: …" }], "_meta": { "tablewalk/code": "cancelled" } }
```

## Limits

- Rows that enter an agent's context leave your machine. Point agents at development databases, or mark a connection `"rows": false` so only the shape answers. When every connection is shape-only, `query`, `sql`, `record` and `breakdown` are not listed at all. When every connection [hides columns](/docs/connections/#a-connections-fields), `sql` and `explain` are not listed.
- A statement runs under a 30-second cap; `sql` takes `timeout_ms` to lower it (at least 100). A client that cancels a call stops its statement.
- Totals from `query` and `breakdown`, and counts on `record`, stop at 10,000 and say so.
- `sql` and `explain` refuse statements that touch tablewalk's own tables (`__mistri_*`, the `mistri` schema, `__tablewalk_*`, `tablewalk_auth`).
