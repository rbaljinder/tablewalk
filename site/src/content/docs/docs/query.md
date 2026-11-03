---
title: Query language
description: The one-line language in tablewalk's query bar. A table, then conditions, paths through foreign keys, counts and dates, compiled to one bounded SQL statement.
---

The query bar takes a table name and then, in plain words, what you want from it.

```text
invoice total > 500 and customer_id.country_code.name = Australia sort total desc
```

Every query compiles to one SQL statement, which runs read-only and with a row limit. **SQL** in the top bar shows the statement it compiled to. Press `?` in the app for this grammar with examples built from your own tables, and `Tab` or `Ctrl+Space` in the bar to complete a table, column or keyword.

![The query bar with a filter on invoices, and the SQL panel showing the statement it compiled to](/shots/sql.webp)

## Filters

A condition comes straight after the table. `where` (or `filter`) may go before it.

| Write | Means |
| --- | --- |
| `status = paid` | equals; also `!=`, `<`, `<=`, `>`, `>=` |
| `name contains freight` | anywhere in the text, any case |
| `name startswith Har` | at the start; `endswith` too |
| `name like Wh%` | your own wildcards: `%` any run, `_` one character |
| `status in (paid, void)` | any of them; `not in` for none |
| `total between 100 and 500` | a range, both ends included |
| `email is empty` | no value; `is not empty` for the rest |
| `name = "Harbour Freight"` | quote a value with spaces |
| `actual_hours > estimated_hours` | compare two columns |

Combine them with `and`, `or` and parentheses. `and` binds tighter than `or`:

```text
invoice (status = issued or status = overdue) and total > 1000
```

A typo is caught before anything runs, with the likely fix: `"totl" is not a column on invoice. Did you mean "total"?`

## Walking a foreign key

A dot follows a foreign key to the row it names, up to four steps along:

```text
invoice_line invoice_id.customer_id.country_code.name = Australia
```

Where a key has more than one column, join the columns with `+`: `shipment invoice_id+line_no.sku = SKU-100`.

To ask about the rows that point *at* a row, use `any` or `no`, with `via` naming the column when there is more than one:

```text
customer any invoice where total > 500
employee no employee via manager_id
```

## Choosing and sorting

```text
invoice show id, invoice_date, total, customer_id.name as customer sort total desc limit 20
```

- `show` (or `select`) picks the columns, in order. A path works here too, and `as` names it.
- `sort` (or `order by`) takes several columns, each with `desc` if you want it.
- `limit` caps the rows.

With no `sort`, rows come newest first wherever an indexed column allows it.

## Counts and sums on each row

```text
customer show name count invoice via customer_id as invoices sum invoice.total via customer_id as revenue sort invoices desc
```

On PostgreSQL, name the child table with its schema: `count public.invoice via customer_id`.

## Dates

A date phrase is a window, so `invoice_date = last 30 days` keeps the rows inside it.

| Write | Window |
| --- | --- |
| `today` | also `yesterday`, `tomorrow` |
| `this week` | also `last week`; weeks start on Monday |
| `this month` | also `last month`, `this year`, `last year` |
| `this quarter` | also `last quarter`, `next quarter` |
| `last 30 days` | also `last 12 hours`, `last 6 weeks`, `last 3 months` |
| `next 7 days` | the same units, forward |
| `previous 30 days` | the window just before `last 30 days` |
| `now` | this moment, to compare with: `due_at < now` |

## Breakdowns

`by` turns a query into counts and sums by something, the `GROUP BY` question:

```text
invoice count by status
invoice count, sum total as billed by month invoice_date sort billed desc limit 12
invoice sum total by customer_id.country_code.name as country
```

- Measures: `count`, `count distinct <column>`, `sum`, `avg`, `min` and `max`, several at once with commas.
- A date can be grouped by `day`, `month`, `quarter` or `year`.
- Up to three things to group by, and a path works as one of them.

## When it cannot say it

The language covers filtering, walking and counting. For window functions, CTEs or self-joins, open the SQL editor (`⌘⇧↵`). **Edit** in the SQL panel starts it from the statement your query compiled to. A statement runs read-only, the same as a query. See [Writing](/docs/writing/) for the one exception.
