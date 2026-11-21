/**
 * Data-level counterpart to `lint`: relational anomalies in the stored rows.
 *
 * `lint` reads the catalog alone, so it can tell you a foreign key is unindexed
 * and cannot tell you that 99% of `invoice.customer_id` is populated while four
 * rows sit null, or that three work orders have `completed_at < created_at`, or
 * that active subscriptions point at soft-deleted accounts.
 *
 * Every check here runs through `adapter.count` and `adapter.countView` over
 * compiled queries (`parseQuery`, `textToView`), never raw SQL:
 *
 *   - every finding carries the exact `query` and `link` to open the offending
 *     rows in one click or one `query` call;
 *   - no row values leave the database, so `anomalies` works on `"rows": false`
 *     (shape-only) and `"hidden"`-column connections alike.
 */
import {
  findTable,
  parseQuery,
  referencesFrom,
  textToView,
  type Adapter,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/host';
import { hopName } from '@mistriwork/engine/shared/view.js';
import type { Severity } from '../shared/lint.js';

export type AnomalyRule = 'temporal-inversion' | 'dangling-lifecycle' | 'nearly-always-present-fk';

export interface AnomalyFinding {
  rule: AnomalyRule;
  severity: Severity;
  table: string;
  columns: string[];
  rows: number;
  capped?: boolean;
  total?: number;
  message: string;
  /** Ready-to-run query in tablewalk's query language that isolates the offending rows. */
  query: string;
  /** Deep link to open the offending rows in the tablewalk browser. */
  link: string;
}

export const ANOMALY_RULES: Record<AnomalyRule, { severity: Severity; why: string }> = {
  'temporal-inversion': {
    severity: 'high',
    why: 'A lifecycle timestamp precedes the event it has to follow (for example, `completed_at < created_at` or `ended_at < started_at`), which breaks duration math, range filters and timeline ordering.',
  },
  'dangling-lifecycle': {
    severity: 'high',
    why: 'Open or active child rows point at a parent row that is soft-deleted, archived or inactive: foreign keys still hold because the parent row was never deleted, so reports and background jobs process records whose owner is gone.',
  },
  'nearly-always-present-fk': {
    severity: 'medium',
    why: 'A nullable foreign key is populated on at least 95% of rows (20+ rows total) with a small tail of nulls — usually an unstated NOT NULL invariant with orphan outliers that will reject an `ALTER COLUMN ... SET NOT NULL` or disappear under an INNER JOIN.',
  },
};

const TEMPORAL_PAIRS: ReadonlyArray<readonly [earlier: string, later: string]> = [
  ['created_at', 'updated_at'],
  ['created_at', 'deleted_at'],
  ['created_at', 'archived_at'],
  ['created_at', 'closed_at'],
  ['created_at', 'completed_at'],
  ['created_at', 'resolved_at'],
  ['started_at', 'ended_at'],
  ['started_at', 'finished_at'],
  ['starts_at', 'ends_at'],
  ['start_date', 'end_date'],
  ['opened_at', 'closed_at'],
  ['opened_at', 'resolved_at'],
  ['issued_at', 'paid_at'],
  ['issued_on', 'paid_on'],
  ['invoice_date', 'paid_date'],
  ['ordered_at', 'shipped_at'],
  ['shipped_at', 'delivered_at'],
];

const SOFT_DELETE_COLS = ['deleted_at', 'archived_at', 'deactivated_at', 'disabled_at', 'terminated_at'] as const;
const CHILD_CLOSED_COLS = ['deleted_at', 'archived_at', 'closed_at', 'completed_at', 'ended_at', 'cancelled_at', 'canceled_at'] as const;

const COUNT_CAP = 10_000;
const MAX_TABLES_DEFAULT = 60;
const MIN_ROWS_FOR_RATIO = 20;
const MAX_NULL_OUTLIER_FRAC = 0.05;

function isTemporalColumn(table: TableMeta, name: string): boolean {
  const col = table.columns.find((c) => c.name === name);
  if (!col) return false;
  return /(date|time|timestamp)/i.test(col.type);
}

function isBooleanColumn(table: TableMeta, name: string): boolean {
  const col = table.columns.find((c) => c.name === name);
  if (!col) return false;
  return /^bool/i.test(col.type);
}

async function countQueryText(
  adapter: Adapter,
  schema: DatabaseSchema,
  queryText: string,
): Promise<{ count: number; capped: boolean } | null> {
  const parsed = parseQuery(queryText, { schema });
  if (parsed.query && !parsed.errors.length) {
    const raw = await adapter.count(parsed.query.table, parsed.query.filter, COUNT_CAP + 1);
    return { count: Math.min(raw, COUNT_CAP), capped: raw > COUNT_CAP };
  }
  if (adapter.countView) {
    const asView = textToView(schema, queryText, { id: 'anomaly', name: '' });
    if (asView.view && !asView.errors.length) {
      const raw = await adapter.countView(asView.view, COUNT_CAP + 1);
      return { count: Math.min(raw, COUNT_CAP), capped: raw > COUNT_CAP };
    }
  }
  return null;
}

export async function checkAnomalies(
  adapter: Adapter,
  schema: DatabaseSchema,
  connId: string,
  options: { table?: string; linkTo: (conn: string, segment: string) => string } = {
    linkTo: (c, s) => `/${encodeURIComponent(c)}/${s}`,
  },
): Promise<{ findings: AnomalyFinding[]; scannedTables: number; skippedTables?: number }> {
  const candidates = options.table
    ? [findTable(schema, options.table)].filter((t): t is TableMeta => Boolean(t))
    : schema.tables.filter((t) => !t.isView);

  const tables = options.table ? candidates : candidates.slice(0, MAX_TABLES_DEFAULT);
  const skippedTables = options.table ? 0 : Math.max(0, candidates.length - tables.length);
  const findings: AnomalyFinding[] = [];

  const linkOf = (q: string) => options.linkTo(connId, encodeURIComponent(q).replace(/!/g, '%21'));

  for (const table of tables) {
    const totalRaw = await adapter.count(table.id, undefined, COUNT_CAP + 1);
    if (totalRaw === 0) continue;
    const total = Math.min(totalRaw, COUNT_CAP);

    /* 1. Temporal inversions on lifecycle pairs. */
    for (const [earlier, later] of TEMPORAL_PAIRS) {
      if (!isTemporalColumn(table, earlier) || !isTemporalColumn(table, later)) continue;
      const q = `${table.id} ${later} < ${earlier}`;
      const counted = await countQueryText(adapter, schema, q);
      if (counted && counted.count > 0) {
        findings.push({
          rule: 'temporal-inversion',
          severity: 'high',
          table: table.id,
          columns: [earlier, later],
          rows: counted.count,
          ...(counted.capped ? { capped: true } : {}),
          total,
          message: `${counted.count}${counted.capped ? '+' : ''} row${counted.count === 1 ? '' : 's'} have ${later} earlier than ${earlier}.`,
          query: q,
          link: linkOf(q),
        });
      }
    }

    /* 2. Foreign-key checks: dangling lifecycles and nearly-always-present nullable FKs. */
    for (const fk of referencesFrom(schema, table.id)) {
      const parent = findTable(schema, fk.to.table);

      /* 2a. Dangling lifecycle across the FK hop (requires multi-table view count). */
      if (parent && parent.id !== table.id && adapter.countView) {
        const hop = hopName(fk);
        const parentSoftDel = SOFT_DELETE_COLS.find((c) => isTemporalColumn(parent, c));
        if (parentSoftDel) {
          const childClosed = CHILD_CLOSED_COLS.find((c) => isTemporalColumn(table, c));
          const childActive = !childClosed && isBooleanColumn(table, 'active');
          const clause = childClosed
            ? `${childClosed} is empty and ${hop}.${parentSoftDel} is not empty`
            : childActive
              ? `active = true and ${hop}.${parentSoftDel} is not empty`
              : `${hop}.${parentSoftDel} is not empty`;
          const q = `${table.id} ${clause}`;
          const counted = await countQueryText(adapter, schema, q);
          if (counted && counted.count > 0) {
            findings.push({
              rule: 'dangling-lifecycle',
              severity: 'high',
              table: table.id,
              columns: [...fk.from.columns],
              rows: counted.count,
              ...(counted.capped ? { capped: true } : {}),
              total,
              message:
                `${counted.count}${counted.capped ? '+' : ''} ${childClosed || childActive ? 'open ' : ''}row${counted.count === 1 ? '' : 's'} ` +
                `point via ${fk.from.columns.join(', ')} at ${parent.id} with ${parentSoftDel} set.`,
              query: q,
              link: linkOf(q),
            });
          }
        } else if (isBooleanColumn(parent, 'active') && isBooleanColumn(table, 'active')) {
          const q = `${table.id} active = true and ${hop}.active = false`;
          const counted = await countQueryText(adapter, schema, q);
          if (counted && counted.count > 0) {
            findings.push({
              rule: 'dangling-lifecycle',
              severity: 'high',
              table: table.id,
              columns: [...fk.from.columns, 'active'],
              rows: counted.count,
              ...(counted.capped ? { capped: true } : {}),
              total,
              message: `${counted.count}${counted.capped ? '+' : ''} active row${counted.count === 1 ? '' : 's'} point via ${fk.from.columns.join(', ')} at an inactive ${parent.id}.`,
              query: q,
              link: linkOf(q),
            });
          }
        }
      }

      /* 2b. Nullable single-column FK that is >=95% populated with a small outlier tail of nulls. */
      if (fk.from.columns.length === 1 && total >= MIN_ROWS_FOR_RATIO && totalRaw <= COUNT_CAP) {
        const fkColName = fk.from.columns[0];
        const fkCol = table.columns.find((c) => c.name === fkColName);
        if (!fkCol?.nullable) continue;
        const q = `${table.id} ${fkColName} is empty`;
        const counted = await countQueryText(adapter, schema, q);
        if (!counted || counted.count === 0) continue;
        const frac = counted.count / total;
        if (frac <= MAX_NULL_OUTLIER_FRAC) {
          const pct = (((total - counted.count) / total) * 100).toFixed(1).replace(/\.0$/, '');
          findings.push({
            rule: 'nearly-always-present-fk',
            severity: 'medium',
            table: table.id,
            columns: [fkColName],
            rows: counted.count,
            total,
            message: `${pct}% of ${total} rows populate ${fkColName} (→ ${fk.to.table}), leaving ${counted.count} null row${counted.count === 1 ? '' : 's'}.`,
            query: q,
            link: linkOf(q),
          });
        }
      }
    }
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.rows - a.rows || a.table.localeCompare(b.table));

  return {
    findings,
    scannedTables: tables.length,
    ...(skippedTables ? { skippedTables } : {}),
  };
}
