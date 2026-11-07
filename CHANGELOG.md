# Changelog

## Unreleased

Built on `@mistriwork/engine`, `kit` and `ui` at exactly `1.0.0-rc.17`.

- The browser's own look is Instrument in the Fog and moss palette: Inter for words, IBM Plex Mono for figures, a hairline
  measuring grid, near-monochrome grey with one moss accent. It is a sheet of this package (`looks/native.css`, in the
  first stylesheet, so it paints with the first load) over the kit's native tokens; the former native look is retired.
  Instrument's other palettes (Graphite, Stone, Slate, Ink) and Folio are host looks beside Blueprint and Console.
  `?look=instrument&palette=fog` still opens, as the default.
- Blueprint and Console are the kit's host looks (`registerHostLooks`): they are offered in Preferences beside the
  built-in looks, persist with the reader's look, and set `data-host-look` on the page. `?look=blueprint`,
  `?look=console` and `?look=default` still pick one from the address. Console names its data face with `--data-face`;
  Blueprint's condensed capitals are the kit's Barlow Semi Condensed.
- Undo can outlive the process. `tablewalk journal` makes the store a writable connection keeps its write journal in (two reserved
  tables in its database): after a restart, Undo and `revert` still reach its last 50 writes, for 7 days. Without the store the
  journal is the process's alone, as before, and opening a connection makes nothing.
- The server modules take the engine's names from `@mistriwork/engine/host`, the entry point for a host that opens and works with a
  database, instead of its deeper paths. The client keeps its own imports, since the entry point is the server's.
- `--version`, MCP's `serverInfo` and telemetry report this package's version through the engine's `setProduct`.

## 1.0.0-rc.13

tablewalk, the database browser, now lives in its own repository and ships as its own
package, built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly
`1.0.0-rc.13`. Nothing about how it behaves changed. Everything before this release
(the browser's history up to 1.0.0-rc.12 included) is in the framework's changelog:
https://github.com/rbaljinder/mistri/blob/main/CHANGELOG.md
