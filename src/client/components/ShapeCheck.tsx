/**
 * What this schema will cost you — and how its tables connect.
 *
 * Unifies five read-only MCP diagnostics in one Workbench surface:
 *   1. Schema & perf (`lint`) — static catalog checks + 1-click index DDL
 *   2. Index & scan health (`perf`) — live index duplicates, scan hotspots, bloat, & stats SQL
 *   3. Data anomalies (`anomalies`) — relational row outliers + 1-click Walk rows
 *   4. Join paths (`path`) — shortest foreign-key walks, index coverage, & runnable query hints
 *   5. Environment drift (`diff`) — schema differences across sibling environments
 */
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, breakdownView, currentEntry, findTable, go, state, tableView } from '@mistriwork/kit/client/core.js';
import { formatNumber } from '@mistriwork/kit/client/locale.js';
import { looksLikeBreakdown } from '@mistriwork/engine/shared/breakdowntext.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { enrichConnectionsWithEnvironments, type EnvironmentTier } from '../../shared/environments.js';
import type { ForeignKeyPath } from '../../shared/path.js';
import { say } from '../copy/workbench/components/ShapeCheck.js';
import './ShapeCheck.css';

export type ShapeTab = 'lint' | 'perf' | 'anomalies' | 'paths' | 'drift';

interface Finding {
  table: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  columns?: string[];
  message: string;
  why?: string;
}
interface LintResult {
  findings?: Finding[];
  rules?: Record<string, { why?: string }>;
  counts?: { high: number; medium: number; low: number };
}
interface PerfFindingItem extends Finding {
  index?: string;
  coveredBy?: string;
  bytes?: number;
  approxRows?: number;
  suggestedSql?: string;
}
interface PerfResult {
  scannedTables?: number;
  findings?: PerfFindingItem[];
  rules?: Record<string, { why?: string }>;
  counts?: { high: number; medium: number; low: number };
}
interface AnomalyFinding extends Finding {
  rows?: number;
  query?: string;
}
interface AnomalyResult {
  scannedTables?: number;
  findings?: AnomalyFinding[];
  rules?: Record<string, { why?: string }>;
  counts?: { high: number; medium: number; low: number };
}
interface PathToolResult {
  from?: string;
  to?: string;
  connected?: boolean;
  paths?: ForeignKeyPath[];
}
interface TableDiffItem {
  table: string;
  onlyIn?: 'left' | 'right';
  columnsOnlyLeft?: string[];
  columnsOnlyRight?: string[];
  changed?: Array<{ column: string; what: string; left: string; right: string }>;
  keysOnlyLeft?: string[];
  keysOnlyRight?: string[];
  deleteRuleChanged?: Array<{ key: string; left: string; right: string }>;
}
interface DiffResult {
  from?: string;
  to?: string;
  same?: boolean;
  tables?: TableDiffItem[];
}
interface ShapeConn {
  id: string;
  name?: string;
  database?: string;
  env?: string;
  tier?: EnvironmentTier;
  redactsRows?: boolean;
}

function quoteIdent(ident: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(ident) ? ident : `"${ident.replace(/"/g, '""')}"`;
}

function qualifiedTableName(meta: TableMeta | undefined, fallback: string): string {
  const baseName = meta?.name ?? fallback;
  return meta?.schema && meta.schema !== 'public' && meta.schema !== 'main'
    ? `${quoteIdent(meta.schema)}.${quoteIdent(baseName)}`
    : quoteIdent(baseName);
}

function buildJoinSqlForPath(path: ForeignKeyPath, tables: TableMeta[]): string | null {
  if (!path.hops.length) return null;
  const byId = new Map(tables.map((t) => [t.id, t]));
  const startId = path.hops[0].from;
  const lines = [
    ['SELECT', `t0.*, t${path.hops.length}.*`].join(' '),
    ['FROM', qualifiedTableName(byId.get(startId), startId), 't0'].join(' '),
  ];
  for (let i = 0; i < path.hops.length; i++) {
    const hop = path.hops[i];
    const nextTable = qualifiedTableName(byId.get(hop.to), hop.to);
    const leftAlias = `t${i}`;
    const rightAlias = `t${i + 1}`;
    const pairs = hop.via.map((viaCol, cIdx) => {
      const targetCol = hop.targetColumns[cIdx] ?? hop.targetColumns[0] ?? 'id';
      return hop.direction === 'to-one'
        ? `${leftAlias}.${quoteIdent(viaCol)} = ${rightAlias}.${quoteIdent(targetCol)}`
        : `${leftAlias}.${quoteIdent(targetCol)} = ${rightAlias}.${quoteIdent(viaCol)}`;
    });
    lines.push(['JOIN', nextTable, rightAlias, 'ON', pairs.join(' AND ')].join(' '));
  }
  lines.push(['LIMIT', '50;'].join(' '));
  return lines.join('\n');
}

function badgeToneFor(counts: { high: number; medium: number; low: number }): string {
  if (counts.high > 0) return ' tone-high';
  if (counts.medium > 0) return ' tone-medium';
  return '';
}

function indexDdlFor(tableMeta: TableMeta | undefined, finding: Finding): string | null {
  if (finding.rule !== 'unindexed-foreign-key' && finding.rule !== 'unindexed-fk') return null;
  let cols = finding.columns?.filter(Boolean) ?? [];
  if (!cols.length) {
    const inferred = /^([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:→|has no index)/.exec(finding.message);
    if (inferred) cols = [inferred[1]];
  }
  if (!cols.length) return null;
  const baseName = tableMeta?.name ?? finding.table;
  const qualified = qualifiedTableName(tableMeta, finding.table);
  const idxName = `idx_${baseName.replace(/[^a-zA-Z0-9_]/g, '_')}_${cols.join('_').replace(/[^a-zA-Z0-9_]/g, '_')}`;
  return `CREATE INDEX ${quoteIdent(idxName)} ON ${qualified} (${cols.map(quoteIdent).join(', ')});`;
}

export function ShapeCheckDialog({ onClose, initialTab = 'lint' }: { onClose: () => void; initialTab?: ShapeTab }) {
  const dialog = useRef<ModalHandle>(null);
  const [tab, setTab] = useState<ShapeTab>(initialTab);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const appState = state as {
    activeConnection?: string;
    connections?: ShapeConn[];
    schema?: { tables?: TableMeta[] };
  };
  const activeId = appState.activeConnection ?? '';
  const schemaTables = appState.schema?.tables ?? [];
  const topEntry = currentEntry() as { table?: string } | undefined;
  const defaultFrom = (topEntry?.table && schemaTables.find((t) => t.id === topEntry.table)?.id) ?? schemaTables[0]?.id ?? '';
  const defaultTo = schemaTables.find((t) => t.id !== defaultFrom)?.id ?? schemaTables[1]?.id ?? defaultFrom;

  const [selectedFrom, setSelectedFrom] = useState<string | null>(null);
  const [selectedTo, setSelectedTo] = useState<string | null>(null);
  const fromTable = (selectedFrom && schemaTables.some((t) => t.id === selectedFrom) ? selectedFrom : defaultFrom) ?? '';
  const toTable = (selectedTo && schemaTables.some((t) => t.id === selectedTo) ? selectedTo : defaultTo) ?? '';

  const enriched = enrichConnectionsWithEnvironments((appState.connections ?? []).map((c) => ({ ...c, name: c.name ?? c.id })));
  const activeConn = enriched.find((c) => c.id === activeId);
  const siblingsFirst = [
    ...enriched.filter((c) => c.id !== activeId && activeConn && c.database.toLowerCase() === activeConn.database.toLowerCase()),
    ...enriched.filter((c) => c.id !== activeId && (!activeConn || c.database.toLowerCase() !== activeConn.database.toLowerCase())),
  ];
  const [selectedCompare, setSelectedCompare] = useState<string | null>(null);
  const compareTarget = siblingsFirst.find((c) => c.id === selectedCompare) ?? siblingsFirst[0];

  /* `all: true` because this is the panel, not an agent's first orientation:
     the tool samples five findings per rule by default, right for an agent
     spending context, wrong for a person who opened a list to read it. */
  const lint = useQuery<{ structuredContent?: LintResult }>({
    queryKey: ['lint', activeId],
    queryFn: () => api('/api/agent/call', { name: 'lint', arguments: { all: true } }),
    enabled: tab === 'lint',
    staleTime: 0,
  });

  const perf = useQuery<{ structuredContent?: PerfResult }>({
    queryKey: ['perf', activeId],
    queryFn: () => api('/api/agent/call', { name: 'perf', arguments: { all: true } }),
    enabled: tab === 'perf',
    staleTime: 0,
  });

  const anomalies = useQuery<{ structuredContent?: AnomalyResult }>({
    queryKey: ['anomalies', activeId],
    queryFn: () => api('/api/agent/call', { name: 'anomalies', arguments: { all: true } }),
    enabled: tab === 'anomalies',
    staleTime: 0,
  });

  const pathQuery = useQuery<{ structuredContent?: PathToolResult }>({
    queryKey: ['shape-path', activeId, fromTable, toTable],
    queryFn: () => api('/api/agent/call', { name: 'path', arguments: { from: fromTable, to: toTable } }),
    enabled: tab === 'paths' && Boolean(fromTable && toTable && fromTable !== toTable),
    staleTime: 0,
  });

  const drift = useQuery<{ structuredContent?: DiffResult }>({
    queryKey: ['shape-diff', activeId, compareTarget?.id ?? ''],
    queryFn: () => api('/api/agent/call', { name: 'diff', arguments: { to: compareTarget!.id } }),
    enabled: tab === 'drift' && Boolean(compareTarget),
    staleTime: 0,
  });

  const close = () => dialog.current?.close();

  const copySql = async (key: string, sqlText: string) => {
    try {
      await navigator.clipboard?.writeText(sqlText);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1500);
    } catch {
      /* Clipboard unavailable. */
    }
  };

  const walkQueryHint = (rawQuery: string) => {
    const trimmed = rawQuery.trim();
    if (!trimmed) return;
    const head = trimmed.split(/\s+/)[0];
    const target = (findTable(head) as TableMeta | undefined)?.id ?? head;
    close();
    const entry = looksLikeBreakdown(trimmed)
      ? (breakdownView as (t: string, q?: string) => unknown)(target, trimmed)
      : (tableView as (t: string, q?: string) => unknown)(target, trimmed);
    go(entry, 'reset');
  };

  const groupFindings = <T extends Finding>(list: T[]) => {
    const map = new Map<string, T[]>();
    for (const f of list) map.set(f.table, [...(map.get(f.table) ?? []), f]);
    return [...map];
  };
  const byRule = <T extends Finding>(list: T[]) => {
    const groups = new Map<string, T[]>();
    for (const f of list) groups.set(f.rule, [...(groups.get(f.rule) ?? []), f]);
    return [...groups];
  };

  const result = lint.data?.structuredContent ?? {};
  const findings = result.findings ?? [];
  const rules = result.rules ?? {};
  const counts = result.counts ?? { high: 0, medium: 0, low: 0 };

  const perfResult = perf.data?.structuredContent ?? {};
  const perfList = perfResult.findings ?? [];
  const perfRules = perfResult.rules ?? {};
  const perfCounts = perfResult.counts ?? { high: 0, medium: 0, low: 0 };

  const anomalyResult = anomalies.data?.structuredContent ?? {};
  const anomalyList = anomalyResult.findings ?? [];
  const anomalyRules = anomalyResult.rules ?? {};
  const anomalyCounts = anomalyResult.counts ?? { high: 0, medium: 0, low: 0 };

  const pathResult = pathQuery.data?.structuredContent ?? {};
  const pathsList = pathResult.paths ?? [];

  const diffResult = drift.data?.structuredContent ?? {};
  const diffTables = diffResult.tables ?? [];
  const compareLabel = compareTarget ? (compareTarget.env ? `${compareTarget.database}@${compareTarget.env}` : compareTarget.name) : '';

  const openSqlInEditor = (sqlText: string) => {
    close();
    void import('../sql.js').then((m) => m.openSql(sqlText));
  };

  return (
    <Modal className="shape-check-dialog shape-check" ref={dialog} onClose={onClose} ariaLabel={say('checkTheShape')} plain backdrop>
      <div className="shape-dialog-head">
        <div className="shape-dialog-title-row">
          <h2>{say('checkTheShape')}</h2>
          {activeConn ? (
            <span className={`env-pill compact tone-${activeConn.tier}`}>
              <span className="env-pill-dot" aria-hidden="true" />
              <span>{activeConn.env ? `${activeConn.database}@${activeConn.env}` : activeConn.name}</span>
            </span>
          ) : null}
          {activeConn?.redactsRows ? <span className="conn-badge">{say('maskedBadge')}</span> : null}
        </div>
        <button type="button" className="shape-dialog-close" aria-label={say('common.close')} onClick={close}>
          ×
        </button>
      </div>

      <div className="shape-check-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-label={say('tabSchemaPerf')}
          aria-selected={tab === 'lint'}
          className={`shape-check-tab${tab === 'lint' ? ' active' : ''}`}
          onClick={() => setTab('lint')}
        >
          <span>{say('tabSchemaPerf')}</span>
          {lint.isSuccess ? <span className={`shape-tab-badge${badgeToneFor(counts)}`}>{findings.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-label={say('tabLivePerf')}
          aria-selected={tab === 'perf'}
          className={`shape-check-tab${tab === 'perf' ? ' active' : ''}`}
          onClick={() => setTab('perf')}
        >
          <span>{say('tabLivePerf')}</span>
          {perf.isSuccess ? <span className={`shape-tab-badge${badgeToneFor(perfCounts)}`}>{perfList.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-label={say('tabAnomalies')}
          aria-selected={tab === 'anomalies'}
          className={`shape-check-tab${tab === 'anomalies' ? ' active' : ''}`}
          onClick={() => setTab('anomalies')}
        >
          <span>{say('tabAnomalies')}</span>
          {anomalies.isSuccess ? <span className={`shape-tab-badge${badgeToneFor(anomalyCounts)}`}>{anomalyList.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-label={say('tabJoinPaths')}
          aria-selected={tab === 'paths'}
          className={`shape-check-tab${tab === 'paths' ? ' active' : ''}`}
          onClick={() => setTab('paths')}
        >
          <span>{say('tabJoinPaths')}</span>
        </button>
        {siblingsFirst.length > 0 ? (
          <button
            type="button"
            role="tab"
            aria-label={say('tabEnvDrift')}
            aria-selected={tab === 'drift'}
            className={`shape-check-tab${tab === 'drift' ? ' active' : ''}`}
            onClick={() => setTab('drift')}
          >
            <span>{say('tabEnvDrift')}</span>
            {drift.isSuccess ? (
              <span className={`shape-tab-badge${diffTables.length > 0 ? ' tone-medium' : ''}`}>{diffTables.length}</span>
            ) : null}
          </button>
        ) : null}
      </div>

      <div className="shape-dialog-body">
        {tab === 'lint' && lint.isPending ? (
          <p className="loading">{say('readingTheCatalog')}</p>
        ) : tab === 'lint' && lint.isError ? (
          <p className="note">{(lint.error as Error).message}</p>
        ) : tab === 'lint' ? (
          <>
            <p className="find-note">
              <span>
                {findings.length
                  ? say('highMediumLowRead', { high: counts.high, medium: counts.medium, low: counts.low })
                  : say('nothingToReportNoMissing')}
              </span>
            </p>
            {groupFindings(findings).map(([table, list]) => {
              const meta = findTable(table) as TableMeta | undefined;
              return (
                <div key={table} className="shape-check-group">
                  {/* Every finding is about a table, and the useful next move is looking at it. */}
                  <div className="shape-check-group-head">
                    <button
                      type="button"
                      className="shape-check-table"
                      title={say('openTable', { table })}
                      onClick={() => {
                        close();
                        go(tableView(meta?.id ?? table), 'reset');
                      }}
                    >
                      <span>{meta?.name ?? table}</span>
                      <span className="shape-check-count">{`${list.length}`}</span>
                    </button>
                    {meta?.approxRows !== undefined ? (
                      <span className="shape-check-approx">{say('approxRowsTag', { rows: formatNumber(meta.approxRows) })}</span>
                    ) : null}
                  </div>
                  {byRule(list).map(([rule, found]) => (
                    <div key={rule} className={`shape-check-rule-group tone-${found[0].severity ?? 'low'}`}>
                      <p className="shape-check-why">
                        <span className="shape-check-rule">{rule}</span>
                        <span>{rules[rule]?.why ?? found[0].why ?? ''}</span>
                      </p>
                      {found.map((finding, i) => {
                        const ddl = indexDdlFor(meta, finding);
                        const key = `${table}:${rule}:${i}`;
                        return (
                          <div key={i} className="shape-check-item-block">
                            <div className="shape-check-item shape-check-item-row">
                              <span>{finding.message}</span>
                            </div>
                            {ddl ? (
                              <div className="shape-check-sql-box">
                                <code className="shape-check-sql-code">{ddl}</code>
                                <div className="shape-check-btn-group">
                                  <button
                                    type="button"
                                    className="shape-check-inline-btn"
                                    title={ddl}
                                    onClick={() => void copySql(key, ddl)}
                                  >
                                    {copiedKey === key ? say('copiedIndexSql') : say('copyIndexSql')}
                                  </button>
                                  <button type="button" className="shape-check-inline-btn" onClick={() => openSqlInEditor(ddl)}>
                                    {say('openInSql')}
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              );
            })}
          </>
        ) : tab === 'perf' ? (
          perf.isPending ? (
            <p className="loading">{say('scanningPerfStats')}</p>
          ) : perf.isError ? (
            <p className="note">{(perf.error as Error).message}</p>
          ) : (
            <>
              <p className="find-note">
                <span>
                  {perfList.length
                    ? say('perfSummary', {
                        high: perfCounts.high,
                        medium: perfCounts.medium,
                        low: perfCounts.low,
                        tables: formatNumber(perfResult.scannedTables ?? 0),
                      })
                    : say('noPerfFindings')}
                </span>
              </p>
              {groupFindings(perfList).map(([table, list]) => {
                const meta = findTable(table) as TableMeta | undefined;
                const approx = meta?.approxRows ?? list.find((f) => f.approxRows !== undefined)?.approxRows;
                return (
                  <div key={table} className="shape-check-group">
                    <div className="shape-check-group-head">
                      <button
                        type="button"
                        className="shape-check-table"
                        title={say('openTable', { table })}
                        onClick={() => {
                          close();
                          go(tableView(meta?.id ?? table), 'reset');
                        }}
                      >
                        <span>{meta?.name ?? table}</span>
                        <span className="shape-check-count">{`${list.length}`}</span>
                      </button>
                      {approx !== undefined ? (
                        <span className="shape-check-approx">{say('approxRowsTag', { rows: formatNumber(approx) })}</span>
                      ) : null}
                    </div>
                    {byRule(list).map(([rule, found]) => (
                      <div key={rule} className={`shape-check-rule-group tone-${found[0].severity ?? 'low'}`}>
                        <p className="shape-check-why">
                          <span className="shape-check-rule">{rule}</span>
                          <span>{perfRules[rule]?.why ?? found[0].why ?? ''}</span>
                        </p>
                        {found.map((finding, i) => {
                          const sqlText = finding.suggestedSql;
                          const key = `perf:${table}:${rule}:${i}`;
                          return (
                            <div key={i} className="shape-check-item-block">
                              <div className="shape-check-item shape-check-item-row">
                                <span>{finding.message}</span>
                              </div>
                              {sqlText ? (
                                <div className="shape-check-sql-box">
                                  <code className="shape-check-sql-code">{sqlText}</code>
                                  <div className="shape-check-btn-group">
                                    <button
                                      type="button"
                                      className="shape-check-inline-btn"
                                      title={sqlText}
                                      onClick={() => void copySql(key, sqlText)}
                                    >
                                      {copiedKey === key ? say('copiedIndexSql') : say('copySql')}
                                    </button>
                                    <button type="button" className="shape-check-inline-btn" onClick={() => openSqlInEditor(sqlText)}>
                                      {say('openInSql')}
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )
        ) : tab === 'anomalies' ? (
          anomalies.isPending ? (
            <p className="loading">{say('scanningDataAnomalies')}</p>
          ) : anomalies.isError ? (
            <p className="note">{(anomalies.error as Error).message}</p>
          ) : (
            <>
              <p className="find-note">
                <span>
                  {anomalyList.length
                    ? say('anomaliesSummary', {
                        high: anomalyCounts.high,
                        medium: anomalyCounts.medium,
                        low: anomalyCounts.low,
                        tables: formatNumber(anomalyResult.scannedTables ?? 0),
                      })
                    : say('noAnomaliesFound')}
                </span>
              </p>
              {groupFindings(anomalyList).map(([table, list]) => {
                const meta = findTable(table) as TableMeta | undefined;
                return (
                  <div key={table} className="shape-check-group">
                    <button
                      type="button"
                      className="shape-check-table"
                      title={say('openTable', { table })}
                      onClick={() => {
                        close();
                        go(tableView(meta?.id ?? table), 'reset');
                      }}
                    >
                      <span>{meta?.name ?? table}</span>
                      <span className="shape-check-count">{`${list.length}`}</span>
                    </button>
                    {byRule(list).map(([rule, found]) => (
                      <div key={rule} className={`shape-check-rule-group tone-${found[0].severity ?? 'low'}`}>
                        <p className="shape-check-why">
                          <span className="shape-check-rule">{rule}</span>
                          <span>{anomalyRules[rule]?.why ?? found[0].why ?? ''}</span>
                        </p>
                        {found.map((finding, i) => (
                          <div key={i} className="shape-check-item shape-check-item-row">
                            <span>{finding.message}</span>
                            {finding.query ? (
                              <button type="button" className="shape-check-inline-btn" onClick={() => walkQueryHint(finding.query!)}>
                                {say('walkRows')}
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )
        ) : tab === 'paths' ? (
          schemaTables.length < 2 ? (
            <p className="find-note">{say('needTwoTablesForPath')}</p>
          ) : (
            <>
              <div className="shape-check-path-bar">
                <label className="shape-check-path-field">
                  <span>{say('pathFromLabel')}</span>
                  <select
                    className="shape-check-path-select"
                    aria-label={say('pathFromLabel')}
                    value={fromTable}
                    onChange={(e) => setSelectedFrom(e.currentTarget.value)}
                  >
                    {schemaTables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="shape-check-inline-btn"
                  title={say('swapTablesTitle')}
                  onClick={() => {
                    setSelectedFrom(toTable);
                    setSelectedTo(fromTable);
                  }}
                >
                  {say('swapTables')}
                </button>
                <label className="shape-check-path-field">
                  <span>{say('pathToLabel')}</span>
                  <select
                    className="shape-check-path-select"
                    aria-label={say('pathToLabel')}
                    value={toTable}
                    onChange={(e) => setSelectedTo(e.currentTarget.value)}
                  >
                    {schemaTables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {fromTable === toTable ? (
                <p className="find-note">{say('selectDifferentTables')}</p>
              ) : pathQuery.isPending ? (
                <p className="loading">{say('findingPaths')}</p>
              ) : pathQuery.isError ? (
                <p className="note">{(pathQuery.error as Error).message}</p>
              ) : !pathsList.length ? (
                <p className="find-note">{say('noPathsFound', { from: fromTable, to: toTable })}</p>
              ) : (
                <>
                  <p className="find-note">{say('pathsSummary', { count: pathsList.length, from: fromTable, to: toTable })}</p>
                  {pathsList.map((p, idx) => {
                    const joinSql = buildJoinSqlForPath(p, schemaTables);
                    const joinKey = `join-sql:${idx}`;
                    return (
                      <div key={idx} className="shape-check-group">
                        <div className={`shape-check-rule-group tone-${p.unindexedHops > 0 ? 'medium' : 'low'}`}>
                          <div className="shape-check-path-head">
                            <div className="shape-check-path-badges">
                              <span className="conn-badge">{say('hopsBadge', { count: p.length })}</span>
                              {p.unindexedHops > 0 ? (
                                <span className="shape-hop-status is-unindexed">
                                  {say('unindexedHopsBadge', { count: p.unindexedHops })}
                                </span>
                              ) : (
                                <span className="shape-hop-status is-indexed">{say('allHopsIndexed')}</span>
                              )}
                            </div>
                            <div className="shape-check-btn-group">
                              {p.queryHint ? (
                                <button type="button" className="shape-check-inline-btn" onClick={() => walkQueryHint(p.queryHint!)}>
                                  {say('walkRows')}
                                </button>
                              ) : null}
                              {joinSql ? (
                                <>
                                  <button
                                    type="button"
                                    className="shape-check-inline-btn"
                                    title={joinSql}
                                    onClick={() => void copySql(joinKey, joinSql)}
                                  >
                                    {copiedKey === joinKey ? say('copiedJoinSql') : say('copyJoinSql')}
                                  </button>
                                  <button type="button" className="shape-check-inline-btn" onClick={() => openSqlInEditor(joinSql)}>
                                    {say('openInSql')}
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </div>
                          {p.queryHint ? <pre className="shape-check-query-hint">{p.queryHint}</pre> : null}
                          <div className="shape-check-hop-list">
                            {p.hops.map((hop, hIdx) => {
                              const hopKey = `path:${idx}:${hIdx}`;
                              return (
                                <div key={hIdx} className="shape-check-hop">
                                  <div className="shape-check-hop-main">
                                    <span className="shape-hop-table">{hop.from}</span>
                                    <span className="conn-badge">{hop.direction === 'to-one' ? say('hopToOne') : say('hopToMany')}</span>
                                    <span className="shape-hop-table">{hop.to}</span>
                                    <span className="shape-hop-via">{`(${hop.via.join(', ')})`}</span>
                                    {hop.scannedApproxRows !== undefined ? (
                                      <span className="shape-check-approx">
                                        {say('approxRowsTag', { rows: formatNumber(hop.scannedApproxRows) })}
                                      </span>
                                    ) : null}
                                    {hop.indexed === false ? (
                                      <span className="shape-hop-status is-unindexed">{say('unindexedBadge')}</span>
                                    ) : hop.indexed === true ? (
                                      <span className="shape-hop-status is-indexed">{say('indexedBadge')}</span>
                                    ) : null}
                                  </div>
                                  {hop.suggestedIndex ? (
                                    <div className="shape-check-btn-group">
                                      <button
                                        type="button"
                                        className="shape-check-inline-btn"
                                        title={hop.suggestedIndex}
                                        onClick={() => void copySql(hopKey, hop.suggestedIndex!)}
                                      >
                                        {copiedKey === hopKey ? say('copiedIndexSql') : say('copyIndexSql')}
                                      </button>
                                      <button
                                        type="button"
                                        className="shape-check-inline-btn"
                                        onClick={() => openSqlInEditor(hop.suggestedIndex!)}
                                      >
                                        {say('openInSql')}
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )
        ) : (
          <>
            <div className="shape-check-drift-bar">
              <span className="shape-check-drift-label">{say('compareAgainst')}</span>
              {siblingsFirst.map((c) => {
                const activeChoice = c.id === compareTarget?.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`env-pill tone-${c.tier}${activeChoice ? ' active' : ''}`}
                    aria-pressed={activeChoice}
                    onClick={() => setSelectedCompare(c.id)}
                  >
                    <span className="env-pill-dot" aria-hidden="true" />
                    <span>{c.env ? `${c.database}@${c.env}` : c.name}</span>
                  </button>
                );
              })}
            </div>
            {drift.isPending ? (
              <p className="loading">{say('comparingEnvironments')}</p>
            ) : drift.isError ? (
              <p className="note">{(drift.error as Error).message}</p>
            ) : diffResult.same || !diffTables.length ? (
              <p className="find-note">{say('driftIdentical', { other: compareLabel })}</p>
            ) : (
              <>
                <p className="find-note">{say('driftSummary', { count: diffTables.length, other: compareLabel })}</p>
                {diffTables.map((td) => {
                  const meta = findTable(td.table) as TableMeta | undefined;
                  return (
                    <div key={td.table} className="shape-check-group">
                      <button
                        type="button"
                        className="shape-check-table"
                        disabled={td.onlyIn === 'right'}
                        title={say('openTable', { table: td.table })}
                        onClick={() => {
                          if (td.onlyIn === 'right') return;
                          close();
                          go(tableView(meta?.id ?? td.table), 'reset');
                        }}
                      >
                        <span>{meta?.name ?? td.table}</span>
                      </button>
                      <div className="shape-check-rule-group tone-medium">
                        {td.onlyIn === 'left' ? <p className="shape-check-diff-line">{say('onlyHere')}</p> : null}
                        {td.onlyIn === 'right' ? (
                          <p className="shape-check-diff-line">{say('onlyInOther', { other: compareLabel })}</p>
                        ) : null}
                        {td.columnsOnlyLeft?.length ? (
                          <p className="shape-check-diff-line">{say('colsOnlyHere', { columns: td.columnsOnlyLeft.join(', ') })}</p>
                        ) : null}
                        {td.columnsOnlyRight?.length ? (
                          <p className="shape-check-diff-line">{say('colsOnlyOther', { columns: td.columnsOnlyRight.join(', ') })}</p>
                        ) : null}
                        {td.changed?.map((ch, idx) => (
                          <p key={idx} className="shape-check-diff-line">
                            {say('colChanged', { column: ch.column, what: ch.what, left: ch.left, right: ch.right })}
                          </p>
                        ))}
                        {td.keysOnlyLeft?.length ? (
                          <p className="shape-check-diff-line">{say('keysOnlyHere', { keys: td.keysOnlyLeft.join('; ') })}</p>
                        ) : null}
                        {td.keysOnlyRight?.length ? (
                          <p className="shape-check-diff-line">{say('keysOnlyOther', { keys: td.keysOnlyRight.join('; ') })}</p>
                        ) : null}
                        {td.deleteRuleChanged?.map((dr, idx) => (
                          <p key={idx} className="shape-check-diff-line">
                            {say('deleteRuleDiff', { key: dr.key, left: dr.left, right: dr.right })}
                          </p>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
