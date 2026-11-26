/**
 * The SQL workbench: DataGrip-style connection-scoped `.sql` workspaces,
 * multi-tab consoles, real-time dialect-aware syntax highlighting, upgraded
 * schema/FK/CTE autocomplete, statement-at-caret & multi-statement script
 * execution, inline `:param` / `{{param}}` binding, execution history,
 * result exports/aggregates, and cross-environment result diffing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@mistriwork/ui/Button.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { Resizable } from '@mistriwork/ui/Resizable.js';
import { Tabs } from '@mistriwork/ui/Tabs.js';
import { api, go, render, state, toast, viewportBox, viewportScale } from '@mistriwork/kit/client/core.js';
import { advanceRecordSource } from '@mistriwork/kit/client/recordSource.js';
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
import {
  computeColumnAggregates,
  diffResultSets,
  extractSqlParameters,
  formatResultExport,
  splitSqlStatements,
  statementAtOffset,
  substituteSqlParameters,
  type ResultExportFormat,
} from '../../shared/sqlScript.js';
import {
  clearHistory,
  clearImportedFiles,
  deleteImportedFile,
  historyFor,
  importedFilesFor,
  importSqlFiles,
  paramValuesFor,
  recordHistory,
  saveParamValues,
  upsertImportedFile,
  type BrowserSqlFile,
  type SqlHistoryEntry,
} from '../sqlworkspace.js';
import { SqlCodeEditor } from './SqlCodeEditor.js';
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

interface ScriptStatementOutcome {
  index: number;
  sql: string;
  startLine: number;
  endLine: number;
  ok: boolean;
  ms: number;
  columns?: string[];
  rows?: unknown[][];
  truncated?: boolean;
  bounded?: boolean;
  affected?: number;
  error?: string;
}

interface ScriptResultPayload {
  statements: ScriptStatementOutcome[];
  totalMs: number;
  totalStatements: number;
  stoppedAt?: number;
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

interface DiskSqlFile {
  path: string;
  folder: string;
  name: string;
  size: number;
  mtimeMs: number;
}

interface DiskWorkspaceState {
  attached: boolean;
  rootName: string | null;
  rootPath: string | null;
  readOnly: boolean;
  files: DiskSqlFile[];
}

interface EditorTab {
  id: string;
  title: string;
  text: string;
  savedText: string;
  kind: 'console' | 'disk' | 'browser';
  filePath?: string;
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
  | { kind: 'script'; data: ScriptResultPayload }
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
let consoleCounter = 1;

function formatCompactNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function groupFilesByFolder<T extends { path: string; folder: string; name: string }>(files: T[]): Array<[string, T[]]> {
  const byFolder = new Map<string, T[]>();
  for (const file of files) {
    const key = file.folder || '';
    const list = byFolder.get(key);
    if (list) list.push(file);
    else byFolder.set(key, [file]);
  }
  return [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function SqlPane({ draft, onDraft, onSwitchConnection, onClose }: SqlPaneProps) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLTextAreaElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const schema = (state as { schema?: { label?: string; dialect?: string } }).schema;
  const dialect = schema?.dialect === 'sqlite' ? 'sqlite' : 'postgres';
  const connections = state as {
    connections?: Array<{
      id: string;
      name?: string;
      detail?: string;
      writable?: boolean;
      rows?: boolean;
      hidesColumns?: boolean;
      redactsRows?: boolean;
      hasSqlWorkspace?: boolean;
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
  const scopeKey = activeConn?.database || activeConn?.id || 'default';

  const [tabs, setTabs] = useState<EditorTab[]>(() => [
    { id: 'console-1', title: say('consoleTabName', { n: 1 }), text: draft, savedText: draft, kind: 'console' },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('console-1');
  const [caret, setCaret] = useState<{ start: number; end: number }>({ start: draft.length, end: draft.length });
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [fanoutIdx, setFanoutIdx] = useState(0);
  const [fanoutDiffOpen, setFanoutDiffOpen] = useState(false);
  const [savedVersion, bump] = useState(0);
  const [pendingWrite, setPendingWrite] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => Boolean(activeConn?.hasSqlWorkspace));
  const [sidebarTab, setSidebarTab] = useState<'files' | 'history'>('files');
  const [diskWorkspace, setDiskWorkspace] = useState<DiskWorkspaceState | null>(null);
  const [browserFiles, setBrowserFiles] = useState<BrowserSqlFile[]>(() => importedFilesFor(scopeKey));
  const [historyEntries, setHistoryEntries] = useState<SqlHistoryEntry[]>(() => historyFor(scopeKey));
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => paramValuesFor(scopeKey));

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const editorText = activeTab?.text ?? draft;

  // Keep browser-scoped workspace state synced when switching database groups.
  useEffect(() => {
    setBrowserFiles(importedFilesFor(scopeKey));
    setHistoryEntries(historyFor(scopeKey));
    setParamValues(paramValuesFor(scopeKey));
  }, [scopeKey]);

  const refreshDiskWorkspace = useCallback(async () => {
    try {
      const data = (await api('/api/sql/workspace')) as DiskWorkspaceState | undefined;
      if (data && typeof data.attached === 'boolean') {
        setDiskWorkspace(data);
      }
    } catch {
      // Offline or mocked test environment without workspace route — keep browser workspace usable.
    }
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    void refreshDiskWorkspace();
  }, [sidebarOpen, activeConn?.id, refreshDiskWorkspace]);

  // Enable directory selection attribute on hidden file input for Import folder…
  useEffect(() => {
    const el = folderInputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, [sidebarOpen]);

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

  const updateActiveTabText = useCallback(
    (nextText: string, syncTextarea = false) => {
      setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, text: nextText } : t)));
      if (activeTabId === 'console-1') onDraft(nextText);
      if (syncTextarea && input.current) {
        input.current.value = nextText;
      }
    },
    [activeTabId, onDraft],
  );

  const setText = (text: string) => {
    updateActiveTabText(text, true);
    setCaret({ start: text.length, end: text.length });
  };

  const switchTab = (tabId: string) => {
    const target = tabs.find((t) => t.id === tabId);
    if (!target) return;
    setActiveTabId(tabId);
    if (input.current) {
      input.current.value = target.text;
      input.current.focus();
      input.current.setSelectionRange(target.text.length, target.text.length);
    }
    setCaret({ start: target.text.length, end: target.text.length });
  };

  const addConsoleTab = () => {
    consoleCounter += 1;
    const id = `console-${consoleCounter}`;
    const next: EditorTab = { id, title: say('consoleTabName', { n: consoleCounter }), text: '', savedText: '', kind: 'console' };
    setTabs((prev) => [...prev, next]);
    setActiveTabId(id);
    if (input.current) {
      input.current.value = '';
      input.current.focus();
    }
    setCaret({ start: 0, end: 0 });
  };

  const closeTab = (tabId: string) => {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === tabId);
    const remaining = tabs.filter((t) => t.id !== tabId);
    setTabs(remaining);
    if (tabId === activeTabId) {
      const next = remaining[Math.max(0, idx - 1)] ?? remaining[0];
      setActiveTabId(next.id);
      if (input.current) input.current.value = next.text;
      setCaret({ start: next.text.length, end: next.text.length });
    }
  };

  const openFileTab = (kind: 'disk' | 'browser', path: string, content: string) => {
    const tabId = `${kind}:${path}`;
    const existing = tabs.find((t) => t.id === tabId);
    if (existing) {
      switchTab(tabId);
      return;
    }
    const title = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
    const next: EditorTab = { id: tabId, title, text: content, savedText: content, kind, filePath: path };
    setTabs((prev) => [...prev, next]);
    setActiveTabId(tabId);
    if (input.current) {
      input.current.value = content;
      input.current.focus();
      input.current.setSelectionRange(content.length, content.length);
    }
    setCaret({ start: content.length, end: content.length });
  };

  const openDiskFile = async (relPath: string) => {
    try {
      const data = (await api(`/api/sql/files?path=${encodeURIComponent(relPath)}`)) as { content?: string; error?: string };
      if (typeof data?.content === 'string') {
        openFileTab('disk', relPath, data.content);
      }
    } catch (err) {
      toast((err as Error).message, 'bad');
    }
  };

  const saveActiveFile = async () => {
    const current = tabs.find((t) => t.id === activeTabId);
    if (!current || !current.filePath) {
      await save();
      return;
    }
    const content = input.current?.value ?? current.text;
    if (current.kind === 'browser') {
      const updated = upsertImportedFile(scopeKey, current.filePath, content);
      setBrowserFiles(updated);
      setTabs((prev) => prev.map((t) => (t.id === current.id ? { ...t, text: content, savedText: content } : t)));
      toast(say('fileSaved', { path: current.filePath }), 'ok');
      return;
    }
    try {
      const res = (await api('/api/sql/files', { path: current.filePath, content })) as { workspace?: DiskWorkspaceState };
      if (res?.workspace) setDiskWorkspace(res.workspace);
      setTabs((prev) => prev.map((t) => (t.id === current.id ? { ...t, text: content, savedText: content } : t)));
      toast(say('fileSaved', { path: current.filePath }), 'ok');
    } catch (err) {
      toast((err as Error).message || say('fileSaveFailed', { path: current.filePath }), 'bad');
    }
  };

  const attachFolder = async () => {
    const dir = await promptFor({
      title: say('attachFolderPrompt'),
      label: say('attachFolderLabel'),
      placeholder: say('attachFolderPlaceholder'),
    });
    if (!dir) return;
    try {
      const ws = (await api('/api/sql/workspace/attach', { dir })) as DiskWorkspaceState;
      setDiskWorkspace(ws);
      toast(say('folderAttached', { name: ws.rootName ?? dir }), 'ok');
    } catch (err) {
      toast((err as Error).message, 'bad');
    }
  };

  const detachFolder = async () => {
    try {
      const ws = (await api('/api/sql/workspace/detach', {})) as DiskWorkspaceState;
      setDiskWorkspace(ws);
      toast(say('folderDetached'), 'ok');
    } catch (err) {
      toast((err as Error).message, 'bad');
    }
  };

  const createNewSqlFile = async () => {
    const rawPath = await promptFor({
      title: say('newSqlFilePrompt'),
      label: say('newSqlFileLabel'),
      placeholder: say('newSqlFilePlaceholder'),
    });
    if (!rawPath) return;
    const rel = rawPath.trim().toLowerCase().endsWith('.sql') ? rawPath.trim() : `${rawPath.trim()}.sql`;
    const initialContent = '';
    if (diskWorkspace?.attached && !diskWorkspace.readOnly) {
      try {
        const res = (await api('/api/sql/files', { path: rel, content: initialContent })) as {
          file?: DiskSqlFile;
          workspace?: DiskWorkspaceState;
        };
        if (res?.workspace) setDiskWorkspace(res.workspace);
        openFileTab('disk', res?.file?.path ?? rel, initialContent);
        toast(say('fileSaved', { path: res?.file?.path ?? rel }), 'ok');
        return;
      } catch (err) {
        toast((err as Error).message, 'bad');
        return;
      }
    }
    const updated = upsertImportedFile(scopeKey, rel, initialContent);
    setBrowserFiles(updated);
    openFileTab('browser', rel, initialContent);
    toast(say('fileSaved', { path: rel }), 'ok');
  };

  const handleFolderImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || !fileList.length) return;
    const sqlFiles = [...fileList].filter((f) => f.name.toLowerCase().endsWith('.sql'));
    e.target.value = '';
    if (!sqlFiles.length) {
      toast(say('noSqlFilesInFolder'), 'bad');
      return;
    }
    const loaded = await Promise.all(
      sqlFiles.map(async (file) => ({
        path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        content: await file.text(),
      })),
    );
    const { files, added } = importSqlFiles(scopeKey, loaded);
    setBrowserFiles(files);
    toast(say('importedFilesToast', { count: added }), 'ok');
  };

  const removeDiskFile = async (relPath: string) => {
    try {
      const res = (await api('/api/sql/files/delete', { path: relPath })) as { workspace?: DiskWorkspaceState };
      if (res?.workspace) setDiskWorkspace(res.workspace);
      toast(say('fileDeleted', { path: relPath }), 'ok');
      const tabId = `disk:${relPath}`;
      if (tabs.some((t) => t.id === tabId)) closeTab(tabId);
    } catch (err) {
      toast((err as Error).message, 'bad');
    }
  };

  const removeBrowserFile = (relPath: string) => {
    const next = deleteImportedFile(scopeKey, relPath);
    setBrowserFiles(next);
    toast(say('fileDeleted', { path: relPath }), 'ok');
    const tabId = `browser:${relPath}`;
    if (tabs.some((t) => t.id === tabId)) closeTab(tabId);
  };

  // Multi-statement & caret awareness
  const statements = useMemo(() => splitSqlStatements(editorText, dialect), [editorText, dialect]);
  const activeStmt = useMemo(() => statementAtOffset(editorText, caret.start, dialect), [editorText, caret.start, dialect]);
  const selectedText = caret.end > caret.start ? editorText.slice(caret.start, caret.end).trim() : '';

  const resolveExecutionSql = (rawFullText: string): string => {
    const sel =
      input.current && input.current.selectionEnd > input.current.selectionStart
        ? rawFullText.slice(input.current.selectionStart, input.current.selectionEnd).trim()
        : '';
    let target = sel;
    if (!target) {
      const stmts = splitSqlStatements(rawFullText, dialect);
      if (stmts.length >= 2) {
        const pos = input.current?.selectionStart ?? rawFullText.length;
        const at = statementAtOffset(rawFullText, pos, dialect);
        target = at ? at.text : rawFullText.trim();
      } else {
        target = rawFullText.trim();
      }
    }
    return substituteSqlParameters(target, paramValues, dialect);
  };

  const activeParams = useMemo(() => {
    const inspectText = selectedText || (statements.length >= 2 && activeStmt ? activeStmt.text : editorText);
    return extractSqlParameters(inspectText, dialect);
  }, [selectedText, statements.length, activeStmt, editorText, dialect]);

  const updateParamValue = (name: string, val: string) => {
    setParamValues((prev) => {
      const next = { ...prev, [name]: val };
      saveParamValues(scopeKey, next);
      return next;
    });
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
      const msg = (err as Error).message;
      setHistoryEntries(recordHistory(scopeKey, { sql: statement, ms: 0, ok: false, error: msg, connectionName: activeConn?.name }));
      setOutcome({ kind: 'error', message: msg });
      return;
    }
    if (data.errors?.length) {
      const msg = data.errors[0].message;
      setHistoryEntries(
        recordHistory(scopeKey, { sql: statement, ms: data.ms ?? 0, ok: false, error: msg, connectionName: activeConn?.name }),
      );
      setOutcome({ kind: 'error', message: msg });
      return;
    }
    if (write) {
      const affected = data.affected ?? 0;
      setHistoryEntries(
        recordHistory(scopeKey, { sql: statement, ms: data.ms ?? 0, ok: true, affected, connectionName: activeConn?.name }),
      );
      toast(`${say('rows', { count: affected })} changed.`, 'ok');
      setOutcome({ kind: 'written', affected });
      // The schema, cached lists/records, and the Undo barrier entry may all have moved.
      advanceRecordSource();
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'command-prepare' });
      void refreshUndo();
      render();
      return;
    }
    setHistoryEntries(
      recordHistory(scopeKey, {
        sql: statement,
        ms: data.ms ?? 0,
        ok: true,
        rowCount: data.rows?.length ?? 0,
        connectionName: activeConn?.name,
      }),
    );
    setOutcome({ kind: 'rows', data });
  };

  const run = () => {
    const raw = input.current?.value ?? editorText;
    const sql = resolveExecutionSql(raw);
    void execute(sql);
  };

  const runScript = async () => {
    const raw = (input.current?.value ?? editorText).trim();
    if (!raw) return;
    const bound = substituteSqlParameters(raw, paramValues, dialect);
    setOutcome({ kind: 'running' });
    try {
      const data = (await api('/api/sql/script', { text: bound, limit: 500, write: false })) as ScriptResultPayload & { error?: string };
      if (data.error || !Array.isArray(data.statements)) {
        setOutcome({ kind: 'error', message: data.error ?? say('compareEnvsFailed') });
        return;
      }
      const hadError = data.stoppedAt !== undefined;
      setHistoryEntries(
        recordHistory(scopeKey, {
          sql: raw,
          ms: data.totalMs ?? 0,
          ok: !hadError,
          ...(hadError ? { error: data.statements[data.statements.length - 1]?.error } : {}),
          connectionName: activeConn?.name,
        }),
      );
      setOutcome({ kind: 'script', data });
    } catch (err) {
      setOutcome({ kind: 'error', message: (err as Error).message });
    }
  };

  const explainStatement = async () => {
    const statement = resolveExecutionSql(input.current?.value ?? editorText);
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
    const statement = substituteSqlParameters((input.current?.value ?? editorText).trim(), paramValues, dialect);
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
    const statement = (input.current?.value ?? editorText).trim();
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
    const statement = resolveExecutionSql(input.current?.value ?? editorText);
    if (!statement) return;
    setOutcome({ kind: 'running' });
    setFanoutIdx(0);
    setFanoutDiffOpen(false);
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
  const isFileTab = Boolean(activeTab?.filePath);
  const activeRange = statements.length >= 2 && activeStmt && !selectedText ? { start: activeStmt.start, end: activeStmt.end } : null;
  void savedVersion;

  const editorAndResults = (
    <Resizable
      className="sql-split"
      direction="vertical"
      ariaLabel={say('sqlWorkspaceSplit')}
      panels={[
        {
          label: say('sqlStatement'),
          defaultSize: 38,
          minSize: 15,
          children: (
            <div className="sql-editor">
              {tabs.length > 1 || statements.length >= 2 || selectedText ? (
                <div className="sql-tabs-bar" role="tablist" aria-label={say('consoleTabsLabel')}>
                  {tabs.map((tab) => {
                    const isCurrent = tab.id === activeTabId;
                    const dirty = tab.kind !== 'console' && tab.text !== tab.savedText;
                    return (
                      <span key={tab.id} className={`sql-console-tab${isCurrent ? ' active' : ''}`}>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={isCurrent}
                          className="sql-console-tab-btn"
                          title={tab.filePath ?? tab.title}
                          onClick={() => switchTab(tab.id)}
                        >
                          {tab.title}
                          {dirty ? <span className="sql-console-tab-dirty"> •</span> : null}
                        </button>
                        {tabs.length > 1 ? (
                          <button
                            type="button"
                            className="sql-console-tab-close"
                            aria-label={say('closeTab', { title: tab.title })}
                            onClick={() => closeTab(tab.id)}
                          >
                            ×
                          </button>
                        ) : null}
                      </span>
                    );
                  })}
                  <button
                    type="button"
                    className="sql-tab-add"
                    title={say('newConsoleTab')}
                    aria-label={say('newConsoleTab')}
                    onClick={addConsoleTab}
                  >
                    +
                  </button>
                  {selectedText ? (
                    <span className="sql-caret-badge">{say('runSelectionHint', { count: selectedText.length })}</span>
                  ) : statements.length >= 2 && activeStmt ? (
                    <span className="sql-caret-badge">
                      {say('statementAtCaret', { index: activeStmt.index + 1, total: statements.length })}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <SqlCodeEditor
                inputRef={input}
                value={editorText}
                defaultValue={draft}
                dialect={dialect}
                ariaLabel={say('sqlStatement')}
                placeholder={say('selectFromCustomerWhere')}
                activeRange={activeRange}
                onValueChange={(next) => updateActiveTabText(next, false)}
                onCaretChange={(start, end) => setCaret({ start, end })}
                onRunShortcut={run}
                onSaveShortcut={() => void saveActiveFile()}
              />
              {activeParams.length > 0 ? (
                <div className="sql-params-bar" role="region" aria-label={say('parametersLabel')}>
                  <span className="sql-params-title">{say('parametersLabel')}</span>
                  {activeParams.map((param) => (
                    <label key={param} className="sql-param-field">
                      <span className="sql-param-name">{`:${param}`}</span>
                      <input
                        type="text"
                        className="sql-param-input"
                        aria-label={param}
                        placeholder={say('parameterPlaceholder', { name: param })}
                        value={paramValues[param] ?? ''}
                        onChange={(e) => updateParamValue(param, e.currentTarget.value)}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ),
        },
        {
          label: say('sqlResultsPane'),
          defaultSize: 62,
          minSize: 20,
          children: (
            <div className="sql-results">
              <Results
                outcome={outcome}
                fanoutIdx={fanoutIdx}
                fanoutDiffOpen={fanoutDiffOpen}
                onToggleFanoutDiff={() => setFanoutDiffOpen((v) => !v)}
                onSelectFanout={(idx) => {
                  setFanoutIdx(idx);
                  setFanoutDiffOpen(false);
                }}
                onClose={onClose}
              />
            </div>
          ),
        },
      ]}
    />
  );

  const sidebarPanel = (
    <aside className="sql-sidebar" aria-label={say('sqlSidebarPane')}>
      <input ref={folderInputRef} type="file" multiple accept=".sql" hidden onChange={(e) => void handleFolderImport(e)} />
      <div className="sql-sidebar-tabs">
        <Tabs
          variant="pills"
          ariaLabel={say('sidebarTabsLabel')}
          value={sidebarTab}
          onValueChange={(v) => setSidebarTab(v as 'files' | 'history')}
          tabs={[
            { value: 'files', label: say('sidebarTabFiles') },
            { value: 'history', label: say('sidebarTabHistory') },
          ]}
        />
      </div>
      {sidebarTab === 'files' ? (
        <>
          <div className="sql-sidebar-actions">
            <Button size="sm" title={say('newSqlFilePrompt')} onClick={() => void createNewSqlFile()}>
              {say('newSqlFile')}
            </Button>
            <Button size="sm" title={say('importFolderTitle')} onClick={() => folderInputRef.current?.click()}>
              {say('importFolder')}
            </Button>
            <Button size="sm" title={say('attachFolderTitle')} onClick={() => void attachFolder()}>
              {say('attachFolder')}
            </Button>
          </div>
          <div className="sql-sidebar-scroll">
            {diskWorkspace?.attached ? (
              <div className="sql-tree-section">
                <div className="sql-tree-head">
                  <span title={diskWorkspace.rootPath ?? undefined}>
                    {say('workspaceDiskHeading', { name: diskWorkspace.rootName ?? '' })}
                  </span>
                  {!diskWorkspace.readOnly ? (
                    <button type="button" className="sql-tool-btn" onClick={() => void detachFolder()}>
                      {say('detachFolder')}
                    </button>
                  ) : null}
                </div>
                {groupFilesByFolder(diskWorkspace.files).map(([folder, items]) => (
                  <div key={`disk-folder:${folder}`}>
                    <div className="sql-tree-folder">{folder || say('rootFolder')}</div>
                    {items.map((file) => {
                      const isOpen = activeTabId === `disk:${file.path}`;
                      return (
                        <div key={file.path} className={`sql-tree-row${isOpen ? ' active' : ''}`}>
                          <button type="button" className="sql-tree-file" title={file.path} onClick={() => void openDiskFile(file.path)}>
                            {file.name}
                          </button>
                          {!diskWorkspace.readOnly ? (
                            <button
                              type="button"
                              className="sql-tree-del"
                              aria-label={say('deleteFile', { path: file.path })}
                              onClick={() => void removeDiskFile(file.path)}
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : null}

            {browserFiles.length > 0 ? (
              <div className="sql-tree-section">
                <div className="sql-tree-head">
                  <span>{say('workspaceBrowserHeading')}</span>
                  <button
                    type="button"
                    className="sql-tool-btn"
                    onClick={() => {
                      clearImportedFiles(scopeKey);
                      setBrowserFiles([]);
                    }}
                  >
                    {say('clearImported')}
                  </button>
                </div>
                {groupFilesByFolder(browserFiles).map(([folder, items]) => (
                  <div key={`browser-folder:${folder}`}>
                    <div className="sql-tree-folder">{folder || say('rootFolder')}</div>
                    {items.map((file) => {
                      const isOpen = activeTabId === `browser:${file.path}`;
                      return (
                        <div key={file.path} className={`sql-tree-row${isOpen ? ' active' : ''}`}>
                          <button
                            type="button"
                            className="sql-tree-file"
                            title={file.path}
                            onClick={() => openFileTab('browser', file.path, file.content)}
                          >
                            {file.name}
                          </button>
                          <button
                            type="button"
                            className="sql-tree-del"
                            aria-label={say('deleteFile', { path: file.path })}
                            onClick={() => removeBrowserFile(file.path)}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ) : null}

            {!diskWorkspace?.attached && browserFiles.length === 0 ? <p className="sql-sidebar-empty">{say('workspaceEmpty')}</p> : null}
          </div>
        </>
      ) : (
        <div className="sql-sidebar-scroll">
          {historyEntries.length > 0 ? (
            <>
              <div className="sql-tree-head">
                <span>{say('sidebarTabHistory')}</span>
                <button
                  type="button"
                  className="sql-tool-btn"
                  onClick={() => {
                    clearHistory(scopeKey);
                    setHistoryEntries([]);
                  }}
                >
                  {say('clearHistory')}
                </button>
              </div>
              {historyEntries.map((item) => (
                <button key={item.id} type="button" className="sql-history-item" title={item.sql} onClick={() => setText(item.sql)}>
                  <span className="sql-history-sql">{item.sql}</span>
                  <span className="sql-history-meta">
                    <span className={`sql-history-dot${item.ok ? '' : ' is-err'}`} aria-hidden="true" />
                    <span>{say('msMs', { ms: item.ms })}</span>
                    {item.rowCount !== undefined ? <span>{say('rows', { count: item.rowCount })}</span> : null}
                    {item.connectionName ? <span>{item.connectionName}</span> : null}
                  </span>
                </button>
              ))}
            </>
          ) : (
            <p className="sql-sidebar-empty">{say('historyEmpty')}</p>
          )}
        </div>
      )}
    </aside>
  );

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
          <Button aria-pressed={sidebarOpen} title={say('filesToggleTitle')} onClick={() => setSidebarOpen((open) => !open)}>
            {say('filesToggle')}
          </Button>
          {/* Offered only where the server would allow it. A button that exists to be refused is a button that lies. */}
          {writable ? (
            <Button
              className="sql-write"
              title={say('runThisStatementOnTheWrite')}
              onClick={() => {
                const text = resolveExecutionSql(input.current?.value ?? editorText);
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
          {isFileTab ? (
            <Button onClick={() => void saveActiveFile()}>{say('saveFile')}</Button>
          ) : (
            <Button title={say('keepThisStatementUnder')} onClick={() => void save()}>
              {say('save')}
            </Button>
          )}
          {statements.length >= 2 ? (
            <Button title={say('runScriptTitle')} onClick={() => void runScript()}>
              {say('runScript', { count: statements.length })}
            </Button>
          ) : null}
          <Button variant="primary" onClick={run}>
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
      {sidebarOpen ? (
        <Resizable
          className="sql-main-split"
          direction="horizontal"
          ariaLabel={say('sqlMainSplit')}
          panels={[
            { label: say('sqlSidebarPane'), defaultSize: 24, minSize: 15, children: sidebarPanel },
            { label: say('sqlWorkspaceSplit'), defaultSize: 76, minSize: 45, children: editorAndResults },
          ]}
        />
      ) : (
        editorAndResults
      )}
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

function ScriptResultView({ data, onClose }: { data: ScriptResultPayload; onClose: () => void }) {
  const succeeded = data.statements.filter((s) => s.ok).length;
  return (
    <>
      <div className="sql-stats">
        <span>{say('scriptSummary', { succeeded, total: data.totalStatements })}</span>
        <span>{say('msMs', { ms: data.totalMs })}</span>
        {data.stoppedAt !== undefined ? <span className="sql-truncated">{say('scriptStopped', { index: data.stoppedAt + 1 })}</span> : null}
      </div>
      <div className="sql-script-list">
        {data.statements.map((stmt) => (
          <div key={stmt.index} className={`sql-script-card${stmt.ok ? '' : ' is-err'}`}>
            <div className="sql-script-card-head">
              <strong>{say('scriptStmtHeading', { index: stmt.index + 1, start: stmt.startLine, end: stmt.endLine })}</strong>
              <span className="sql-script-sql">{stmt.sql}</span>
              <span className="sql-fanout-meta">{say('msMs', { ms: stmt.ms })}</span>
            </div>
            {!stmt.ok ? (
              <p className="sql-error" role="alert">
                {stmt.error}
              </p>
            ) : stmt.columns ? (
              <RowsResult
                data={{
                  columns: stmt.columns,
                  rows: stmt.rows ?? [],
                  ms: stmt.ms,
                  truncated: stmt.truncated,
                  bounded: stmt.bounded,
                }}
                onClose={onClose}
              />
            ) : (
              <p className="note">{say('scriptAffected', { count: stmt.affected ?? 0 })}</p>
            )}
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

function FanoutDiffView({
  leftLabel,
  rightLabel,
  left,
  right,
}: {
  leftLabel: string;
  rightLabel: string;
  left: SqlResult;
  right: SqlResult;
}) {
  const diff = useMemo(
    () => diffResultSets({ columns: left.columns, rows: left.rows }, { columns: right.columns, rows: right.rows }),
    [left, right],
  );
  const changed = diff.rows.filter((r) => r.status === 'changed').length;
  const added = diff.rows.filter((r) => r.status === 'added').length;
  const removed = diff.rows.filter((r) => r.status === 'removed').length;

  return (
    <div className="sql-diff-wrap">
      <div className="sql-stats">
        <span>
          {diff.keyColumn
            ? say('diffHeader', { left: leftLabel, right: rightLabel, key: diff.keyColumn })
            : say('diffNoKey', { left: leftLabel, right: rightLabel })}
        </span>
        <span>
          {diff.rows.length === 0
            ? say('diffIdentical', { count: diff.unchangedCount, left: leftLabel, right: rightLabel })
            : say('diffSummary', { changed, added, removed, unchanged: diff.unchangedCount })}
        </span>
      </div>
      {diff.rows.length > 0 ? (
        <table className="sql-diff-table">
          <thead>
            <tr>
              <th>#</th>
              {diff.columns.map((col) => (
                <th key={col}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {diff.rows.map((row, idx) => (
              <tr key={`${row.status}:${row.key}:${idx}`} className={`sql-diff-row-${row.status}`}>
                <td>
                  {row.status === 'added'
                    ? say('diffStatusAdded')
                    : row.status === 'removed'
                      ? say('diffStatusRemoved')
                      : say('diffStatusChanged')}
                </td>
                {diff.columns.map((col) => {
                  const isChanged = row.status === 'changed' && row.diffColumns.includes(col);
                  const lv = row.left?.[col];
                  const rv = row.right?.[col];
                  const fmt = (v: unknown) => (v === null || v === undefined ? 'null' : String(v));
                  return (
                    <td key={col} className={isChanged ? 'sql-diff-cell-changed' : undefined}>
                      {isChanged ? `${fmt(lv)} → ${fmt(rv)}` : row.status === 'removed' ? fmt(lv) : fmt(rv)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function Results({
  outcome,
  fanoutIdx,
  fanoutDiffOpen,
  onToggleFanoutDiff,
  onSelectFanout,
  onClose,
}: {
  outcome: Outcome;
  fanoutIdx: number;
  fanoutDiffOpen: boolean;
  onToggleFanoutDiff: () => void;
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
    case 'script':
      return <ScriptResultView data={outcome.data} onClose={onClose} />;
    case 'plan':
      return <PlanResult lines={outcome.lines} ms={outcome.ms} />;
    case 'ddl':
      return <VerifyDdlResultView data={outcome.data} ms={outcome.ms} />;
    case 'fanout': {
      const picked = outcome.entries[fanoutIdx] ?? outcome.entries[0];
      const normalized = picked ? normalizeFanoutSqlResult(picked) : null;
      const activeKey = picked?.connection ?? outcome.entries[0]?.connection ?? '';
      const okPairs = outcome.entries
        .map((entry) => ({ entry, data: normalizeFanoutSqlResult(entry) }))
        .filter((item): item is { entry: FanoutEnvEntry; data: SqlResult } => Boolean(item.data && !item.data.errors?.length));
      const canDiff = okPairs.length >= 2;

      return (
        <>
          <div className="sql-fanout-bar">
            <Tabs
              className="sql-fanout-tabs"
              variant="pills"
              ariaLabel={say('fanoutTabsLabel')}
              value={activeKey}
              onValueChange={(connKey) => {
                const idx = outcome.entries.findIndex((entry) => entry.connection === connKey);
                if (idx >= 0) onSelectFanout(idx);
              }}
              tabs={outcome.entries.map((entry) => {
                const rowCount = entry.ok ? (entry.result?.rows?.length ?? 0) : null;
                return {
                  value: entry.connection,
                  label: (
                    <span className="sql-fanout-tab-label">
                      <span className={`env-pill compact tone-${entry.tier}`}>
                        <span className="env-pill-dot" aria-hidden="true" />
                        <span>{entry.env ?? entry.name}</span>
                      </span>
                      <span className="sql-fanout-meta">
                        {entry.ok ? `${say('rows', { count: rowCount ?? 0 })} · ${say('msMs', { ms: entry.ms })}` : say('fanoutErrorBadge')}
                      </span>
                    </span>
                  ),
                };
              })}
            />
            {canDiff ? (
              <Button size="sm" onClick={onToggleFanoutDiff}>
                {fanoutDiffOpen ? say('diffEnvsActive') : say('diffEnvs')}
              </Button>
            ) : null}
          </div>
          {fanoutDiffOpen && canDiff ? (
            <FanoutDiffView
              leftLabel={okPairs[0].entry.env ?? okPairs[0].entry.name}
              rightLabel={okPairs[1].entry.env ?? okPairs[1].entry.name}
              left={okPairs[0].data}
              right={okPairs[1].data}
            />
          ) : !picked ? null : !picked.ok ? (
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
  const aggregates = useMemo(() => computeColumnAggregates(data.columns, data.rows).slice(0, 4), [data.columns, data.rows]);
  const open = (row: Record<string, unknown>) => {
    const key: Record<string, unknown> = {};
    for (const column of target!.columns.filter((c) => c.primaryKey)) key[column.name] = row[column.name];
    onClose();
    go({ kind: 'row', table: target!.id, key, label: String(Object.values(key).join('/')) }, 'reset');
  };

  const copyAs = async (format: ResultExportFormat, label: string) => {
    const formatted = formatResultExport(data.columns, data.rows, format, target?.name ?? 'results');
    try {
      await navigator.clipboard.writeText(formatted);
      toast(say('copiedFormat', { format: label }), 'ok');
    } catch {
      toast(say('copyFailed'), 'bad');
    }
  };

  const downloadCsv = () => {
    const csv = formatResultExport(data.columns, data.rows, 'csv', target?.name ?? 'results');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${target?.name ?? 'sql-result'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
        {data.rows.length > 0 ? (
          <span className="sql-result-tools">
            <button type="button" className="sql-tool-btn" onClick={() => void copyAs('csv', say('copyCsv'))}>
              {say('copyCsv')}
            </button>
            <button type="button" className="sql-tool-btn" onClick={() => void copyAs('json', say('copyJson'))}>
              {say('copyJson')}
            </button>
            <button type="button" className="sql-tool-btn" onClick={() => void copyAs('markdown', say('copyMarkdown'))}>
              {say('copyMarkdown')}
            </button>
            <button type="button" className="sql-tool-btn" onClick={() => void copyAs('insert', say('copyInsert'))}>
              {say('copyInsert')}
            </button>
            <button type="button" className="sql-tool-btn" onClick={() => void copyAs('in', say('copyIn'))}>
              {say('copyIn')}
            </button>
            <button type="button" className="sql-tool-btn" onClick={downloadCsv}>
              {say('downloadCsv')}
            </button>
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
            {aggregates.length > 0 ? (
              <div className="sql-agg-footer">
                {aggregates.map((agg) => (
                  <span key={agg.column}>
                    {say('aggregateLabel', {
                      col: agg.column,
                      sum: formatCompactNumber(agg.sum),
                      avg: formatCompactNumber(agg.avg),
                      min: formatCompactNumber(agg.min),
                      max: formatCompactNumber(agg.max),
                    })}
                  </span>
                ))}
              </div>
            ) : null}
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
          variant="danger"
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
