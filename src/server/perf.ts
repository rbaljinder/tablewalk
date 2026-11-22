/**
 * Live index and scan diagnostics (`perf`).
 *
 * `lint` inspects static catalog definitions (missing primary keys, unindexed
 * foreign keys), while `anomalies` counts relational data outliers. `perf`
 * inspects how the engine is actually executing against the schema:
 *
 *   - On PostgreSQL (`pg_stat_user_tables` + `pg_stat_user_indexes` + `pg_index`):
 *     sequential-scan hotspots, redundant prefix btree indexes, zero-scan
 *     non-constraint indexes, dead-tuple bloat, and stale planner statistics.
 *   - On SQLite (`PRAGMA index_list` / `index_info`, `EXPLAIN QUERY PLAN`, and
 *     `sqlite_master`): redundant prefix indexes, views that force full-table
 *     scans over populated tables, and multi-index tables missing `ANALYZE`
 *     planner statistics (`sqlite_stat1`).
 *
 * Every table and column is intersected with the caller's policy-filtered
 * `DatabaseSchema`, and zero row values are ever read, so `perf` is safe on
 * `"rows": false`, `"redact": true`, `"hidden"`, and `"blocklist"` connections.
 */
import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  findTable,
  referencesFrom,
  resolveConnection,
  scrubSecrets,
  type DatabaseSchema,
  type Registry,
  type TableMeta,
} from '@mistriwork/engine/host';
import { PgConnectionManager } from '@mistriwork/engine/adapters/postgresPool.js';
import { quoteIdent } from '@mistriwork/engine/server/migrate/database.js';
import type { Severity } from '../shared/lint.js';
import { ToolError } from './mcp/toolkit.js';

export type PerfRule =
  | 'sequential-scan-hotspot'
  | 'duplicate-index'
  | 'unused-index'
  | 'dead-tuple-bloat'
  | 'stale-statistics'
  | 'view-full-scan'
  | 'missing-analyze-stats'
  | 'lock-contention'
  | 'long-running-query';

export interface PerfFinding {
  rule: PerfRule;
  severity: Severity;
  table: string;
  index?: string;
  coveredBy?: string;
  columns?: string[];
  bytes?: number;
  approxRows?: number;
  message: string;
  suggestedSql?: string;
  link: string;
}

export const PERF_RULES: Record<PerfRule, { severity: Severity; why: string }> = {
  'sequential-scan-hotspot': {
    severity: 'high',
    why: 'Queries are repeatedly walking the whole heap instead of seeking through an index, burning I/O and buffer cache as row count grows.',
  },
  'duplicate-index': {
    severity: 'medium',
    why: 'A non-unique btree index is a leading-column prefix of another index on the same table: writes maintain both while the wider index already serves prefix lookups.',
  },
  'unused-index': {
    severity: 'low',
    why: 'An index that neither enforces uniqueness, backs a foreign key, nor serves scans still pays write amplification and WAL/page overhead on every insert, update, and delete.',
  },
  'dead-tuple-bloat': {
    severity: 'medium',
    why: 'A high share of dead tuples inflates heap and index scans and signals autovacuum is lagging behind update/delete churn.',
  },
  'stale-statistics': {
    severity: 'low',
    why: 'Row modifications since the last ANALYZE have drifted far enough that join order and index-vs-scan estimates can misprice queries.',
  },
  'view-full-scan': {
    severity: 'medium',
    why: 'Planning a read of this view walks a populated underlying table without an index, turning a small page look into a full scan.',
  },
  'missing-analyze-stats': {
    severity: 'low',
    why: 'Multiple indexes compete on a populated SQLite table without `sqlite_stat1` selectivity statistics, leaving the query planner to guess cardinalities.',
  },
  'lock-contention': {
    severity: 'high',
    why: 'One or more database backends are actively blocked waiting on row or relation locks held by another session, stalling reads or writes.',
  },
  'long-running-query': {
    severity: 'medium',
    why: 'An open transaction or active query has been running long enough to hold locks, pin MVCC snapshots, and block autovacuum cleanup.',
  },
};

export interface PgTableStatRow {
  schema_name: string;
  table_name: string;
  seq_scan: number | string;
  seq_tup_read: number | string;
  idx_scan: number | string;
  n_live_tup: number | string;
  n_dead_tup: number | string;
  n_mod_since_analyze: number | string;
  total_bytes?: number | string;
}

export interface PgIndexStatRow {
  schema_name: string;
  table_name: string;
  index_name: string;
  am_name: string;
  is_unique: boolean;
  is_primary: boolean;
  is_constraint: boolean;
  is_partial: boolean;
  has_expressions: boolean;
  idx_scan: number | string;
  index_bytes: number | string;
  key_columns: string[];
}

export interface PgActivityContentionRow {
  pid: number | string;
  state: string;
  wait_event_type?: string | null;
  wait_event?: string | null;
  blocking_pids?: Array<number | string> | null;
  age_seconds: number | string;
  schema_name?: string | null;
  table_name?: string | null;
}

function fmtInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function qualifyPgObject(schemaName: string | undefined, objectName: string): string {
  if (schemaName && schemaName !== 'public') {
    return `${quoteIdent('postgres', schemaName)}.${quoteIdent('postgres', objectName)}`;
  }
  return quoteIdent('postgres', objectName);
}

function isPrefixOf(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== full[i]) return false;
  }
  return true;
}

function resolveSchemaTable(schema: DatabaseSchema, schemaName: string | undefined, tableName: string): TableMeta | undefined {
  if (schemaName) {
    const exact = schema.tables.find((t) => (t.schema ?? 'public') === schemaName && t.name === tableName);
    if (exact) return exact;
  }
  return findTable(schema, tableName);
}

function sortPerfFindings(findings: PerfFinding[]): PerfFinding[] {
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (b.bytes ?? 0) - (a.bytes ?? 0) ||
      (b.approxRows ?? 0) - (a.approxRows ?? 0) ||
      a.table.localeCompare(b.table) ||
      (a.index ?? '').localeCompare(b.index ?? ''),
  );
}

/**
 * Pure evaluator over PostgreSQL catalog/statistics snapshots, intersected
 * strictly against `schema` so withheld tables and columns never surface.
 */
export function analyzePostgresPerfStats(
  schema: DatabaseSchema,
  connId: string,
  tableStats: readonly PgTableStatRow[],
  indexStats: readonly PgIndexStatRow[],
  options: { table?: string; linkTo?: (conn: string, segment: string) => string } = {},
): { findings: PerfFinding[]; scannedTables: number } {
  const linkFn = options.linkTo ?? ((c: string, s: string) => `/${encodeURIComponent(c)}/${s}`);
  const linkOf = (tableId: string) => linkFn(connId, encodeURIComponent(tableId));
  const wantedTable = options.table ? findTable(schema, options.table) : undefined;

  const findings: PerfFinding[] = [];
  const tableMap = new Map<string, { meta: TableMeta; row: PgTableStatRow }>();

  for (const row of tableStats) {
    const meta = resolveSchemaTable(schema, row.schema_name, row.table_name);
    if (!meta || meta.isView) continue;
    if (wantedTable && meta.id !== wantedTable.id) continue;
    tableMap.set(meta.id, { meta, row });

    const liveTup = Math.max(0, Number(row.n_live_tup ?? 0));
    const deadTup = Math.max(0, Number(row.n_dead_tup ?? 0));
    const seqScan = Math.max(0, Number(row.seq_scan ?? 0));
    const seqTupRead = Math.max(0, Number(row.seq_tup_read ?? 0));
    const idxScan = Math.max(0, Number(row.idx_scan ?? 0));
    const modSinceAnalyze = Math.max(0, Number(row.n_mod_since_analyze ?? 0));
    const totalBytes = row.total_bytes !== undefined ? Math.max(0, Number(row.total_bytes)) : undefined;

    if (liveTup >= 500 && seqScan >= 20 && seqTupRead >= 10_000 && seqScan > idxScan * 2) {
      const severity: Severity = liveTup >= 10_000 && seqTupRead >= 250_000 ? 'high' : 'medium';
      findings.push({
        rule: 'sequential-scan-hotspot',
        severity,
        table: meta.id,
        ...(totalBytes ? { bytes: totalBytes } : {}),
        approxRows: liveTup,
        message: `${fmtInt(seqScan)} sequential scans read ${fmtInt(seqTupRead)} tuples across ~${fmtInt(liveTup)} live rows (vs ${fmtInt(idxScan)} index scans).`,
        link: linkOf(meta.id),
      });
    }

    const totalTuples = liveTup + deadTup;
    if (deadTup >= 1_000 && totalTuples > 0 && deadTup / totalTuples >= 0.2) {
      const pct = Math.round((deadTup / totalTuples) * 100);
      findings.push({
        rule: 'dead-tuple-bloat',
        severity: 'medium',
        table: meta.id,
        ...(totalBytes ? { bytes: totalBytes } : {}),
        approxRows: liveTup,
        message: `${fmtInt(deadTup)} dead tuples (${pct}% of ${fmtInt(totalTuples)} total tuples) awaiting vacuum.`,
        suggestedSql: `VACUUM (ANALYZE) ${qualifyPgObject(row.schema_name, meta.name)};`,
        link: linkOf(meta.id),
      });
    }

    if (modSinceAnalyze >= 1_000 && modSinceAnalyze >= Math.max(1_000, liveTup * 0.25)) {
      findings.push({
        rule: 'stale-statistics',
        severity: 'low',
        table: meta.id,
        approxRows: liveTup,
        message: `${fmtInt(modSinceAnalyze)} row modifications since last ANALYZE (~${fmtInt(liveTup)} live rows).`,
        suggestedSql: `ANALYZE ${qualifyPgObject(row.schema_name, meta.name)};`,
        link: linkOf(meta.id),
      });
    }
  }

  /* Group visible indexes per visible table. Any index touching a withheld/hidden column is skipped. */
  const indexesByTable = new Map<
    string,
    Array<{
      meta: TableMeta;
      row: PgIndexStatRow;
      cols: string[];
      idxScan: number;
      bytes: number;
    }>
  >();

  for (const idxRow of indexStats) {
    const meta = resolveSchemaTable(schema, idxRow.schema_name, idxRow.table_name);
    if (!meta || meta.isView) continue;
    if (wantedTable && meta.id !== wantedTable.id) continue;
    const cols = Array.isArray(idxRow.key_columns)
      ? idxRow.key_columns.filter((c): c is string => typeof c === 'string' && c.length > 0)
      : [];
    const visibleColSet = new Set(meta.columns.map((c) => c.name));
    if (cols.some((c) => !visibleColSet.has(c))) continue;
    if (!idxRow.has_expressions && cols.length === 0) continue;

    let list = indexesByTable.get(meta.id);
    if (!list) {
      list = [];
      indexesByTable.set(meta.id, list);
    }
    list.push({
      meta,
      row: idxRow,
      cols,
      idxScan: Math.max(0, Number(idxRow.idx_scan ?? 0)),
      bytes: Math.max(0, Number(idxRow.index_bytes ?? 0)),
    });
  }

  for (const [tableId, list] of indexesByTable) {
    const duplicateNames = new Set<string>();
    const tableStat = tableMap.get(tableId)?.row;
    const tableActivity = tableStat ? Math.max(0, Number(tableStat.seq_scan ?? 0)) + Math.max(0, Number(tableStat.idx_scan ?? 0)) : 0;

    for (const a of list) {
      if (
        a.row.is_primary ||
        a.row.is_unique ||
        a.row.is_constraint ||
        a.row.is_partial ||
        a.row.has_expressions ||
        a.row.am_name !== 'btree' ||
        a.cols.length === 0
      ) {
        continue;
      }
      const covering = list.find((b) => {
        if (b.row.index_name === a.row.index_name) return false;
        if (b.row.is_partial || b.row.has_expressions || b.row.am_name !== 'btree') return false;
        if (!isPrefixOf(a.cols, b.cols)) return false;
        if (a.cols.length < b.cols.length) return true;
        /* Identical key columns: prefer keeping primary/unique/constraint indexes, else higher scan count, else lexicographically first name. */
        if (b.row.is_primary || b.row.is_unique || b.row.is_constraint) return true;
        if (a.idxScan !== b.idxScan) return a.idxScan < b.idxScan;
        return a.row.index_name > b.row.index_name;
      });
      if (covering) {
        duplicateNames.add(a.row.index_name);
        findings.push({
          rule: 'duplicate-index',
          severity: 'medium',
          table: tableId,
          index: a.row.index_name,
          coveredBy: covering.row.index_name,
          columns: a.cols,
          ...(a.bytes > 0 ? { bytes: a.bytes } : {}),
          message: `Index ${a.row.index_name} (${a.cols.join(', ')}) is a leading prefix of ${covering.row.index_name} (${covering.cols.join(', ')})${a.bytes > 0 ? `, occupying ${fmtBytes(a.bytes)}` : ''}.`,
          suggestedSql: `DROP INDEX CONCURRENTLY ${qualifyPgObject(a.row.schema_name, a.row.index_name)};`,
          link: linkOf(tableId),
        });
      }
    }

    const outgoingFks = referencesFrom(schema, tableId);
    for (const a of list) {
      if (duplicateNames.has(a.row.index_name)) continue;
      if (a.row.is_primary || a.row.is_unique || a.row.is_constraint) continue;
      if (a.idxScan > 0 || a.bytes < 65_536 || tableActivity < 50) continue;

      /* Keep an index that is the only btree index covering an outgoing FK's leading columns (needed for parent DELETE/UPDATE checks). */
      const backsFkAlone =
        !a.row.is_partial &&
        !a.row.has_expressions &&
        a.cols.length > 0 &&
        outgoingFks.some((fk) => {
          if (!isPrefixOf(fk.from.columns, a.cols)) return false;
          const otherCovers = list.some(
            (b) =>
              b.row.index_name !== a.row.index_name &&
              !duplicateNames.has(b.row.index_name) &&
              !b.row.is_partial &&
              !b.row.has_expressions &&
              isPrefixOf(fk.from.columns, b.cols),
          );
          return !otherCovers;
        });
      if (backsFkAlone) continue;

      findings.push({
        rule: 'unused-index',
        severity: 'low',
        table: tableId,
        index: a.row.index_name,
        ...(a.cols.length ? { columns: a.cols } : {}),
        bytes: a.bytes,
        message: `Index ${a.row.index_name} has 0 index scans across ${fmtInt(tableActivity)} table operations (${fmtBytes(a.bytes)}).`,
        suggestedSql: `DROP INDEX CONCURRENTLY ${qualifyPgObject(a.row.schema_name, a.row.index_name)};`,
        link: linkOf(tableId),
      });
    }
  }

  const scannedCount = wantedTable ? (wantedTable.isView ? 0 : 1) : schema.tables.filter((t) => !t.isView).length;
  return {
    findings: sortPerfFindings(findings),
    scannedTables: Math.max(tableMap.size, scannedCount),
  };
}

function extractSqlitePath(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed === ':memory:') return undefined;
  if (trimmed.startsWith('file:')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.searchParams.get('mode') === 'memory') return undefined;
      return decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith('sqlite://')) {
    const rest = trimmed.slice('sqlite://'.length);
    return rest && rest !== ':memory:' ? rest : undefined;
  }
  if (trimmed.startsWith('sqlite:')) {
    const rest = trimmed.slice('sqlite:'.length);
    return rest && rest !== ':memory:' ? rest : undefined;
  }
  if (/^[a-z][\w+.-]*:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

const CONTENTION_DIAGNOSTIC_SQL =
  "SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocking_pids, now() - COALESCE(xact_start, query_start) AS age FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle' ORDER BY age DESC;";

export function analyzePostgresActivityContention(
  schema: DatabaseSchema,
  connectionId: string,
  rows: readonly PgActivityContentionRow[],
  options: {
    table?: string;
    linkTo?: (conn: string, segment: string) => string;
  } = {},
): PerfFinding[] {
  const linkFn = options.linkTo ?? ((c: string, s: string) => `/${encodeURIComponent(c)}/${s}`);
  const targetMeta = options.table ? findTable(schema, options.table) : undefined;
  const findings: PerfFinding[] = [];
  const seenBlockedPid = new Set<string>();
  const seenLongPid = new Set<string>();

  for (const row of rows) {
    const pid = String(row.pid ?? '').trim();
    if (!pid) continue;
    const age = Number(row.age_seconds ?? 0);
    if (!Number.isFinite(age) || age <= 0) continue;

    /* Resolve relation strictly through the policy-filtered schema so blocked/out-of-focus tables never surface. */
    let resolvedTable: TableMeta | undefined;
    if (row.table_name) {
      resolvedTable = resolveSchemaTable(schema, row.schema_name ?? undefined, row.table_name);
      if (!resolvedTable) continue;
    }
    if (targetMeta && (!resolvedTable || resolvedTable.id !== targetMeta.id)) continue;
    if (!resolvedTable && schema.tables.length === 0) continue;

    const tableLabel = resolvedTable?.id ?? targetMeta?.id ?? schema.tables[0]?.id ?? 'database';
    const link = resolvedTable ? linkFn(connectionId, encodeURIComponent(resolvedTable.id)) : `/${encodeURIComponent(connectionId)}`;
    const blockers = (row.blocking_pids ?? []).map((p) => String(p).trim()).filter(Boolean);
    const waitDesc = [row.wait_event_type, row.wait_event].filter(Boolean).join(':');

    if (blockers.length > 0 && age >= 1 && !seenBlockedPid.has(pid)) {
      seenBlockedPid.add(pid);
      findings.push({
        rule: 'lock-contention',
        severity: 'high',
        table: tableLabel,
        ...(resolvedTable?.approxRows !== undefined ? { approxRows: resolvedTable.approxRows } : {}),
        message: `Backend PID ${pid} has been blocked for ${Math.round(age)}s${resolvedTable ? ` on ${resolvedTable.id}` : ''} waiting on PID ${blockers.join(', ')}${waitDesc ? ` (${waitDesc})` : ''}.`,
        suggestedSql: CONTENTION_DIAGNOSTIC_SQL,
        link,
      });
      continue;
    }

    const state = (row.state ?? '').toLowerCase();
    if (
      (state === 'active' || state === 'idle in transaction' || state === 'idle in transaction (aborted)') &&
      age >= 30 &&
      !seenLongPid.has(pid)
    ) {
      seenLongPid.add(pid);
      findings.push({
        rule: 'long-running-query',
        severity: 'medium',
        table: tableLabel,
        ...(resolvedTable?.approxRows !== undefined ? { approxRows: resolvedTable.approxRows } : {}),
        message: `Backend PID ${pid} is "${row.state}" for ${Math.round(age)}s${resolvedTable ? ` holding locks on ${resolvedTable.id}` : ''}${waitDesc ? ` (${waitDesc})` : ''}.`,
        suggestedSql: CONTENTION_DIAGNOSTIC_SQL,
        link,
      });
    }
  }

  return sortPerfFindings(findings);
}

export async function checkPerf(
  registry: Registry,
  id: string,
  schema: DatabaseSchema,
  options: {
    table?: string;
    trusted?: boolean;
    linkTo?: (conn: string, segment: string) => string;
  } = {},
): Promise<{
  dialect: DatabaseSchema['dialect'];
  source: 'pg_stat' | 'sqlite_pragma' | 'catalog_only';
  scannedTables: number;
  findings: PerfFinding[];
}> {
  const config = registry.configOf(id);
  if (!config || config.http || (schema.dialect !== 'sqlite' && schema.dialect !== 'postgres')) {
    throw new ToolError('forbidden', `${schema.dialect} connections do not expose index/scan diagnostics in this build.`);
  }

  const linkFn = options.linkTo ?? ((c: string, s: string) => `/${encodeURIComponent(c)}/${s}`);
  const linkOf = (tableId: string) => linkFn(id, encodeURIComponent(tableId));

  if (schema.dialect === 'postgres') {
    const rawTarget = registry.openableUrlOf(id) ?? config.url;
    const resolved = await resolveConnection(config.name, rawTarget, {
      secrets: options.trusted !== false,
      environment: registry.environment,
    });
    const manager = new PgConnectionManager(resolved.url, undefined, undefined, {
      readers: 1,
      writers: 0,
      readersOnly: true,
      minIdle: 0,
      capMs: 5_000,
    });
    try {
      const { tableRows, indexRows, activityRows } = await manager.withReadClient(async (client) => {
        const hasSchemas = Boolean(config.schemas?.length);
        const schemaFilter = hasSchemas ? ' WHERE schemaname = ANY($1::text[])' : '';
        const indexSchemaFilter = hasSchemas ? ' AND sui.schemaname = ANY($1::text[])' : '';
        const params = hasSchemas ? [config.schemas] : [];

        const tablesRes = await client.query(
          `SELECT
             schemaname AS schema_name,
             relname AS table_name,
             COALESCE(seq_scan, 0)::bigint AS seq_scan,
             COALESCE(seq_tup_read, 0)::bigint AS seq_tup_read,
             COALESCE(idx_scan, 0)::bigint AS idx_scan,
             COALESCE(n_live_tup, 0)::bigint AS n_live_tup,
             COALESCE(n_dead_tup, 0)::bigint AS n_dead_tup,
             COALESCE(n_mod_since_analyze, 0)::bigint AS n_mod_since_analyze,
             pg_total_relation_size(relid)::bigint AS total_bytes
           FROM pg_stat_user_tables${schemaFilter}`,
          params,
        );

        const indexesRes = await client.query(
          `SELECT
             sui.schemaname AS schema_name,
             sui.relname AS table_name,
             sui.indexrelname AS index_name,
             am.amname AS am_name,
             ix.indisunique AS is_unique,
             ix.indisprimary AS is_primary,
             (con.oid IS NOT NULL) AS is_constraint,
             (ix.indpred IS NOT NULL) AS is_partial,
             (ix.indexprs IS NOT NULL) AS has_expressions,
             COALESCE(sui.idx_scan, 0)::bigint AS idx_scan,
             pg_relation_size(sui.indexrelid)::bigint AS index_bytes,
             ARRAY(
               SELECT a.attname
               FROM unnest(ix.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
               LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
               WHERE k.ord <= ix.indnkeyatts
               ORDER BY k.ord
             ) AS key_columns
           FROM pg_stat_user_indexes sui
           JOIN pg_index ix ON ix.indexrelid = sui.indexrelid
           JOIN pg_class ic ON ic.oid = sui.indexrelid
           JOIN pg_am am ON am.oid = ic.relam
           LEFT JOIN pg_constraint con ON con.conindid = sui.indexrelid
           WHERE ix.indisvalid${indexSchemaFilter}`,
          params,
        );

        let actRows: PgActivityContentionRow[] = [];
        try {
          const actRes = await client.query(
            `SELECT
               a.pid,
               a.state,
               a.wait_event_type,
               a.wait_event,
               pg_blocking_pids(a.pid) AS blocking_pids,
               EXTRACT(EPOCH FROM (now() - COALESCE(a.xact_start, a.query_start)))::numeric AS age_seconds,
               rel.schema_name,
               rel.table_name
             FROM pg_stat_activity a
             LEFT JOIN LATERAL (
               SELECT ns.nspname AS schema_name, cl.relname AS table_name
               FROM pg_locks l
               JOIN pg_class cl ON cl.oid = l.relation
               JOIN pg_namespace ns ON ns.oid = cl.relnamespace
               WHERE l.pid = a.pid
                 AND cl.relkind IN ('r', 'p', 'v', 'm')
                 AND ns.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
               ORDER BY l.granted ASC, cl.oid ASC
               LIMIT 1
             ) rel ON true
             WHERE a.datname = current_database()
               AND a.pid <> pg_backend_pid()
               AND a.state IS NOT NULL
               AND a.state <> 'idle'`,
          );
          actRows = actRes.rows as unknown as PgActivityContentionRow[];
        } catch {
          /* Restricted roles without pg_stat_activity visibility still return table/index stats. */
        }

        return {
          tableRows: tablesRes.rows as unknown as PgTableStatRow[],
          indexRows: indexesRes.rows as unknown as PgIndexStatRow[],
          activityRows: actRows,
        };
      }, true);

      const analyzed = analyzePostgresPerfStats(schema, id, tableRows, indexRows, {
        table: options.table,
        linkTo: linkFn,
      });
      const contention = analyzePostgresActivityContention(schema, id, activityRows, {
        table: options.table,
        linkTo: linkFn,
      });
      return {
        dialect: 'postgres',
        source: 'pg_stat',
        scannedTables: analyzed.scannedTables,
        findings: sortPerfFindings([...analyzed.findings, ...contention]),
      };
    } catch (err) {
      throw new ToolError('internal', scrubSecrets((err as Error).message, resolved.url), { cause: err });
    } finally {
      await manager.close().catch(() => {});
    }
  }

  /* SQLite live index & planner diagnostics. */
  let sourceFile = registry.sqliteFile(id);
  if (!sourceFile) {
    const rawTarget = registry.openableUrlOf(id) ?? config.url;
    const resolved = await resolveConnection(config.name, rawTarget, {
      secrets: options.trusted !== false,
      environment: registry.environment,
    });
    sourceFile = extractSqlitePath(resolved.url);
  }

  const candidates = options.table ? [findTable(schema, options.table)].filter((t): t is TableMeta => Boolean(t)) : schema.tables;

  if (!sourceFile) {
    return {
      dialect: 'sqlite',
      source: 'catalog_only',
      scannedTables: candidates.length,
      findings: [],
    };
  }
  const fileInfo = await stat(sourceFile).catch(() => undefined);
  if (!fileInfo?.isFile()) {
    return {
      dialect: 'sqlite',
      source: 'catalog_only',
      scannedTables: candidates.length,
      findings: [],
    };
  }

  const findings: PerfFinding[] = [];
  const db = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    const hasStat1 = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get());

    for (const table of candidates) {
      if (table.isView) {
        try {
          const planRows = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${quoteIdent('sqlite', table.name)} LIMIT 20`).all() as Array<{
            detail?: string;
          }>;
          const reportedScans = new Set<string>();
          for (const row of planRows) {
            const detail = typeof row.detail === 'string' ? row.detail.trim() : '';
            if (!detail || /\bUSING\s+(?:COVERING\s+)?INDEX\b/i.test(detail)) continue;
            const m = /^SCAN\s+(?:TABLE\s+)?(?:"([^"]+)"|([^\s(]+))/i.exec(detail);
            const rawScanned = m?.[1] ?? m?.[2];
            if (!rawScanned || reportedScans.has(rawScanned)) continue;
            const baseMeta = findTable(schema, rawScanned);
            if (!baseMeta || baseMeta.isView) continue;
            const approx = baseMeta.approxRows ?? 0;
            if (approx < 100) continue;
            reportedScans.add(rawScanned);
            findings.push({
              rule: 'view-full-scan',
              severity: 'medium',
              table: table.id,
              approxRows: approx,
              message: `View ${table.id} triggers a full table scan on ${baseMeta.id} (~${fmtInt(approx)} rows).`,
              link: linkOf(table.id),
            });
          }
        } catch {
          /* Ignore broken or unauthorized view plans. */
        }
        continue;
      }

      const visibleCols = new Set(table.columns.map((c) => c.name));
      let rawList: Array<{ name?: string; unique?: number; origin?: string; partial?: number }> = [];
      try {
        rawList = db.prepare(`PRAGMA index_list(${quoteIdent('sqlite', table.name)})`).all() as typeof rawList;
      } catch {
        continue;
      }

      const parsedIndexes: Array<{
        name: string;
        unique: boolean;
        origin: string;
        partial: boolean;
        columns: string[];
      }> = [];

      for (const idx of rawList) {
        if (typeof idx.name !== 'string' || !idx.name) continue;
        let infoRows: Array<{ seqno?: number; name?: string | null }> = [];
        try {
          infoRows = db.prepare(`PRAGMA index_info(${quoteIdent('sqlite', idx.name)})`).all() as typeof infoRows;
        } catch {
          continue;
        }
        if (!infoRows.length) continue;
        /* Skip expression indexes (where `name` is null) or indexes referencing hidden/blocked columns. */
        if (infoRows.some((r) => typeof r.name !== 'string' || !r.name || !visibleCols.has(r.name))) continue;
        const orderedCols = [...infoRows].sort((a, b) => (a.seqno ?? 0) - (b.seqno ?? 0)).map((r) => r.name as string);
        parsedIndexes.push({
          name: idx.name,
          unique: Number(idx.unique ?? 0) !== 0,
          origin: typeof idx.origin === 'string' ? idx.origin : 'c',
          partial: Number(idx.partial ?? 0) !== 0,
          columns: orderedCols,
        });
      }

      for (const a of parsedIndexes) {
        if (a.origin !== 'c' || a.unique || a.partial || a.columns.length === 0) continue;
        const covering = parsedIndexes.find((b) => {
          if (b.name === a.name || b.partial) return false;
          if (!isPrefixOf(a.columns, b.columns)) return false;
          if (a.columns.length < b.columns.length) return true;
          if (b.unique || b.origin !== 'c') return true;
          return a.name > b.name;
        });
        if (covering) {
          findings.push({
            rule: 'duplicate-index',
            severity: 'medium',
            table: table.id,
            index: a.name,
            coveredBy: covering.name,
            columns: a.columns,
            ...(table.approxRows !== undefined ? { approxRows: table.approxRows } : {}),
            message: `Index ${a.name} (${a.columns.join(', ')}) is a leading prefix of ${covering.name} (${covering.columns.join(', ')}).`,
            suggestedSql: `DROP INDEX ${quoteIdent('sqlite', a.name)};`,
            link: linkOf(table.id),
          });
        }
      }

      if (!hasStat1 && (table.approxRows ?? 0) >= 500 && parsedIndexes.length >= 2) {
        findings.push({
          rule: 'missing-analyze-stats',
          severity: 'low',
          table: table.id,
          approxRows: table.approxRows,
          message: `Table ${table.id} (~${fmtInt(table.approxRows ?? 0)} rows) has ${parsedIndexes.length} indexes without sqlite_stat1 selectivity statistics.`,
          suggestedSql: `ANALYZE ${quoteIdent('sqlite', table.name)};`,
          link: linkOf(table.id),
        });
      }
    }
  } finally {
    db.close();
  }

  return {
    dialect: 'sqlite',
    source: 'sqlite_pragma',
    scannedTables: candidates.length,
    findings: sortPerfFindings(findings),
  };
}
