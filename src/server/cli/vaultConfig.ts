/**
 * Vault & piped configuration input, connection lease enforcement, agent
 * blocklist installation, and fast one-shot CLI query/tool execution.
 *
 * Loaded on demand only when piped/vault input, blocklists, leases, environment
 * targeting flags, or one-shot `--query`/`--call` options are used, so plain
 * `--help`, `--mcp`, and `serve` keep their exact cold-start module budgets.
 */
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { Registry, Refusal, looksLikeBreakdown, redact, type Adapter, type DatabaseSchema, type ViewDef } from '@mistriwork/engine/host';
import { lendWriteView, writeViewOf } from '@mistriwork/engine/adapters/storeHost.js';
import { sqliteTargetFrom } from '@mistriwork/engine/server/configPaths.js';
import { product } from '@mistriwork/engine/server/product.js';
import { parseViewsConfig } from '@mistriwork/engine/shared/view.js';
import { parseQueriesConfig, type SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import { parsePagesConfig, type PageDef } from '@mistriwork/engine/shared/page.js';
import { parseLayoutsConfig } from '@mistriwork/engine/shared/recordview.js';
import {
  applyBlocklist,
  extractConnectionBlocklist,
  hasBlocklistRules,
  mergeBlocklists,
  parseBlocklist,
  type BlocklistRules,
} from '../blocklist.js';
import {
  getConnectionConfigExtras,
  getConnectionEnvMeta,
  getTopLevelConfigExtras,
  loadConfigEnvMeta,
  resolveConnectionEntry,
  setConnectionConfigExtras,
  setConnectionEnvMeta,
  setTopLevelConfigExtras,
} from '../mcp/toolkit.js';
import { bindShelf, runTool } from '../mcp.js';

const MAX_PIPED_CONFIG_BYTES = 8 * 1024 * 1024;

export interface LeaseSpec {
  idleSeconds?: number;
  maxSeconds?: number;
  exitOnExpire?: boolean;
}

export interface LoadedVaultConfig {
  registry: Registry;
  namesApps?: boolean;
  views: ViewDef[];
  queries: SavedQuery[];
  pages: PageDef[];
  layouts: ReturnType<typeof parseLayoutsConfig>;
  active?: string;
  only?: boolean;
  lazy?: boolean;
  lease?: LeaseSpec;
  remainingStdin?: NodeJS.ReadableStream;
}

/** Parse seconds from `120`, `"120"`, `"120s"`, `"5m"`, `"1h"`, `"500ms"`. */
export function parseDurationSeconds(raw: unknown, where: string): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error(`${where} must be a positive number of seconds, not ${JSON.stringify(raw)}.`);
    }
    return raw;
  }
  if (typeof raw === 'string') {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs)?$/i.exec(raw.trim());
    if (!m) {
      throw new Error(`${where} must be a positive duration like 60, "60s", or "5m", not ${JSON.stringify(raw)}.`);
    }
    const n = Number(m[1]);
    const unit = (m[2] ?? 's').toLowerCase();
    const seconds = unit === 'ms' ? n / 1000 : unit.startsWith('m') ? n * 60 : unit.startsWith('h') ? n * 3600 : n;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`${where} must be greater than zero.`);
    }
    return seconds;
  }
  throw new Error(`${where} must be a number of seconds or duration string, not ${JSON.stringify(raw)}.`);
}

export function parseLeaseSpec(raw: unknown, where: string): LeaseSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const maxSeconds = parseDurationSeconds(raw, `${where} "lease"`);
    return {
      maxSeconds,
      idleSeconds: Math.min(60, maxSeconds),
      exitOnExpire: true,
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${where}: "lease" must be seconds (e.g. 120) or { "idleSeconds"?: number, "maxSeconds"?: number, "exitOnExpire"?: boolean }.`,
    );
  }
  const rec = raw as Record<string, unknown>;
  const allowed = new Set(['idleSeconds', 'maxSeconds', 'ttlSeconds', 'seconds', 'exitOnExpire']);
  const unknown = Object.keys(rec).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw new Error(
      `${where}: unknown key ${unknown.map((k) => `"${k}"`).join(', ')} in "lease" (expected idleSeconds, maxSeconds, exitOnExpire).`,
    );
  }
  const maxRaw = rec.maxSeconds ?? rec.ttlSeconds ?? rec.seconds;
  const idleSeconds = rec.idleSeconds !== undefined ? parseDurationSeconds(rec.idleSeconds, `${where} lease.idleSeconds`) : undefined;
  const maxSeconds = maxRaw !== undefined ? parseDurationSeconds(maxRaw, `${where} lease.maxSeconds`) : undefined;
  if (rec.exitOnExpire !== undefined && typeof rec.exitOnExpire !== 'boolean') {
    throw new Error(`${where}: lease.exitOnExpire must be true or false.`);
  }
  if (idleSeconds === undefined && maxSeconds === undefined) return undefined;
  return {
    ...(idleSeconds !== undefined ? { idleSeconds } : {}),
    ...(maxSeconds !== undefined ? { maxSeconds } : {}),
    exitOnExpire: rec.exitOnExpire !== false,
  };
}

export function mergeLeaseSpecs(base?: LeaseSpec, override?: LeaseSpec): LeaseSpec | undefined {
  if (!base && !override) return undefined;
  const idleCandidates = [base?.idleSeconds, override?.idleSeconds].filter((n): n is number => n !== undefined);
  const maxCandidates = [base?.maxSeconds, override?.maxSeconds].filter((n): n is number => n !== undefined);
  return {
    ...(idleCandidates.length ? { idleSeconds: Math.min(...idleCandidates) } : {}),
    ...(maxCandidates.length ? { maxSeconds: Math.min(...maxCandidates) } : {}),
    exitOnExpire: override?.exitOnExpire ?? base?.exitOnExpire ?? true,
  };
}

/** Parse `.env`-formatted text into key/value pairs without mutating `process.env`. */
export function parseDotenvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = stripped.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') {
        val = val.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    } else {
      const hashAt = val.indexOf(' #');
      if (hashAt >= 0) val = val.slice(0, hashAt).trim();
    }
    out[key] = val;
  }
  return out;
}

function parseEnvObject(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} must be an object mapping environment variable names to string values.`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new Error(`${where}: invalid variable name "${k}".`);
    }
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new Error(`${where}["${k}"] must be a string, number, or boolean.`);
    }
    out[k] = String(v);
  }
  return out;
}

/**
 * Scan `.env` text on a combined `--mcp --config -` stdin stream to find where
 * the `.env` header ends and the first MCP JSON-RPC line (`{...}`) begins.
 * Returns the character index of the split, or `-1` if no JSON-RPC line has
 * arrived yet.
 */
function findDotenvMcpBoundary(acc: string): { configEnd: number; restStart: number } | null {
  let pos = 0;
  while (pos < acc.length) {
    const nl = acc.indexOf('\n', pos);
    const lineEnd = nl < 0 ? acc.length : nl;
    const trimmed = acc.slice(pos, lineEnd).trim();
    if (trimmed === '---') {
      return { configEnd: pos, restStart: nl < 0 ? acc.length : nl + 1 };
    }
    if (trimmed.startsWith('{')) {
      return { configEnd: pos, restStart: pos };
    }
    if (nl < 0) break;
    pos = nl + 1;
  }
  return null;
}

/**
 * Read a piped config document from `stdin`.
 *
 * In non-MCP modes, reads until EOF.
 * In `--mcp` mode (`{ vault get; cat; } | tablewalk --mcp --config -`), scans
 * either the leading balanced JSON object/array OR the leading `.env` lines
 * (stopping before the first `{` JSON-RPC line or `---` delimiter) without
 * waiting for EOF, and returns a `PassThrough` stream carrying any remaining
 * bytes plus live `stdin` events for the MCP JSON-RPC protocol.
 */
async function readStdinConfig(mcpMode: boolean): Promise<{ text: string; remainingStdin?: NodeJS.ReadableStream }> {
  if (!mcpMode) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > MAX_PIPED_CONFIG_BYTES) {
        throw new Error(`Piped config on stdin exceeds ${MAX_PIPED_CONFIG_BYTES} bytes.`);
      }
      chunks.push(buf);
    }
    return { text: Buffer.concat(chunks).toString('utf8') };
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const decoder = new StringDecoder('utf8');
    let acc = '';
    let bytes = 0;
    let startedAt = -1;
    let openChar = '';
    let closeChar = '';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let scanIdx = 0;

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    };

    const onError = (err: Error) => {
      cleanup();
      rejectPromise(err);
    };

    const finishAt = (configEndExclusive: number, restStartIndex: number) => {
      cleanup();
      process.stdin.pause();
      const configText = acc.slice(0, configEndExclusive);
      let rest = acc.slice(restStartIndex);
      rest = rest.replace(/^[ \t\r]*\n?/, '');
      const pass = new PassThrough();
      if (rest.length > 0) pass.write(rest, 'utf8');
      process.stdin.on('data', (chunk) => pass.write(chunk));
      process.stdin.once('end', () => pass.end());
      process.stdin.once('error', (err) => pass.destroy(err));
      process.stdin.resume();
      resolvePromise({ text: configText, remainingStdin: pass });
    };

    const onEnd = () => {
      cleanup();
      const full = acc + decoder.end();
      if (startedAt === -2) {
        const boundary = findDotenvMcpBoundary(full);
        if (boundary) {
          const pass = new PassThrough();
          const rest = full.slice(boundary.restStart).replace(/^[ \t\r]*\n?/, '');
          if (rest.length > 0) pass.write(rest, 'utf8');
          pass.end();
          resolvePromise({ text: full.slice(0, boundary.configEnd), remainingStdin: pass });
          return;
        }
      }
      const pass = new PassThrough();
      pass.end();
      resolvePromise({ text: full, remainingStdin: pass });
    };

    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > MAX_PIPED_CONFIG_BYTES) {
        cleanup();
        rejectPromise(new Error(`Piped config on stdin exceeds ${MAX_PIPED_CONFIG_BYTES} bytes.`));
        return;
      }
      acc += decoder.write(buf);
      for (; scanIdx < acc.length; scanIdx++) {
        const ch = acc[scanIdx];
        if (startedAt === -1) {
          if (/\s/.test(ch)) continue;
          if (ch === '{' || ch === '[') {
            startedAt = scanIdx;
            openChar = ch;
            closeChar = ch === '{' ? '}' : ']';
            depth = 1;
            continue;
          }
          startedAt = -2;
          break;
        }
        if (startedAt === -2) break;
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') {
          inString = true;
        } else if (ch === openChar) {
          depth++;
        } else if (ch === closeChar) {
          depth--;
          if (depth === 0) {
            finishAt(scanIdx + 1, scanIdx + 1);
            return;
          }
        }
      }
      if (startedAt === -2) {
        const boundary = findDotenvMcpBoundary(acc);
        if (boundary) {
          finishAt(boundary.configEnd, boundary.restStart);
        }
      }
    };

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

async function readRawVaultSource(
  configArg: string | undefined,
  mcpMode: boolean,
): Promise<{ text: string; where: string; remainingStdin?: NodeJS.ReadableStream }> {
  if (!configArg && process.env.TABLEWALK_CONFIG_JSON?.trim()) {
    return { text: process.env.TABLEWALK_CONFIG_JSON, where: 'TABLEWALK_CONFIG_JSON' };
  }
  if (configArg === '-' || configArg === '/dev/stdin') {
    const read = await readStdinConfig(mcpMode);
    return { text: read.text, where: 'stdin (--config -)', remainingStdin: read.remainingStdin };
  }
  if (configArg) {
    const text = await readFile(configArg, 'utf8');
    return { text, where: configArg };
  }
  const read = await readStdinConfig(false);
  return { text: read.text, where: 'stdin' };
}

function validateHiddenShape(raw: unknown, where: string): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
    throw new Error(`${where}: "hidden" must be an object of table -> column names.`);
  }
  for (const [table, cols] of Object.entries(raw as Record<string, unknown>)) {
    if (
      !table.trim() ||
      !Array.isArray(cols) ||
      !cols.length ||
      cols.some((c) => typeof c !== 'string' || !c.trim() || /^\*+$/.test(c.trim()))
    ) {
      throw new Error(`${where}: "hidden" for "${table}" must be a non-empty list of column patterns (not "*").`);
    }
  }
  return raw as Record<string, string[]>;
}

export interface PolicyRegistryOptions {
  environment?: NodeJS.ProcessEnv;
  defaultBlocklist?: BlocklistRules;
  blocklists?: Map<string, BlocklistRules>;
  connectionLeases?: Map<string, LeaseSpec>;
  sessionLease?: LeaseSpec;
  mcpMode?: boolean;
}

interface ManagedSlot {
  rawAdapter: Adapter;
  wrapped: Adapter;
  schema: DatabaseSchema;
  evicted: boolean;
}

/**
 * First-class `Registry` subclass enforcing table/field blocklists and
 * connection leases across every route to an adapter (`open`, `refresh`,
 * `dialedAdapter`, `onAdapterDialed`, `lease`, `update`, `remove`, `closeAll`,
 * `list`, `poolStats`, and `add`).
 *
 * Key invariants:
 * - Default top-level `blocklist` and `sessionLease` apply dynamically via
 *   `rulesFor(id)` and `leaseFor(id)` to connections added after construction
 *   (CLI positional/`--db` targets, `--demo`, and browser session connections).
 * - Idle eviction closes the underlying adapter handle in place (`slot.evicted = true`)
 *   without calling `remove`/`add`, so `active` never moves even momentarily.
 * - Both `applyBlocklist` and `wrapLeasedAdapter` build explicit allowlist
 *   `Adapter` facades with zero prototype or unlisted-method inheritance.
 */
export class PolicyRegistry extends Registry {
  private readonly defaultBlocklist?: BlocklistRules;
  private readonly blocklists = new Map<string, BlocklistRules>();
  private readonly connectionLeases = new Map<string, LeaseSpec>();
  private readonly sessionLease?: LeaseSpec;
  private readonly mcpMode: boolean;

  private readonly slots = new Map<string, ManagedSlot>();
  private readonly inFlight = new Map<string, number>();
  private readonly leasePins = new Map<string, number>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly connMaxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly expiredIds = new Set<string>();
  private readonly evicting = new Map<string, Promise<void>>();
  private readonly reopening = new Map<string, Promise<{ adapter: Adapter; schema: DatabaseSchema }>>();
  private readonly refreshingFromEvict = new Set<string>();
  private sessionExpired = false;
  private sessionMaxTimer?: ReturnType<typeof setTimeout>;

  constructor(options: PolicyRegistryOptions = {}) {
    super(options.environment ? { environment: options.environment } : {});
    this.defaultBlocklist = options.defaultBlocklist;
    if (options.blocklists) {
      for (const [id, rules] of options.blocklists) {
        this.blocklists.set(id, rules);
      }
    }
    if (options.connectionLeases) {
      for (const [id, lease] of options.connectionLeases) {
        this.connectionLeases.set(id, lease);
      }
    }
    this.sessionLease = options.sessionLease;
    this.mcpMode = options.mcpMode === true;

    if (this.sessionLease?.maxSeconds) {
      const maxSec = this.sessionLease.maxSeconds;
      this.sessionMaxTimer = setTimeout(
        () => {
          this.sessionExpired = true;
          void (async () => {
            this.clearAllTimers();
            this.slots.clear();
            await super.closeAll().catch(() => {});
            await this.closeServices().catch(() => {});
            if (this.mcpMode && this.sessionLease?.exitOnExpire !== false) {
              console.error(`tablewalk: connection lease (${maxSec}s) expired; closed all connections.`);
              process.stdout.write('', () => process.exit(0));
            }
          })();
        },
        Math.max(25, Math.round(maxSec * 1000)),
      );
      this.sessionMaxTimer.unref();
    }
  }

  setConnectionBlocklist(id: string, rules: BlocklistRules | undefined): void {
    if (!rules || !hasBlocklistRules(rules)) {
      this.blocklists.delete(id);
      return;
    }
    this.blocklists.set(id, rules);
  }

  setConnectionLease(id: string, lease: LeaseSpec | undefined): void {
    if (!lease) {
      this.connectionLeases.delete(id);
      return;
    }
    this.connectionLeases.set(id, lease);
    const cfg = this.configOf(id);
    const effIdle = this.leaseFor(id)?.idleSeconds ?? this.leaseFor(id)?.maxSeconds;
    if (cfg && effIdle !== undefined && (/^postgres(ql)?:\/\//i.test(cfg.url) || cfg.url.includes('$'))) {
      cfg.pool = {
        ...(cfg.pool ?? {}),
        minIdle: 0,
        idleSeconds: Math.max(1, Math.ceil(Math.min(cfg.pool?.idleSeconds ?? effIdle, effIdle))),
      };
    }
  }

  private rulesFor(id: string): BlocklistRules | undefined {
    return mergeBlocklists(this.defaultBlocklist, this.blocklists.get(id));
  }

  private leaseFor(id: string): LeaseSpec | undefined {
    return mergeLeaseSpecs(this.sessionLease, this.connectionLeases.get(id));
  }

  private isExpired(id: string): boolean {
    return this.sessionExpired || this.expiredIds.has(id);
  }

  private assertNotExpired(id: string): void {
    if (this.sessionExpired) {
      throw new Refusal(`Connection lease expired after ${this.sessionLease?.maxSeconds}s; start a new session to reconnect.`);
    }
    if (this.expiredIds.has(id)) {
      const own = this.connectionLeases.get(id);
      throw new Refusal(`Connection "${id}" lease expired after ${own?.maxSeconds}s.`);
    }
  }

  private clearIdleTimer(id: string): void {
    const t = this.idleTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.idleTimers.delete(id);
    }
  }

  private clearAllTimers(): void {
    for (const id of [...this.idleTimers.keys()]) this.clearIdleTimer(id);
    for (const [id, t] of this.connMaxTimers) {
      clearTimeout(t);
      this.connMaxTimers.delete(id);
    }
    if (this.sessionMaxTimer) {
      clearTimeout(this.sessionMaxTimer);
      this.sessionMaxTimer = undefined;
    }
  }

  private isBusy(id: string): boolean {
    return (this.inFlight.get(id) ?? 0) > 0 || (this.leasePins.get(id) ?? 0) > 0;
  }

  /**
   * Close an idle connection's adapter in place without `remove`/`add`, so
   * `active`, `configs()`, and connection metadata remain completely untouched.
   */
  private evictConnection(id: string): Promise<void> {
    const running = this.evicting.get(id);
    if (running) return running;
    if (this.isBusy(id)) return Promise.resolve();
    const slot = this.slots.get(id);
    if (!slot || slot.evicted) return Promise.resolve();
    this.clearIdleTimer(id);
    slot.evicted = true;
    const p = slot.rawAdapter
      .close()
      .catch(() => {})
      .finally(() => {
        this.evicting.delete(id);
      });
    this.evicting.set(id, p);
    return p;
  }

  private scheduleIdle(id: string): void {
    const l = this.leaseFor(id);
    if (!l?.idleSeconds) return;
    this.clearIdleTimer(id);
    if (this.isBusy(id)) return;
    const slot = this.slots.get(id);
    if (!slot || slot.evicted) return;
    const timer = setTimeout(
      () => {
        this.idleTimers.delete(id);
        if (!this.isBusy(id)) {
          void this.evictConnection(id);
        }
      },
      Math.max(25, Math.round(l.idleSeconds * 1000)),
    );
    timer.unref();
    this.idleTimers.set(id, timer);
  }

  private ensureMaxTimer(id: string): void {
    const own = this.connectionLeases.get(id);
    if (!own?.maxSeconds || this.connMaxTimers.has(id)) return;
    const timer = setTimeout(
      () => {
        this.connMaxTimers.delete(id);
        this.expiredIds.add(id);
        void this.evictConnection(id);
      },
      Math.max(25, Math.round(own.maxSeconds * 1000)),
    );
    timer.unref();
    this.connMaxTimers.set(id, timer);
  }

  private trackFlight<Args extends unknown[], R>(id: string, fn: (...args: Args) => Promise<R>): (...args: Args) => Promise<R> {
    return async (...args: Args): Promise<R> => {
      this.assertNotExpired(id);
      this.clearIdleTimer(id);
      this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
      try {
        return await fn(...args);
      } finally {
        const next = Math.max(0, (this.inFlight.get(id) ?? 1) - 1);
        if (next === 0) this.inFlight.delete(id);
        else this.inFlight.set(id, next);
        this.scheduleIdle(id);
      }
    };
  }

  private wrapLeasedAdapter(id: string, base: Adapter): Adapter {
    if (!this.leaseFor(id)) return base;
    const wrapped: Adapter = {
      dialect: base.dialect,
      close: base.close.bind(base),
      introspect: this.trackFlight(id, base.introspect.bind(base)),
      query: this.trackFlight(id, base.query.bind(base)),
      count: this.trackFlight(id, base.count.bind(base)),
    };
    if (base.poolStats) wrapped.poolStats = base.poolStats.bind(base);
    if (base.privileges) wrapped.privileges = this.trackFlight(id, base.privileges.bind(base));
    if (base.triggers) wrapped.triggers = this.trackFlight(id, base.triggers.bind(base));
    if (base.triggerKeys) wrapped.triggerKeys = this.trackFlight(id, base.triggerKeys.bind(base));
    if (base.estimateCount) wrapped.estimateCount = this.trackFlight(id, base.estimateCount.bind(base));
    if (base.countEach) wrapped.countEach = this.trackFlight(id, base.countEach.bind(base));
    if (base.runView) wrapped.runView = this.trackFlight(id, base.runView.bind(base));
    if (base.countView) wrapped.countView = this.trackFlight(id, base.countView.bind(base));
    if (base.runBreakdown) wrapped.runBreakdown = this.trackFlight(id, base.runBreakdown.bind(base));
    if (base.countBreakdown) wrapped.countBreakdown = this.trackFlight(id, base.countBreakdown.bind(base));
    if (base.aggregate) wrapped.aggregate = this.trackFlight(id, base.aggregate.bind(base));
    if (base.scopeReads) wrapped.scopeReads = this.trackFlight(id, base.scopeReads.bind(base));
    if (base.runSql) wrapped.runSql = this.trackFlight(id, base.runSql.bind(base));
    if (base.explainSql) wrapped.explainSql = this.trackFlight(id, base.explainSql.bind(base));
    if (base.profile) wrapped.profile = this.trackFlight(id, base.profile.bind(base));
    if (base.ddl) wrapped.ddl = this.trackFlight(id, base.ddl.bind(base));
    if (base.insert) wrapped.insert = this.trackFlight(id, base.insert.bind(base));
    if (base.update) wrapped.update = this.trackFlight(id, base.update.bind(base));
    if (base.remove) wrapped.remove = this.trackFlight(id, base.remove.bind(base));
    if (base.transaction) {
      const txFn = base.transaction.bind(base);
      wrapped.transaction = <T>(run: Parameters<NonNullable<Adapter['transaction']>>[0]): Promise<T> =>
        this.trackFlight(id, () => txFn(run) as Promise<T>)();
    }
    if (base.scopeTransaction) {
      const scopeTxFn = base.scopeTransaction.bind(base);
      wrapped.scopeTransaction = <T>(
        scope: Parameters<NonNullable<Adapter['scopeTransaction']>>[0],
        run: Parameters<NonNullable<Adapter['scopeTransaction']>>[1],
      ): Promise<T> => this.trackFlight(id, () => scopeTxFn(scope, run) as Promise<T>)();
    }
    const innerView = writeViewOf(base);
    lendWriteView(wrapped, {
      over: innerView ? innerView.over : base,
      records: (records) => (innerView ? innerView.records(records) : records),
      catalog: (catalog) => (innerView ? innerView.catalog(catalog) : catalog),
    });
    return wrapped;
  }

  private decorateOpened(id: string, rawAdapter: Adapter, rawSchema: DatabaseSchema): { adapter: Adapter; schema: DatabaseSchema } {
    const hit = this.slots.get(id);
    if (hit && !hit.evicted && hit.rawAdapter === rawAdapter) {
      this.scheduleIdle(id);
      return { adapter: hit.wrapped, schema: hit.schema };
    }

    /* Make `rawAdapter.close()` idempotent so in-place idle eviction followed
       later by `super.refresh(id)` or `super.closeAll()` never double-closes
       a `node:sqlite` handle. */
    let rawClosed = false;
    const origClose = rawAdapter.close.bind(rawAdapter);
    rawAdapter.close = async () => {
      if (rawClosed) return;
      rawClosed = true;
      await origClose();
    };

    const cfg = this.configOf(id);
    const rules = this.rulesFor(id);
    const blocked =
      rules && hasBlocklistRules(rules)
        ? applyBlocklist(rawAdapter, rawSchema, cfg?.name ?? id, rules)
        : { adapter: rawAdapter, schema: rawSchema };
    const leased = this.wrapLeasedAdapter(id, blocked.adapter);
    this.slots.set(id, { rawAdapter, wrapped: leased, schema: blocked.schema, evicted: false });
    this.ensureMaxTimer(id);
    this.scheduleIdle(id);
    return { adapter: leased, schema: blocked.schema };
  }

  override add(config: Parameters<Registry['add']>[0], options?: Parameters<Registry['add']>[1]): ReturnType<Registry['add']> {
    const added = super.add(config, options);
    const effLease = this.leaseFor(added.id);
    const effIdle = effLease?.idleSeconds ?? effLease?.maxSeconds;
    if (effIdle !== undefined && !added.http && (/^postgres(ql)?:\/\//i.test(added.url) || added.url.includes('$'))) {
      added.pool = {
        ...(added.pool ?? {}),
        minIdle: 0,
        idleSeconds: Math.max(1, Math.ceil(Math.min(added.pool?.idleSeconds ?? effIdle, effIdle))),
      };
    }
    return added;
  }

  override onAdapterDialed(hook: (id: string, adapter: Adapter) => void): void {
    super.onAdapterDialed((id, rawAdapter) => {
      /* Never expose an unwrapped adapter beneath a blocklist to dial listeners. */
      if (this.rulesFor(id)) return;
      hook(id, rawAdapter);
    });
  }

  override dialedAdapter(id: string): Adapter | undefined {
    if (this.rulesFor(id) || this.slots.get(id)?.evicted || this.isExpired(id)) {
      return undefined;
    }
    return super.dialedAdapter(id);
  }

  override lease(id: string): () => void {
    this.assertNotExpired(id);
    this.clearIdleTimer(id);
    this.leasePins.set(id, (this.leasePins.get(id) ?? 0) + 1);
    const releaseSuper = super.lease(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Math.max(0, (this.leasePins.get(id) ?? 1) - 1);
      if (next === 0) this.leasePins.delete(id);
      else this.leasePins.set(id, next);
      releaseSuper();
      this.scheduleIdle(id);
    };
  }

  override async open(id: string): Promise<{ adapter: Adapter; schema: DatabaseSchema }> {
    this.assertNotExpired(id);
    const pendingEvict = this.evicting.get(id);
    if (pendingEvict) await pendingEvict;

    if (!this.refreshingFromEvict.has(id)) {
      const existingReopen = this.reopening.get(id);
      if (existingReopen) return existingReopen;
      const currentSlot = this.slots.get(id);
      if (currentSlot?.evicted) {
        const reopenPromise = (async () => {
          this.slots.delete(id);
          this.refreshingFromEvict.add(id);
          try {
            return await super.refresh(id);
          } finally {
            this.refreshingFromEvict.delete(id);
          }
        })().finally(() => {
          this.reopening.delete(id);
        });
        this.reopening.set(id, reopenPromise);
        return reopenPromise;
      }
    }

    const opened = await super.open(id);
    return this.decorateOpened(id, opened.adapter, opened.schema);
  }

  override async refresh(id: string): Promise<{ adapter: Adapter; schema: DatabaseSchema }> {
    this.assertNotExpired(id);
    const pendingEvict = this.evicting.get(id);
    if (pendingEvict) await pendingEvict;
    this.slots.delete(id);
    return super.refresh(id);
  }

  override async update(
    id: string,
    patch: Parameters<Registry['update']>[1],
    options?: Parameters<Registry['update']>[2],
  ): ReturnType<Registry['update']> {
    const before = this.configOf(id);
    const updated = await super.update(id, patch, options);
    if (
      before &&
      ((patch.url !== undefined && patch.url !== before.url) ||
        (patch.schemas !== undefined && JSON.stringify(patch.schemas) !== JSON.stringify(before.schemas)))
    ) {
      this.clearIdleTimer(id);
      this.slots.delete(id);
    }
    return updated;
  }

  override async remove(id: string): Promise<void> {
    this.clearIdleTimer(id);
    const mt = this.connMaxTimers.get(id);
    if (mt) {
      clearTimeout(mt);
      this.connMaxTimers.delete(id);
    }
    this.slots.delete(id);
    this.blocklists.delete(id);
    this.connectionLeases.delete(id);
    await super.remove(id);
  }

  override async closeAll(): Promise<void> {
    this.clearAllTimers();
    this.slots.clear();
    await super.closeAll();
  }

  override list(): ReturnType<Registry['list']> {
    return super.list().map((item) => {
      const rules = this.rulesFor(item.id);
      const slot = this.slots.get(item.id);
      const evictedOrExpired = Boolean(slot?.evicted) || this.isExpired(item.id);
      return {
        ...item,
        ...(evictedOrExpired
          ? { connected: false, tables: undefined }
          : slot
            ? { connected: true, tables: slot.schema.tables.length }
            : {}),
        ...(rules ? { hidesColumns: true } : {}),
      };
    });
  }

  override poolStats(): ReturnType<Registry['poolStats']> {
    if (this.sessionExpired) return [];
    const activePositions = new Set<number>();
    this.configs().forEach((cfg, idx) => {
      const slot = this.slots.get(cfg.id);
      if (slot && !slot.evicted && !this.expiredIds.has(cfg.id)) {
        activePositions.add(idx + 1);
      }
    });
    return super.poolStats().filter((stat) => activePositions.has(stat.position));
  }
}

/**
 * Load piped/FIFO/`TABLEWALK_CONFIG_JSON` config into a new `Registry` (using
 * `PolicyRegistry` whenever blocklists or leases apply), including in-memory
 * secrets (`env` / `secrets` / `dotenv`), `blocklist` rules, and `lease`
 * settings. Never writes secrets or config to disk.
 */
export async function loadPipedVaultConfig(
  configArg: string | undefined,
  mcpMode: boolean,
  cliLeaseRaw?: string,
): Promise<LoadedVaultConfig> {
  const { text, where, remainingStdin } = await readRawVaultSource(configArg, mcpMode);
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`${where} is empty — expected a JSON config (or .env variables alongside --db).`);
  }

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    /* Plain `.env` text piped on stdin alongside `--db <url>`. */
    const vars = parseDotenvText(trimmed);
    if (!Object.keys(vars).length) {
      throw new Error(`${where} is neither valid JSON nor KEY=VALUE environment lines.`);
    }
    const environment = Object.freeze({ ...process.env, ...vars });
    const cliLease = cliLeaseRaw ? parseLeaseSpec(cliLeaseRaw, '--lease') : undefined;
    const registry = cliLease ? new PolicyRegistry({ environment, sessionLease: cliLease, mcpMode }) : new Registry({ environment });
    return { registry, views: [], queries: [], pages: [], layouts: [], lease: cliLease, remainingStdin };
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${where} is not valid JSON: ${(err as Error).message}`);
  }

  const doc: Record<string, unknown> = Array.isArray(parsedRaw)
    ? { connections: parsedRaw }
    : parsedRaw && typeof parsedRaw === 'object'
      ? { ...(parsedRaw as Record<string, unknown>) }
      : (() => {
          throw new Error(`${where} must be a JSON object or array of connections.`);
        })();

  if (doc.apps !== undefined) {
    return { registry: new Registry(), namesApps: true, views: [], queries: [], pages: [], layouts: [], remainingStdin };
  }

  /* Single-connection shorthand: `{ "url": "postgres://...", "name": "billing", "env": "staging", ... }`. */
  if (doc.connections === undefined && typeof doc.url === 'string' && doc.url.trim()) {
    const singleEnvName = typeof doc.env === 'string' ? doc.env : typeof doc.environment === 'string' ? doc.environment : undefined;
    doc.connections = [
      {
        name: typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : redact(doc.url.trim()),
        url: doc.url,
        ...(doc.schemas !== undefined ? { schemas: doc.schemas } : {}),
        ...(doc.writable !== undefined ? { writable: doc.writable } : {}),
        ...(doc.rows !== undefined ? { rows: doc.rows } : {}),
        ...(doc.hidden !== undefined ? { hidden: doc.hidden } : {}),
        ...(doc.pool !== undefined ? { pool: doc.pool } : {}),
        ...(doc.replicas !== undefined ? { replicas: doc.replicas } : {}),
        ...(doc.database !== undefined ? { database: doc.database } : doc.group !== undefined ? { group: doc.group } : {}),
        ...(singleEnvName !== undefined ? { env: singleEnvName } : {}),
        ...(doc.blocklist !== undefined ? { blocklist: doc.blocklist } : {}),
        ...(doc.blockedTables !== undefined ? { blockedTables: doc.blockedTables } : {}),
        ...(doc.blockedFields !== undefined ? { blockedFields: doc.blockedFields } : {}),
        ...(doc.blockedColumns !== undefined ? { blockedColumns: doc.blockedColumns } : {}),
      },
    ];
    if (typeof doc.env === 'string') delete doc.env;
  }

  /* Build isolated in-memory environment from `dotenv` + `env` (when object) + `secrets` + `variables`. */
  const dotenvVars = typeof doc.dotenv === 'string' ? parseDotenvText(doc.dotenv) : {};
  const envVars = doc.env && typeof doc.env === 'object' && !Array.isArray(doc.env) ? parseEnvObject(doc.env, `${where} "env"`) : {};
  const secretVars = parseEnvObject(doc.secrets, `${where} "secrets"`);
  const extraVars = parseEnvObject(doc.variables, `${where} "variables"`);
  const environment =
    Object.keys(dotenvVars).length || Object.keys(envVars).length || Object.keys(secretVars).length || Object.keys(extraVars).length
      ? Object.freeze({
          ...process.env,
          ...dotenvVars,
          ...extraVars,
          ...envVars,
          ...secretVars,
        })
      : undefined;

  const defaultBlocklist = parseBlocklist(doc.blocklist, where);
  const topLease = parseLeaseSpec(doc.lease, where);
  const cliLease = cliLeaseRaw ? parseLeaseSpec(cliLeaseRaw, '--lease') : undefined;
  const sessionLease = mergeLeaseSpecs(topLease, cliLease);

  const rawConns = doc.connections;
  if (rawConns !== undefined && !Array.isArray(rawConns)) {
    throw new Error(`${where}: "connections" must be an array.`);
  }

  const parsedEntries: Array<{
    addArg: Parameters<Registry['add']>[0];
    database?: string;
    envName?: string;
    extras?: Record<string, unknown>;
    blocklist?: BlocklistRules;
    lease?: LeaseSpec;
  }> = [];

  const cwd = process.cwd();
  let anyConnPolicy = false;

  for (const [i, item] of (rawConns ?? []).entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${where}: connection ${i + 1} must be an object.`);
    }
    const c = item as Record<string, unknown>;
    if (typeof c.url !== 'string' || !c.url.trim()) {
      throw new Error(`${where}: connection ${i + 1} has no "url".`);
    }
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : redact(c.url.trim());
    if (c.writable !== undefined && typeof c.writable !== 'boolean') {
      throw new Error(`${where}: connection "${name}" has "writable": ${JSON.stringify(c.writable)}. It must be true or false.`);
    }
    if (c.rows !== undefined && typeof c.rows !== 'boolean') {
      throw new Error(`${where}: connection "${name}" has "rows": ${JSON.stringify(c.rows)}. It must be true or false.`);
    }
    if (c.rows === false && c.writable === true) {
      throw new Error(`${where}: connection "${name}" is both "writable" and "rows": false. Drop one of them.`);
    }
    const hidden = c.hidden !== undefined ? validateHiddenShape(c.hidden, `${where}: connection "${name}"`) : undefined;
    const connBlocklist = extractConnectionBlocklist(c, `${where}: connection "${name}"`, defaultBlocklist);
    const ownLease = parseLeaseSpec(c.lease, `${where}: connection "${name}"`);
    if (connBlocklist || ownLease) anyConnPolicy = true;

    const rawPool = c.pool && typeof c.pool === 'object' && !Array.isArray(c.pool) ? { ...(c.pool as Record<string, number>) } : undefined;
    const isHttp = c.kind === 'http' && c.http && typeof c.http === 'object';
    const located = isHttp ? c.url : sqliteTargetFrom(c.url, cwd);

    const database = typeof c.database === 'string' ? c.database.trim() : typeof c.group === 'string' ? c.group.trim() : undefined;
    const envName = typeof c.env === 'string' ? c.env.trim() : typeof c.environment === 'string' ? c.environment.trim() : undefined;
    const hasExtras =
      c.blocklist !== undefined ||
      c.blockedTables !== undefined ||
      c.blockedFields !== undefined ||
      c.blockedColumns !== undefined ||
      c.lease !== undefined;

    parsedEntries.push({
      addArg: {
        name,
        url: located,
        ...(located !== c.url ? { writtenUrl: c.url } : {}),
        ...(Array.isArray(c.schemas) ? { schemas: c.schemas.map(String) } : {}),
        writable: c.writable === true,
        rows: c.rows === false ? false : undefined,
        ...(hidden ? { hidden } : {}),
        ...(rawPool ? { pool: rawPool } : {}),
        ...(Array.isArray(c.replicas) ? { replicas: c.replicas.map(String) } : {}),
        ...(typeof c.listen === 'string' ? { listen: c.listen } : {}),
        ...(c.migrations && typeof c.migrations === 'object' ? { migrations: c.migrations as { dir: string; table?: string } } : {}),
        source: 'config',
      },
      database,
      envName,
      extras: hasExtras
        ? {
            ...(c.blocklist !== undefined ? { blocklist: c.blocklist } : {}),
            ...(c.blockedTables !== undefined ? { blockedTables: c.blockedTables } : {}),
            ...(c.blockedFields !== undefined ? { blockedFields: c.blockedFields } : {}),
            ...(c.blockedColumns !== undefined ? { blockedColumns: c.blockedColumns } : {}),
            ...(c.lease !== undefined ? { lease: c.lease } : {}),
          }
        : undefined,
      blocklist: connBlocklist,
      lease: ownLease,
    });
  }

  const usePolicyRegistry = Boolean(defaultBlocklist || sessionLease || anyConnPolicy);
  const registry: Registry = usePolicyRegistry
    ? new PolicyRegistry({ environment, defaultBlocklist, sessionLease, mcpMode })
    : new Registry(environment ? { environment } : {});

  if (doc.blocklist !== undefined || doc.lease !== undefined) {
    setTopLevelConfigExtras(registry, {
      ...(doc.blocklist !== undefined ? { blocklist: doc.blocklist } : {}),
      ...(doc.lease !== undefined ? { lease: doc.lease } : {}),
    });
  }

  for (const entry of parsedEntries) {
    const added = registry.add(entry.addArg);
    if (entry.database || entry.envName) {
      setConnectionEnvMeta(registry, added.id, {
        ...(entry.database ? { database: entry.database } : {}),
        ...(entry.envName ? { env: entry.envName } : {}),
      });
    }
    if (entry.extras) {
      setConnectionConfigExtras(registry, added.id, entry.extras);
    }
    if (registry instanceof PolicyRegistry) {
      if (entry.blocklist) registry.setConnectionBlocklist(added.id, entry.blocklist);
      if (entry.lease) registry.setConnectionLease(added.id, entry.lease);
    }
  }

  console.log(`${product()}: ${parsedEntries.length} connection(s) from ${where}`);

  const views = doc.views !== undefined ? parseViewsConfig(doc, where) : [];
  const queries = doc.queries !== undefined ? parseQueriesConfig(doc, where) : [];
  const pages = doc.pages !== undefined ? parsePagesConfig(doc, where) : [];
  const layouts = doc.layouts !== undefined ? parseLayoutsConfig(doc, where) : [];

  const activeRaw =
    typeof doc.active === 'string' && doc.active.trim()
      ? doc.active.trim()
      : typeof doc.defaultConnection === 'string' && doc.defaultConnection.trim()
        ? doc.defaultConnection.trim()
        : undefined;

  return {
    registry,
    views,
    queries,
    pages,
    layouts,
    active: activeRaw,
    only: doc.only === true,
    lazy: typeof doc.lazy === 'boolean' ? doc.lazy : mcpMode ? true : undefined,
    lease: sessionLease,
    remainingStdin,
  };
}

/**
 * Upgrade a disk-loaded `Registry` (before any connection has been opened) into
 * a `PolicyRegistry` carrying top-level and per-connection `blocklist` rules,
 * `lease` settings, and isolated `secrets`/`dotenv` environment variables.
 */
export function applyExtendedDiskConfig(
  baseRegistry: Registry,
  rawConfigText: string | undefined,
  where: string,
  mcpMode: boolean,
  cliLeaseRaw?: string,
): { registry: Registry; active?: string; only?: boolean; lazy?: boolean; lease?: LeaseSpec } {
  let doc: Record<string, unknown> = {};
  if (rawConfigText) {
    try {
      const parsed = JSON.parse(rawConfigText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {
      /* Already validated by readStartupConfig. */
    }
  }

  const dotenvVars = typeof doc.dotenv === 'string' ? parseDotenvText(doc.dotenv) : {};
  const envVars = doc.env && typeof doc.env === 'object' && !Array.isArray(doc.env) ? parseEnvObject(doc.env, `${where} "env"`) : {};
  const secretVars = parseEnvObject(doc.secrets, `${where} "secrets"`);
  const environment =
    Object.keys(dotenvVars).length || Object.keys(envVars).length || Object.keys(secretVars).length
      ? Object.freeze({
          ...process.env,
          ...dotenvVars,
          ...envVars,
          ...secretVars,
        })
      : baseRegistry.environment;

  const defaultBlocklist = parseBlocklist(doc.blocklist, where);
  const topLease = parseLeaseSpec(doc.lease, where);
  const cliLease = cliLeaseRaw ? parseLeaseSpec(cliLeaseRaw, '--lease') : undefined;
  const sessionLease = mergeLeaseSpecs(topLease, cliLease);

  const blocklists = new Map<string, BlocklistRules>();
  const connectionLeases = new Map<string, LeaseSpec>();
  const existingConfigs = baseRegistry.configs();
  const usedIds = new Set<string>();

  if (Array.isArray(doc.connections)) {
    for (const raw of doc.connections) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (!name) continue;
      const match =
        existingConfigs.find((c) => c.source === 'config' && c.name === name && !usedIds.has(c.id)) ??
        existingConfigs.find((c) => c.name === name && !usedIds.has(c.id));
      if (!match) continue;
      usedIds.add(match.id);
      const bl = extractConnectionBlocklist(rec, `${where}: connection "${name}"`, defaultBlocklist);
      if (bl) blocklists.set(match.id, bl);
      const ownLease = parseLeaseSpec(rec.lease, `${where}: connection "${name}"`);
      if (ownLease) connectionLeases.set(match.id, ownLease);
    }
  }

  const needsPolicy = Boolean(defaultBlocklist || sessionLease || blocklists.size > 0 || connectionLeases.size > 0);
  let registry: Registry = baseRegistry;

  if (needsPolicy || environment !== baseRegistry.environment) {
    const next = needsPolicy
      ? new PolicyRegistry({
          environment,
          defaultBlocklist,
          blocklists,
          connectionLeases,
          sessionLease,
          mcpMode,
        })
      : new Registry(environment ? { environment } : {});

    next.sections = baseRegistry.sections;
    for (const svc of baseRegistry.serviceConfigs()) next.addService(svc);
    for (const kept of baseRegistry.keptEntries()) next.keep(kept);
    for (const cfg of existingConfigs) {
      next.add({ ...cfg });
      const meta = getConnectionEnvMeta(baseRegistry, cfg.id);
      if (meta) setConnectionEnvMeta(next, cfg.id, meta);
      const extras = getConnectionConfigExtras(baseRegistry, cfg.id);
      if (extras) setConnectionConfigExtras(next, cfg.id, extras);
      if (next instanceof PolicyRegistry) {
        const ownLease = connectionLeases.get(cfg.id);
        if (ownLease) next.setConnectionLease(cfg.id, ownLease);
      }
    }
    if (baseRegistry.active && next.has(baseRegistry.active)) {
      next.setActive(baseRegistry.active);
    }
    const topExtras = getTopLevelConfigExtras(baseRegistry);
    if (topExtras) setTopLevelConfigExtras(next, topExtras);
    registry = next;
  }

  if (rawConfigText) {
    loadConfigEnvMeta(registry, rawConfigText);
  } else if (doc.blocklist !== undefined || doc.lease !== undefined) {
    setTopLevelConfigExtras(registry, {
      ...(doc.blocklist !== undefined ? { blocklist: doc.blocklist } : {}),
      ...(doc.lease !== undefined ? { lease: doc.lease } : {}),
    });
  }

  const active =
    typeof doc.active === 'string' && doc.active.trim()
      ? doc.active.trim()
      : typeof doc.defaultConnection === 'string' && doc.defaultConnection.trim()
        ? doc.defaultConnection.trim()
        : undefined;

  return {
    registry,
    active,
    only: doc.only === true,
    lazy: typeof doc.lazy === 'boolean' ? doc.lazy : undefined,
    lease: sessionLease,
  };
}

/**
 * Select the startup active connection from `--connection`, `--env`, or config
 * `"active"` / `"defaultConnection"`, optionally isolating the registry to only
 * that connection (`only: true`).
 */
export async function applyStartupTargetSelection(
  registry: Registry,
  options: { connection?: string; env?: string; configActive?: string; only?: boolean },
): Promise<void> {
  const asked = options.connection?.trim() || options.configActive?.trim() || '';
  const env = options.env?.trim() || '';
  if (!asked && !env) return;

  const chosen = resolveConnectionEntry(registry, asked || undefined, { env: env || undefined });
  registry.setActive(chosen.id);

  if (options.only) {
    for (const conn of registry.list()) {
      if (conn.id !== chosen.id) {
        await registry.remove(conn.id);
      }
    }
  }
}

/**
 * Execute a fast one-shot `--query <q>` or `--call <tool> [--args '<json>']`
 * against `registry`, print JSON to stdout, and close all connections.
 */
export async function runCliOneShot(
  registry: Registry,
  shelf: { views?: ViewDef[]; queries: SavedQuery[]; pages: PageDef[] },
  options: { query?: string; call?: string; args?: string; connection?: string; env?: string },
): Promise<void> {
  bindShelf(registry, shelf);
  try {
    let toolName: string;
    let toolArgs: Record<string, unknown> = {};

    if (options.args?.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(options.args);
      } catch (err) {
        console.error(`tablewalk: --args is not valid JSON: ${(err as Error).message}`);
        process.exitCode = 2;
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error('tablewalk: --args must be a JSON object.');
        process.exitCode = 2;
        return;
      }
      toolArgs = { ...(parsed as Record<string, unknown>) };
    }

    if (options.query !== undefined) {
      const q = options.query.trim();
      if (!q) {
        console.error('tablewalk: --query requires a non-empty query string.');
        process.exitCode = 2;
        return;
      }
      toolName = looksLikeBreakdown(q) ? 'breakdown' : 'query';
      toolArgs.q = q;
    } else {
      toolName = (options.call ?? '').trim();
      if (!toolName) {
        console.error('tablewalk: --call requires a tool name (for example schema_summary, tables, query, record).');
        process.exitCode = 2;
        return;
      }
    }

    if (options.connection && toolArgs.connection === undefined) toolArgs.connection = options.connection;
    if (options.env && toolArgs.env === undefined) toolArgs.env = options.env;

    const answer = await runTool(registry, toolName, toolArgs);
    if (answer.isError) {
      console.error(`tablewalk: ${answer.content[0]?.text ?? 'Tool call failed.'}`);
      process.exitCode = 1;
      return;
    }
    const payload = answer.structuredContent ?? { text: answer.content[0]?.text ?? '' };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    await registry.closeAll().catch(() => {});
    await registry.closeServices().catch(() => {});
  }
}
