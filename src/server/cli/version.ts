import { readFileSync } from 'node:fs';

/**
 * This package's version, read from its own package.json, given to the engine with `setProduct` so `--version`, MCP's
 * serverInfo and telemetry say it. `runtimeVersion` stays the engine's, the framework's number on its own schedule.
 * `../../../` reaches the package root from both src/server/cli and dist/server/cli.
 */
export function browserVersion(): string {
  return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}
