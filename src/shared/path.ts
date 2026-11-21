/**
 * Shortest foreign-key walks between two tables, with index-coverage and
 * compiled query-language hints.
 *
 * Pure over `DatabaseSchema`, shared between the MCP `path` tool and client
 * diagnostics: answers "how does `organization` reach `refund_line`?" without
 * round-trips, flags reverse (`to-many`) hops lacking a leading index on large
 * tables, and synthesizes ready-to-run query/view expressions.
 */
import {
  findTable,
  primaryKey,
  tableNamed,
  type DatabaseSchema,
  type ForeignKey,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';

export interface PathHop {
  from: string;
  to: string;
  direction: 'to-one' | 'to-many';
  constraint?: string;
  /** Referencing column(s) on the child table (`from` when `to-one`, `to` when `to-many`). */
  via: string[];
  /** Referenced column(s) on the parent table. */
  targetColumns: string[];
  onDelete?: string;
  /** True when the lookup side of this hop has a leading index (PK/unique on `to-one`, child FK index on `to-many`). */
  indexed?: boolean;
  /** Approximate rows on the table scanned by this hop, when reported by the catalog. */
  scannedApproxRows?: number;
  /** Suggested `CREATE INDEX` DDL when `direction === 'to-many'` and `indexed === false`. */
  suggestedIndex?: string;
}

export interface ForeignKeyPath {
  hops: PathHop[];
  length: number;
  unindexedHops: number;
  /** Human-readable chain summary, e.g. `invoice.customer_id -> customer.id ; customer.country_code -> country.code`. */
  summary: string;
  /** Ready-to-run `tablewalk` query or view projection walking this chain, when expressible in one query. */
  queryHint?: string;
}

export interface PathSearchResult {
  from: string;
  to: string;
  connected: boolean;
  paths: ForeignKeyPath[];
}

interface Edge {
  fk: ForeignKey;
  next: string;
  direction: 'to-one' | 'to-many';
}

function quoteIdentSimple(ident: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(ident) ? ident : `"${ident.replace(/"/g, '""')}"`;
}

function representativeColumn(table: TableMeta | undefined): string {
  if (!table) return 'id';
  const preferred = table.columns.find((c) => /^(?:name|title|label|code|email|slug|display_name)$/i.test(c.name));
  if (preferred) return preferred.name;
  const pk = primaryKey(table)[0];
  return pk ?? table.columns[0]?.name ?? 'id';
}

function buildHop(schema: DatabaseSchema, currentId: string, edge: Edge): PathHop {
  const { fk, next, direction } = edge;
  if (direction === 'to-one') {
    const parent = findTable(schema, next);
    return {
      from: currentId,
      to: next,
      direction: 'to-one',
      ...(fk.name ? { constraint: fk.name } : {}),
      via: [...fk.from.columns],
      targetColumns: [...fk.to.columns],
      ...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
      indexed: true,
      ...(parent?.approxRows !== undefined ? { scannedApproxRows: parent.approxRows } : {}),
    };
  }

  /* Reverse walk (`parent <- child`): scans `next` (the child table) on `fk.from.columns[0]`. */
  const child = findTable(schema, next);
  const lead = fk.from.columns[0];
  const indexed = child?.indexed ? child.indexed.includes(lead) : undefined;
  const indexName = `idx_${(child?.name ?? next).replace(/[^a-zA-Z0-9_]/g, '_')}_${fk.from.columns.join('_').replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const qualifiedChild =
    child?.schema && child.schema !== 'public' && child.schema !== 'main'
      ? `${quoteIdentSimple(child.schema)}.${quoteIdentSimple(child.name)}`
      : quoteIdentSimple(child?.name ?? next);
  const suggestedIndex =
    indexed === false
      ? `CREATE INDEX ${quoteIdentSimple(indexName)} ON ${qualifiedChild} (${fk.from.columns.map(quoteIdentSimple).join(', ')});`
      : undefined;

  return {
    from: currentId,
    to: next,
    direction: 'to-many',
    ...(fk.name ? { constraint: fk.name } : {}),
    via: [...fk.from.columns],
    targetColumns: [...fk.to.columns],
    ...(fk.onDelete ? { onDelete: fk.onDelete } : {}),
    ...(indexed !== undefined ? { indexed } : {}),
    ...(child?.approxRows !== undefined ? { scannedApproxRows: child.approxRows } : {}),
    ...(suggestedIndex ? { suggestedIndex } : {}),
  };
}

function summarizeHops(hops: readonly PathHop[]): string {
  return hops
    .map((h) =>
      h.direction === 'to-one'
        ? `${h.from}.${h.via.join('+')} -> ${h.to}.${h.targetColumns.join('+')}`
        : `${h.from}.${h.targetColumns.join('+')} <- ${h.to}.${h.via.join('+')}`,
    )
    .join(' · ');
}

/**
 * Synthesize a concrete query-language expression when a chain of single-column
 * references can be projected directly via dot-paths or `any` filters.
 */
function synthesizeQueryHint(schema: DatabaseSchema, fromId: string, toId: string, hops: readonly PathHop[]): string | undefined {
  if (!hops.length) return fromId;
  if (hops.some((h) => h.via.length !== 1)) return undefined;

  const fromTable = findTable(schema, fromId);
  const toTable = findTable(schema, toId);
  const fromPk = primaryKey(fromTable ?? ({ columns: [] } as unknown as TableMeta))[0] ?? representativeColumn(fromTable);

  /* Case 1: Every hop is `to-one` (`from -> ... -> to`). */
  if (hops.every((h) => h.direction === 'to-one')) {
    const chain = hops.map((h) => h.via[0]).join('.');
    const leaf = representativeColumn(toTable);
    return `${fromId} show ${fromPk}, ${chain}.${leaf}`;
  }

  /* Case 2: Every hop is `to-many` (`from <- ... <- to`), so `to` walks `to-one` back to `from`! */
  if (hops.every((h) => h.direction === 'to-many')) {
    const reverseChain = [...hops]
      .reverse()
      .map((h) => h.via[0])
      .join('.');
    const fromLeaf = representativeColumn(fromTable);
    const toPk = primaryKey(toTable ?? ({ columns: [] } as unknown as TableMeta))[0] ?? representativeColumn(toTable);
    if (hops.length === 1) {
      return `${toId} show ${toPk}, ${reverseChain}.${fromLeaf} (or filter parents: ${fromId} any ${toId} where ${hops[0].via[0]} is not empty)`;
    }
    return `${toId} show ${toPk}, ${reverseChain}.${fromLeaf}`;
  }

  /* Case 3: Bridge / join table in the middle (`from <- bridge -> ... -> to`, i.e. `to-many` then `to-one`). */
  const splitIdx = hops.findIndex((h) => h.direction === 'to-one');
  if (
    splitIdx > 0 &&
    hops.slice(0, splitIdx).every((h) => h.direction === 'to-many') &&
    hops.slice(splitIdx).every((h) => h.direction === 'to-one')
  ) {
    const apexId = hops[splitIdx].from;
    const leftChain = hops
      .slice(0, splitIdx)
      .reverse()
      .map((h) => h.via[0])
      .join('.');
    const rightChain = hops
      .slice(splitIdx)
      .map((h) => h.via[0])
      .join('.');
    return `${apexId} show ${leftChain}.${representativeColumn(fromTable)}, ${rightChain}.${representativeColumn(toTable)}`;
  }

  return undefined;
}

export function findForeignKeyPaths(
  schema: DatabaseSchema,
  fromName: string,
  toName: string,
  options: { maxHops?: number; maxPaths?: number } = {},
): PathSearchResult | { error: string } {
  const fromTable = tableNamed(schema, fromName);
  if (!fromTable) {
    return { error: `Unknown table "${fromName}". Ask \`tables\` for what exists.` };
  }
  const toTable = tableNamed(schema, toName);
  if (!toTable) {
    return { error: `Unknown table "${toName}". Ask \`tables\` for what exists.` };
  }

  const maxHops = Math.max(1, Math.min(10, Math.floor(options.maxHops ?? 6)));
  const maxPaths = Math.max(1, Math.min(10, Math.floor(options.maxPaths ?? 5)));

  const adj = new Map<string, Edge[]>();
  for (const t of schema.tables) adj.set(t.id, []);
  for (const fk of schema.foreignKeys) {
    adj.get(fk.from.table)?.push({ fk, next: fk.to.table, direction: 'to-one' });
    adj.get(fk.to.table)?.push({ fk, next: fk.from.table, direction: 'to-many' });
  }

  const found: ForeignKeyPath[] = [];
  const seenSignatures = new Set<string>();

  /* Self-path (`from === to`): look for direct self-referencing FKs or short cycles back to `fromTable.id`. */
  if (fromTable.id === toTable.id) {
    for (const fk of schema.foreignKeys) {
      if (fk.from.table === fromTable.id && fk.to.table === fromTable.id) {
        const hop = buildHop(schema, fromTable.id, { fk, next: fromTable.id, direction: 'to-one' });
        const summary = summarizeHops([hop]);
        if (!seenSignatures.has(summary)) {
          seenSignatures.add(summary);
          found.push({
            hops: [hop],
            length: 1,
            unindexedHops: 0,
            summary,
            queryHint: synthesizeQueryHint(schema, fromTable.id, toTable.id, [hop]),
          });
        }
      }
    }
    return {
      from: fromTable.id,
      to: toTable.id,
      connected: true,
      paths: found.slice(0, maxPaths),
    };
  }

  /* Breadth-first search keeping shortest simple walks up to `maxHops`. */
  interface QueueNode {
    tableId: string;
    visited: Set<string>;
    hops: PathHop[];
  }

  const queue: QueueNode[] = [{ tableId: fromTable.id, visited: new Set([fromTable.id]), hops: [] }];
  let shortestFound: number | null = null;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.hops.length >= maxHops) continue;
    /* Keep exploring up to `shortestFound + 1` hops so meaningful alternate routes (e.g. direct vs bridge) are shown,
       without enumerating long detours across hubs. */
    if (shortestFound !== null && current.hops.length > shortestFound + 1 && found.length >= maxPaths) {
      break;
    }

    for (const edge of adj.get(current.tableId) ?? []) {
      if (current.visited.has(edge.next)) continue;
      const hop = buildHop(schema, current.tableId, edge);
      const nextHops = [...current.hops, hop];

      if (edge.next === toTable.id) {
        const sig = summarizeHops(nextHops);
        if (!seenSignatures.has(sig)) {
          seenSignatures.add(sig);
          if (shortestFound === null) shortestFound = nextHops.length;
          const unindexedHops = nextHops.filter((h) => h.direction === 'to-many' && h.indexed === false).length;
          const queryHint = synthesizeQueryHint(schema, fromTable.id, toTable.id, nextHops);
          found.push({
            hops: nextHops,
            length: nextHops.length,
            unindexedHops,
            summary: sig,
            ...(queryHint ? { queryHint } : {}),
          });
        }
        continue;
      }

      if (nextHops.length < maxHops && (shortestFound === null || nextHops.length <= shortestFound)) {
        const nextVisited = new Set(current.visited);
        nextVisited.add(edge.next);
        queue.push({ tableId: edge.next, visited: nextVisited, hops: nextHops });
      }
    }
  }

  found.sort((a, b) => a.length - b.length || a.unindexedHops - b.unindexedHops);

  return {
    from: fromTable.id,
    to: toTable.id,
    connected: found.length > 0,
    paths: found.slice(0, maxPaths),
  };
}
