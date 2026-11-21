/**
 * What every tool family shares: the hints and the cost stanza their
 * declarations spread, the shape of a call, how a call finds its
 * connection, the deep link an answer carries, and the count of rows that
 * have left the machine. A family imports this and none of its siblings.
 */
import {
  findTable,
  primaryKey,
  Refusal,
  StatementStopped,
  type Registry,
  type Adapter,
  type DatabaseSchema,
} from '@mistriwork/engine/host';
import {
  classifyEnvTier,
  enrichConnectionsWithEnvironments,
  filterConnectionsByEnv,
  parseEnvironmentSelector,
  type ConnectionEnvMeta,
  type EnrichedConnection,
} from '../../shared/environments.js';

type PublicConnection = ReturnType<Registry['list']>[number];

export type { ConnectionEnvMeta } from '../../shared/environments.js';

/**
 * The hints a client acts on without reading prose: reading is all the read
 * tools do, asking twice is the same as asking once, and the world they touch
 * is the configured database, not the open internet. Declared once and spread
 * — hints that drifted per-tool would lie about exactly the thing they exist
 * to make machine-readable. A client that trusts them can stop asking
 * permission for every look.
 */
export const READS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Shared inputSchema descriptor for environment targeting on MCP tools. */
export const ENV_ARG = {
  type: 'string',
  description: 'Target environment (e.g. "local", "staging", "prod") of the active or named database.',
} as const;

/** The stanza the dispatch loop appends to every answer, declared once for
    the output schemas below. */
export const STATS = {
  type: 'object',
  description: 'What the call cost: wall ms, and rows read/written/deleted when rows moved.',
  properties: {
    ms: { type: 'number' },
    rowsRead: { type: 'number' },
    rowsWritten: { type: 'number' },
    rowsInserted: { type: 'number' },
    rowsDeleted: { type: 'number' },
  },
} as const;

export interface Open {
  adapter: Adapter;
  schema: DatabaseSchema;
  id: string;
}

/** One tool call: its arguments, and the connection they named, opened. */
export interface ToolCall extends Open {
  registry: Registry;
  args: Record<string, unknown>;
  trusted?: boolean;
}

/** What a tool does with a call. The answer is the structured result, before stats. */
export type Handler = (call: ToolCall) => Promise<Record<string, unknown>>;

const envMetaByRegistry = new WeakMap<Registry, Map<string, ConnectionEnvMeta>>();

function envMapFor(registry: Registry): Map<string, ConnectionEnvMeta> {
  let map = envMetaByRegistry.get(registry);
  if (!map) {
    map = new Map();
    envMetaByRegistry.set(registry, map);
  }
  return map;
}

export function setConnectionEnvMeta(registry: Registry, id: string, meta: ConnectionEnvMeta): void {
  const database = meta.database?.trim() || undefined;
  const env = meta.env?.trim() || undefined;
  const map = envMapFor(registry);
  if (!database && !env) {
    map.delete(id);
    return;
  }
  map.set(id, {
    ...(database ? { database } : {}),
    ...(env ? { env } : {}),
  });
}

export function getConnectionEnvMeta(registry: Registry, id: string): ConnectionEnvMeta | undefined {
  return envMetaByRegistry.get(registry)?.get(id);
}

export function removeConnectionEnvMeta(registry: Registry, id: string): void {
  envMetaByRegistry.get(registry)?.delete(id);
}

/**
 * Hydrate explicit `database`/`group` and `env`/`environment` metadata from raw `tablewalk.json` text.
 */
export function loadConfigEnvMeta(registry: Registry, rawConfigJsonText: string): void {
  let parsed: { connections?: unknown };
  try {
    parsed = JSON.parse(rawConfigJsonText) as { connections?: unknown };
  } catch {
    return;
  }
  if (!Array.isArray(parsed?.connections)) return;
  const configs = registry.configs();
  const usedIds = new Set<string>();
  for (const raw of parsed.connections) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const database = typeof rec.database === 'string' ? rec.database.trim() : typeof rec.group === 'string' ? rec.group.trim() : '';
    const env = typeof rec.env === 'string' ? rec.env.trim() : typeof rec.environment === 'string' ? rec.environment.trim() : '';
    if (!database && !env) continue;
    const match =
      configs.find((c) => c.source === 'config' && c.name === name && !usedIds.has(c.id)) ??
      configs.find((c) => c.name === name && !usedIds.has(c.id));
    if (match) {
      usedIds.add(match.id);
      setConnectionEnvMeta(registry, match.id, {
        ...(database ? { database } : {}),
        ...(env ? { env } : {}),
      });
    }
  }
}

export function listEnrichedConnections(registry: Registry): Array<EnrichedConnection<PublicConnection>> {
  return enrichConnectionsWithEnvironments(registry.list(), envMetaByRegistry.get(registry));
}

function describeEnvList(entries: ReadonlyArray<EnrichedConnection<PublicConnection>>): string {
  return entries.map((c) => `${c.database}@${c.env ?? c.tier} (${c.id})`).join(', ');
}

export async function openFor(
  registry: Registry,
  asked: unknown,
  options?: { env?: unknown; write?: boolean; fallbackConnection?: string },
): Promise<Open> {
  const rawAsked = typeof asked === 'string' ? asked.trim() : '';
  const rawEnv = typeof options?.env === 'string' ? options.env.trim() : '';
  const enriched = listEnrichedConnections(registry);
  const known = enriched.map((c) => c.id).join(', ');

  let entry: EnrichedConnection<PublicConnection> | undefined;

  const resolveInDatabasePool = (dbName: string, pool: Array<EnrichedConnection<PublicConnection>>, wantedEnv: string) => {
    const matches = filterConnectionsByEnv(pool, wantedEnv);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ToolError(
        'invalid_argument',
        `Multiple connections match "${dbName}@${wantedEnv}": ${matches.map((m) => m.id).join(', ')}. Name the exact connection id.`,
      );
    }
    throw new ToolError('not_found', `Database "${dbName}" has no "${wantedEnv}" environment. Available: ${describeEnvList(pool)}.`);
  };

  const resolveRelativeEnv = (wantedEnv: string, baseConnectionId?: string | null) => {
    const anchor = baseConnectionId ? enriched.find((c) => c.id === baseConnectionId || c.name === baseConnectionId) : undefined;
    if (anchor) {
      const dbPool = enriched.filter((c) => c.database.toLowerCase() === anchor.database.toLowerCase());
      const inAnchorDb = filterConnectionsByEnv(dbPool, wantedEnv);
      if (inAnchorDb.length === 1) return inAnchorDb[0];
      if (inAnchorDb.length > 1) {
        throw new ToolError(
          'invalid_argument',
          `Multiple connections in "${anchor.database}" match "${wantedEnv}": ${inAnchorDb.map((m) => m.id).join(', ')}. Name the connection id.`,
        );
      }
    }
    const acrossAll = filterConnectionsByEnv(enriched, wantedEnv);
    if (acrossAll.length === 1) return acrossAll[0];
    if (acrossAll.length > 1) {
      const candidates = acrossAll.map((m) => `"${m.database}@${m.env ?? wantedEnv}" (${m.id})`).join(', ');
      throw new ToolError(
        'invalid_argument',
        `Multiple databases have a "${wantedEnv}" environment: ${candidates}. Specify which database, e.g. "${acrossAll[0].database}@${wantedEnv}".`,
      );
    }
    throw new ToolError(
      'not_found',
      anchor
        ? `No "${wantedEnv}" environment found for "${anchor.database}" (or any other configured database). Available: ${describeEnvList(enriched)}.`
        : `No "${wantedEnv}" environment found. Known connections: ${known}.`,
    );
  };

  if (rawAsked) {
    // 1. Exact connection id when no separate `env` override was asked.
    const exactId = !rawEnv ? enriched.find((c) => c.id === rawAsked) : undefined;
    if (exactId) {
      entry = exactId;
    } else {
      // 2. Selector syntax: `"billing@staging"` or `"@staging"`.
      const selector = parseEnvironmentSelector(rawAsked);
      if (selector) {
        if (rawEnv && rawEnv.toLowerCase() !== selector.env.toLowerCase() && classifyEnvTier(rawEnv) !== classifyEnvTier(selector.env)) {
          throw new ToolError(
            'invalid_argument',
            `Conflicting environments: connection selector "${rawAsked}" names "${selector.env}", while env names "${rawEnv}".`,
          );
        }
        const wantedEnv = rawEnv || selector.env;
        if (selector.database) {
          const dbKey = selector.database.toLowerCase();
          const dbPool = enriched.filter((c) => c.database.toLowerCase() === dbKey);
          if (!dbPool.length) {
            throw new ToolError('not_found', `No database or connection called "${selector.database}". Known: ${known}.`);
          }
          entry = resolveInDatabasePool(dbPool[0].database, dbPool, wantedEnv);
        } else {
          entry = resolveRelativeEnv(wantedEnv, options?.fallbackConnection ?? registry.active);
        }
      } else if (rawEnv) {
        // 3. `connection: "billing"` (or `"billing-local"`) + `env: "staging"`.
        const dbKey = rawAsked.toLowerCase();
        let dbPool = enriched.filter((c) => c.database.toLowerCase() === dbKey);
        if (!dbPool.length) {
          const named = enriched.find((c) => c.id === rawAsked || c.name.toLowerCase() === dbKey);
          if (named) dbPool = enriched.filter((c) => c.database.toLowerCase() === named.database.toLowerCase());
        }
        if (!dbPool.length) {
          throw new ToolError('not_found', `No connection or database called "${rawAsked}". Known: ${known}.`);
        }
        entry = resolveInDatabasePool(dbPool[0].database, dbPool, rawEnv);
      } else {
        // 4. Plain `connection` string: exact unique name, or logical database lookup.
        const byName = enriched.filter((c) => c.name === rawAsked);
        const dbPool = enriched.filter((c) => c.database.toLowerCase() === rawAsked.toLowerCase());
        if (byName.length === 1 && dbPool.length <= 1) {
          entry = byName[0];
        } else if (dbPool.length > 1) {
          throw new ToolError(
            'invalid_argument',
            `Database "${dbPool[0].database}" spans multiple environments: ${describeEnvList(dbPool)}. ` +
              `Pass "${dbPool[0].database}@<env>" (e.g. "${dbPool[0].database}@${dbPool[0].env ?? dbPool[0].tier}") or set "env".`,
          );
        } else if (byName.length >= 1) {
          entry = byName[0];
        } else if (dbPool.length === 1) {
          entry = dbPool[0];
        }
      }
    }
  } else if (rawEnv) {
    // `env: "staging"` with no `connection`: resolve relative to active/fallback database.
    entry = resolveRelativeEnv(rawEnv, options?.fallbackConnection ?? registry.active);
  } else {
    // Implicit fallback to active connection.
    const wanted = options?.fallbackConnection ?? registry.active;
    entry = enriched.find((c) => c.id === wanted || c.name === wanted);
    if (entry && options?.write === true) {
      const explicitMeta = getConnectionEnvMeta(registry, entry.id);
      const explicitProd = explicitMeta?.env !== undefined && classifyEnvTier(explicitMeta.env) === 'prod';
      const hasNonProdSibling = entry.siblings.some((s) => s.tier !== 'prod');
      if (entry.tier === 'prod' && (explicitProd || hasNonProdSibling)) {
        const safer = entry.siblings.find((s) => s.writable && s.tier !== 'prod') ?? entry.siblings.find((s) => s.tier !== 'prod');
        const suggestion = safer
          ? ` To target ${safer.env ?? safer.tier} instead, pass "connection": "${safer.id}"${safer.env ? ` (or "env": "${safer.env}")` : ''}.`
          : '';
        throw new ToolError(
          'forbidden',
          `Active connection "${entry.id}" is a production environment (${entry.database}@${entry.env ?? 'prod'}). ` +
            `Writes to production require naming the target explicitly — pass "connection": "${entry.id}" or "env": "prod".${suggestion}`,
        );
      }
    }
  }

  if (!entry) {
    const wanted = rawAsked || options?.fallbackConnection || registry.active;
    throw new ToolError('not_found', `No connection called "${String(wanted)}". Known: ${known}.`);
  }
  const { adapter, schema } = await registry.open(entry.id);
  return { adapter, schema, id: entry.id };
}

/** The deep link a result can be opened at, for the human beside the agent. */
export const linkTo = (conn: string, segment: string) => `/${encodeURIComponent(conn)}/${segment}`;

/**
 * Rows that have left the machine this session, per connection.
 *
 * The README's trust boundary — "rows entering an agent's context leave the
 * machine" — as a number instead of a sentence. Counted where stats are
 * made, reported by `connections`, so one call answers "what has the agent
 * seen".
 */
export const sessionEgress = new Map<string, number>();

/**
 * Thrown inside `adapter.transaction(...)` when `dryRun: true` has measured
 * the database's response (generated keys, defaults, trigger effects, constraint
 * checks) and wants the adapter to issue `ROLLBACK` without recording history.
 */
export class DryRunRollback<T> extends Error {
  readonly result: T;
  constructor(result: T) {
    super('Dry run rolled back.');
    this.name = 'DryRunRollback';
    this.result = result;
  }
}

export interface AgentActivityEntry {
  seq: number;
  at: string;
  via: 'mcp' | 'console';
  tool: string;
  connection?: string;
  args: Record<string, unknown>;
  ms: number;
  isError: boolean;
  error?: string;
  rowsRead?: number;
  rowsWritten?: number;
  rowsDeleted?: number;
  dryRun?: boolean;
  undoId?: number;
  links: string[];
  answer: {
    isError: boolean;
    structuredContent?: Record<string, unknown>;
    content: Array<{ type: 'text'; text: string }>;
  };
}

const MAX_ACTIVITY = 50;
const MAX_ANSWER_TEXT = 32_768;

interface ActivityState {
  seq: number;
  entries: AgentActivityEntry[];
  egress: Map<string, number>;
}

const activityByRegistry = new WeakMap<Registry, ActivityState>();

function stateFor(registry: Registry): ActivityState {
  let st = activityByRegistry.get(registry);
  if (!st) {
    st = { seq: 0, entries: [], egress: new Map() };
    activityByRegistry.set(registry, st);
  }
  return st;
}

function compactArg(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (depth >= 2) return Array.isArray(value) ? `[${value.length}]` : '{…}';
  if (Array.isArray(value)) {
    const head = value.slice(0, 8).map((item) => compactArg(item, depth + 1));
    return value.length > 8 ? [...head, `…+${value.length - 8}`] : head;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries.slice(0, 12)) out[k] = compactArg(v, depth + 1);
    return out;
  }
  return String(value);
}

function collectLinks(structured: Record<string, unknown> | undefined): string[] {
  if (!structured) return [];
  const seen = new Set<string>();
  const walk = (value: unknown, key?: string) => {
    if (seen.size >= 8) return;
    if (key === 'link' && typeof value === 'string' && /^[#/]\/?\w/.test(value) && !value.startsWith('//')) {
      seen.add(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
    }
  };
  walk(structured);
  return [...seen];
}

export function recordAgentActivity(
  registry: Registry,
  entry: {
    via: 'mcp' | 'console';
    tool: string;
    args: Record<string, unknown>;
    ms: number;
    answer: {
      isError: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: 'text'; text: string }>;
    };
  },
): void {
  const st = stateFor(registry);
  const structured = entry.answer.structuredContent;
  const stats = (structured?.stats ?? {}) as Record<string, unknown>;
  const conn =
    typeof structured?.connection === 'string'
      ? structured.connection
      : typeof entry.args.connection === 'string'
        ? entry.args.connection
        : (registry.active ?? undefined);
  const rowsRead = typeof stats.rowsRead === 'number' ? stats.rowsRead : undefined;
  if (rowsRead && conn) st.egress.set(conn, (st.egress.get(conn) ?? 0) + rowsRead);
  const rawText = entry.answer.content[0]?.text ?? '';
  const boundedAnswer =
    rawText.length <= MAX_ANSWER_TEXT
      ? entry.answer
      : {
          isError: entry.answer.isError,
          content: [{ type: 'text' as const, text: `${rawText.slice(0, MAX_ANSWER_TEXT)}\n… (truncated in activity trail)` }],
          ...(structured
            ? {
                structuredContent: {
                  ...(conn ? { connection: conn } : {}),
                  ...(structured.link ? { link: structured.link } : {}),
                  stats,
                },
              }
            : {}),
        };
  const item: AgentActivityEntry = {
    seq: ++st.seq,
    at: new Date().toISOString(),
    via: entry.via,
    tool: entry.tool,
    ...(conn ? { connection: conn } : {}),
    args: (compactArg(entry.args) as Record<string, unknown>) ?? {},
    ms: entry.ms,
    isError: entry.answer.isError,
    ...(entry.answer.isError ? { error: rawText.slice(0, 300) } : {}),
    ...(rowsRead !== undefined ? { rowsRead } : {}),
    ...(typeof stats.rowsWritten === 'number' ? { rowsWritten: stats.rowsWritten } : {}),
    ...(typeof stats.rowsDeleted === 'number' ? { rowsDeleted: stats.rowsDeleted } : {}),
    ...(structured?.dryRun === true ? { dryRun: true } : {}),
    ...(typeof structured?.undoId === 'number' ? { undoId: structured.undoId } : {}),
    links: collectLinks(structured),
    answer: boundedAnswer,
  };
  st.entries.unshift(item);
  if (st.entries.length > MAX_ACTIVITY) st.entries.length = MAX_ACTIVITY;
}

export function agentActivity(
  registry: Registry,
  sinceSeq = 0,
): { seq: number; calls: AgentActivityEntry[]; egress: Record<string, number> } {
  const st = stateFor(registry);
  const calls = sinceSeq > 0 ? st.entries.filter((e) => e.seq > sinceSeq) : st.entries.slice();
  return {
    seq: st.seq,
    calls,
    egress: Object.fromEntries(st.egress),
  };
}

/**
 * The bound a count in an answer stops at: the one App menus count to. A
 * count is how an agent sizes a question, and "more than ten thousand"
 * sizes it as well as the exact number, for a fraction of the scan. Past
 * the bound an answer carries the bound and says so.
 */
export const COUNT_LIMIT = 10_000;
/* The bound in words, for the tool descriptions. Grouped by hand rather than
   with toLocaleString, which starts ICU (30 to 170 ms) at module load, on
   every --mcp start, to print one number. */
export const COUNT_LIMIT_WORDS = String(COUNT_LIMIT).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A key that names every primary-key column, or the error that says which are missing. */
export function wholeKeyOrThrow(schema: DatabaseSchema, table: { name: string; id: string }, key: Record<string, string | number>): void {
  const wanted = primaryKey(findTable(schema, table.id)!);
  if (!wanted.length) {
    throw new ToolError('invalid_argument', `"${table.name}" has no primary key, so no single row can be addressed by key.`);
  }
  const missing = wanted.filter((c) => key[c] === undefined);
  if (missing.length) {
    throw new ToolError(
      'invalid_argument',
      `The key is missing ${missing.join(', ')} — a ${table.name} is identified by (${wanted.join(', ')}).`,
    );
  }
}

export const ERROR_CODES = [
  /** The connection is not `"writable": true`, or the dialect has no write path here. */
  'read_only',
  /** A table, connection or tool the call names does not exist. */
  'not_found',
  /** The statement ran into its cap. Ask a narrower question. */
  'timeout',
  /** The client withdrew the call. */
  'cancelled',
  /** The arguments are wrong, missing or contradict each other. */
  'invalid_argument',
  /** Not allowed here: a tool outside the profile, a reserved table, a capability this build lacks. */
  'forbidden',
  /** Past a bound the tool sets: too many keys in one call. */
  'limit',
  /** Anything unclassified: the server's, or the database's, fault. */
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** An error with its code decided where it is thrown, which is where the reason is known. */
export class ToolError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** The code for whatever a call threw. `cancelled` is the client's own say, which beats whatever the stop looked like. */
export function errorCodeOf(error: unknown, cancelled: boolean): ErrorCode {
  if (cancelled) return 'cancelled';
  if (error instanceof ToolError) return error.code;
  if (error instanceof StatementStopped) return error.reason;
  /* The engine declining a request as written (a key that is not the whole key, a malformed lock): the caller's to fix. */
  if (error instanceof Refusal) return 'invalid_argument';
  return 'internal';
}
