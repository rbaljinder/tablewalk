/**
 * The SQL editor: the last mile of the query language, handed to a
 * connection that cannot write. Two ways in — a statement from scratch, or
 * the one the language compiled to, taken over at the point the language
 * runs out. Why a SQL box at all, at length: `sql.js`.
 *
 * The textarea is uncontrolled on purpose: the completer writes into it
 * directly when a suggestion is accepted, and the value is read when Run
 * is pressed rather than mirrored keystroke by keystroke.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@mistriwork/ui/Button.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { api, go, render, state, toast, viewportBox, viewportScale } from '@mistriwork/kit/client/core.js';
import { advanceRecordSource } from '@mistriwork/kit/client/recordSource.js';
import { attachComplete } from '../complete.js';
import { sqlSuggestions, tokenAt } from '../sqlcomplete.js';
import { promptFor } from '@mistriwork/kit/client/prompt.js';
import { removeStatement, saveStatement, savedStatements } from '../sqlsaved.js';
import { refreshUndo } from '../undo.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Grid } from '@mistriwork/kit/client/components/Grid.js';
import { say } from '../copy/workbench/components/SqlPane.js';
import { addHostListener, removeHostListener, shellQuery } from '@mistriwork/kit/client/shellHost.js';
import {
  enrichConnectionsWithEnvironments,
  groupConnectionsByDatabase,
  type EnvironmentTier,
  type SiblingEnvironment,
} from '../../shared/environments.js';
import './SqlPane.css';

interface SqlResult {
  columns: string[];
  rows: unknown[][];
  ms: number;
  truncated?: boolean;
  bounded?: boolean;
  affected?: number;
  errors?: Array<{ message: string }>;
}
interface FanoutEnvEntry {
  connection: string;
  name: string;
  env?: string;
  tier: EnvironmentTier;
  ok: boolean;
  ms: number;
  error?: string;
  result?: {
    columns?: string[];
    rows?: Array<unknown[] | Record<string, unknown>>;
    truncated?: boolean;
    bounded?: boolean;
    errors?: string[];
  };
}
interface Statement {
  name: string;
  sql: string;
  description?: string;
  source: 'saved' | 'config';
}
interface VerifyDdlTableDiff {
  table: string;
  onlyIn?: 'left' | 'right';
  columnsOnlyLeft?: string[];
  columnsOnlyRight?: string[];
  changed?: Array<{ column: string; what: string; left: string; right: string }>;
}
interface VerifyDdlPayload {
  valid: boolean;
  dialect?: string;
  statements?: number;
  statementCount?: number;
  statement?: string;
  failedStatement?: string;
  errors?: string[];
  error?: string;
  same?: boolean;
  diff?: VerifyDdlTableDiff[] | { same?: boolean; tables?: VerifyDdlTableDiff[] };
  introducedLint?: {
    findings?: Array<{ table: string; rule: string; severity: string; message: string }>;
  };
  newLintFindings?: Array<{ table: string; rule: string; severity: string; message: string }>;
}
type Outcome =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }
  | { kind: 'written'; affected: number }
  | { kind: 'rows'; data: SqlResult }
  | { kind: 'fanout'; entries: FanoutEnvEntry[] }
  | { kind: 'plan'; lines: string[]; ms: number }
  | { kind: 'ddl'; data: VerifyDdlPayload; ms: number };

interface SqlPaneProps {
  draft: string;
  onDraft: (text: string) => void;
  onSwitchConnection?: (id: string, currentDraft: string) => void;
  onClose: () => void;
}

let savedPanelHeightPx: number | null = null;

/* A textarea that grows with its content, to a point. */
function autoGrow(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 84), 340)}px`;
}

export function SqlPane({ draft, onDraft, onSwitchConnection, onClose }: SqlPaneProps) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLTextAreaElement>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [fanoutIdx, setFanoutIdx] = useState(0);
  const [savedVersion, bump] = useState(0);
  const [pendingWrite, setPendingWrite] = useState<string | null>(null);
  const schema = (state as { schema?: { label?: string; dialect?: string } }).schema;
  const connections = state as {
    connections?: Array<{
      id: string;
      name?: string;
      detail?: string;
      writable?: boolean;
      rows?: boolean;
      hidesColumns?: boolean;
      redactsRows?: boolean;
      database?: string;
      env?: string;
      tier?: EnvironmentTier;
      siblings?: SiblingEnvironment[];
    }>;
    activeConnection?: string;
  };
  const enriched = enrichConnectionsWithEnvironments((connections.connections ?? []).map((c) => ({ ...c, name: c.name ?? c.id })));
  const activeConn = enriched.find((c) => c.id === connections.activeConnection);
  const activeGroup = activeConn
    ? groupConnectionsByDatabase(enriched).find((g) => g.database.toLowerCase() === activeConn.database.toLowerCase())
    : undefined;
  const writable = activeConn?.writable;
  const canExplain = !activeConn?.hidesColumns && !activeConn?.redactsRows;

  useEffect(() => {
    const node = input.current!;
    const detach = attachComplete(node, sqlSuggestions, { anchor: 'caret', split: tokenAt }) as (() => void) | undefined;
    autoGrow(node);
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    return () => detach?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The completion list eats Escape first; this only fires when it is closed.
      if (shellQuery('.ac:not([hidden])')) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') {
        (document.activeElement as HTMLElement).blur();
        return;
      }
      e.preventDefault();
      onClose();
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  }, [onClose]);

  const setText = (text: string) => {
    onDraft(text);
    if (input.current) {
      input.current.value = text;
      autoGrow(input.current);
    }
  };

  /**
   * Run a statement and render whatever comes back. Errors land beside the
   * editor rather than as a toast that disappears, in the database's own
   * wording because any paraphrase says less.
   */
  const execute = async (text: string, write = false) => {
    const statement = text.trim();
    if (!statement) return;
    setOutcome({ kind: 'running' });
    let data: SqlResult;
    try {
      data = await api('/api/sql', { text: statement, limit: 500, write });
    } catch (err) {
      setOutcome({ kind: 'error', message: (err as Error).message });
      return;
    }
    if (data.errors?.length) {
      setOutcome({ kind: 'error', message: data.errors[0].message });
      return;
    }
    if (write) {
      const affected = data.affected ?? 0;
      toast(`${say('rows', { count: affected })} changed.`, 'ok');
      setOutcome({ kind: 'written', affected });
      // The schema, cached lists/records, and the Undo barrier entry may all have moved.
      advanceRecordSource();
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'command-prepare' });
      void refreshUndo();
      render();
      return;
    }
    setOutcome({ kind: 'rows', data });
  };
  const run = () => void execute(input.current?.value ?? '');

  const explainStatement = async () => {
    const statement = (input.current?.value ?? '').trim();
    if (!statement) return;
    setOutcome({ kind: 'running' });
    try {
      const reply = (await api('/api/agent/call', {
        name: 'explain',
        arguments: {
          statement,
          ...(connections.activeConnection ? { connection: connections.activeConnection } : {}),
        },
      })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: { plan?: string[]; stats?: { ms?: number } };
      };
      if (reply.isError || !Array.isArray(reply.structuredContent?.plan)) {
        setOutcome({ kind: 'error', message: reply.content?.[0]?.text ?? say('explainFailed') });
        return;
      }
      setOutcome({
        kind: 'plan',
        lines: reply.structuredContent.plan,
        ms: Number(reply.structuredContent.stats?.ms ?? 0),
      });
    } catch (err) {
      setOutcome({ kind: 'error', message: (err as Error).message });
    }
  };

  const verifyDdlStatement = async () => {
    const statement = (input.current?.value ?? '').trim();
    if (!statement) return;
    setOutcome({ kind: 'running' });
    try {
      const reply = (await api('/api/agent/call', {
        name: 'verify_ddl',
        arguments: {
          sql: statement,
          ...(connections.activeConnection ? { connection: connections.activeConnection } : {}),
        },
      })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: VerifyDdlPayload & { stats?: { ms?: number } };
      };
      if (reply.isError || !reply.structuredContent || typeof reply.structuredContent.valid !== 'boolean') {
        setOutcome({ kind: 'error', message: reply.content?.[0]?.text ?? say('verifyDdlFailed') });
        return;
      }
      setOutcome({
        kind: 'ddl',
        data: reply.structuredContent,
        ms: Number(reply.structuredContent.stats?.ms ?? 0),
      });
    } catch (err) {
      setOutcome({ kind: 'error', message: (err as Error).message });
    }
  };

  const save = async () => {
    const statement = (input.current?.value ?? '').trim();
    if (!statement) return;
    const name = await promptFor({
      title: say('nameThisStatement'),
      label: say('common.name'),
      hint: statement.length > 120 ? `${statement.slice(0, 120)}…` : statement,
      placeholder: say('eGCustomersOver'),
    });
    if (!name) return;
    if (saveStatement(name, statement)) {
      toast(say('saved', { name }), 'ok');
      bump((n) => n + 1);
    }
  };

  const compareAcrossEnvs = async () => {
    const statement = (input.current?.value ?? '').trim();
    if (!statement) return;
    setOutcome({ kind: 'running' });
    setFanoutIdx(0);
    try {
      const reply = (await api('/api/agent/call', {
        name: 'sql',
        arguments: { statement, envs: 'all' },
      })) as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: { environments?: FanoutEnvEntry[] };
      };
      if (reply.isError || !Array.isArray(reply.structuredContent?.environments)) {
        setOutcome({ kind: 'error', message: reply.content?.[0]?.text ?? say('compareEnvsFailed') });
        return;
      }
      setOutcome({ kind: 'fanout', entries: reply.structuredContent.environments });
    } catch (err) {
      setOutcome({ kind: 'error', message: (err as Error).message });
    }
  };

  useEffect(() => {
    const panelEl = input.current?.closest('.sql-panel') as HTMLElement | null;
    if (panelEl && savedPanelHeightPx !== null) {
      panelEl.style.height = `${savedPanelHeightPx}px`;
      panelEl.style.maxHeight = '82vh';
      panelEl.style.overflowY = 'auto';
    }
  }, []);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const panelEl = handle.closest('.sql-panel') as HTMLElement | null;
    if (!panelEl) return;
    const startY = e.clientY;
    const startH = viewportBox(panelEl).height;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const scale = typeof viewportScale === 'function' ? viewportScale() : 1;
      const delta = (startY - ev.clientY) / (scale || 1);
      const next = Math.max(180, Math.min(760, Math.round(startH + delta)));
      savedPanelHeightPx = next;
      panelEl.style.height = `${next}px`;
      panelEl.style.maxHeight = '82vh';
      panelEl.style.overflowY = 'auto';
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const saved = savedStatements() as Statement[];
  const hasSiblingEnvs = Boolean(activeConn && activeGroup && activeGroup.environments.length > 1);
  void savedVersion;
  return (
    <>
      <div
        className="sql-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={say('resizeSqlPane')}
        title={say('resizeSqlPane')}
        onPointerDown={startResize}
      >
        <span className="sql-resize-grip" aria-hidden="true" />
      </div>
      <div className="sql-head">
        <div className="sql-title">
          <span className="sql-eyebrow">SQL</span>
          <span className="sql-target">{`${schema?.label ?? ''} · ${schema?.dialect ?? ''}`}</span>
          {activeConn && activeGroup && activeGroup.environments.length > 1 ? (
            <div className="sql-env-bar" role="group" aria-label={say('sqlEnvironmentsLabel', { database: activeConn.database })}>
              {activeGroup.environments.map((envConn) => {
                const current = envConn.id === activeConn.id;
                return (
                  <button
                    key={envConn.id}
                    type="button"
                    className={`env-pill compact tone-${envConn.tier}${current ? ' active' : ''}`}
                    aria-pressed={current}
                    title={say('switchSqlToName', { name: envConn.name })}
                    onClick={() => {
                      if (!current) onSwitchConnection?.(envConn.id, input.current?.value ?? draft);
                    }}
                  >
                    <span className="env-pill-dot" aria-hidden="true" />
                    <span>{envConn.env ?? envConn.name}</span>
                  </button>
                );
              })}
            </div>
          ) : activeConn && (activeConn.tier !== 'other' || Boolean(activeConn.env)) ? (
            <span className={`env-pill compact active tone-${activeConn.tier}`}>
              <span className="env-pill-dot" aria-hidden="true" />
              <span>{activeConn.env ?? activeConn.tier}</span>
            </span>
          ) : null}
        </div>
        <div className="sql-head-actions">
          {/* Offered only where the server would allow it. A button that exists to be refused is a button that lies. */}
          {writable ? (
            <Button
              className="sql-write"
              title={say('runThisStatementOnTheWrite')}
              onClick={() => {
                const text = (input.current?.value ?? '').trim();
                if (text) setPendingWrite(text);
              }}
            >
              {say('runAsWrite')}
            </Button>
          ) : null}
          {hasSiblingEnvs ? (
            <Button title={say('compareEnvsTitle')} onClick={() => void compareAcrossEnvs()}>
              {say('compareEnvs')}
            </Button>
          ) : null}
          {canExplain ? (
            <>
              <Button title={say('verifyDdlTitle')} onClick={() => void verifyDdlStatement()}>
                {say('verifyDdl')}
              </Button>
              <Button title={say('explainTitle')} onClick={() => void explainStatement()}>
                {say('explain')}
              </Button>
            </>
          ) : null}
          <Button title={say('keepThisStatementUnder')} onClick={() => void save()}>
            {say('save')}
          </Button>
          <Button intent="primary" onClick={run}>
            {say('run')}
          </Button>
          <Button onClick={onClose}>{say('common.done')}</Button>
        </div>
      </div>
      {/* Config-defined and browser-saved together: to whoever is looking for one they are the same thing. */}
      {saved.length ? (
        <div className="sql-saved">
          {saved.map((item) => (
            <span key={`${item.source}:${item.name}`} className={`sql-chip source-${item.source}`}>
              <button type="button" className="sql-chip-open" title={item.description ?? item.sql} onClick={() => setText(item.sql)}>
                {item.name}
              </button>
              {item.source === 'saved' ? (
                <button
                  type="button"
                  className="sql-chip-remove"
                  title={say('forget', { name: item.name })}
                  aria-label={say('forgetName', { name: item.name })}
                  onClick={() => {
                    removeStatement(item.name);
                    bump((n) => n + 1);
                  }}
                >
                  ×
                </button>
              ) : (
                <span className="sql-chip-tag" title={say('definedInTablewalkJson')}>
                  {say('config')}
                </span>
              )}
            </span>
          ))}
        </div>
      ) : (
        <div hidden />
      )}
      <div className="sql-editor">
        <textarea
          ref={input}
          className="sql-input"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label={say('sqlStatement')}
          placeholder={say('selectFromCustomerWhere')}
          defaultValue={draft}
          onInput={(e) => {
            onDraft(e.currentTarget.value);
            autoGrow(e.currentTarget);
          }}
          onKeyDown={(e) => {
            // ⌘↵ runs. Plain Enter is a newline: a box where Enter submits is a box you cannot write two lines in.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              run();
            }
          }}
        />
      </div>
      <div className="sql-results">
        <Results outcome={outcome} fanoutIdx={fanoutIdx} onSelectFanout={setFanoutIdx} onClose={onClose} />
      </div>
      {pendingWrite !== null && (
        <WriteConfirm
          statement={pendingWrite}
          prodTarget={activeConn?.tier === 'prod' ? activeConn.name : undefined}
          onClose={() => setPendingWrite(null)}
          onRun={() => void execute(pendingWrite, true)}
        />
      )}
    </>
  );
}

function classifyPlanLine(line: string): 'warn' | 'ok' | null {
  const trimmed = line.trim();
  if (
    /\b(?:Index(?: Only)? Scan|Bitmap Index Scan)\b/i.test(trimmed) ||
    /\bUSING\s+(?:(?:COVERING|INTEGER)\s+)?(?:INDEX|PRIMARY\s+KEY)\b/i.test(trimmed)
  ) {
    return 'ok';
  }
  if (/\bSeq Scan\b/i.test(trimmed) || /^SCAN\s+/i.test(trimmed) || /\bSCAN TABLE\b/i.test(trimmed)) {
    return 'warn';
  }
  return null;
}

function PlanResult({ lines, ms }: { lines: string[]; ms: number }) {
  const classified = lines.map((line) => ({ line, tone: classifyPlanLine(line) }));
  const seqScans = classified.filter((c) => c.tone === 'warn').length;
  const indexSeeks = classified.filter((c) => c.tone === 'ok').length;
  return (
    <>
      <div className="sql-stats">
        <span>{say('planNodes', { count: lines.length })}</span>
        <span>{say('msMs', { ms })}</span>
        {seqScans > 0 ? <span className="sql-truncated">{say('seqScanSummary', { count: seqScans })}</span> : null}
        {indexSeeks > 0 ? <span>{say('indexSeekSummary', { count: indexSeeks })}</span> : null}
      </div>
      <div className="sql-plan-list" role="region" aria-label={say('explain')}>
        {classified.map(({ line, tone }, i) => (
          <div key={i} className={`sql-plan-line${tone ? ` tone-${tone}` : ''}`}>
            <span>{line}</span>
            {tone === 'warn' ? (
              <span className="sql-plan-tag tone-warn">{say('seqScanBadge')}</span>
            ) : tone === 'ok' ? (
              <span className="sql-plan-tag tone-ok">{say('indexSeekBadge')}</span>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

function VerifyDdlResultView({ data, ms }: { data: VerifyDdlPayload; ms: number }) {
  const diffTables = Array.isArray(data.diff) ? data.diff : (data.diff?.tables ?? []);
  const diffLines: string[] = [];
  for (const td of diffTables) {
    if (td.onlyIn === 'right') diffLines.push(say('ddlAddedTable', { table: td.table }));
    else if (td.onlyIn === 'left') diffLines.push(say('ddlDroppedTable', { table: td.table }));
    else {
      if (td.columnsOnlyRight?.length) {
        diffLines.push(say('ddlAddedColumns', { table: td.table, columns: td.columnsOnlyRight.join(', ') }));
      }
      if (td.columnsOnlyLeft?.length) {
        diffLines.push(say('ddlDroppedColumns', { table: td.table, columns: td.columnsOnlyLeft.join(', ') }));
      }
      for (const ch of td.changed ?? []) {
        diffLines.push(say('ddlChangedColumn', { table: td.table, column: ch.column, what: ch.what, left: ch.left, right: ch.right }));
      }
    }
  }
  const lintItems = data.introducedLint?.findings ?? data.newLintFindings ?? [];
  const stmtCount = data.statements ?? data.statementCount;
  const errText = data.errors?.[0] ?? data.error;
  const failedStmt = data.statement ?? data.failedStatement;
  return (
    <>
      <div className="sql-stats">
        <span className={`sql-ddl-badge ${data.valid ? 'is-ok' : 'is-bad'}`}>
          {data.valid ? say('ddlValidBadge') : say('ddlInvalidBadge')}
        </span>
        {stmtCount !== undefined ? <span>{say('ddlStatementsCount', { count: stmtCount })}</span> : null}
        <span>{say('msMs', { ms })}</span>
      </div>
      <div className="sql-ddl-card" role="region" aria-label={say('verifyDdl')}>
        {!data.valid ? (
          <>
            <p className="sql-error" role="alert">
              {errText ?? say('verifyDdlFailed')}
            </p>
            {failedStmt ? <pre className="confirm-params">{failedStmt}</pre> : null}
          </>
        ) : diffLines.length > 0 ? (
          <div className="sql-ddl-list">
            {diffLines.map((line, idx) => (
              <div key={idx}>{line}</div>
            ))}
          </div>
        ) : (
          <p className="note">{say('ddlNoStructuralChanges')}</p>
        )}
        {lintItems.length > 0 ? (
          <div className="sql-ddl-lint">
            <span className="sql-ddl-lint-head">{say('ddlNewLintHeading', { count: lintItems.length })}</span>
            <div className="sql-ddl-list">
              {lintItems.map((f, idx) => (
                <div key={idx}>{`[${f.severity}] ${f.table} (${f.rule}): ${f.message}`}</div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function normalizeFanoutSqlResult(entry: FanoutEnvEntry): SqlResult | null {
  if (!entry.ok || !entry.result) return null;
  if (entry.result.errors?.length) {
    return { columns: [], rows: [], ms: entry.ms, errors: entry.result.errors.map((message) => ({ message })) };
  }
  const columns = entry.result.columns ?? [];
  const rawRows = entry.result.rows ?? [];
  const rows: unknown[][] = rawRows.map((r) => (Array.isArray(r) ? r : columns.map((col) => (r as Record<string, unknown>)[col])));
  return {
    columns,
    rows,
    ms: entry.ms,
    truncated: entry.result.truncated,
    bounded: entry.result.bounded,
  };
}

function Results({
  outcome,
  fanoutIdx,
  onSelectFanout,
  onClose,
}: {
  outcome: Outcome;
  fanoutIdx: number;
  onSelectFanout: (idx: number) => void;
  onClose: () => void;
}) {
  switch (outcome.kind) {
    case 'idle':
      return null;
    case 'running':
      return <p className="loading">{say('running')}</p>;
    case 'error':
      return (
        <p className="sql-error" role="alert">
          {outcome.message}
        </p>
      );
    case 'written':
      return <p className="note">{`${say('rows', { count: outcome.affected })} changed.`}</p>;
    case 'rows':
      return <RowsResult data={outcome.data} onClose={onClose} />;
    case 'plan':
      return <PlanResult lines={outcome.lines} ms={outcome.ms} />;
    case 'ddl':
      return <VerifyDdlResultView data={outcome.data} ms={outcome.ms} />;
    case 'fanout': {
      const picked = outcome.entries[fanoutIdx] ?? outcome.entries[0];
      const normalized = picked ? normalizeFanoutSqlResult(picked) : null;
      return (
        <>
          <div className="sql-fanout-tabs" role="tablist">
            {outcome.entries.map((entry, idx) => {
              const rowCount = entry.ok ? (entry.result?.rows?.length ?? 0) : null;
              return (
                <button
                  key={entry.connection}
                  type="button"
                  role="tab"
                  aria-selected={idx === fanoutIdx}
                  className={`sql-fanout-tab${idx === fanoutIdx ? ' active' : ''}`}
                  onClick={() => onSelectFanout(idx)}
                >
                  <span className={`env-pill compact tone-${entry.tier}`}>
                    <span className="env-pill-dot" aria-hidden="true" />
                    <span>{entry.env ?? entry.name}</span>
                  </span>
                  <span className="sql-fanout-meta">
                    {entry.ok ? `${say('rows', { count: rowCount ?? 0 })} · ${say('msMs', { ms: entry.ms })}` : say('fanoutErrorBadge')}
                  </span>
                </button>
              );
            })}
          </div>
          {!picked ? null : !picked.ok ? (
            <p className="sql-error" role="alert">
              {picked.error ?? say('compareEnvsFailed')}
            </p>
          ) : normalized?.errors?.length ? (
            <p className="sql-error" role="alert">
              {normalized.errors[0].message}
            </p>
          ) : normalized ? (
            <RowsResult data={normalized} onClose={onClose} />
          ) : null}
        </>
      );
    }
  }
}

/** The table whose rows these are, if the columns can say. */
function walkableTable(columns: string[]): TableMeta | null {
  const present = new Set(columns);
  const tables = (state as { schema?: { tables?: TableMeta[] } }).schema?.tables ?? [];
  const candidates = tables.filter((t) => {
    const key = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
    return key.length > 0 && key.every((c) => present.has(c));
  });
  if (!candidates.length) return null;
  /* Several tables can share a key shape — `id` is not distinctive. The one whose other columns also appear is the one the statement is about. */
  const overlap = (table: TableMeta) => table.columns.filter((c) => present.has(c.name)).length;
  return candidates.sort((a, b) => overlap(b) - overlap(a))[0];
}

/**
 * Rows as a grid, walkable when the columns can identify a row. When they
 * cannot, the rows are inert and look it — the grid is given no click.
 */
function RowsResult({ data, onClose }: { data: SqlResult; onClose: () => void }) {
  const target = walkableTable(data.columns);
  /* The wire format is positional so duplicate names survive the trip; rebuilt as objects here. */
  const rows = data.rows.map((row) => Object.fromEntries(data.columns.map((name, i) => [name, row[i]])));
  const open = (row: Record<string, unknown>) => {
    const key: Record<string, unknown> = {};
    for (const column of target!.columns.filter((c) => c.primaryKey)) key[column.name] = row[column.name];
    onClose();
    go({ kind: 'row', table: target!.id, key, label: String(Object.values(key).join('/')) }, 'reset');
  };
  return (
    <>
      <div className="sql-stats">
        <span>{say('rows', { count: data.rows.length })}</span>
        <span>{say('msMs', { ms: data.ms })}</span>
        {/* Said rather than implied: "the front of the answer" is a different fact from "there are more rows". */}
        {data.truncated ? (
          <span className="sql-truncated">
            {data.bounded
              ? say('firstAddALimit', { rowsCount: data.rows.length })
              : say('firstOfWhatTheDatabase', { rowsCount: data.rows.length })}
          </span>
        ) : null}
      </div>
      <div>
        {!data.rows.length ? (
          /* An empty result still knows its shape, and saying so is the difference between "nothing matched" and "something went wrong". */
          <p className="sql-empty">
            <strong>{say('noRows')}</strong>
            <span>
              {data.columns.length
                ? say('theStatementReturnedThese', { columns: data.columns.join(', ') })
                : say('theStatementReturnedNoColumns')}
            </span>
          </p>
        ) : (
          <>
            {target ? <p className="sql-walk">{say('rowsOpenAsRecords', { name: target.name })}</p> : null}
            <div className="grid-host">
              <Grid
                table={target ?? undefined}
                data={{ columns: data.columns, rows }}
                onRowClick={target ? open : undefined}
                virtual={false}
                interactive={false}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** A write, with the statement in front of you: the question is whether it says what you think it says. */
function WriteConfirm({
  statement,
  prodTarget,
  onClose,
  onRun,
}: {
  statement: string;
  prodTarget?: string;
  onClose: () => void;
  onRun: () => void;
}) {
  const dialog = useRef<ModalHandle>(null);
  return (
    <Modal className="confirm" ref={dialog} onClose={onClose}>
      <h2>{say('runThisAsAWrite')}</h2>
      {prodTarget ? (
        <p className="sql-prod-callout" role="alert">
          {say('productionWriteWarning', { target: prodTarget })}
        </p>
      ) : null}
      <p>{say('thisRunsOnTheWrite')}</p>
      <pre className="confirm-params">{statement}</pre>
      <div className="confirm-actions">
        <Button onClick={() => dialog.current?.close()}>{say('common.cancel')}</Button>
        <Button
          intent="danger"
          onClick={() => {
            dialog.current?.close();
            onRun();
          }}
        >
          {say('runAsWriteConfirm')}
        </Button>
      </div>
    </Modal>
  );
}
