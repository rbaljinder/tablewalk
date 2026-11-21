/**
 * What this schema will cost you.
 *
 * The `lint` tool answers it for an agent and `--lint` answers it for CI;
 * this is the same tool through the same endpoint, for the person who can
 * actually fix the unindexed key. Every finding is a fact already on screen
 * somewhere — the keys in the diagram, the types in the table view — and
 * what the check adds is the consequence, which nobody reads a catalog to
 * work out. Findings are grouped by table, then by rule with the cost said
 * once: four findings of one rule are four columns and one consequence.
 */
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, findTable, go, state, tableView } from '@mistriwork/kit/client/core.js';
import { formatNumber } from '@mistriwork/kit/client/locale.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { enrichConnectionsWithEnvironments, type EnvironmentTier } from '../../shared/environments.js';
import { say } from '../copy/workbench/components/ShapeCheck.js';
import './ShapeCheck.css';

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
}

function quoteIdent(ident: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(ident) ? ident : `"${ident.replace(/"/g, '""')}"`;
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
  const qualified =
    tableMeta?.schema && tableMeta.schema !== 'public' && tableMeta.schema !== 'main'
      ? `${quoteIdent(tableMeta.schema)}.${quoteIdent(baseName)}`
      : quoteIdent(baseName);
  const idxName = `idx_${baseName.replace(/[^a-zA-Z0-9_]/g, '_')}_${cols.join('_').replace(/[^a-zA-Z0-9_]/g, '_')}`;
  return `CREATE INDEX ${quoteIdent(idxName)} ON ${qualified} (${cols.map(quoteIdent).join(', ')});`;
}

export function ShapeCheckDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<ModalHandle>(null);
  const [tab, setTab] = useState<'lint' | 'anomalies' | 'drift'>('lint');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const appState = state as {
    activeConnection?: string;
    connections?: ShapeConn[];
  };
  const activeId = appState.activeConnection ?? '';
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
    staleTime: 0,
  });

  const anomalies = useQuery<{ structuredContent?: AnomalyResult }>({
    queryKey: ['anomalies', activeId],
    queryFn: () => api('/api/agent/call', { name: 'anomalies', arguments: { all: true } }),
    enabled: tab === 'anomalies',
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

  const anomalyResult = anomalies.data?.structuredContent ?? {};
  const anomalyList = anomalyResult.findings ?? [];
  const anomalyRules = anomalyResult.rules ?? {};
  const anomalyCounts = anomalyResult.counts ?? { high: 0, medium: 0, low: 0 };

  const diffResult = drift.data?.structuredContent ?? {};
  const diffTables = diffResult.tables ?? [];
  const compareLabel = compareTarget ? (compareTarget.env ? `${compareTarget.database}@${compareTarget.env}` : compareTarget.name) : '';

  return (
    <Modal className="conn-manager shape-check" ref={dialog} onClose={onClose} ariaLabel={say('checkTheShape')} plain backdrop={false}>
      <div className="conn-inner">
        {tab === 'lint' && lint.isPending ? (
          <p className="loading">{say('readingTheCatalog')}</p>
        ) : tab === 'lint' && lint.isError ? (
          <p className="note">{(lint.error as Error).message}</p>
        ) : (
          <>
            <div className="conn-head">
              <h2>{say('checkTheShape')}</h2>
              <button type="button" className="ghost" aria-label={say('common.close')} onClick={close}>
                ×
              </button>
            </div>
            <div className="shape-check-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'lint'}
                className={`shape-check-tab${tab === 'lint' ? ' active' : ''}`}
                onClick={() => setTab('lint')}
              >
                {say('tabSchemaPerf')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'anomalies'}
                className={`shape-check-tab${tab === 'anomalies' ? ' active' : ''}`}
                onClick={() => setTab('anomalies')}
              >
                {say('tabAnomalies')}
              </button>
              {siblingsFirst.length > 0 ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'drift'}
                  className={`shape-check-tab${tab === 'drift' ? ' active' : ''}`}
                  onClick={() => setTab('drift')}
                >
                  {say('tabEnvDrift')}
                </button>
              ) : null}
            </div>

            {tab === 'lint' ? (
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
                              <div key={i} className="shape-check-item shape-check-item-row">
                                <span>{finding.message}</span>
                                {ddl ? (
                                  <button
                                    type="button"
                                    className="shape-check-inline-btn"
                                    title={ddl}
                                    onClick={() => void copySql(key, ddl)}
                                  >
                                    {copiedKey === key ? say('copiedIndexSql') : say('copyIndexSql')}
                                  </button>
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
                                  <button
                                    type="button"
                                    className="shape-check-inline-btn"
                                    onClick={() => {
                                      close();
                                      go((tableView as (t: string, q?: string) => unknown)(meta?.id ?? table, finding.query), 'reset');
                                    }}
                                  >
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
          </>
        )}
      </div>
    </Modal>
  );
}
