---
title: FAQ and troubleshooting
description: Answers to the questions tablewalk users ask most, and what to do about the errors it prints.
---

Short answers, and the fix for each message tablewalk prints most often.

## Questions

**Which databases does it read?**
SQLite, built in through Node's own `node:sqlite`, and PostgreSQL. MySQL and MariaDB are not supported, and a `mysql://` URL is refused with a message saying so.

**Will it change my data?**
Not unless you let it. Every read runs in a read-only transaction, and a write needs both `"writable": true` on that connection in the config file and write mode turned on in the page. See [Writing](/docs/writing/).

**Is it safe to point at production?**
Connect as a database role that can only read, so the database enforces what tablewalk promises. To keep row values from leaving the server at all, mark the connection `"rows": false`, or hide sensitive columns with `"hidden"`. See [Connections and config](/docs/connections/#a-connections-fields).

**Does it send anything anywhere?**
No. There is no telemetry. OpenTelemetry export happens only when you set `OTEL_EXPORTER_OTLP_ENDPOINT`, and carries no row values, SQL parameters or tokens.

**Where are my layouts and pages kept?**
In `~/.config/tablewalk/layouts.json` and `pages.json` (under `$XDG_CONFIG_HOME` when it is set). Saved filters, views and SQL statements stay in the browser that saved them. See [Pages, layouts and views](/docs/pages/#where-it-is-kept).

**Can I share a link?**
Yes. Every table, record, page and query has an address in the path, such as `/demo/customer/~42`. See [Addresses](/docs/browsing/#addresses). Old links of the form `#/…` are not read.

**Can I run it for my team?**
Yes, with the [container image](/docs/deploying/) behind a proxy that signs people in. tablewalk has no sign-in of its own.

**`tablewalk --app` says it serves no App.**
Apps are built with mistri, the framework tablewalk grew alongside. Run the command it names: `npx @mistriwork/mistri --app <dir>`.

## Messages

**`MySQL is not supported; use PostgreSQL or SQLite.`**
tablewalk reads SQLite and PostgreSQL only. The message can arrive at the end of a longer "Could not open the active connection" error, after a line about a missing password; the MySQL line is the one that matters.

**`Refused: this request arrived for host "…"`**
You reached tablewalk by a name other than `localhost` or its bound address. Add the name with `--allowed-host` or `TABLEWALK_ALLOWED_HOSTS`. See [Deploying](/docs/deploying/#two-network-settings-to-get-right).

**`Warning: bound to 0.0.0.0, beyond loopback, with no sign-in.`**
Anyone who can reach the port can read the database. Bind `--host 127.0.0.1`, publish the container to `127.0.0.1` only, or put it behind a signing-in proxy with `--auth-proxy-header`.

**A config error naming an unset variable.**
A `${VARIABLE}` in a connection URL is not set in the environment. tablewalk stops rather than sending an empty password.

**`… hides columns ("hidden" in your tablewalk.json): raw SQL is refused`**
On a connection with hidden columns, raw SQL could name any column, so it is refused. Use the query language, or connect as a role without `SELECT` on those columns and remove `"hidden"`.

**`"totl" is not a column on invoice. Did you mean "total"?`**
The query language checks every name before anything runs. Take the suggestion, or press `Tab` in the query bar to complete names.

**The agent has no `update` or `insert` tool.**
Write tools are listed only when a connection is `"writable": true`, and a `--tools` profile can remove them. See [MCP](/docs/mcp/#the-tools).

**The agent has no `query`, `sql` or `record` tool.**
Every connection is `"rows": false`, so the tools that return row values are not listed.

**Node.js says `node:sqlite` is not found, or the install refuses.**
tablewalk needs Node.js 24.22.1 or newer. Check with `node --version`, or use the [desktop app](/docs/desktop/), which carries its own.

## Still stuck

Open an issue on [GitHub](https://github.com/rbaljinder/tablewalk/issues) with the command you ran and the message it printed. The [changelog](https://github.com/rbaljinder/tablewalk/blob/main/CHANGELOG.md) lists what changed in each release.
