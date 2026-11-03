/** The `--flag` words in a text: what a USAGE offers, what a README's Options block lists. */
export const flagsIn = (text: string): Set<string> => new Set([...text.matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0]));
