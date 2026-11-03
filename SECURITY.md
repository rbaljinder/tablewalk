# Security

## Reporting

tablewalk opens databases. If you find a way for it to read, write or reach
something it should not, please report it privately rather than in a public
issue, by email to security@mistriwork.dev. You will get an acknowledgement
within a few days and a fix or a reasoned answer as soon as one exists.
Credit is given in the release notes unless you would rather it were not.

## The model, in short

- **Read-only by default, per connection.** Writes exist only behind
  `"writable": true` in the config, checked by the server in every route
  and tool that writes (the Workbench's write routes and the MCP write tools) before a statement reaches the database; the
  adapter does not check it, and runs whatever it is handed. Every read runs
  in a read-only transaction. The database role is the limit that holds
  whatever the server does, so connect as one that can only read where
  nothing should write. Retargeting a connection makes it read-only again.
- **Loopback by default.** The server binds `127.0.0.1`. Every request is
  checked against the `Host` it arrived for (the DNS-rebinding defense),
  and writes are checked for `Origin` and content type.
- **No authentication.** Anyone who can reach the port can read every
  connection the server holds and add network connections of their own.
  Bound beyond loopback the server stops trusting the browser with
  environment references, keychain lookups, SQLite file paths, config
  saves and redirects of config-named connections, and dials a URL it typed
  sealed: no user or password filled in from `PG*` variables or `~/.pgpass`,
  and no loopback, private or link-local (cloud metadata) address — but that is a line
  between "your machine" and "the network", not a login. Anything reachable
  past a private network belongs behind a proxy that authenticates — and
  `--auth-proxy-header` carries that proxy's decision in, refusing requests
  that skipped it or carry it from a peer that is neither loopback nor in
  `--auth-proxy-from`, and journaling every write with who made it.
- **Queries compile to structure, never to SQL text.** Every value is a
  bound parameter; table names are checked against the catalog before being
  quoted; raw SQL runs one statement at a time inside a read-only session
  and is bounded by a LIMIT wrap.
- **The page talks to its own server alone.** The Workbench is drawn in a shell
  that carries a Content-Security-Policy: scripts come from the server (and its
  inline startup scripts, pinned by hash), requests go to the server
  (`connect-src 'self'`), no plugin or frame of another origin loads, and no
  other site may frame the page. Every answer also carries
  `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy`
  that grants no camera, microphone, location or payment sheet, and an answer
  that arrived over https (TLS, or a trusted proxy's `X-Forwarded-Proto`)
  carries `Strict-Transport-Security`.
- **A hidden column is never served.** A connection's `"hidden"` in
  tablewalk.json cuts columns from the catalog the server answers with, at the
  adapter itself, so the Workbench and MCP inherit it. A query, filter, sort,
  walk, export or count that names one is refused as naming a column that is not
  there, and raw SQL is refused on a connection that hides columns. It is not a
  database privilege: anyone with the connection URL still reads the column, and
  a role without `SELECT` on it is the stronger boundary.
- **`MISTRI_SERVER_TIMING=1` is for load testing only.** It answers every
  request with a `Server-Timing` header that includes the process's own state
  (heap, garbage collection, pool use and queues), to any requester, signed in
  or not. It names no statement, row or key, but it is a free look at how loaded
  the process is. Keep it off in production, or set `MISTRI_SERVER_TIMING_TOKEN`:
  the process entry is then added only to a request that sends the token as an
  `x-mistri-timing` header.
- **Credentials** come from the environment, the OS keychain, or a 0600
  file, and never reach the browser in any response.

The full account is in the README and in docs/deploy.md for containers.
