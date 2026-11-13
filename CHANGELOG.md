# Changelog

## 1.0.0-rc.13

tablewalk, the database browser, now lives in its own repository and ships as its own
package, built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly
`1.0.0-rc.49`. Everything before this release (the browser's history up to 1.0.0-rc.12
included) is in the framework's changelog:
https://github.com/rbaljinder/mistri/blob/main/CHANGELOG.md

### Looks

- The browser's own look is Instrument in the Fog and moss palette: Inter for words, IBM Plex Mono for figures, a hairline
  measuring grid, near-monochrome grey with one moss accent. It is a sheet of this package (`looks/native.css`, in the
  first stylesheet, so it paints with the first load) over the kit's native tokens; the former native look is retired.
  Instrument's other palettes (Graphite, Stone, Slate, Ink) and Folio are host looks beside Blueprint and Console.
  `?look=instrument&palette=fog` still opens, as the default.
- Blueprint and Console are the kit's host looks (`registerHostLooks`): they are offered in Preferences beside the
  built-in looks, persist with the reader's look, and set `data-host-look` on the page. `?look=blueprint`,
  `?look=console` and `?look=default` still pick one from the address. Console names its data face with `--data-face`;
  Blueprint's condensed capitals are the kit's Barlow Semi Condensed.
### Undo and version

- Undo can outlive the process. `tablewalk journal` makes the store a writable connection keeps its write journal in (two reserved
  tables in its database): after a restart, Undo and `revert` still reach its last 50 writes, for 7 days. Without the store the
  journal is the process's alone, as before, and opening a connection makes nothing.
- `--version`, MCP's `serverInfo` and telemetry report this package's version through the engine's `setProduct`.

### Safety and correctness

- The SQL editor refuses a statement that touches tablewalk's own runtime tables, as the MCP `sql` tool already did.
- On a server reachable beyond this machine, removing a connection from the config file is refused unless the request
  comes from the machine running tablewalk.
- `migrate up`, `migrate baseline` and `migrate repair` need a writable connection, as `seed` does, and a mistyped
  `migrate` or `seed` suggests the right tablewalk command.
- An MCP tool's error carries a stable code in its result's `_meta`, so an agent can act on the kind of failure without
  reading the message.
- The Docker image and the desktop app install from the lockfile, and the desktop app offers DevTools only in a
  development run.

### Docs

- The README shows the startup warning tablewalk really prints, points to the App framework instead of describing it,
  recommends a read-only role on Postgres, and says to run `npx tablewalk@next` for the current build.

