# Changelog

## Unreleased

Built on `@mistriwork/engine`, `kit` and `ui` at exactly `1.0.0-rc.14`.

- Blueprint and Console are the kit's host looks (`registerHostLooks`): they are offered in Preferences beside the
  built-in looks, persist with the reader's look, and set `data-host-look` on the page. `?look=blueprint`,
  `?look=console` and `?look=default` still pick one from the address. Console names its data face with `--data-face`;
  Blueprint's condensed capitals are the kit's Barlow Semi Condensed.
- `--version`, MCP's `serverInfo` and telemetry report this package's version through the engine's `setProduct`.

## 1.0.0-rc.13

tablewalk, the database browser, now lives in its own repository and ships as its own
package, built on `@mistriwork/engine`, `@mistriwork/kit` and `@mistriwork/ui` at exactly
`1.0.0-rc.13`. Nothing about how it behaves changed. Everything before this release
(the browser's history up to 1.0.0-rc.12 included) is in the framework's changelog:
https://github.com/rbaljinder/mistri/blob/main/CHANGELOG.md
