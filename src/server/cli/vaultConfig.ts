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
import { computeFocusBlocklist, parseFocusSpec, type FocusSpec } from '../focus.js';
import { applyRedaction } from '../mask.js';
import { classifyEnvTier, resolveConnectionEnvironment } from '../../shared/environments.js';
import {
  getConnectionConfigExtras,
  getConnectionEnvMeta,
  getTopLevelConfigExtras,
  loadConfigEnvMeta,
  resolveConnectionEntry,
  setConnectionConfigExtras,
  setConnectionEnvMeta,
  setRuntimePolicyResolver,
  setTopLevelConfigExtras,
  type RuntimeConnectionPolicy,
} from '../mcp/toolkit.js';
import { bindShelf, runTool } from '../mcp.js';

const MAX_PIPED_CONFIG_BYTES = 8 * 1024 * 1024;
const idempotentAdapters = new WeakSet<Adapter>();

export interface LeaseSpec {
  idleSeconds?: number;
  maxSeconds?: number;
  exitOnExpire?: boolean;
}

export interface EnvironmentPolicySpec {
  writable?: boolean;
  rows?: boolean;
  lease?: LeaseSpec;
  blocklist?: BlocklistRules;
  redact?: boolean;
  redactColumns?: string[];
  maxRows?: number;
  timeoutMs?: number;
  focus?: FocusSpec;
}

export interface CliPolicyOverrides {
  lease?: string;
  maxRows?: string;
  redact?: boolean;
  timeoutMs?: string;
  focus?: string;
  focusHops?: string;
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

function normalizeCliOverrides(cliOrLease?: string | CliPolicyOverrides): CliPolicyOverrides {
  if (!cliOrLease) return {};
  return typeof cliOrLease === 'string' ? { lease: cliOrLease } : cliOrLease;
}

export function parseMaxRows(raw: unknown, where: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`${where} must be a positive whole number of rows, not ${JSON.stringify(raw)}.`);
  }
  return num;
}

function parseRedactColumnsSpec(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`${where} is not valid JSON: ${(err as Error).message}`);
      }
      return parseRedactColumnsSpec(parsed, where);
    }
    const cols = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return cols.length ? cols : undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${where} must be an array of column names (e.g. ["internal_memo", "invoice.notes"]).`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${where} entries must be non-empty strings, not ${JSON.stringify(item)}.`);
    }
    const clean = item.trim();
    if (!out.includes(clean)) out.push(clean);
  }
  return out.length ? out : undefined;
}

function mergeRedactColumns(...lists: Array<readonly string[] | undefined>): string[] | undefined {
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out.length ? out : undefined;
}

function minDefined(...nums: Array<number | undefined>): number | undefined {
  const valid = nums.filter((n): n is number => n !== undefined);
  return valid.length ? Math.min(...valid) : undefined;
}

export function parseTimeoutMs(raw: unknown, where: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error(`${where} must be a positive number of milliseconds, not ${JSON.stringify(raw)}.`);
    }
    return Math.max(1, Math.round(raw));
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${where} must be greater than zero.`);
      }
      return Math.max(1, Math.round(n));
    }
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins)$/i.exec(trimmed);
    if (!m) {
      throw new Error(`${where} must be milliseconds (e.g. 2500) or a duration like "500ms" or "5s", not ${JSON.stringify(raw)}.`);
    }
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 'ms' ? n : unit.startsWith('m') ? n * 60_000 : n * 1_000;
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`${where} must be greater than zero.`);
    }
    return Math.max(1, Math.round(ms));
  }
  throw new Error(`${where} must be a positive number of milliseconds or duration string, not ${JSON.stringify(raw)}.`);
}

function parseCredentialCommand(raw: unknown, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${where} must be a non-empty shell command string.`);
  }
  return raw.trim();
}

async function executeCredentialCommand(
  cmd: string,
  connId: string,
  connName: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
): Promise<Record<string, string>> {
  const { execFile } = await import('node:child_process');
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      shell,
      shellArgs,
      {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          ...(baseEnv ?? {}),
          TABLEWALK_CONNECTION_ID: connId,
          TABLEWALK_CONNECTION_NAME: connName,
        },
      },
      (err, out, stderr) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          const stderrSummary = typeof stderr === 'string' && stderr.trim() ? `: ${stderr.trim().slice(0, 160)}` : '';
          rejectPromise(
            new Error(`credentialCommand for "${connName}" failed${code !== undefined ? ` (exit ${String(code)})` : ''}${stderrSummary}`),
          );
          return;
        }
        resolvePromise(out);
      },
    );
  });

  const trimmed = stdout.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`credentialCommand for "${connName}" returned invalid JSON: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`credentialCommand for "${connName}" must return a JSON object or KEY=VALUE lines.`);
    }
    const rec = parsed as Record<string, unknown>;
    const hasNested =
      (rec.dotenv !== undefined && typeof rec.dotenv === 'string') ||
      (rec.env !== undefined && typeof rec.env === 'object' && !Array.isArray(rec.env)) ||
      (rec.secrets !== undefined && typeof rec.secrets === 'object' && !Array.isArray(rec.secrets)) ||
      (rec.variables !== undefined && typeof rec.variables === 'object' && !Array.isArray(rec.variables));
    if (hasNested) {
      return {
        ...(typeof rec.dotenv === 'string' ? parseDotenvText(rec.dotenv) : {}),
        ...(rec.variables ? parseEnvObject(rec.variables, 'credentialCommand "variables"') : {}),
        ...(rec.env ? parseEnvObject(rec.env, 'credentialCommand "env"') : {}),
        ...(rec.secrets ? parseEnvObject(rec.secrets, 'credentialCommand "secrets"') : {}),
      };
    }
    return parseEnvObject(rec, 'credentialCommand output');
  }
  return parseDotenvText(trimmed);
}

function mergeEnvironmentPolicies(base?: EnvironmentPolicySpec, override?: EnvironmentPolicySpec): EnvironmentPolicySpec | undefined {
  if (!base && !override) return undefined;
  const writable = override?.writable ?? base?.writable;
  const rows = override?.rows ?? base?.rows;
  const lease = mergeLeaseSpecs(base?.lease, override?.lease);
  const blocklist = mergeBlocklists(base?.blocklist, override?.blocklist);
  const redact = override?.redact ?? base?.redact;
  const redactColumns = mergeRedactColumns(base?.redactColumns, override?.redactColumns);
  const maxRows = minDefined(base?.maxRows, override?.maxRows);
  const timeoutMs = minDefined(base?.timeoutMs, override?.timeoutMs);
  const focus = override?.focus ?? base?.focus;
  return {
    ...(writable !== undefined ? { writable } : {}),
    ...(rows !== undefined ? { rows } : {}),
    ...(lease ? { lease } : {}),
    ...(blocklist ? { blocklist } : {}),
    ...(redact !== undefined ? { redact } : {}),
    ...(redactColumns ? { redactColumns } : {}),
    ...(maxRows !== undefined ? { maxRows } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(focus ? { focus } : {}),
  };
}

export function parseEnvironmentPolicies(raw: unknown, where: string): Map<string, EnvironmentPolicySpec> {
  const out = new Map<string, EnvironmentPolicySpec>();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${where}: "environments" must be an object mapping environment or tier names (e.g. "staging", "prod") to policy objects.`,
    );
  }
  const allowedKeys = new Set([
    'writable',
    'rows',
    'lease',
    'blocklist',
    'blockedTables',
    'blockedFields',
    'blockedColumns',
    'redact',
    'redactColumns',
    'redact_columns',
    'maxRows',
    'max_rows',
    'timeoutMs',
    'timeout_ms',
    'focus',
    'focusHops',
    'focus_hops',
  ]);
  for (const [rawKey, rawVal] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) throw new Error(`${where}: "environments" has an empty environment name.`);
    if (!rawVal || typeof rawVal !== 'object' || Array.isArray(rawVal)) {
      throw new Error(`${where}: environments["${rawKey}"] must be an object.`);
    }
    const rec = rawVal as Record<string, unknown>;
    const unknown = Object.keys(rec).filter((k) => !allowedKeys.has(k));
    if (unknown.length) {
      throw new Error(
        `${where}: unknown key ${unknown.map((k) => `"${k}"`).join(', ')} in environments["${rawKey}"] ` +
          '(expected writable, rows, lease, blocklist, blockedTables, blockedFields, redact, redactColumns, maxRows, timeoutMs, focus, focusHops).',
      );
    }
    const label = `${where}: environments["${rawKey}"]`;
    if (rec.writable !== undefined && typeof rec.writable !== 'boolean') {
      throw new Error(`${label}: "writable" must be true or false.`);
    }
    if (rec.rows !== undefined && typeof rec.rows !== 'boolean') {
      throw new Error(`${label}: "rows" must be true or false.`);
    }
    if (rec.rows === false && rec.writable === true) {
      throw new Error(`${label} cannot set both "writable": true and "rows": false.`);
    }
    if (rec.redact !== undefined && typeof rec.redact !== 'boolean') {
      throw new Error(`${label}: "redact" must be true or false.`);
    }
    const lease = parseLeaseSpec(rec.lease, label);
    const blocklist = extractConnectionBlocklist(rec, label);
    const redactColumns = mergeRedactColumns(
      parseRedactColumnsSpec(rec.redactColumns, `${label} "redactColumns"`),
      parseRedactColumnsSpec(rec.redact_columns, `${label} "redact_columns"`),
    );
    const maxRows = parseMaxRows(rec.maxRows ?? rec.max_rows, `${label} "maxRows"`);
    const timeoutMs = parseTimeoutMs(rec.timeoutMs ?? rec.timeout_ms, `${label} "timeoutMs"`);
    const focus = parseFocusSpec(rec.focus, rec.focusHops ?? rec.focus_hops, `${label} "focus"`);
    out.set(key, {
      ...(rec.writable !== undefined ? { writable: rec.writable } : {}),
      ...(rec.rows !== undefined ? { rows: rec.rows } : {}),
      ...(lease ? { lease } : {}),
      ...(blocklist ? { blocklist } : {}),
      ...(rec.redact !== undefined ? { redact: rec.redact } : {}),
      ...(redactColumns ? { redactColumns } : {}),
      ...(maxRows !== undefined ? { maxRows } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(focus ? { focus } : {}),
    });
  }
  return out;
}

function resolveEnvPolicyFromMap(
  map: ReadonlyMap<string, EnvironmentPolicySpec>,
  conn: { id: string; name: string; url: string; database?: string; env?: string },
): EnvironmentPolicySpec | undefined {
  if (!map.size) return undefined;
  const detail = redact(conn.url);
  const envInfo = resolveConnectionEnvironment({
    id: conn.id,
    name: conn.name,
    detail,
    database: conn.database,
    env: conn.env,
  });
  const tier = envInfo.tier !== 'other' ? envInfo.tier : classifyEnvTier(envInfo.env, detail);
  const tierPol = tier !== 'other' ? map.get(tier) : undefined;
  const exactKey = envInfo.env?.trim().toLowerCase();
  const exactPol = exactKey && exactKey !== tier ? map.get(exactKey) : undefined;
  return mergeEnvironmentPolicies(tierPol, exactPol);
}

function parseCsvOrJsonList(raw: string, where: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${where} is not valid JSON: ${(err as Error).message}`);
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseEnvAndCliPolicies(
  env: NodeJS.ProcessEnv | undefined,
  cli: CliPolicyOverrides,
): {
  envBlocklist?: BlocklistRules;
  envLease?: LeaseSpec;
  forceRedact?: boolean;
  envRedactColumns?: string[];
  envMaxRows?: number;
  envTimeoutMs?: number;
  cliFocus?: FocusSpec;
  envCredentialCommand?: string;
} {
  const source = env ?? process.env;
  let envBlocklist: BlocklistRules | undefined;
  if (source.TABLEWALK_BLOCKLIST?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.TABLEWALK_BLOCKLIST.trim());
    } catch (err) {
      throw new Error(`TABLEWALK_BLOCKLIST is not valid JSON: ${(err as Error).message}`);
    }
    envBlocklist = parseBlocklist(parsed, 'TABLEWALK_BLOCKLIST');
  }
  const tablesRaw = source.TABLEWALK_BLOCKED_TABLES?.trim()
    ? parseCsvOrJsonList(source.TABLEWALK_BLOCKED_TABLES, 'TABLEWALK_BLOCKED_TABLES')
    : undefined;
  const fieldsRaw = source.TABLEWALK_BLOCKED_FIELDS?.trim()
    ? parseCsvOrJsonList(source.TABLEWALK_BLOCKED_FIELDS, 'TABLEWALK_BLOCKED_FIELDS')
    : undefined;
  const colsRaw = source.TABLEWALK_BLOCKED_COLUMNS?.trim()
    ? parseCsvOrJsonList(source.TABLEWALK_BLOCKED_COLUMNS, 'TABLEWALK_BLOCKED_COLUMNS')
    : undefined;
  if (tablesRaw !== undefined || fieldsRaw !== undefined || colsRaw !== undefined) {
    envBlocklist = extractConnectionBlocklist(
      {
        ...(tablesRaw !== undefined ? { blockedTables: tablesRaw } : {}),
        ...(fieldsRaw !== undefined ? { blockedFields: fieldsRaw } : {}),
        ...(colsRaw !== undefined ? { blockedColumns: colsRaw } : {}),
      },
      'environment variables',
      envBlocklist,
    );
  }

  const envLeaseFromVar = source.TABLEWALK_LEASE?.trim()
    ? (() => {
        const raw = source.TABLEWALK_LEASE.trim();
        if (raw.startsWith('{')) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            throw new Error(`TABLEWALK_LEASE is not valid JSON: ${(err as Error).message}`);
          }
          return parseLeaseSpec(parsed, 'TABLEWALK_LEASE');
        }
        return parseLeaseSpec(raw, 'TABLEWALK_LEASE');
      })()
    : undefined;
  const cliLease = cli.lease ? parseLeaseSpec(cli.lease, '--lease') : undefined;
  const envLease = mergeLeaseSpecs(envLeaseFromVar, cliLease);

  const redactVar = source.TABLEWALK_REDACT?.trim().toLowerCase();
  if (redactVar && !['1', 'true', 'yes', '0', 'false', 'no'].includes(redactVar)) {
    throw new Error(`TABLEWALK_REDACT must be 1/true or 0/false, not ${JSON.stringify(source.TABLEWALK_REDACT)}.`);
  }
  const forceRedact = cli.redact === true || redactVar === '1' || redactVar === 'true' || redactVar === 'yes' ? true : undefined;
  const envRedactColumns = source.TABLEWALK_REDACT_COLUMNS?.trim()
    ? parseRedactColumnsSpec(source.TABLEWALK_REDACT_COLUMNS, 'TABLEWALK_REDACT_COLUMNS')
    : undefined;

  const envMaxRows = minDefined(
    source.TABLEWALK_MAX_ROWS?.trim() ? parseMaxRows(source.TABLEWALK_MAX_ROWS, 'TABLEWALK_MAX_ROWS') : undefined,
    cli.maxRows !== undefined ? parseMaxRows(cli.maxRows, '--max-rows') : undefined,
  );

  const envTimeoutMs = minDefined(
    source.TABLEWALK_TIMEOUT_MS?.trim() ? parseTimeoutMs(source.TABLEWALK_TIMEOUT_MS, 'TABLEWALK_TIMEOUT_MS') : undefined,
    cli.timeoutMs !== undefined ? parseTimeoutMs(cli.timeoutMs, '--timeout-ms') : undefined,
  );

  const rawFocus = cli.focus ?? source.TABLEWALK_FOCUS;
  const rawFocusHops = cli.focusHops ?? source.TABLEWALK_FOCUS_HOPS;
  if (rawFocus === undefined && cli.focusHops !== undefined) {
    throw new Error('--focus-hops requires --focus <tables> (or TABLEWALK_FOCUS).');
  }
  const cliFocus = rawFocus ? parseFocusSpec(rawFocus, rawFocusHops, cli.focus !== undefined ? '--focus' : 'TABLEWALK_FOCUS') : undefined;

  const envCredentialCommand = source.TABLEWALK_CREDENTIAL_COMMAND?.trim()
    ? parseCredentialCommand(source.TABLEWALK_CREDENTIAL_COMMAND, 'TABLEWALK_CREDENTIAL_COMMAND')
    : undefined;

  return {
    ...(envBlocklist ? { envBlocklist } : {}),
    ...(envLease ? { envLease } : {}),
    ...(forceRedact ? { forceRedact } : {}),
    ...(envRedactColumns ? { envRedactColumns } : {}),
    ...(envMaxRows !== undefined ? { envMaxRows } : {}),
    ...(envTimeoutMs !== undefined ? { envTimeoutMs } : {}),
    ...(cliFocus ? { cliFocus } : {}),
    ...(envCredentialCommand ? { envCredentialCommand } : {}),
  };
}

export interface PolicyRegistryOptions {
  environment?: NodeJS.ProcessEnv;
  defaultBlocklist?: BlocklistRules;
  blocklists?: Map<string, BlocklistRules>;
  connectionLeases?: Map<string, LeaseSpec>;
  sessionLease?: LeaseSpec;
  environmentPolicies?: Map<string, EnvironmentPolicySpec>;
  defaultRedact?: boolean;
  forceRedact?: boolean;
  defaultRedactColumns?: string[];
  connectionRedacts?: Map<string, { enabled: boolean; columns?: string[] }>;
  defaultMaxRows?: number;
  connectionMaxRows?: Map<string, number>;
  defaultTimeoutMs?: number;
  connectionTimeouts?: Map<string, number>;
  defaultFocus?: FocusSpec;
  cliFocus?: FocusSpec;
  connectionFocus?: Map<string, FocusSpec>;
  defaultCredentialCommand?: string;
  connectionCredentialCommands?: Map<string, string>;
  mcpMode?: boolean;
}

interface ManagedSlot {
  rawAdapter: Adapter;
  wrapped: Adapter;
  schema: DatabaseSchema;
  policySignature: string;
  evicted: boolean;
}

/**
 * First-class `Registry` subclass enforcing table/field blocklists, always-on
 * row redaction, environment-tier policies, session row caps, and connection
 * leases across every route to an adapter (`open`, `refresh`, `dialedAdapter`,
 * `onAdapterDialed`, `lease`, `update`, `remove`, `closeAll`, `list`,
 * `poolStats`, and `add`).
 *
 * Key invariants:
 * - Default top-level policies, `environments.<env>` policies, and CLI/env-var
 *   policies apply dynamically to connections added after construction (CLI
 *   positional/`--db` targets, `--demo`, and browser session connections).
 * - Idle eviction closes the underlying adapter handle in place (`slot.evicted = true`)
 *   without calling `remove`/`add`, so `active` never moves even momentarily.
 * - `applyBlocklist`, `applyRedaction`, and `wrapLeasedAdapter` all build explicit
 *   allowlist `Adapter` facades with zero prototype or unlisted-method inheritance.
 */
export class PolicyRegistry extends Registry {
  private readonly baseEnvironment?: NodeJS.ProcessEnv;
  private readonly dynamicCredentials: Record<string, string> = {};
  private readonly defaultBlocklist?: BlocklistRules;
  private readonly blocklists = new Map<string, BlocklistRules>();
  private readonly connectionLeases = new Map<string, LeaseSpec>();
  private readonly sessionLease?: LeaseSpec;
  private readonly environmentPolicies = new Map<string, EnvironmentPolicySpec>();
  private readonly defaultRedact?: boolean;
  private readonly forceRedact: boolean;
  private readonly defaultRedactColumns?: string[];
  private readonly connectionRedacts = new Map<string, { enabled: boolean; columns?: string[] }>();
  private readonly defaultMaxRows?: number;
  private readonly connectionMaxRows = new Map<string, number>();
  private readonly defaultTimeoutMs?: number;
  private readonly connectionTimeouts = new Map<string, number>();
  private readonly defaultFocus?: FocusSpec;
  private readonly cliFocus?: FocusSpec;
  private readonly connectionFocus = new Map<string, FocusSpec>();
  private readonly defaultCredentialCommand?: string;
  private readonly connectionCredentialCommands = new Map<string, string>();
  private readonly credentialRefreshing = new Map<string, Promise<void>>();
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
    this.baseEnvironment = options.environment;
    this.defaultBlocklist = options.defaultBlocklist;
    if (options.blocklists) {
      for (const [id, rules] of options.blocklists) this.blocklists.set(id, rules);
    }
    if (options.connectionLeases) {
      for (const [id, lease] of options.connectionLeases) this.connectionLeases.set(id, lease);
    }
    if (options.environmentPolicies) {
      for (const [envKey, pol] of options.environmentPolicies) this.environmentPolicies.set(envKey, pol);
    }
    this.defaultRedact = options.defaultRedact;
    this.forceRedact = options.forceRedact === true;
    this.defaultRedactColumns = options.defaultRedactColumns;
    if (options.connectionRedacts) {
      for (const [id, spec] of options.connectionRedacts) this.connectionRedacts.set(id, spec);
    }
    this.defaultMaxRows = options.defaultMaxRows;
    if (options.connectionMaxRows) {
      for (const [id, max] of options.connectionMaxRows) this.connectionMaxRows.set(id, max);
    }
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    if (options.connectionTimeouts) {
      for (const [id, ms] of options.connectionTimeouts) this.connectionTimeouts.set(id, ms);
    }
    this.defaultFocus = options.defaultFocus;
    this.cliFocus = options.cliFocus;
    if (options.connectionFocus) {
      for (const [id, spec] of options.connectionFocus) this.connectionFocus.set(id, spec);
    }
    this.defaultCredentialCommand = options.defaultCredentialCommand;
    if (options.connectionCredentialCommands) {
      for (const [id, cmd] of options.connectionCredentialCommands) this.connectionCredentialCommands.set(id, cmd);
    }
    this.sessionLease = options.sessionLease;
    this.mcpMode = options.mcpMode === true;

    setRuntimePolicyResolver(this, (id) => this.runtimePolicyFor(id));

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
    this.syncPoolIdle(id);
  }

  setConnectionRedact(id: string, spec: { enabled: boolean; columns?: string[] } | undefined): void {
    if (!spec) {
      this.connectionRedacts.delete(id);
      return;
    }
    this.connectionRedacts.set(id, spec);
  }

  setConnectionMaxRows(id: string, maxRows: number | undefined): void {
    if (maxRows === undefined) {
      this.connectionMaxRows.delete(id);
      return;
    }
    this.connectionMaxRows.set(id, maxRows);
  }

  setConnectionTimeoutMs(id: string, timeoutMs: number | undefined): void {
    if (timeoutMs === undefined) {
      this.connectionTimeouts.delete(id);
      return;
    }
    this.connectionTimeouts.set(id, timeoutMs);
  }

  setConnectionFocus(id: string, focus: FocusSpec | undefined): void {
    if (!focus) {
      this.connectionFocus.delete(id);
      return;
    }
    this.connectionFocus.set(id, focus);
  }

  setConnectionCredentialCommand(id: string, cmd: string | undefined): void {
    if (!cmd) {
      this.connectionCredentialCommands.delete(id);
      return;
    }
    this.connectionCredentialCommands.set(id, cmd);
  }

  private syncPoolIdle(id: string): void {
    const cfg = this.configOf(id);
    const effIdle = this.leaseFor(id)?.idleSeconds ?? this.leaseFor(id)?.maxSeconds;
    if (cfg && !cfg.http && effIdle !== undefined && /^postgres(ql)?:\/\//i.test(cfg.url)) {
      cfg.pool = {
        ...(cfg.pool ?? {}),
        minIdle: 0,
        idleSeconds: Math.max(1, Math.ceil(Math.min(cfg.pool?.idleSeconds ?? effIdle, effIdle))),
      };
    }
  }

  private envPolicyFor(id: string): EnvironmentPolicySpec | undefined {
    if (!this.environmentPolicies.size) return undefined;
    const cfg = this.configOf(id);
    if (!cfg) return undefined;
    const meta = getConnectionEnvMeta(this, id);
    return resolveEnvPolicyFromMap(this.environmentPolicies, {
      id,
      name: cfg.name,
      url: cfg.url,
      database: meta?.database,
      env: meta?.env,
    });
  }

  private rulesFor(id: string): BlocklistRules | undefined {
    const withEnv = mergeBlocklists(this.defaultBlocklist, this.envPolicyFor(id)?.blocklist);
    return mergeBlocklists(withEnv, this.blocklists.get(id));
  }

  private focusFor(id: string): FocusSpec | undefined {
    return this.cliFocus ?? this.connectionFocus.get(id) ?? this.envPolicyFor(id)?.focus ?? this.defaultFocus;
  }

  private ownLeaseFor(id: string): LeaseSpec | undefined {
    return mergeLeaseSpecs(this.envPolicyFor(id)?.lease, this.connectionLeases.get(id));
  }

  private leaseFor(id: string): LeaseSpec | undefined {
    return mergeLeaseSpecs(this.sessionLease, this.ownLeaseFor(id));
  }

  private redactFor(id: string): { columns?: string[] } | undefined {
    const envPol = this.envPolicyFor(id);
    const own = this.connectionRedacts.get(id);
    const enabled = this.forceRedact || (own !== undefined ? own.enabled : (envPol?.redact ?? this.defaultRedact ?? false));
    if (!enabled) return undefined;
    const columns = mergeRedactColumns(this.defaultRedactColumns, envPol?.redactColumns, own?.columns);
    return columns ? { columns } : {};
  }

  private maxRowsFor(id: string): number | undefined {
    return minDefined(this.defaultMaxRows, this.envPolicyFor(id)?.maxRows, this.connectionMaxRows.get(id));
  }

  private timeoutMsFor(id: string): number | undefined {
    return minDefined(this.defaultTimeoutMs, this.envPolicyFor(id)?.timeoutMs, this.connectionTimeouts.get(id));
  }

  private credentialCommandFor(id: string): string | undefined {
    const cfg = this.configOf(id);
    /* Never run credential commands for browser session-added connections. */
    if (cfg?.source === 'session') return undefined;
    return this.connectionCredentialCommands.get(id) ?? this.defaultCredentialCommand;
  }

  private async refreshCredentialsFor(id: string): Promise<void> {
    const cmd = this.credentialCommandFor(id);
    if (!cmd) return;
    const inflight = this.credentialRefreshing.get(id);
    if (inflight) {
      await inflight;
      return;
    }
    const cfg = this.configOf(id);
    const connName = cfg?.name ?? id;
    const task = (async () => {
      const fresh = await executeCredentialCommand(cmd, id, connName, this.baseEnvironment);
      Object.assign(this.dynamicCredentials, fresh);
      (this as unknown as { environment?: NodeJS.ProcessEnv }).environment = Object.freeze({
        ...process.env,
        ...(this.baseEnvironment ?? {}),
        ...this.dynamicCredentials,
      });
    })().finally(() => {
      this.credentialRefreshing.delete(id);
    });
    this.credentialRefreshing.set(id, task);
    await task;
  }

  private runtimePolicyFor(id: string): RuntimeConnectionPolicy | undefined {
    const redact = this.redactFor(id);
    const maxRows = this.maxRowsFor(id);
    const timeoutMs = this.timeoutMsFor(id);
    const focus = this.focusFor(id);
    if (!redact && maxRows === undefined && timeoutMs === undefined && !focus) return undefined;
    return {
      ...(redact ? { redactsRows: true, ...(redact.columns ? { redactColumns: redact.columns } : {}) } : {}),
      ...(maxRows !== undefined ? { maxRows } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(focus ? { focused: true } : {}),
    };
  }

  private isExpired(id: string): boolean {
    return this.sessionExpired || this.expiredIds.has(id);
  }

  private assertNotExpired(id: string): void {
    if (this.sessionExpired) {
      throw new Refusal(`Connection lease expired after ${this.sessionLease?.maxSeconds}s; start a new session to reconnect.`);
    }
    if (this.expiredIds.has(id)) {
      const own = this.ownLeaseFor(id);
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
    const own = this.ownLeaseFor(id);
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
    const rules = this.rulesFor(id);
    const focusSpec = this.focusFor(id);
    const redactSpec = this.redactFor(id);
    const leaseSpec = this.leaseFor(id);
    const policySignature = JSON.stringify({
      rules: rules ?? null,
      focus: focusSpec ?? null,
      redact: redactSpec ?? null,
      lease: leaseSpec ?? null,
    });

    const hit = this.slots.get(id);
    if (hit && !hit.evicted && hit.rawAdapter === rawAdapter && hit.policySignature === policySignature) {
      this.scheduleIdle(id);
      return { adapter: hit.wrapped, schema: hit.schema };
    }

    /* Make `rawAdapter.close()` idempotent once per underlying adapter so in-place
       idle eviction followed later by `super.refresh(id)` or `super.closeAll()`
       never double-closes a `node:sqlite` handle. */
    if (!idempotentAdapters.has(rawAdapter)) {
      idempotentAdapters.add(rawAdapter);
      let rawClosed = false;
      const origClose = rawAdapter.close.bind(rawAdapter);
      rawAdapter.close = async () => {
        if (rawClosed) return;
        rawClosed = true;
        await origClose();
      };
    }

    const cfg = this.configOf(id);
    const label = cfg?.name ?? id;
    const focusRules = focusSpec ? computeFocusBlocklist(rawSchema, focusSpec).rules : undefined;
    const effectiveRules = mergeBlocklists(rules, focusRules);
    const shouldFenceCatalog = Boolean((effectiveRules && hasBlocklistRules(effectiveRules)) || focusSpec);
    const blocked = shouldFenceCatalog
      ? applyBlocklist(rawAdapter, rawSchema, label, effectiveRules ?? { tables: [], fields: {} })
      : { adapter: rawAdapter, schema: rawSchema };
    const redacted = redactSpec ? applyRedaction(blocked.adapter, blocked.schema, label, redactSpec) : blocked;
    const leased = this.wrapLeasedAdapter(id, redacted.adapter);
    this.slots.set(id, { rawAdapter, wrapped: leased, schema: redacted.schema, policySignature, evicted: false });
    this.ensureMaxTimer(id);
    this.scheduleIdle(id);
    return { adapter: leased, schema: redacted.schema };
  }

  override add(config: Parameters<Registry['add']>[0], options?: Parameters<Registry['add']>[1]): ReturnType<Registry['add']> {
    const added = super.add(config, options);
    if (added.source !== 'config') {
      const envPol = this.envPolicyFor(added.id);
      if (envPol?.rows === false && !added.writable) {
        added.rows = false;
      }
    }
    this.syncPoolIdle(added.id);
    return added;
  }

  override onAdapterDialed(hook: (id: string, adapter: Adapter) => void): void {
    super.onAdapterDialed((id, rawAdapter) => {
      /* Never expose an unwrapped adapter beneath a blocklist, focus, or redaction policy to dial listeners. */
      if (this.rulesFor(id) || this.focusFor(id) || this.redactFor(id)) return;
      hook(id, rawAdapter);
    });
  }

  override dialedAdapter(id: string): Adapter | undefined {
    if (this.rulesFor(id) || this.focusFor(id) || this.redactFor(id) || this.slots.get(id)?.evicted || this.isExpired(id)) {
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
            await this.refreshCredentialsFor(id);
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
      if (!currentSlot) {
        await this.refreshCredentialsFor(id);
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
    await this.refreshCredentialsFor(id);
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
    this.connectionRedacts.delete(id);
    this.connectionMaxRows.delete(id);
    this.connectionTimeouts.delete(id);
    this.connectionFocus.delete(id);
    this.connectionCredentialCommands.delete(id);
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
      const focusSpec = this.focusFor(item.id);
      const redactSpec = this.redactFor(item.id);
      const maxRows = this.maxRowsFor(item.id);
      const timeoutMs = this.timeoutMsFor(item.id);
      const slot = this.slots.get(item.id);
      const evictedOrExpired = Boolean(slot?.evicted) || this.isExpired(item.id);
      return {
        ...item,
        ...(evictedOrExpired
          ? { connected: false, tables: undefined }
          : slot
            ? { connected: true, tables: slot.schema.tables.length }
            : {}),
        ...(rules || redactSpec || focusSpec ? { hidesColumns: true } : {}),
        ...(redactSpec ? { redactsRows: true } : {}),
        ...(focusSpec ? { focused: true } : {}),
        ...(maxRows !== undefined ? { maxRows } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      } as ReturnType<Registry['list']>[number];
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
 * `PolicyRegistry` whenever blocklists, redaction, row caps, environment-tier
 * policies, or leases apply), including in-memory secrets (`env` / `secrets` /
 * `dotenv`). Never writes secrets or config to disk.
 */
export async function loadPipedVaultConfig(
  configArg: string | undefined,
  mcpMode: boolean,
  cliOrLease?: string | CliPolicyOverrides,
  splitStdinStream?: boolean,
): Promise<LoadedVaultConfig> {
  const cli = normalizeCliOverrides(cliOrLease);
  const { text, where, remainingStdin } = await readRawVaultSource(configArg, splitStdinStream ?? mcpMode);
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
    const envPol = parseEnvAndCliPolicies(environment, cli);
    const hasPolicy = Boolean(
      envPol.envBlocklist ||
      envPol.envLease ||
      envPol.forceRedact ||
      envPol.envRedactColumns ||
      envPol.envMaxRows !== undefined ||
      envPol.envTimeoutMs !== undefined ||
      envPol.cliFocus ||
      envPol.envCredentialCommand,
    );
    const registry = hasPolicy
      ? new PolicyRegistry({
          environment,
          defaultBlocklist: envPol.envBlocklist,
          sessionLease: envPol.envLease,
          forceRedact: envPol.forceRedact,
          defaultRedactColumns: envPol.envRedactColumns,
          defaultMaxRows: envPol.envMaxRows,
          defaultTimeoutMs: envPol.envTimeoutMs,
          cliFocus: envPol.cliFocus,
          defaultCredentialCommand: envPol.envCredentialCommand,
          mcpMode,
        })
      : new Registry({ environment });
    return { registry, views: [], queries: [], pages: [], layouts: [], lease: envPol.envLease, remainingStdin };
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
        ...(doc.redact !== undefined ? { redact: doc.redact } : {}),
        ...(doc.redactColumns !== undefined ? { redactColumns: doc.redactColumns } : {}),
        ...(doc.redact_columns !== undefined ? { redact_columns: doc.redact_columns } : {}),
        ...(doc.maxRows !== undefined ? { maxRows: doc.maxRows } : {}),
        ...(doc.max_rows !== undefined ? { max_rows: doc.max_rows } : {}),
        ...(doc.timeoutMs !== undefined ? { timeoutMs: doc.timeoutMs } : {}),
        ...(doc.timeout_ms !== undefined ? { timeout_ms: doc.timeout_ms } : {}),
        ...(doc.focus !== undefined ? { focus: doc.focus } : {}),
        ...(doc.focusHops !== undefined ? { focusHops: doc.focusHops } : {}),
        ...(doc.focus_hops !== undefined ? { focus_hops: doc.focus_hops } : {}),
        ...(doc.credentialCommand !== undefined ? { credentialCommand: doc.credentialCommand } : {}),
        ...(doc.credential_command !== undefined ? { credential_command: doc.credential_command } : {}),
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

  const envPol = parseEnvAndCliPolicies(environment ?? process.env, cli);
  const environmentPolicies = parseEnvironmentPolicies(doc.environments, where);
  const defaultBlocklist = mergeBlocklists(parseBlocklist(doc.blocklist, where), envPol.envBlocklist);
  const topLease = parseLeaseSpec(doc.lease, where);
  const sessionLease = mergeLeaseSpecs(topLease, envPol.envLease);
  if (doc.redact !== undefined && typeof doc.redact !== 'boolean') {
    throw new Error(`${where}: "redact" must be true or false.`);
  }
  const defaultRedact = typeof doc.redact === 'boolean' ? doc.redact : undefined;
  const defaultRedactColumns = mergeRedactColumns(
    parseRedactColumnsSpec(doc.redactColumns, `${where} "redactColumns"`),
    parseRedactColumnsSpec(doc.redact_columns, `${where} "redact_columns"`),
    envPol.envRedactColumns,
  );
  const defaultMaxRows = minDefined(parseMaxRows(doc.maxRows ?? doc.max_rows, `${where} "maxRows"`), envPol.envMaxRows);
  const defaultTimeoutMs = minDefined(parseTimeoutMs(doc.timeoutMs ?? doc.timeout_ms, `${where} "timeoutMs"`), envPol.envTimeoutMs);
  const defaultFocus = parseFocusSpec(doc.focus, doc.focusHops ?? doc.focus_hops, `${where} "focus"`);
  const defaultCredentialCommand =
    parseCredentialCommand(doc.credentialCommand ?? doc.credential_command, `${where} "credentialCommand"`) ?? envPol.envCredentialCommand;

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
    redactSpec?: { enabled: boolean; columns?: string[] };
    maxRows?: number;
    timeoutMs?: number;
    focus?: FocusSpec;
    credentialCommand?: string;
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
    const connWhere = `${where}: connection "${name}"`;
    if (c.writable !== undefined && typeof c.writable !== 'boolean') {
      throw new Error(`${connWhere} has "writable": ${JSON.stringify(c.writable)}. It must be true or false.`);
    }
    if (c.rows !== undefined && typeof c.rows !== 'boolean') {
      throw new Error(`${connWhere} has "rows": ${JSON.stringify(c.rows)}. It must be true or false.`);
    }
    if (c.redact !== undefined && typeof c.redact !== 'boolean') {
      throw new Error(`${connWhere} has "redact": ${JSON.stringify(c.redact)}. It must be true or false.`);
    }
    const database = typeof c.database === 'string' ? c.database.trim() : typeof c.group === 'string' ? c.group.trim() : undefined;
    const envName = typeof c.env === 'string' ? c.env.trim() : typeof c.environment === 'string' ? c.environment.trim() : undefined;
    const matchedEnvPol = resolveEnvPolicyFromMap(environmentPolicies, { id: name, name, url: c.url, database, env: envName });

    const effectiveWritable = c.writable !== undefined ? c.writable === true : matchedEnvPol?.writable === true;
    const effectiveRows = c.rows !== undefined ? c.rows : matchedEnvPol?.rows;
    if (effectiveRows === false && effectiveWritable === true) {
      throw new Error(`${connWhere} is both "writable" and "rows": false. Drop one of them.`);
    }

    const hidden = c.hidden !== undefined ? validateHiddenShape(c.hidden, connWhere) : undefined;
    const connBlocklist = extractConnectionBlocklist(c, connWhere);
    const ownLease = parseLeaseSpec(c.lease, connWhere);
    const ownRedactCols = mergeRedactColumns(
      parseRedactColumnsSpec(c.redactColumns, `${connWhere} "redactColumns"`),
      parseRedactColumnsSpec(c.redact_columns, `${connWhere} "redact_columns"`),
    );
    const redactSpec =
      c.redact !== undefined || ownRedactCols !== undefined
        ? {
            enabled: c.redact !== undefined ? c.redact : Boolean(ownRedactCols?.length),
            ...(ownRedactCols ? { columns: ownRedactCols } : {}),
          }
        : undefined;
    const ownMaxRows = parseMaxRows(c.maxRows ?? c.max_rows, `${connWhere} "maxRows"`);
    const ownTimeoutMs = parseTimeoutMs(c.timeoutMs ?? c.timeout_ms, `${connWhere} "timeoutMs"`);
    const ownFocus = parseFocusSpec(c.focus, c.focusHops ?? c.focus_hops, `${connWhere} "focus"`);
    const ownCredCmd = parseCredentialCommand(c.credentialCommand ?? c.credential_command, `${connWhere} "credentialCommand"`);
    if (connBlocklist || ownLease || redactSpec || ownMaxRows !== undefined || ownTimeoutMs !== undefined || ownFocus || ownCredCmd) {
      anyConnPolicy = true;
    }

    const rawPool = c.pool && typeof c.pool === 'object' && !Array.isArray(c.pool) ? { ...(c.pool as Record<string, number>) } : undefined;
    const isHttp = c.kind === 'http' && c.http && typeof c.http === 'object';
    const located = isHttp ? c.url : sqliteTargetFrom(c.url, cwd);

    const hasExtras =
      c.blocklist !== undefined ||
      c.blockedTables !== undefined ||
      c.blockedFields !== undefined ||
      c.blockedColumns !== undefined ||
      c.lease !== undefined ||
      c.redact !== undefined ||
      c.redactColumns !== undefined ||
      c.redact_columns !== undefined ||
      c.maxRows !== undefined ||
      c.max_rows !== undefined ||
      c.timeoutMs !== undefined ||
      c.timeout_ms !== undefined ||
      c.focus !== undefined ||
      c.focusHops !== undefined ||
      c.focus_hops !== undefined;

    parsedEntries.push({
      addArg: {
        name,
        url: located,
        ...(located !== c.url ? { writtenUrl: c.url } : {}),
        ...(Array.isArray(c.schemas) ? { schemas: c.schemas.map(String) } : {}),
        writable: effectiveWritable,
        rows: effectiveRows === false ? false : undefined,
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
            ...(c.redact !== undefined ? { redact: c.redact } : {}),
            ...(c.redactColumns !== undefined ? { redactColumns: c.redactColumns } : {}),
            ...(c.redact_columns !== undefined ? { redact_columns: c.redact_columns } : {}),
            ...(c.maxRows !== undefined ? { maxRows: c.maxRows } : c.max_rows !== undefined ? { maxRows: c.max_rows } : {}),
            ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : c.timeout_ms !== undefined ? { timeoutMs: c.timeout_ms } : {}),
            ...(c.focus !== undefined ? { focus: c.focus } : {}),
            ...(c.focusHops !== undefined ? { focusHops: c.focusHops } : c.focus_hops !== undefined ? { focusHops: c.focus_hops } : {}),
          }
        : undefined,
      blocklist: connBlocklist,
      lease: ownLease,
      redactSpec,
      maxRows: ownMaxRows,
      timeoutMs: ownTimeoutMs,
      focus: ownFocus,
      credentialCommand: ownCredCmd,
    });
  }

  const usePolicyRegistry = Boolean(
    defaultBlocklist ||
    sessionLease ||
    environmentPolicies.size > 0 ||
    defaultRedact !== undefined ||
    envPol.forceRedact ||
    defaultRedactColumns ||
    defaultMaxRows !== undefined ||
    defaultTimeoutMs !== undefined ||
    defaultFocus ||
    envPol.cliFocus ||
    defaultCredentialCommand ||
    anyConnPolicy,
  );
  const registry: Registry = usePolicyRegistry
    ? new PolicyRegistry({
        environment,
        defaultBlocklist,
        sessionLease,
        environmentPolicies,
        defaultRedact,
        forceRedact: envPol.forceRedact,
        defaultRedactColumns,
        defaultMaxRows,
        defaultTimeoutMs,
        defaultFocus,
        cliFocus: envPol.cliFocus,
        defaultCredentialCommand,
        mcpMode,
      })
    : new Registry(environment ? { environment } : {});

  if (
    doc.blocklist !== undefined ||
    doc.lease !== undefined ||
    doc.environments !== undefined ||
    doc.redact !== undefined ||
    doc.redactColumns !== undefined ||
    doc.redact_columns !== undefined ||
    doc.maxRows !== undefined ||
    doc.max_rows !== undefined ||
    doc.timeoutMs !== undefined ||
    doc.timeout_ms !== undefined ||
    doc.focus !== undefined ||
    doc.focusHops !== undefined ||
    doc.focus_hops !== undefined
  ) {
    setTopLevelConfigExtras(registry, {
      ...(doc.blocklist !== undefined ? { blocklist: doc.blocklist } : {}),
      ...(doc.lease !== undefined ? { lease: doc.lease } : {}),
      ...(doc.environments !== undefined ? { environments: doc.environments } : {}),
      ...(doc.redact !== undefined ? { redact: doc.redact } : {}),
      ...(doc.redactColumns !== undefined ? { redactColumns: doc.redactColumns } : {}),
      ...(doc.redact_columns !== undefined ? { redact_columns: doc.redact_columns } : {}),
      ...(doc.maxRows !== undefined ? { maxRows: doc.maxRows } : doc.max_rows !== undefined ? { maxRows: doc.max_rows } : {}),
      ...(doc.timeoutMs !== undefined ? { timeoutMs: doc.timeoutMs } : doc.timeout_ms !== undefined ? { timeoutMs: doc.timeout_ms } : {}),
      ...(doc.focus !== undefined ? { focus: doc.focus } : {}),
      ...(doc.focusHops !== undefined ? { focusHops: doc.focusHops } : doc.focus_hops !== undefined ? { focusHops: doc.focus_hops } : {}),
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
      if (entry.redactSpec) registry.setConnectionRedact(added.id, entry.redactSpec);
      if (entry.maxRows !== undefined) registry.setConnectionMaxRows(added.id, entry.maxRows);
      if (entry.timeoutMs !== undefined) registry.setConnectionTimeoutMs(added.id, entry.timeoutMs);
      if (entry.focus) registry.setConnectionFocus(added.id, entry.focus);
      if (entry.credentialCommand) registry.setConnectionCredentialCommand(added.id, entry.credentialCommand);
      /* Re-sync pool idle now that explicit `env` metadata has been attached to `added.id`. */
      if (entry.database || entry.envName) registry.setConnectionLease(added.id, entry.lease);
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
 * a `PolicyRegistry` carrying top-level, environment-tier, env-var, and
 * per-connection policies (`blocklist`, `redact`, `maxRows`, `timeoutMs`,
 * `focus`, `credentialCommand`, `lease`, and isolated `secrets`/`dotenv`
 * variables).
 */
export function applyExtendedDiskConfig(
  baseRegistry: Registry,
  rawConfigText: string | undefined,
  where: string,
  mcpMode: boolean,
  cliOrLease?: string | CliPolicyOverrides,
): { registry: Registry; active?: string; only?: boolean; lazy?: boolean; lease?: LeaseSpec } {
  const cli = normalizeCliOverrides(cliOrLease);
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

  const envPol = parseEnvAndCliPolicies(environment ?? process.env, cli);
  const environmentPolicies = parseEnvironmentPolicies(doc.environments, where);
  const defaultBlocklist = mergeBlocklists(parseBlocklist(doc.blocklist, where), envPol.envBlocklist);
  const topLease = parseLeaseSpec(doc.lease, where);
  const sessionLease = mergeLeaseSpecs(topLease, envPol.envLease);
  if (doc.redact !== undefined && typeof doc.redact !== 'boolean') {
    throw new Error(`${where}: "redact" must be true or false.`);
  }
  const defaultRedact = typeof doc.redact === 'boolean' ? doc.redact : undefined;
  const defaultRedactColumns = mergeRedactColumns(
    parseRedactColumnsSpec(doc.redactColumns, `${where} "redactColumns"`),
    parseRedactColumnsSpec(doc.redact_columns, `${where} "redact_columns"`),
    envPol.envRedactColumns,
  );
  const defaultMaxRows = minDefined(parseMaxRows(doc.maxRows ?? doc.max_rows, `${where} "maxRows"`), envPol.envMaxRows);
  const defaultTimeoutMs = minDefined(parseTimeoutMs(doc.timeoutMs ?? doc.timeout_ms, `${where} "timeoutMs"`), envPol.envTimeoutMs);
  const defaultFocus = parseFocusSpec(doc.focus, doc.focusHops ?? doc.focus_hops, `${where} "focus"`);
  const defaultCredentialCommand =
    parseCredentialCommand(doc.credentialCommand ?? doc.credential_command, `${where} "credentialCommand"`) ?? envPol.envCredentialCommand;

  const blocklists = new Map<string, BlocklistRules>();
  const connectionLeases = new Map<string, LeaseSpec>();
  const connectionRedacts = new Map<string, { enabled: boolean; columns?: string[] }>();
  const connectionMaxRows = new Map<string, number>();
  const connectionTimeouts = new Map<string, number>();
  const connectionFocus = new Map<string, FocusSpec>();
  const connectionCredentialCommands = new Map<string, string>();
  const rawConnById = new Map<string, Record<string, unknown>>();
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
      rawConnById.set(match.id, rec);
      const connWhere = `${where}: connection "${name}"`;
      const bl = extractConnectionBlocklist(rec, connWhere);
      if (bl) blocklists.set(match.id, bl);
      const ownLease = parseLeaseSpec(rec.lease, connWhere);
      if (ownLease) connectionLeases.set(match.id, ownLease);
      if (rec.redact !== undefined && typeof rec.redact !== 'boolean') {
        throw new Error(`${connWhere}: "redact" must be true or false.`);
      }
      const ownRedactCols = mergeRedactColumns(
        parseRedactColumnsSpec(rec.redactColumns, `${connWhere} "redactColumns"`),
        parseRedactColumnsSpec(rec.redact_columns, `${connWhere} "redact_columns"`),
      );
      if (rec.redact !== undefined || ownRedactCols !== undefined) {
        connectionRedacts.set(match.id, {
          enabled: typeof rec.redact === 'boolean' ? rec.redact : Boolean(ownRedactCols?.length),
          ...(ownRedactCols ? { columns: ownRedactCols } : {}),
        });
      }
      const ownMax = parseMaxRows(rec.maxRows ?? rec.max_rows, `${connWhere} "maxRows"`);
      if (ownMax !== undefined) connectionMaxRows.set(match.id, ownMax);
      const ownTimeout = parseTimeoutMs(rec.timeoutMs ?? rec.timeout_ms, `${connWhere} "timeoutMs"`);
      if (ownTimeout !== undefined) connectionTimeouts.set(match.id, ownTimeout);
      const ownFocus = parseFocusSpec(rec.focus, rec.focusHops ?? rec.focus_hops, `${connWhere} "focus"`);
      if (ownFocus) connectionFocus.set(match.id, ownFocus);
      const ownCredCmd = parseCredentialCommand(rec.credentialCommand ?? rec.credential_command, `${connWhere} "credentialCommand"`);
      if (ownCredCmd) connectionCredentialCommands.set(match.id, ownCredCmd);
    }
  }

  const needsPolicy = Boolean(
    defaultBlocklist ||
    sessionLease ||
    environmentPolicies.size > 0 ||
    defaultRedact !== undefined ||
    envPol.forceRedact ||
    defaultRedactColumns ||
    defaultMaxRows !== undefined ||
    defaultTimeoutMs !== undefined ||
    defaultFocus ||
    envPol.cliFocus ||
    defaultCredentialCommand ||
    blocklists.size > 0 ||
    connectionLeases.size > 0 ||
    connectionRedacts.size > 0 ||
    connectionMaxRows.size > 0 ||
    connectionTimeouts.size > 0 ||
    connectionFocus.size > 0 ||
    connectionCredentialCommands.size > 0,
  );
  let registry: Registry = baseRegistry;

  if (needsPolicy || environment !== baseRegistry.environment) {
    const next = needsPolicy
      ? new PolicyRegistry({
          environment,
          defaultBlocklist,
          blocklists,
          connectionLeases,
          sessionLease,
          environmentPolicies,
          defaultRedact,
          forceRedact: envPol.forceRedact,
          defaultRedactColumns,
          connectionRedacts,
          defaultMaxRows,
          connectionMaxRows,
          defaultTimeoutMs,
          connectionTimeouts,
          defaultFocus,
          cliFocus: envPol.cliFocus,
          connectionFocus,
          defaultCredentialCommand,
          connectionCredentialCommands,
          mcpMode,
        })
      : new Registry(environment ? { environment } : {});

    next.sections = baseRegistry.sections;
    for (const svc of baseRegistry.serviceConfigs()) next.addService(svc);
    for (const kept of baseRegistry.keptEntries()) next.keep(kept);
    for (const cfg of existingConfigs) {
      const meta = getConnectionEnvMeta(baseRegistry, cfg.id);
      const rawConn = rawConnById.get(cfg.id);
      const matchedEnvPol = resolveEnvPolicyFromMap(environmentPolicies, {
        id: cfg.id,
        name: cfg.name,
        url: cfg.url,
        database: meta?.database,
        env: meta?.env,
      });
      const writable =
        rawConn?.writable !== undefined ? cfg.writable : matchedEnvPol?.writable !== undefined ? matchedEnvPol.writable : cfg.writable;
      const rows = rawConn?.rows !== undefined ? cfg.rows : matchedEnvPol?.rows === false ? false : cfg.rows;
      if (rows === false && writable === true) {
        throw new Error(`${where}: connection "${cfg.name}" is both "writable" and "rows": false (via environment policy).`);
      }
      next.add({ ...cfg, writable, rows });
      if (meta) setConnectionEnvMeta(next, cfg.id, meta);
      const extras = getConnectionConfigExtras(baseRegistry, cfg.id);
      if (extras) setConnectionConfigExtras(next, cfg.id, extras);
      if (next instanceof PolicyRegistry) {
        next.setConnectionLease(cfg.id, connectionLeases.get(cfg.id));
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
  } else if (
    doc.blocklist !== undefined ||
    doc.lease !== undefined ||
    doc.environments !== undefined ||
    doc.redact !== undefined ||
    doc.redactColumns !== undefined ||
    doc.maxRows !== undefined ||
    doc.timeoutMs !== undefined ||
    doc.focus !== undefined ||
    doc.focusHops !== undefined
  ) {
    setTopLevelConfigExtras(registry, {
      ...(doc.blocklist !== undefined ? { blocklist: doc.blocklist } : {}),
      ...(doc.lease !== undefined ? { lease: doc.lease } : {}),
      ...(doc.environments !== undefined ? { environments: doc.environments } : {}),
      ...(doc.redact !== undefined ? { redact: doc.redact } : {}),
      ...(doc.redactColumns !== undefined ? { redactColumns: doc.redactColumns } : {}),
      ...(doc.maxRows !== undefined ? { maxRows: doc.maxRows } : {}),
      ...(doc.timeoutMs !== undefined ? { timeoutMs: doc.timeoutMs } : {}),
      ...(doc.focus !== undefined ? { focus: doc.focus } : {}),
      ...(doc.focusHops !== undefined ? { focusHops: doc.focusHops } : {}),
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
 * against `registry`, format to stdout (`json` | `ndjson` | `tsv` | `md`), and
 * close all connections.
 */
function coerceCliParamValue(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (/^null$/i.test(trimmed)) return null;
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n;
  }
  return raw;
}

function parseCliParams(entries: readonly string[] | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!entries?.length) return out;
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(`--param expects key=value (got "${entry}").`);
    }
    const key = entry.slice(0, eq).trim().replace(/^:/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`--param has invalid parameter name "${key}".`);
    }
    out[key] = coerceCliParamValue(entry.slice(eq + 1));
  }
  return out;
}

function inferExportOptions(outPath: string): { format: 'csv' | 'ndjson' | 'json'; compress?: 'gzip' } {
  const lower = outPath.toLowerCase();
  const compress = lower.endsWith('.gz') ? ('gzip' as const) : undefined;
  const stem = compress ? lower.slice(0, -3) : lower;
  if (stem.endsWith('.ndjson') || stem.endsWith('.jsonl')) return { format: 'ndjson', ...(compress ? { compress } : {}) };
  if (stem.endsWith('.json')) return { format: 'json', ...(compress ? { compress } : {}) };
  return { format: 'csv', ...(compress ? { compress } : {}) };
}

export async function runCliOneShot(
  registry: Registry,
  shelf: { views?: ViewDef[]; queries: SavedQuery[]; pages: PageDef[] },
  options: {
    query?: string;
    call?: string;
    sqlFile?: string;
    params?: string[];
    out?: string;
    args?: string;
    connection?: string;
    env?: string;
    allEnvs?: boolean;
    format?: string;
  },
): Promise<void> {
  bindShelf(registry, shelf);
  try {
    const { formatCliOutput, parseCliOutputFormat } = await import('./outputFormat.js');
    let outFormat;
    try {
      outFormat = parseCliOutputFormat(options.format);
    } catch (err) {
      console.error(`tablewalk: ${(err as Error).message}`);
      process.exitCode = 2;
      return;
    }

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

    if (options.params?.length) {
      let cliParams: Record<string, string | number | boolean | null>;
      try {
        cliParams = parseCliParams(options.params);
      } catch (err) {
        console.error(`tablewalk: ${(err as Error).message}`);
        process.exitCode = 2;
        return;
      }
      const prevParams =
        toolArgs.params && typeof toolArgs.params === 'object' && !Array.isArray(toolArgs.params)
          ? (toolArgs.params as Record<string, unknown>)
          : {};
      toolArgs.params = { ...prevParams, ...cliParams };
    }

    const outPath = options.out?.trim();
    const outHints = outPath ? inferExportOptions(outPath) : undefined;

    if (options.sqlFile !== undefined) {
      const spec = options.sqlFile.trim();
      if (!spec) {
        console.error('tablewalk: --sql-file requires a file path or saved workspace query name.');
        process.exitCode = 2;
        return;
      }
      const { existsSync, readFileSync, statSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const diskPath = resolve(spec);
      const isDiskFile = existsSync(diskPath) && statSync(diskPath).isFile();
      if (outPath) {
        toolName = 'export';
        if (isDiskFile) toolArgs.sql = readFileSync(diskPath, 'utf8');
        else toolArgs.saved = spec;
        if (toolArgs.format === undefined) toolArgs.format = outHints!.format;
        if (toolArgs.compress === undefined && outHints!.compress) toolArgs.compress = outHints!.compress;
      } else {
        toolName = 'sql';
        if (isDiskFile) toolArgs.statement = readFileSync(diskPath, 'utf8');
        else toolArgs.saved = spec;
      }
    } else if (options.query !== undefined) {
      const q = options.query.trim();
      if (!q) {
        console.error('tablewalk: --query requires a non-empty query string.');
        process.exitCode = 2;
        return;
      }
      if (outPath) {
        toolName = 'export';
        toolArgs.query = q;
        if (toolArgs.format === undefined) toolArgs.format = outHints!.format;
        if (toolArgs.compress === undefined && outHints!.compress) toolArgs.compress = outHints!.compress;
      } else {
        toolName = looksLikeBreakdown(q) ? 'breakdown' : 'query';
        toolArgs.q = q;
      }
    } else {
      toolName = (options.call ?? '').trim();
      if (!toolName) {
        console.error('tablewalk: --call requires a tool name (for example schema_summary, tables, query, record).');
        process.exitCode = 2;
        return;
      }
      if (outPath && toolName === 'export') {
        if (toolArgs.format === undefined) toolArgs.format = outHints!.format;
        if (toolArgs.compress === undefined && outHints!.compress) toolArgs.compress = outHints!.compress;
      }
    }

    if (options.connection && toolArgs.connection === undefined) toolArgs.connection = options.connection;
    if (options.allEnvs && toolArgs.envs === undefined && toolArgs.env === undefined) {
      toolArgs.envs = 'all';
    } else if (options.env && toolArgs.env === undefined && toolArgs.envs === undefined) {
      toolArgs.env = options.env;
    }

    const answer = await runTool(registry, toolName, toolArgs);
    if (answer.isError) {
      console.error(`tablewalk: ${answer.content[0]?.text ?? 'Tool call failed.'}`);
      process.exitCode = 1;
      return;
    }
    const payload = { ...(answer.structuredContent ?? { text: answer.content[0]?.text ?? '' }) };
    if (outPath && toolName === 'export' && typeof payload.path === 'string') {
      const { copyFileSync, mkdirSync, unlinkSync } = await import('node:fs');
      const { dirname, resolve } = await import('node:path');
      const dest = resolve(outPath);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(payload.path, dest);
      try {
        unlinkSync(payload.path);
      } catch {
        /* Best-effort cleanup of temp export file. */
      }
      payload.path = dest;
    }
    process.stdout.write(formatCliOutput(toolName, payload, outFormat));
  } finally {
    await registry.closeAll().catch(() => {});
    await registry.closeServices().catch(() => {});
  }
}

async function readStreamUtf8(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_PIPED_CONFIG_BYTES) {
      throw new Error(`Batch input exceeds ${MAX_PIPED_CONFIG_BYTES} bytes.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Execute newline-delimited queries, breakdowns, or JSON tool calls (`--batch <path|->`)
 * over a single connection session, streaming NDJSON lines (or formatted output) to stdout
 * and closing all connections when finished.
 */
export async function runCliBatch(
  registry: Registry,
  shelf: { views?: ViewDef[]; queries: SavedQuery[]; pages: PageDef[] },
  options: {
    batch: string;
    connection?: string;
    env?: string;
    allEnvs?: boolean;
    format?: string;
    inputStream?: NodeJS.ReadableStream;
  },
): Promise<void> {
  bindShelf(registry, shelf);
  try {
    const { formatCliOutput, parseCliOutputFormat } = await import('./outputFormat.js');
    let outFormat;
    try {
      outFormat = options.format === undefined ? 'ndjson' : parseCliOutputFormat(options.format);
    } catch (err) {
      console.error(`tablewalk: ${(err as Error).message}`);
      process.exitCode = 2;
      return;
    }

    let rawText: string;
    try {
      rawText =
        options.batch === '-' || options.batch === '/dev/stdin'
          ? await readStreamUtf8(options.inputStream ?? process.stdin)
          : await readFile(options.batch, 'utf8');
    } catch (err) {
      console.error(`tablewalk: could not read --batch ${options.batch}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const lines = rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('//'));

    if (!lines.length) {
      console.error('tablewalk: --batch input contains no queries or tool calls.');
      process.exitCode = 2;
      return;
    }

    const jsonCollector: Array<Record<string, unknown>> = [];
    const emitBatchEnvelope = (env: Record<string, unknown>, toolName?: string) => {
      if (outFormat === 'json') {
        jsonCollector.push(env);
        return;
      }
      if (outFormat === 'ndjson') {
        process.stdout.write(`${JSON.stringify(env)}\n`);
        return;
      }
      /* Human/LLM compact `--format tsv` or `--format md` across batch items. */
      const headerLabel = env.id !== undefined ? `[${String(env.id)}] ${toolName ?? ''}`.trim() : `#${String(env.index)}`;
      if (env.ok === false) {
        if (outFormat === 'md') {
          process.stdout.write(`### ${headerLabel}\n\n_Error (${String(env.code ?? 'error')}): ${String(env.error ?? '')}_\n\n`);
        } else {
          process.stdout.write(`# ${headerLabel}\tERROR\t${String(env.code ?? 'error')}\t${String(env.error ?? '')}\n`);
        }
        return;
      }
      const res = (env.result as Record<string, unknown>) ?? {};
      const formatted = formatCliOutput(toolName ?? '', res, outFormat);
      if (outFormat === 'md') {
        process.stdout.write(`### ${headerLabel}\n\n${formatted}\n`);
      } else {
        process.stdout.write(`# ${headerLabel}\n${formatted}`);
      }
    };

    let anyFailed = false;
    for (const [index, line] of lines.entries()) {
      let toolName = '';
      let toolArgs: Record<string, unknown> = {};
      let callId: unknown;

      if (line.startsWith('{')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          anyFailed = true;
          emitBatchEnvelope({
            index,
            ok: false,
            code: 'invalid_argument',
            error: `Invalid JSON on line ${index + 1}: ${(err as Error).message}`,
          });
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          anyFailed = true;
          emitBatchEnvelope({
            index,
            ok: false,
            code: 'invalid_argument',
            error: `Line ${index + 1} must be a JSON object or query string.`,
          });
          continue;
        }
        const rec = parsed as Record<string, unknown>;
        callId = rec.id;
        const rawArgs = rec.args ?? rec.arguments;
        if (rawArgs !== undefined) {
          if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
            anyFailed = true;
            emitBatchEnvelope({
              index,
              ...(callId !== undefined ? { id: callId } : {}),
              ok: false,
              code: 'invalid_argument',
              error: '"args" must be a JSON object.',
            });
            continue;
          }
          toolArgs = { ...(rawArgs as Record<string, unknown>) };
        }
        const namedTool =
          typeof rec.tool === 'string' ? rec.tool : typeof rec.call === 'string' ? rec.call : typeof rec.name === 'string' ? rec.name : '';
        const queryShorthand = typeof rec.query === 'string' ? rec.query : typeof rec.q === 'string' ? rec.q : '';
        if (namedTool.trim()) {
          toolName = namedTool.trim();
        } else if (queryShorthand.trim()) {
          const q = queryShorthand.trim();
          toolName = looksLikeBreakdown(q) ? 'breakdown' : 'query';
          toolArgs.q = q;
          if (rec.limit !== undefined && toolArgs.limit === undefined) toolArgs.limit = rec.limit;
          if (rec.offset !== undefined && toolArgs.offset === undefined) toolArgs.offset = rec.offset;
        } else {
          anyFailed = true;
          emitBatchEnvelope({
            index,
            ...(callId !== undefined ? { id: callId } : {}),
            ok: false,
            code: 'invalid_argument',
            error: 'Batch JSON object must specify "tool" (or "call") or "query".',
          });
          continue;
        }
        if (typeof rec.connection === 'string' && toolArgs.connection === undefined) toolArgs.connection = rec.connection;
        if (typeof rec.env === 'string' && toolArgs.env === undefined) toolArgs.env = rec.env;
        if (rec.envs !== undefined && toolArgs.envs === undefined) toolArgs.envs = rec.envs;
      } else {
        toolName = looksLikeBreakdown(line) ? 'breakdown' : 'query';
        toolArgs = { q: line };
      }

      if (options.connection && toolArgs.connection === undefined) toolArgs.connection = options.connection;
      if (options.allEnvs && toolArgs.envs === undefined && toolArgs.env === undefined) {
        toolArgs.envs = 'all';
      } else if (options.env && toolArgs.env === undefined && toolArgs.envs === undefined) {
        toolArgs.env = options.env;
      }

      const answer = await runTool(registry, toolName, toolArgs);
      if (answer.isError) {
        anyFailed = true;
        emitBatchEnvelope(
          {
            index,
            ...(callId !== undefined ? { id: callId } : {}),
            ok: false,
            tool: toolName,
            code: answer._meta?.['tablewalk/code'] ?? 'internal',
            error: answer.content[0]?.text ?? 'Tool call failed.',
          },
          toolName,
        );
      } else {
        emitBatchEnvelope(
          {
            index,
            ...(callId !== undefined ? { id: callId } : {}),
            ok: true,
            tool: toolName,
            result: answer.structuredContent ?? { text: answer.content[0]?.text ?? '' },
          },
          toolName,
        );
      }
    }

    if (outFormat === 'json') {
      process.stdout.write(`${JSON.stringify(jsonCollector, null, 2)}\n`);
    }

    if (anyFailed) process.exitCode = 1;
  } finally {
    await registry.closeAll().catch(() => {});
    await registry.closeServices().catch(() => {});
  }
}
