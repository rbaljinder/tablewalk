---
title: Pages, layouts and views
description: Keep the work you build in tablewalk. Saved filters and views, record layouts, and pages that gather a record with everything around it.
---

Keep what you build in tablewalk: a filter under a name, a view across tables, a record laid out the way you read it, or a page.

## Saved filters

A query on a table can be kept under a name. Click **+ Save this filter** beside the chips above the grid and name it: it becomes a tab beside **All** at the top of the table. Saved filters live in this browser.

## Views

A view is one row per record of a table, with columns from any table it points at, and counts or sums of the rows that point back at it. Open **Views…** from the `···` menu: choose the table to start from, **Add** a related table to bring in its fields, tick the fields you want, count or summarize a child table, and write a `where` in the [query language](/docs/query/). **SQL** shows the statement the view compiles to, and **Save** keeps it in this browser.

A view in a config file is one line of the query language:

```json
{ "views": [{ "name": "Unpaid, biggest first", "connection": "demo",
              "text": "invoice show id, total, status, customer_id.name as customer where status != paid sort total desc limit 50" }] }
```

## Record layouts

A layout is how the record view arranges every row of one table. On a record, click **Layout**: tick the sections to show and move them up or down, choose the fields or columns inside each (**All**, **None**, or drag to arrange), set how many rows a related list holds, then **Save layout**. **Reset to default** returns to the layout tablewalk drew.

![The Record layout panel beside a customer record: sections with checkboxes and arrows, and the fields inside each to drag into order](/shots/layout.webp)

## Pages

A page gathers one record with what surrounds it: its fields, figures and related lists as tabs. Open one with **As a page →** on a record, or **Page →** on a table. Its address is `/{connection}/@{page}~{id}`, such as `/demo/@customer~1`.

![The customer page for Harbour Freight, with its related lists as tabs](/shots/page.webp)

tablewalk suggests a page for any table. **Copy layout** starts your own copy of it, and on a saved page **Layout** changes it. The star pins a page to the home screen.

## Where it is kept

Layouts and pages are kept by the server, so every browser that reaches it sees them:

| What | File |
| --- | --- |
| Record layouts | `$XDG_CONFIG_HOME/tablewalk/layouts.json` |
| Saved pages | `$XDG_CONFIG_HOME/tablewalk/pages.json` |

`$XDG_CONFIG_HOME` is `~/.config` when it is not set. The files are plain JSON, keyed by connection and then table, so you can read them and copy them to another machine. Saved filters, views and SQL statements stay in the browser that saved them; to share one, put it in the config file.

## Sharing them with a team

A [config file](/docs/connections/) can carry `views`, `pages`, `layouts` and `queries` beside its connections, so the surfaces a team agrees on live in version control:

```json
{
  "layouts": [{
    "table": "customer", "connection": "demo", "name": "Account desk",
    "sections": [
      { "kind": "fields", "title": "Account", "show": ["name", "email", "credit_limit"] },
      { "kind": "list", "title": "Invoices", "from": "invoice", "whose": "customer_id",
        "show": ["id", "invoice_date", "total"], "limit": 5, "sort": "invoice_date desc" }
    ]
  }]
}
```

A list section names its rows with `from` and `whose`: the `invoice` rows whose `customer_id` is this customer. A committed layout fills in for a table nobody has laid out, and never replaces one somebody saved. A malformed entry stops the server with a message naming the entry and the fix.
