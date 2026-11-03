/** The folders a source-reading test walks. One package here, so `src` is the one folder; the monorepo's version spans its packages. */
export function inPackages(sub: string): string[] {
  return [sub];
}
