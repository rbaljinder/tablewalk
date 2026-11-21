/**
 * Schema neighborhood focus (`--focus <tables>`, `--focus-hops <n>`, `"focus"`).
 *
 * Large schemas (80–300+ tables) spend thousands of catalog tokens and expose
 * unrelated domains to an agent that only needs to work around one or two focal
 * tables. `computeFocusBlocklist` walks the undirected foreign-key graph up to
 * `hops` steps (`0..5`, default `1`) from the focal tables and withholds every
 * table outside that neighborhood via `BlocklistRules`, automatically scoping
 * `tables`, `schema_summary`, `query`, `breakdown`, `find`, `record`, `profile`,
 * `lint`, `perf`, `anomalies`, `export`, and writes while refusing raw SQL.
 */
import { tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/host';
import type { BlocklistRules } from './blocklist.js';

export interface FocusSpec {
  tables: string[];
  hops: number;
}

export const DEFAULT_FOCUS_HOPS = 1;
export const MAX_FOCUS_HOPS = 5;

export function parseFocusHops(raw: unknown, where: string): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_FOCUS_HOPS;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_FOCUS_HOPS) {
    throw new Error(`${where} must be an integer between 0 and ${MAX_FOCUS_HOPS}, not ${JSON.stringify(raw)}.`);
  }
  return n;
}

export function parseFocusTables(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`${where} is not valid JSON: ${(err as Error).message}`);
      }
      return parseFocusTables(parsed, where);
    }
    const items = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${where} must be a comma-separated string or array of table names (e.g. ["invoice", "customer"]).`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${where} entries must be non-empty table names, not ${JSON.stringify(item)}.`);
    }
    const clean = item.trim();
    if (!out.includes(clean)) out.push(clean);
  }
  return out.length ? out : undefined;
}

export function parseFocusSpec(rawFocus: unknown, rawHops: unknown, where: string): FocusSpec | undefined {
  if (rawFocus && typeof rawFocus === 'object' && !Array.isArray(rawFocus)) {
    const rec = rawFocus as Record<string, unknown>;
    const allowed = new Set(['tables', 'hops']);
    const unknown = Object.keys(rec).filter((k) => !allowed.has(k));
    if (unknown.length) {
      throw new Error(`${where}: unknown key ${unknown.map((k) => `"${k}"`).join(', ')} in "focus" (expected tables, hops).`);
    }
    const tables = parseFocusTables(rec.tables, `${where} focus.tables`);
    if (!tables?.length) return undefined;
    const hops = parseFocusHops(rawHops ?? rec.hops, `${where} focus.hops`);
    return { tables, hops };
  }
  const tables = parseFocusTables(rawFocus, where);
  if (!tables?.length) return undefined;
  const hops = parseFocusHops(rawHops, `${where} focusHops`);
  return { tables, hops };
}

function globMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(candidate.toLowerCase());
}

function matchSeedTables(schema: DatabaseSchema, seeds: readonly string[]): TableMeta[] {
  const matched = new Map<string, TableMeta>();
  for (const seed of seeds) {
    if (seed.includes('*')) {
      for (const t of schema.tables) {
        if (globMatches(seed, t.id) || globMatches(seed, t.name)) {
          matched.set(t.id, t);
        }
      }
      continue;
    }
    const direct = tableNamed(schema, seed);
    if (direct) matched.set(direct.id, direct);
  }
  return [...matched.values()];
}

/**
 * Compute a fail-closed `BlocklistRules` keeping only `focus.tables` and tables
 * within `focus.hops` undirected foreign-key edges in `schema`.
 */
export function computeFocusBlocklist(schema: DatabaseSchema, focus: FocusSpec): { rules: BlocklistRules; keptTables: string[] } {
  const seeds = matchSeedTables(schema, focus.tables);
  const adj = new Map<string, Set<string>>();
  for (const fk of schema.foreignKeys) {
    let fromSet = adj.get(fk.from.table);
    if (!fromSet) {
      fromSet = new Set();
      adj.set(fk.from.table, fromSet);
    }
    fromSet.add(fk.to.table);

    let toSet = adj.get(fk.to.table);
    if (!toSet) {
      toSet = new Set();
      adj.set(fk.to.table, toSet);
    }
    toSet.add(fk.from.table);
  }

  const visited = new Set<string>();
  let frontier: string[] = [];
  for (const seed of seeds) {
    visited.add(seed.id);
    frontier.push(seed.id);
  }

  for (let depth = 0; depth < focus.hops && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  const blockedTables: string[] = [];
  const keptTables: string[] = [];
  for (const t of schema.tables) {
    if (!t.isView && visited.has(t.id)) {
      keptTables.push(t.id);
    } else {
      blockedTables.push(t.id);
    }
  }

  return {
    rules: {
      tables: blockedTables,
      fields: {},
    },
    keptTables,
  };
}
