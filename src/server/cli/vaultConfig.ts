/**
 * Vault & piped configuration input, connection lease enforcement, agent
 * blocklist installation, and fast one-shot CLI query/tool execution.
 *
 * Loaded on demand only when piped/vault input, blocklists, leases, environment
 * targeting flags, or one-shot `--query`/`--call` options are used, so plain
 * `--help`, `--mcp`, and `serve` keep their exact cold-start module budgets.
 */
import { fstatSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  Refusal,
  looksLikeBreakdown,
  redact,
  type Adapter,
  type DatabaseSchema,
  type Registry,
  type ViewDef,
} from '@mistriwork/engine/host';
import { lendWriteView, writeViewOf } from '@mistriwork/engine/adapters/storeHost.js';
import { sqliteTargetFrom } from '@mistriwork/engine/server/configPaths.js';
import { product } from '@mistriwork/engine/server/product.js';
import { parseViewsConfig } from '@mistriwork/engine/shared/view.js';
import { parseQueriesConfig, type SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import { parsePagesConfig, type PageDef } from '@mistriwork/engine/shared/page.js';
import { parseLayoutsConfig } from '@mistriwork/engine/shared/recordview.js';
import { applyBlocklist, extractConnectionBlocklist, hasBlocklistRules, parseBlocklist, type BlocklistRules } from '../blocklist.js';
import {
  getConnectionConfigExtras,
  getConnectionEnvMeta,
  resolveConnectionEntry,
  setConnectionConfigExtras,
  setConnectionEnvMeta,
} from '../mcp/toolkit.js';
import { bindShelf, runTool } from '../mcp.js';

const MAX_PIPED_CONFIG_BYTES = 8 * 1024 * 1024;

export interface LeaseSpec {
  idleSeconds?: number;
  maxSeconds?: number;
  exitOnExpire?: boolean;
}

export interface AgentCliExtras {
  connection?: string;
  env?: string;
  lease?: string;
  lazy?: boolean;
  query?: string;
  call?: string;
  args?: string;
}

export interface LoadedVaultConfig {
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

/** Detect whether `configArg`, `TABLEWALK_CONFIG_JSON`, or redirected file stdin supplies in-memory config. */
export function hasPipedConfigSource(
  configArg: string | undefined,
  noConfig: boolean,
  mcpMode: boolean,
  hasTargetOrDemo: boolean,
): boolean {
  if (noConfig) return false;
  if (!configArg && process.env.TABLEWALK_CONFIG_JSON?.trim()) return true;
  if (configArg === '-' || configArg === '/dev/stdin') return true;
  if (configArg && (/^\/(?:dev\/fd|proc\/self\/fd)\/\d+$/.test(configArg) || isFifoPath(configArg))) return true;
  if (!mcpMode && !configArg && !hasTargetOrDemo && isRegularFileOnStdin()) return true;
  return false;
}

/** Detect whether raw JSON text from a disk `tablewalk.json` uses blocklist, lease, vault secrets, or startup scoping keys. */
export function textHasExtendedConfigKeys(rawText: string | undefined): boolean {
  if (!rawText) return false;
  return /"(?:blocklist|blockedTables|blockedFields|blockedColumns|lease|secrets|dotenv|defaultConnection|active|lazy|only)"/.test(rawText);
}

function isFifoPath(path: string): boolean {
  try {
    return statSync(path).isFIFO();
  } catch {
    return false;
  }
}

function isRegularFileOnStdin(): boolean {
  try {
    const st = fstatSync(0);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
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
 * Read a piped config document from `stdin`.
 *
 * In non-MCP modes, reads until EOF.
 * In `--mcp` mode (`{ vault get; cat; } | tablewalk --mcp --config -`), scans
 * the leading top-level JSON object/array off `stdin` without waiting for EOF
 * and returns a `PassThrough` stream carrying any remaining bytes plus live
 * `stdin` events for the MCP JSON-RPC protocol!
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

    const finishWithSplit = (endCharIndex: number) => {
      cleanup();
      process.stdin.pause();
      const configText = acc.slice(0, endCharIndex + 1);
      let rest = acc.slice(endCharIndex + 1);
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
      const pass = new PassThrough();
      pass.end();
      resolvePromise({ text: acc + decoder.end(), remainingStdin: pass });
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
          /* Not JSON (for example `.env` text): read until EOF. */
          startedAt = -2;
          return;
        }
        if (startedAt === -2) return;
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
            finishWithSplit(scanIdx);
            return;
          }
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

interface PolicySetup {
  blocklists: Map<string, BlocklistRules>;
  connectionLeases: Map<string, LeaseSpec>;
  sessionLease?: LeaseSpec;
}

/**
 * Load piped/FIFO/`TABLEWALK_CONFIG_JSON` config into `registry`, including
 * in-memory secrets (`env` / `secrets` / `dotenv`), `blocklist` rules, and
 * `lease` settings. Never writes secrets or config to disk.
 */
export async function loadPipedVaultConfig(
  configArg: string | undefined,
  mcpMode: boolean,
  registry: Registry,
  cliLeaseRaw?: string,
): Promise<LoadedVaultConfig> {
  const { text, where, remainingStdin } = await readRawVaultSource(configArg, mcpMode);
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(`${where} is empty — expected a JSON config (or .env variables alongside --db).`);
  }

  let parsedRaw: unknown;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    /* Plain `.env` text piped on stdin alongside `--db <url>`. */
    const vars = parseDotenvText(trimmed);
    if (!Object.keys(vars).length) {
      throw new Error(`${where} is neither valid JSON nor KEY=VALUE environment lines.`);
    }
    (registry as { environment?: NodeJS.ProcessEnv }).environment = Object.freeze({ ...process.env, ...vars });
    const cliLease = cliLeaseRaw ? parseLeaseSpec(cliLeaseRaw, '--lease') : undefined;
    if (cliLease) {
      installConnectionPolicies(registry, { blocklists: new Map(), connectionLeases: new Map(), sessionLease: cliLease }, mcpMode);
    }
    return { views: [], queries: [], pages: [], layouts: [], lease: cliLease, remainingStdin };
  }

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
    return { namesApps: true, views: [], queries: [], pages: [], layouts: [], remainingStdin };
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
  if (Object.keys(dotenvVars).length || Object.keys(envVars).length || Object.keys(secretVars).length || Object.keys(extraVars).length) {
    (registry as { environment?: NodeJS.ProcessEnv }).environment = Object.freeze({
      ...process.env,
      ...dotenvVars,
      ...extraVars,
      ...envVars,
      ...secretVars,
    });
  }

  const defaultBlocklist = parseBlocklist(doc.blocklist, where);
  const topLease = parseLeaseSpec(doc.lease, where);
  const cliLease = cliLeaseRaw ? parseLeaseSpec(cliLeaseRaw, '--lease') : undefined;
  const sessionLease = mergeLeaseSpecs(topLease, cliLease);

  const rawConns = doc.connections;
  if (rawConns !== undefined && !Array.isArray(rawConns)) {
    throw new Error(`${where}: "connections" must be an array.`);
  }

  const blocklists = new Map<string, BlocklistRules>();
  const connectionLeases = new Map<string, LeaseSpec>();
  const cwd = process.cwd();

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
    const effectiveLease = mergeLeaseSpecs(sessionLease, ownLease);

    const rawPool = c.pool && typeof c.pool === 'object' && !Array.isArray(c.pool) ? { ...(c.pool as Record<string, number>) } : undefined;
    const effectiveIdle = effectiveLease?.idleSeconds ?? effectiveLease?.maxSeconds;
    const isPgLike = /^postgres(ql)?:\/\//i.test(c.url) || c.url.includes('$');
    const pool =
      effectiveIdle !== undefined && isPgLike
        ? {
            ...(rawPool ?? {}),
            minIdle: 0,
            idleSeconds: Math.max(1, Math.ceil(Math.min(rawPool?.idleSeconds ?? effectiveIdle, effectiveIdle))),
          }
        : rawPool;

    const isHttp = c.kind === 'http' && c.http && typeof c.http === 'object';
    const located = isHttp ? c.url : sqliteTargetFrom(c.url, cwd);
    const added = registry.add({
      name,
      url: located,
      ...(located !== c.url ? { writtenUrl: c.url } : {}),
      ...(Array.isArray(c.schemas) ? { schemas: c.schemas.map(String) } : {}),
      writable: c.writable === true,
      rows: c.rows === false ? false : undefined,
      ...(hidden ? { hidden } : {}),
      ...(pool ? { pool } : {}),
      ...(Array.isArray(c.replicas) ? { replicas: c.replicas.map(String) } : {}),
      ...(typeof c.listen === 'string' ? { listen: c.listen } : {}),
      ...(c.migrations && typeof c.migrations === 'object' ? { migrations: c.migrations as { dir: string; table?: string } } : {}),
      source: 'config',
    });

    const database = typeof c.database === 'string' ? c.database.trim() : typeof c.group === 'string' ? c.group.trim() : '';
    const envName = typeof c.env === 'string' ? c.env.trim() : typeof c.environment === 'string' ? c.environment.trim() : '';
    if (database || envName) {
      setConnectionEnvMeta(registry, added.id, {
        ...(database ? { database } : {}),
        ...(envName ? { env: envName } : {}),
      });
    }
    if (connBlocklist) blocklists.set(added.id, connBlocklist);
    if (ownLease) connectionLeases.set(added.id, ownLease);
  }

  console.log(`${product()}: ${(rawConns ?? []).length} connection(s) from ${where}`);

  const views = doc.views !== undefined ? parseViewsConfig(doc, where) : [];
  const queries = doc.queries !== undefined ? parseQueriesConfig(doc, where) : [];
  const pages = doc.pages !== undefined ? parsePagesConfig(doc, where) : [];
  const layouts = doc.layouts !== undefined ? parseLayoutsConfig(doc, where) : [];

  if (blocklists.size > 0 || connectionLeases.size > 0 || sessionLease) {
    installConnectionPolicies(registry, { blocklists, connectionLeases, sessionLease }, mcpMode);
  }

  const activeRaw =
    typeof doc.active === 'string' && doc.active.trim()
      ? doc.active.trim()
      : typeof doc.defaultConnection === 'string' && doc.defaultConnection.trim()
        ? doc.defaultConnection.trim()
        : undefined;

  return {
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
 * Apply extended keys (`blocklist`, `lease`, `secrets`/`dotenv`, `active`, `only`, `lazy`)
 * from a regular disk `tablewalk.json` (plus optional CLI `--lease`) onto an already-loaded `Registry`.
 */
export function applyExtendedDiskConfig(
  registry: Registry,
  rawConfigText: string | undefined,
  where: string,
  mcpMode: boolean,
  cliLeaseRaw?: string,
): { active?: string; only?: boolean; lazy?: boolean; lease?: LeaseSpec } {
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
  if (Object.keys(dotenvVars).length || Object.keys(envVars).length || Object.keys(secretVars).length) {
    (registry as { environment?: NodeJS.ProcessEnv }).environment = Object.freeze({
      ...process.env,
      ...dotenvVars,
      ...envVars,
      ...secretVars,
    });
  }

  const defaultBlocklist = parseBlocklist(doc.blocklist, where);
  const topLease = parseLeaseSpec(doc.lease, where);
  const cliLease = cliLeaseRaw ? parseLeaseSpec(cliLeaseRaw, '--lease') : undefined;
  const sessionLease = mergeLeaseSpecs(topLease, cliLease);

  const blocklists = new Map<string, BlocklistRules>();
  const connectionLeases = new Map<string, LeaseSpec>();
  const configs = registry.configs();
  const usedIds = new Set<string>();

  if (Array.isArray(doc.connections)) {
    for (const raw of doc.connections) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (!name) continue;
      const match =
        configs.find((c) => c.source === 'config' && c.name === name && !usedIds.has(c.id)) ??
        configs.find((c) => c.name === name && !usedIds.has(c.id));
      if (!match) continue;
      usedIds.add(match.id);
      const bl = extractConnectionBlocklist(rec, `${where}: connection "${name}"`, defaultBlocklist);
      if (bl) blocklists.set(match.id, bl);
      const ownLease = parseLeaseSpec(rec.lease, `${where}: connection "${name}"`);
      if (ownLease) connectionLeases.set(match.id, ownLease);
    }
  } else if (defaultBlocklist) {
    for (const cfg of configs) blocklists.set(cfg.id, defaultBlocklist);
  }

  /* Apply defaultBlocklist to any CLI `--db` connection added alongside a config with top-level `blocklist`. */
  if (defaultBlocklist) {
    for (const cfg of configs) {
      if (!blocklists.has(cfg.id)) blocklists.set(cfg.id, defaultBlocklist);
    }
  }

  if (blocklists.size > 0 || connectionLeases.size > 0 || sessionLease) {
    installConnectionPolicies(registry, { blocklists, connectionLeases, sessionLease }, mcpMode);
  }

  const active =
    typeof doc.active === 'string' && doc.active.trim()
      ? doc.active.trim()
      : typeof doc.defaultConnection === 'string' && doc.defaultConnection.trim()
        ? doc.defaultConnection.trim()
        : undefined;

  return {
    active,
    only: doc.only === true,
    lazy: typeof doc.lazy === 'boolean' ? doc.lazy : undefined,
    lease: sessionLease,
  };
}

/**
 * Wrap `registry` so blocklists prune catalogs/queries across every surface and
 * connection leases close idle adapters and expire sessions deterministically.
 */
export function installConnectionPolicies(registry: Registry, setup: PolicySetup, mcpMode: boolean): void {
  const { blocklists, connectionLeases, sessionLease } = setup;

  const rawOpen = registry.open.bind(registry);
  const rawRefresh = registry.refresh.bind(registry);
  const rawList = registry.list.bind(registry);
  const rawRemove = registry.remove.bind(registry);
  const rawAdd = registry.add.bind(registry);
  const rawCloseAll = registry.closeAll.bind(registry);

  const cached = new Map<string, { rawAdapter: Adapter; wrapped: Adapter; schema: DatabaseSchema }>();
  const inFlight = new Map<string, number>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const connMaxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const expiredIds = new Set<string>();
  const evicting = new Set<string>();
  let sessionExpired = false;
  let sessionMaxTimer: ReturnType<typeof setTimeout> | undefined;

  const leaseFor = (id: string): LeaseSpec | undefined => mergeLeaseSpecs(sessionLease, connectionLeases.get(id));

  /* Lower PostgreSQL pool minIdle to 0 on leased connections so idle readers drop to zero open sockets. */
  for (const cfg of registry.configs()) {
    const l = leaseFor(cfg.id);
    const effIdle = l?.idleSeconds ?? l?.maxSeconds;
    if (effIdle !== undefined && /^postgres(ql)?:\/\//i.test(cfg.url)) {
      cfg.pool = {
        ...(cfg.pool ?? {}),
        minIdle: 0,
        idleSeconds: Math.max(1, Math.ceil(Math.min(cfg.pool?.idleSeconds ?? effIdle, effIdle))),
      };
    }
  }

  const clearIdleTimer = (id: string) => {
    const t = idleTimers.get(id);
    if (t) {
      clearTimeout(t);
      idleTimers.delete(id);
    }
  };

  const clearAllTimers = () => {
    for (const id of [...idleTimers.keys()]) clearIdleTimer(id);
    for (const [id, t] of connMaxTimers) {
      clearTimeout(t);
      connMaxTimers.delete(id);
    }
    if (sessionMaxTimer) {
      clearTimeout(sessionMaxTimer);
      sessionMaxTimer = undefined;
    }
  };

  const evictConnection = async (id: string) => {
    if (evicting.has(id) || (inFlight.get(id) ?? 0) > 0) return;
    const cfg = registry.configOf(id);
    if (!cfg) return;
    const pub = rawList().find((c) => c.id === id);
    if (!pub?.connected) return;
    evicting.add(id);
    clearIdleTimer(id);
    try {
      const wasActive = registry.active;
      const envMeta = getConnectionEnvMeta(registry, id);
      const extras = getConnectionConfigExtras(registry, id);
      cached.delete(id);
      await rawRemove(id);
      rawAdd({ ...cfg, id });
      if (wasActive && registry.has(wasActive)) registry.setActive(wasActive);
      if (envMeta) setConnectionEnvMeta(registry, id, envMeta);
      if (extras) setConnectionConfigExtras(registry, id, extras);
    } catch {
      /* Best-effort idle release. */
    } finally {
      evicting.delete(id);
    }
  };

  const scheduleIdle = (id: string) => {
    const l = leaseFor(id);
    if (!l?.idleSeconds) return;
    clearIdleTimer(id);
    if ((inFlight.get(id) ?? 0) > 0) return;
    const timer = setTimeout(
      () => {
        idleTimers.delete(id);
        if ((inFlight.get(id) ?? 0) === 0) {
          void evictConnection(id);
        }
      },
      Math.max(25, Math.round(l.idleSeconds * 1000)),
    );
    timer.unref();
    idleTimers.set(id, timer);
  };

  const ensureMaxTimer = (id: string) => {
    const own = connectionLeases.get(id);
    if (!own?.maxSeconds || connMaxTimers.has(id)) return;
    const timer = setTimeout(
      () => {
        connMaxTimers.delete(id);
        expiredIds.add(id);
        void evictConnection(id);
      },
      Math.max(25, Math.round(own.maxSeconds * 1000)),
    );
    timer.unref();
    connMaxTimers.set(id, timer);
  };

  if (sessionLease?.maxSeconds) {
    const maxSec = sessionLease.maxSeconds;
    sessionMaxTimer = setTimeout(
      () => {
        sessionExpired = true;
        void (async () => {
          clearAllTimers();
          cached.clear();
          await rawCloseAll().catch(() => {});
          await registry.closeServices().catch(() => {});
          if (mcpMode && sessionLease.exitOnExpire !== false) {
            console.error(`tablewalk: connection lease (${maxSec}s) expired; closed all connections.`);
            process.stdout.write('', () => process.exit(0));
          }
        })();
      },
      Math.max(25, Math.round(maxSec * 1000)),
    );
    sessionMaxTimer.unref();
  }

  const assertNotExpired = (id: string) => {
    if (sessionExpired) {
      throw new Refusal(`Connection lease expired after ${sessionLease?.maxSeconds}s; start a new session to reconnect.`);
    }
    if (expiredIds.has(id)) {
      const own = connectionLeases.get(id);
      throw new Refusal(`Connection "${id}" lease expired after ${own?.maxSeconds}s.`);
    }
  };

  const trackFlight = <Args extends unknown[], R>(id: string, fn: (...args: Args) => Promise<R>) => {
    return async (...args: Args): Promise<R> => {
      assertNotExpired(id);
      clearIdleTimer(id);
      inFlight.set(id, (inFlight.get(id) ?? 0) + 1);
      try {
        return await fn(...args);
      } finally {
        const next = Math.max(0, (inFlight.get(id) ?? 1) - 1);
        if (next === 0) inFlight.delete(id);
        else inFlight.set(id, next);
        scheduleIdle(id);
      }
    };
  };

  const wrapLeasedAdapter = (id: string, base: Adapter): Adapter => {
    if (!leaseFor(id)) return base;
    const wrapped = Object.create(Object.getPrototypeOf(base)) as Adapter;
    Object.assign(wrapped, base);
    wrapped.close = base.close.bind(base);
    wrapped.introspect = trackFlight(id, base.introspect.bind(base));
    wrapped.query = trackFlight(id, base.query.bind(base));
    wrapped.count = trackFlight(id, base.count.bind(base));
    if (base.countEach) wrapped.countEach = trackFlight(id, base.countEach.bind(base));
    if (base.runView) wrapped.runView = trackFlight(id, base.runView.bind(base));
    if (base.countView) wrapped.countView = trackFlight(id, base.countView.bind(base));
    if (base.runBreakdown) wrapped.runBreakdown = trackFlight(id, base.runBreakdown.bind(base));
    if (base.countBreakdown) wrapped.countBreakdown = trackFlight(id, base.countBreakdown.bind(base));
    if (base.aggregate) wrapped.aggregate = trackFlight(id, base.aggregate.bind(base));
    if (base.runSql) wrapped.runSql = trackFlight(id, base.runSql.bind(base));
    if (base.explainSql) wrapped.explainSql = trackFlight(id, base.explainSql.bind(base));
    if (base.profile) wrapped.profile = trackFlight(id, base.profile.bind(base));
    if (base.ddl) wrapped.ddl = trackFlight(id, base.ddl.bind(base));
    if (base.insert) wrapped.insert = trackFlight(id, base.insert.bind(base));
    if (base.update) wrapped.update = trackFlight(id, base.update.bind(base));
    if (base.remove) wrapped.remove = trackFlight(id, base.remove.bind(base));
    if (base.transaction) {
      const txFn = base.transaction.bind(base);
      wrapped.transaction = <T>(run: Parameters<NonNullable<Adapter['transaction']>>[0]): Promise<T> =>
        trackFlight(id, () => txFn(run) as Promise<T>)();
    }
    if (base.scopeTransaction) {
      const scopeTxFn = base.scopeTransaction.bind(base);
      wrapped.scopeTransaction = <T>(
        scope: Parameters<NonNullable<Adapter['scopeTransaction']>>[0],
        run: Parameters<NonNullable<Adapter['scopeTransaction']>>[1],
      ): Promise<T> => trackFlight(id, () => scopeTxFn(scope, run) as Promise<T>)();
    }
    const innerView = writeViewOf(base);
    lendWriteView(wrapped, {
      over: innerView ? innerView.over : base,
      records: (records) => (innerView ? innerView.records(records) : records),
      catalog: (catalog) => (innerView ? innerView.catalog(catalog) : catalog),
    });
    return wrapped;
  };

  const decorateOpened = (id: string, rawAdapter: Adapter, rawSchema: DatabaseSchema): { adapter: Adapter; schema: DatabaseSchema } => {
    const hit = cached.get(id);
    if (hit && hit.rawAdapter === rawAdapter) {
      scheduleIdle(id);
      return { adapter: hit.wrapped, schema: hit.schema };
    }
    const cfg = registry.configOf(id);
    const rules = blocklists.get(id);
    const blocked =
      rules && hasBlocklistRules(rules)
        ? applyBlocklist(rawAdapter, rawSchema, cfg?.name ?? id, rules)
        : { adapter: rawAdapter, schema: rawSchema };
    const leased = wrapLeasedAdapter(id, blocked.adapter);
    cached.set(id, { rawAdapter, wrapped: leased, schema: blocked.schema });
    ensureMaxTimer(id);
    scheduleIdle(id);
    return { adapter: leased, schema: blocked.schema };
  };

  registry.open = async (id: string) => {
    assertNotExpired(id);
    /* If a background idle eviction is finishing on `id`, wait a tick for it to re-register `id`. */
    while (evicting.has(id)) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const { adapter, schema } = await rawOpen(id);
    return decorateOpened(id, adapter, schema);
  };

  registry.refresh = async (id: string) => {
    assertNotExpired(id);
    cached.delete(id);
    const { adapter, schema } = await rawRefresh(id);
    return decorateOpened(id, adapter, schema);
  };

  registry.list = () =>
    rawList().map((item) => {
      const rules = blocklists.get(item.id);
      if (!rules || !hasBlocklistRules(rules)) return item;
      const c = cached.get(item.id);
      return {
        ...item,
        hidesColumns: true,
        ...(c ? { tables: c.schema.tables.length } : {}),
      };
    });

  registry.remove = async (id: string) => {
    clearIdleTimer(id);
    const mt = connMaxTimers.get(id);
    if (mt) {
      clearTimeout(mt);
      connMaxTimers.delete(id);
    }
    cached.delete(id);
    blocklists.delete(id);
    connectionLeases.delete(id);
    await rawRemove(id);
  };

  registry.closeAll = async () => {
    clearAllTimers();
    cached.clear();
    await rawCloseAll();
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
