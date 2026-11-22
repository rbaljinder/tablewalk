/**
 * The agent console: the MCP tools, driven by hand, plus the live activity
 * trail of external MCP clients sharing this browser server (`POST /mcp`).
 * Answers are byte-identical to what an agent receives — same code path,
 * stats and all.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, loadJson, saveJson, state, toast, trapFocus } from '@mistriwork/kit/client/core.js';
import { formatNumber } from '@mistriwork/kit/client/locale.js';
import { say } from '../copy/workbench/components/AgentConsole.js';
import { shown } from '@mistriwork/kit/client/addressMount.js';
import { addHostListener, navFollow, removeHostListener } from '@mistriwork/kit/client/shellHost.js';
import { shell } from '@mistriwork/kit/client/shellMode.js';
import { enrichConnectionsWithEnvironments, type EnvironmentTier, type SiblingEnvironment } from '../../shared/environments.js';
import './AgentConsole.css';

interface Spec {
  type?: string | string[];
  description?: string;
  items?: { type?: string };
}
export interface Tool {
  name: string;
  description?: string;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema?: { properties?: Record<string, Spec>; required?: string[] };
}
interface Answer {
  isError?: boolean;
  structuredContent?: Record<string, unknown> & { stats?: Record<string, unknown> };
  content?: Array<{ text?: string }>;
}
interface Call {
  tool: string;
  args: Record<string, unknown>;
  answer: Answer;
}
interface LiveCall {
  seq: number;
  via: 'mcp' | 'console';
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  isError: boolean;
  rowsRead?: number;
  rowsWritten?: number;
  rowsDeleted?: number;
  dryRun?: boolean;
  undoId?: number;
  answer: Answer;
}
interface ActivityPayload {
  seq?: number;
  calls?: LiveCall[];
  egress?: Record<string, number>;
  maxRows?: Record<string, number>;
  mcpEndpoint?: string | null;
}

/** ~4 characters per token is the rule of thumb the readout says it is. */
const cost = (text: string) => say('charsTokens', { chars: formatNumber(text.length), tokens: formatNumber(Math.ceil(text.length / 4)) });
const typesOf = (spec: Spec) => (Array.isArray(spec.type) ? spec.type : [spec.type]);

function Badges({ tool }: { tool: Tool }) {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint) return <span className="agent-badge tone-ok">{say('readOnly')}</span>;
  if (tool.name === 'export') return <span className="agent-badge">{say('writesFile')}</span>;
  return (
    <>
      <span className="agent-badge tone-warn">{say('writes')}</span>
      {a.destructiveHint ? <span className="agent-badge tone-bad">{say('destructive')}</span> : null}
    </>
  );
}

const NON_FANOUT_TOOLS = new Set(['connections', 'diff', 'export', 'verify_ddl']);

type ToolCategoryKey = 'catSchemaGraph' | 'catQueryWalk' | 'catDiagnostics' | 'catMigrations' | 'catSafeWrites';

const CATEGORY_ORDER: ToolCategoryKey[] = ['catSchemaGraph', 'catQueryWalk', 'catDiagnostics', 'catMigrations', 'catSafeWrites'];

function categoryOfTool(tool: Tool): ToolCategoryKey {
  if (!tool.annotations?.readOnlyHint && tool.name !== 'export') return 'catSafeWrites';
  if (
    tool.name === 'connections' ||
    tool.name === 'refresh' ||
    tool.name === 'schema_summary' ||
    tool.name === 'tables' ||
    tool.name === 'table' ||
    tool.name === 'path'
  ) {
    return 'catSchemaGraph';
  }
  if (tool.name === 'lint' || tool.name === 'perf' || tool.name === 'anomalies' || tool.name === 'profile' || tool.name === 'explain') {
    return 'catDiagnostics';
  }
  if (
    tool.name === 'diff' ||
    tool.name === 'change_impact' ||
    tool.name === 'verify_ddl' ||
    tool.name === 'order' ||
    tool.name === 'fixture'
  ) {
    return 'catMigrations';
  }
  return 'catQueryWalk';
}

function categoryLabel(cat: ToolCategoryKey): string {
  switch (cat) {
    case 'catSchemaGraph':
      return say('catSchemaGraph');
    case 'catQueryWalk':
      return say('catQueryWalk');
    case 'catDiagnostics':
      return say('catDiagnostics');
    case 'catMigrations':
      return say('catMigrations');
    case 'catSafeWrites':
      return say('catSafeWrites');
  }
}

function canFanOutTool(tool: Tool | undefined): boolean {
  if (!tool) return false;
  return Boolean(tool.annotations?.readOnlyHint) && !NON_FANOUT_TOOLS.has(tool.name);
}

const ALL_ENVS_TARGET = '__all_envs__';

export function AgentConsole({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const seenWriteSeq = useRef(0);
  const tools = useQuery<Tool[]>({
    queryKey: ['agent-tools'],
    queryFn: async () => (await api('/api/agent/tools')).tools ?? [],
    retry: false,
    staleTime: Infinity,
  });
  const activity = useQuery<ActivityPayload>({
    queryKey: ['agent-activity'],
    queryFn: async () => (await api('/api/agent/activity' as never)) as ActivityPayload,
    retry: false,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [toolFilter, setToolFilter] = useState('');
  const [pinnedTarget, setPinnedTarget] = useState<string | null>(null);
  const [followAgent, setFollowAgent] = useState<boolean>(() => Boolean(loadJson('mistri.followAgent.v1', false)));
  const seenFollowSeq = useRef<number | null>(null);
  const [transcript, setTranscript] = useState<Call[]>([]);
  const [answer, setAnswer] = useState<
    { kind: 'idle' } | { kind: 'running'; tool: string } | { kind: 'error'; message: string } | { kind: 'answer'; answer: Answer }
  >({ kind: 'idle' });
  useEffect(() => {
    const release = trapFocus(panel.current!.parentElement ?? panel.current!) as (() => void) | undefined;
    return () => release?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        (document.activeElement as HTMLElement).blur();
        return;
      }
      e.preventDefault();
      onClose();
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  }, [onClose]);
  useEffect(() => {
    if (tools.isError) {
      toast((tools.error as Error).message, 'error');
      onClose();
    }
  }, [tools.isError]); // eslint-disable-line react-hooks/exhaustive-deps

  const externalCalls = Array.isArray(activity.data?.calls)
    ? activity.data!.calls.filter((c) => c.via === 'mcp' || (c as { via?: string }).via === 'mcp-http')
    : [];
  useEffect(() => {
    const newestUndo = externalCalls.find((c) => c.undoId !== undefined || (c.rowsWritten ?? 0) > 0 || (c.rowsDeleted ?? 0) > 0);
    if (newestUndo && newestUndo.seq > seenWriteSeq.current) {
      seenWriteSeq.current = newestUndo.seq;
      void shell().undo?.refresh?.();
    }
  }, [externalCalls]);

  useEffect(() => {
    const maxSeq = externalCalls.reduce((m, c) => Math.max(m, c.seq), 0);
    if (seenFollowSeq.current === null) {
      seenFollowSeq.current = maxSeq;
      return;
    }
    if (!followAgent) {
      seenFollowSeq.current = Math.max(seenFollowSeq.current, maxSeq);
      return;
    }
    const fresh = externalCalls.find((c) => c.seq > (seenFollowSeq.current ?? 0) && !c.isError);
    if (!fresh) return;
    seenFollowSeq.current = Math.max(seenFollowSeq.current, maxSeq);
    const rawLinks = (fresh as { links?: string[] }).links;
    const link =
      (Array.isArray(rawLinks) && typeof rawLinks[0] === 'string' ? rawLinks[0] : undefined) ??
      (typeof fresh.answer?.structuredContent?.link === 'string' ? fresh.answer.structuredContent.link : undefined);
    if (link) {
      onClose();
      navFollow(link);
    }
  }, [externalCalls, followAgent, onClose]);

  const toggleFollowAgent = () => {
    const next = !followAgent;
    setFollowAgent(next);
    saveJson('mistri.followAgent.v1', next);
  };

  if (!tools.data)
    return (
      <div className="conn-inner" ref={panel}>
        <p className="loading">{say('readingTheTools')}</p>
      </div>
    );
  const list = tools.data;
  const filterNorm = toolFilter.trim().toLowerCase();
  const filteredTools = filterNorm
    ? list.filter((t) => t.name.toLowerCase().includes(filterNorm) || (t.description ?? '').toLowerCase().includes(filterNorm))
    : list;
  const groupedTools = CATEGORY_ORDER.map((cat) => ({
    cat,
    items: filteredTools.filter((t) => categoryOfTool(t) === cat),
  })).filter((g) => g.items.length > 0);

  const tool = list.find((t) => t.name === selected) ?? filteredTools[0] ?? list[0];
  const connState = state as {
    activeConnection?: string;
    connections?: Array<{
      id: string;
      name?: string;
      detail?: string;
      writable?: boolean;
      rows?: boolean;
      hidesColumns?: boolean;
      redactsRows?: boolean;
      maxRows?: number;
      database?: string;
      env?: string;
      tier?: EnvironmentTier;
      siblings?: SiblingEnvironment[];
    }>;
  };
  const enrichedConnections = enrichConnectionsWithEnvironments((connState.connections ?? []).map((c) => ({ ...c, name: c.name ?? c.id })));
  const activeId = connState.activeConnection;
  const activeConn = enrichedConnections.find((c) => c.id === activeId) ?? enrichedConnections[0];
  const siblingEnvCount = activeConn ? 1 + (activeConn.siblings?.length ?? 0) : 0;
  const fanoutEligible = siblingEnvCount > 1 && canFanOutTool(tool);
  const isAllEnvs = fanoutEligible && pinnedTarget === ALL_ENVS_TARGET;
  const targetId = !isAllEnvs && pinnedTarget && enrichedConnections.some((c) => c.id === pinnedTarget) ? pinnedTarget : activeId;

  const pick = (name: string) => {
    setSelected(name);
    setAnswer({ kind: 'idle' });
  };
  const call = async (args: Record<string, unknown>) => {
    setAnswer({ kind: 'running', tool: tool.name });
    const effectiveArgs = isAllEnvs
      ? args.envs === undefined
        ? { ...args, envs: 'all' }
        : args
      : targetId &&
          targetId !== activeId &&
          args.connection === undefined &&
          args.env === undefined &&
          tool.name !== 'connections' &&
          (tool.name !== 'diff' || (args.from === undefined && args.fromEnv === undefined))
        ? tool.name === 'diff'
          ? { ...args, from: targetId }
          : { ...args, connection: targetId }
        : args;
    let got: Answer;
    try {
      got = await api('/api/agent/call', { name: tool.name, arguments: effectiveArgs });
    } catch (err) {
      setAnswer({ kind: 'error', message: (err as Error).message });
      return;
    }
    if (got.structuredContent?.undoId !== undefined) void shell().undo?.refresh?.();
    void activity.refetch();
    setTranscript((was) => [{ tool: tool.name, args: effectiveArgs, answer: got }, ...was]);
    setAnswer({ kind: 'answer', answer: got });
  };
  const mcpUrl = typeof activity.data?.mcpEndpoint === 'string' ? activity.data.mcpEndpoint : null;
  const copyMcpUrl = async () => {
    if (!mcpUrl) return;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      toast(say('copiedMcpEndpoint'));
    } catch {
      /* Clipboard denied. */
    }
  };
  return (
    <div className="conn-inner" ref={panel}>
      <div className="conn-head">
        <div className="conn-head-titles">
          <div className="conn-brand" aria-hidden="true">
            <span className="brand-mark" />
            <span className="conn-brand-name">tablewalk</span>
          </div>
          <h2>{say('agentConsole')}</h2>
          <p className="conn-lede">{say('theMcpToolsDriven')}</p>
        </div>
        <div className="conn-head-actions">
          {mcpUrl ? (
            <>
              <button
                type="button"
                className={`ghost${followAgent ? ' active' : ''}`}
                aria-pressed={followAgent}
                title={say('followAgentTitle')}
                onClick={toggleFollowAgent}
              >
                {say('followAgent')}
              </button>
              <button type="button" className="ghost" onClick={() => void copyMcpUrl()}>
                {say('copyMcpEndpoint', { url: mcpUrl })}
              </button>
            </>
          ) : null}
          <button type="button" onClick={onClose}>
            {say('common.done')}
          </button>
        </div>
      </div>
      <div className="agent-body">
        <div className="agent-rail">
          {list.length > 6 ? (
            <input
              type="search"
              className="agent-tool-search"
              aria-label={say('filterToolsLabel')}
              placeholder={say('filterToolsPlaceholder', { count: list.length })}
              value={toolFilter}
              onChange={(e) => setToolFilter(e.currentTarget.value)}
            />
          ) : null}
          <div className="agent-tools" role="listbox" aria-label={say('tools')}>
            {groupedTools.length === 0 ? (
              <p className="note">{say('noMatchingTools', { query: toolFilter.trim() })}</p>
            ) : list.length > 6 ? (
              groupedTools.map(({ cat, items }) => (
                <div key={cat} role="presentation">
                  <div className="agent-cat-head" aria-hidden="true">
                    {categoryLabel(cat)}
                  </div>
                  {items.map((t) => (
                    <button
                      key={t.name}
                      type="button"
                      className={`agent-tool${t.name === tool?.name ? ' active' : ''}`}
                      role="option"
                      aria-selected={t.name === tool?.name}
                      onClick={() => pick(t.name)}
                    >
                      <span className="agent-tool-name">{t.name}</span>
                      <span className="agent-tool-badges">
                        <Badges tool={t} />
                      </span>
                    </button>
                  ))}
                </div>
              ))
            ) : (
              filteredTools.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className={`agent-tool${t.name === tool?.name ? ' active' : ''}`}
                  role="option"
                  aria-selected={t.name === tool?.name}
                  onClick={() => pick(t.name)}
                >
                  <span className="agent-tool-name">{t.name}</span>
                  <span className="agent-tool-badges">
                    <Badges tool={t} />
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="agent-main">
          {enrichedConnections.length > 0 ? (
            <div className="agent-target-bar" role="group" aria-label={say('targetConnectionsGroup')}>
              <span className="agent-target-label">{say('targetConnectionLabel')}</span>
              <div className="agent-target-list">
                {enrichedConnections.map((conn) => {
                  const current = !isAllEnvs && conn.id === targetId;
                  const rowsRead = activity.data?.egress?.[conn.id] ?? 0;
                  const connMax = activity.data?.maxRows?.[conn.id] ?? conn.maxRows;
                  return (
                    <button
                      key={conn.id}
                      type="button"
                      className={`agent-target-pill tone-${conn.tier}${current ? ' active' : ''}`}
                      aria-pressed={current}
                      onClick={() => setPinnedTarget(conn.id === activeId ? null : conn.id)}
                    >
                      <span className="env-pill-dot" aria-hidden="true" />
                      <span className="agent-target-name">{conn.name}</span>
                      {conn.env ? <span className={`env-pill compact tone-${conn.tier}`}>{conn.env}</span> : null}
                      <span className="agent-target-posture">
                        {conn.rows === false
                          ? say('shapeOnlyBadge')
                          : conn.redactsRows
                            ? say('maskedBadge')
                            : conn.writable
                              ? say('writableBadge')
                              : say('readOnly')}
                      </span>
                      {connMax !== undefined ? (
                        <span className={`agent-target-egress${rowsRead >= connMax ? ' at-cap' : ''}`}>
                          {say('rowsBudgetPill', { read: formatNumber(rowsRead), max: formatNumber(connMax) })}
                        </span>
                      ) : rowsRead > 0 ? (
                        <span className="agent-target-egress">{say('rowsReadPill', { read: formatNumber(rowsRead) })}</span>
                      ) : null}
                    </button>
                  );
                })}
                {fanoutEligible ? (
                  <button
                    type="button"
                    className={`agent-target-pill${isAllEnvs ? ' active' : ''}`}
                    aria-pressed={isAllEnvs}
                    title={say('allEnvsTitle')}
                    onClick={() => setPinnedTarget(isAllEnvs ? null : ALL_ENVS_TARGET)}
                  >
                    <span>{say('allEnvsPill', { count: siblingEnvCount })}</span>
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {tool ? (
            <>
              <ToolForm
                key={tool.name}
                tool={tool}
                targetConnection={isAllEnvs ? undefined : targetId}
                onCall={call}
                onBadJson={(message) => setAnswer({ kind: 'error', message })}
              />
              <div className="agent-result">
                {answer.kind === 'running' ? (
                  <p className="loading">{say('calling', { tool: answer.tool })}</p>
                ) : answer.kind === 'error' ? (
                  <p className="agent-error" role="alert">
                    {answer.message}
                  </p>
                ) : answer.kind === 'answer' ? (
                  <AnswerView answer={answer.answer} onClose={onClose} />
                ) : null}
              </div>
              <LiveActivityTrail
                calls={externalCalls}
                egress={activity.data?.egress}
                onShow={(a) => setAnswer({ kind: 'answer', answer: a })}
              />
              <Transcript calls={transcript} onShow={(a) => setAnswer({ kind: 'answer', answer: a })} />
            </>
          ) : (
            <p className="note">{say('noToolsIsTheServer')}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolForm({
  tool,
  targetConnection,
  onCall,
  onBadJson,
}: {
  tool: Tool;
  targetConnection?: string;
  onCall: (args: Record<string, unknown>) => void;
  onBadJson: (message: string) => void;
}) {
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const [values, setValues] = useState<Record<string, string>>({});
  const run = () => {
    const args: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(properties)) {
      const raw = (values[name] ?? '').trim();
      if (!raw) continue;
      const types = typesOf(spec);
      if (types.includes('object')) {
        /* Objects arrive as JSON, because a key or a set of values is a shape the caller composes. */
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
          args[name] = parsed;
        } catch {
          onBadJson(say('isNotJson', { name, raw: raw.slice(0, 60) }));
          return;
        }
      } else if (types.includes('array')) {
        if (spec.items?.type === 'string' && !raw.startsWith('[')) {
          args[name] = raw
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        } else {
          try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error();
            args[name] = parsed;
          } catch {
            onBadJson(say('isNotJson', { name, raw: raw.slice(0, 60) }));
            return;
          }
        }
      } else if ((types.includes('number') || types.includes('integer')) && !Number.isNaN(Number(raw))) {
        args[name] = Number(raw);
      } else if (types.includes('boolean')) {
        args[name] = raw === 'true' || raw === '1' || raw === 'yes';
      } else {
        args[name] = raw;
      }
    }
    onCall(args);
  };
  return (
    <div className="agent-form">
      <div className="agent-desc-row">
        <h3>{tool.annotations?.title ?? tool.name}</h3>
        <Badges tool={tool} />
      </div>
      {/* The description, shown whole: this text is the tool's entire pitch to a model deciding whether to call it. */}
      <p className="agent-desc">{tool.description}</p>
      {Object.entries(properties).map(([name, spec]) => {
        const types = typesOf(spec);
        const isJson = types.includes('object') || types.includes('array');
        const set = (v: string) => setValues((was) => ({ ...was, [name]: v }));
        return (
          <div key={name} className="agent-field">
            <label>
              {name}
              {required.has(name) ? <span className="req">{say('required')}</span> : null}
            </label>
            {isJson ? (
              <textarea
                className="agent-input agent-json"
                rows={2}
                spellCheck={false}
                placeholder={spec.description ?? (types.includes('array') ? '[ ]' : '{ }')}
                aria-label={`${name} (json)`}
                value={values[name] ?? ''}
                onChange={(e) => set(e.currentTarget.value)}
              />
            ) : (
              <input
                type="text"
                className="agent-input"
                autoComplete="off"
                spellCheck={false}
                aria-label={name}
                placeholder={name === 'connection' ? `${targetConnection ?? 'active'} (active)` : (spec.description ?? '')}
                value={values[name] ?? ''}
                onChange={(e) => set(e.currentTarget.value)}
              />
            )}
          </div>
        );
      })}
      <div className="agent-run-row">
        <button type="button" className="primary" onClick={run}>
          {say('callTool')}
        </button>
      </div>
    </div>
  );
}

function AnswerView({ answer, onClose }: { answer: Answer; onClose: () => void }) {
  const text = answer.structuredContent ? JSON.stringify(answer.structuredContent, null, 2) : (answer.content?.[0]?.text ?? '');
  const stats = answer.structuredContent?.stats ?? {};
  /* Every deep link in the answer (`link` fields from `linkTo`), surfaced as a real door: "see that row" should cost one click. */
  const links: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (key === 'link' && typeof value === 'string' && /^[#/]\/?\w/.test(value) && !value.startsWith('//')) links.push(value);
    else if (Array.isArray(value)) value.forEach((item) => walk(item));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(answer.structuredContent ?? {});
  return (
    <>
      <div className="agent-stats">
        {answer.isError ? <span className="agent-badge tone-bad">isError</span> : null}
        {answer.structuredContent?.dryRun === true ? <span className="agent-badge">{say('dryRunBadge')}</span> : null}
        {Object.entries(stats).map(([k, v]) => (
          <span key={k} className="stat">{`${k} ${v}`}</span>
        ))}
        <span className="stat">{cost(text)}</span>
      </div>
      <pre className={`agent-answer${answer.isError ? ' agent-answer-error' : ''}`}>{text}</pre>
      {links.length ? (
        <div className="agent-links">
          {links.slice(0, 8).map((hash) => (
            <button
              key={hash}
              type="button"
              className="ghost"
              onClick={() => {
                onClose();
                /* A path is navigated, not assigned to `location.hash`; pushState so the console's own history entry survives. */
                navFollow(shown(hash.replace(/^#/, '')));
              }}
            >
              {say('openLink', { link: decodeURIComponent(hash).slice(0, 60) })}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function LiveActivityTrail({
  calls,
  egress,
  onShow,
}: {
  calls: LiveCall[];
  egress?: Record<string, number>;
  onShow: (answer: Answer) => void;
}) {
  if (!calls.length) return null;
  const totalEgress = egress
    ? Object.values(egress).reduce((n, v) => n + (Number(v) || 0), 0)
    : calls.reduce((n, c) => n + (c.rowsRead ?? 0), 0);
  return (
    <div className="agent-transcript agent-live-trail">
      <h4>{say('liveMcpHeading', { calls: say('calls', { count: calls.length }), rows: say('rows', { count: totalEgress }) })}</h4>
      {calls.slice(0, 12).map((entry) => {
        const size = entry.answer.content?.[0]?.text?.length ?? 0;
        return (
          <button key={entry.seq} type="button" className="agent-past" onClick={() => onShow(entry.answer)}>
            <span className="agent-badge tone-ok">{say('viaMcp')}</span>
            {entry.dryRun ? <span className="agent-badge">{say('dryRunBadge')}</span> : null}
            <span className="agent-past-tool">{entry.tool}</span>
            <span className="agent-past-args">{JSON.stringify(entry.args).slice(0, 60)}</span>
            <span className="agent-past-cost">{say('callCost', { ms: String(entry.ms), size: formatNumber(size) })}</span>
          </button>
        );
      })}
    </div>
  );
}

function Transcript({ calls, onShow }: { calls: Call[]; onShow: (answer: Answer) => void }) {
  if (!calls.length) return <div />;
  const rows = calls.reduce((n, e) => n + (Number(e.answer.structuredContent?.stats?.rowsRead) || 0), 0);
  return (
    <div className="agent-transcript">
      <h4>{say('thisSessionRead', { calls: say('calls', { count: calls.length }), rows: say('rows', { count: rows }) })}</h4>
      {calls.slice(0, 12).map((entry, i) => {
        const size = entry.answer.content?.[0]?.text?.length ?? 0;
        return (
          <button key={i} type="button" className="agent-past" onClick={() => onShow(entry.answer)}>
            <span className="agent-past-tool">{entry.tool}</span>
            <span className="agent-past-args">{JSON.stringify(entry.args).slice(0, 60)}</span>
            <span className="agent-past-cost">
              {say('callCost', { ms: String(entry.answer.structuredContent?.stats?.ms ?? '–'), size: formatNumber(size) })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
