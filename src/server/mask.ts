/**
 * Deterministic relational masking for `fixture` and `export`.
 *
 * Replacing every string with `"[REDACTED]"` breaks the two things a database
 * extract is taken for: a `UNIQUE` column (`email`) rejects the second row, a
 * `CHECK` or format expectation (`email LIKE '%@%'`, `varchar(12)`) rejects the
 * first, and a masked foreign key (`country_code`) leaves children pointing at
 * nothing. So masking here is a function of `(table, column, value)` and the
 * catalog: primary keys, foreign-key endpoints and `CHECK` vocabularies stay
 * as stored, nulls stay null, and distinct inputs map to distinct synthetic
 * values of the right shape and length.
 */
import {
  Refusal,
  findTable,
  referencesFrom,
  referencesTo,
  type Adapter,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/host';
import { type BreakdownResult, type ProfileResult, type ViewResult } from '@mistriwork/engine/adapters/adapter.js';
import { lendWriteView, writeViewOf } from '@mistriwork/engine/adapters/storeHost.js';
import { tryResolvePath } from '@mistriwork/engine/shared/view.js';

type ColumnMeta = TableMeta['columns'][number];

export interface MaskOptions {
  /** Additional column names (bare `notes` or qualified `invoice.notes`) to mask. */
  columns?: readonly string[];
  /** Per-call salt when non-linkable output across runs is wanted; fixed by default for deterministic tests. */
  salt?: string;
}

const DEFAULT_SALT = 'tablewalk-redact-v1';

const SECRET_COL =
  /(password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|auth[_-]?code|hash|salt|ssn|tax[_-]?id|iban|routing|card[_-]?num|cvv)/i;
const EMAIL_COL = /(^|_)(e?_?mail)(_|$)/i;
const PHONE_COL = /(^|_)(phone|mobile|cell|fax|tel|telephone|sms|whatsapp)(_|$)/i;
const PERSON_NAME_COL =
  /(^|_)(first[_-]?name|last[_-]?name|full[_-]?name|given[_-]?name|family[_-]?name|surname|middle[_-]?name|contact[_-]?name|display[_-]?name|username|login|handle)(_|$)/i;
const PERSON_TABLE =
  /(user|account|customer|client|person|people|employee|staff|member|contact|patient|student|author|profile|lead|subscriber|guest|applicant)/i;
const ADDRESS_COL = /(^|_)(address|address[_-]?\d|street|line1|line2|apt|suite)(_|$)/i;
const POSTAL_COL = /(^|_)(postal|postal[_-]?code|zip|zip[_-]?code|postcode)(_|$)/i;
const IP_COL = /(^|_)(ip|ip[_-]?address|client[_-]?ip|remote[_-]?ip|source[_-]?ip)(_|$)/i;
const DOB_COL = /(^|_)(dob|date[_-]?of[_-]?birth|birth[_-]?date|birthday)(_|$)/i;
const FREE_TEXT_PII_COL = /(^|_)(notes?|comment|body|message|bio|user[_-]?agent)(_|$)/i;

const EMAIL_VALUE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@.]{2,}$/;

const FIRST_NAMES = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Cameron', 'Drew'];
const LAST_NAMES = ['Rivera', 'chen', 'Patel', 'Kim', 'Silva', 'Novak', 'Costa', 'brooks', 'Hayes', 'Reed', 'ellis', 'Stone'].map(
  (s) => s[0].toUpperCase() + s.slice(1),
);

/** FNV-1a 32-bit digest: fast, synchronous, deterministic across platforms. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, '0');
}

function fitMax(value: string, max: number | undefined, fallbackPrefix: string, hash: number): string {
  if (max === undefined || max <= 0 || value.length <= max) return value;
  const compact = `${fallbackPrefix}${hex8(hash)}`;
  if (compact.length <= max) return compact;
  return hex8(hash).slice(0, max);
}

/** Columns whose values participate in primary keys or foreign-key joins on `table`. */
function structuralColumns(schema: DatabaseSchema, table: TableMeta): Set<string> {
  const locked = new Set<string>();
  for (const col of table.columns) {
    if (col.primaryKey) locked.add(col.name);
  }
  for (const fk of referencesFrom(schema, table.id)) {
    for (const c of fk.from.columns) locked.add(c);
  }
  for (const fk of referencesTo(schema, table.id)) {
    for (const c of fk.to.columns) locked.add(c);
  }
  return locked;
}

function tableHasPiiPeer(table: TableMeta): boolean {
  return table.columns.some(
    (c) =>
      EMAIL_COL.test(c.name) ||
      PHONE_COL.test(c.name) ||
      SECRET_COL.test(c.name) ||
      PERSON_NAME_COL.test(c.name) ||
      ADDRESS_COL.test(c.name),
  );
}

type MaskKind = 'secret' | 'email' | 'phone' | 'first_name' | 'last_name' | 'full_name' | 'address' | 'postal' | 'ip' | 'dob' | 'text';

function classifyColumn(
  table: TableMeta,
  col: ColumnMeta | undefined,
  colName: string,
  explicit: boolean,
  peerPii: boolean,
): MaskKind | null {
  if (col?.allowed?.length) return null;
  if (EMAIL_COL.test(colName)) return 'email';
  if (SECRET_COL.test(colName)) return 'secret';
  if (PHONE_COL.test(colName)) return 'phone';
  if (/first[_-]?name|given[_-]?name/i.test(colName)) return 'first_name';
  if (/last[_-]?name|family[_-]?name|surname/i.test(colName)) return 'last_name';
  if (PERSON_NAME_COL.test(colName)) return 'full_name';
  if (/^name$/i.test(colName) && (PERSON_TABLE.test(table.name) || peerPii)) return 'full_name';
  if (ADDRESS_COL.test(colName)) return 'address';
  if (POSTAL_COL.test(colName)) return 'postal';
  if (IP_COL.test(colName)) return 'ip';
  if (DOB_COL.test(colName)) return 'dob';
  if (FREE_TEXT_PII_COL.test(colName)) return 'text';
  if (explicit) return 'text';
  return null;
}

function maskScalar(kind: MaskKind, value: unknown, hash: number, max: number | undefined): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (kind === 'secret' || kind === 'phone' || kind === 'postal') return 100_000 + (hash % 900_000);
    return value;
  }
  if (typeof value === 'bigint') {
    if (kind === 'secret' || kind === 'phone' || kind === 'postal') return BigInt(100_000 + (hash % 900_000));
    return value;
  }
  if (value instanceof Uint8Array) {
    const out = new Uint8Array(Math.min(value.length, 8));
    for (let i = 0; i < out.length; i++) out[i] = (hash >>> ((i % 4) * 8)) & 0xff;
    return out;
  }
  if (value instanceof Date) {
    if (kind === 'dob') return new Date(Date.UTC(1970 + (hash % 35), hash % 12, 1 + (hash % 28)));
    return value;
  }
  if (typeof value === 'object') {
    return maskJsonObject(value, hash);
  }

  const raw = String(value);
  if (raw === '') return '';
  const hex = hex8(hash);
  switch (kind) {
    case 'email': {
      const full = `user-${hex}@example.com`;
      if (max !== undefined && max < full.length) {
        const short = `u${hex.slice(0, Math.max(1, max - 8))}@x.test`;
        return short.length <= max ? short : hex.slice(0, max);
      }
      return full;
    }
    case 'phone': {
      const line = String(100 + (hash % 900));
      const tail = String(1000 + ((hash >>> 10) % 9000));
      return fitMax(`+1-555-0${line.slice(0, 2)}-${tail}`, max, '555', hash);
    }
    case 'first_name': {
      const picked = `${FIRST_NAMES[hash % FIRST_NAMES.length]} ${hex.slice(0, 4)}`;
      return fitMax(picked, max, 'P', hash);
    }
    case 'last_name': {
      const picked = `${LAST_NAMES[hash % LAST_NAMES.length]}-${hex.slice(0, 4)}`;
      return fitMax(picked, max, 'L', hash);
    }
    case 'full_name': {
      const first = FIRST_NAMES[hash % FIRST_NAMES.length];
      const last = LAST_NAMES[(hash >>> 5) % LAST_NAMES.length];
      return fitMax(`${first} ${last} (${hex.slice(0, 4)})`, max, `${first} `, hash);
    }
    case 'address':
      return fitMax(`${100 + (hash % 899)} Example St #${hex.slice(0, 4)}`, max, 'Addr-', hash);
    case 'postal':
      return fitMax(`00${String(100 + (hash % 899))}`, max, '0', hash);
    case 'ip':
      return fitMax(`192.0.2.${1 + (hash % 254)}`, max, '0.0.0.', hash);
    case 'dob': {
      const year = 1970 + (hash % 35);
      const month = String(1 + (hash % 12)).padStart(2, '0');
      const day = String(1 + (hash % 28)).padStart(2, '0');
      return fitMax(`${year}-${month}-${day}`, max, `${year}`, hash);
    }
    case 'secret':
      return fitMax(`redacted-${hex}`, max, 'r-', hash);
    case 'text':
      return fitMax(`Redacted ${hex}`, max, 'r-', hash);
  }
}

function maskJsonObject(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((item, i) => maskJsonObject(item, (seed + i + 1) >>> 0));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && EMAIL_VALUE.test(value)) return `user-${hex8(fnv1a(`${seed}:${value}`))}@example.com`;
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const h = fnv1a(`${seed}:${k}:${typeof v === 'string' ? v : ''}`);
    if (v === null || v === undefined) out[k] = v;
    else if (typeof v === 'object') out[k] = maskJsonObject(v, h);
    else if (EMAIL_COL.test(k) || (typeof v === 'string' && EMAIL_VALUE.test(v))) out[k] = `user-${hex8(h)}@example.com`;
    else if (SECRET_COL.test(k)) out[k] = `redacted-${hex8(h)}`;
    else if (PHONE_COL.test(k)) out[k] = `+1-555-01${String(10 + (h % 89))}`;
    else if (PERSON_NAME_COL.test(k) || ADDRESS_COL.test(k)) out[k] = `Redacted ${hex8(h).slice(0, 6)}`;
    else out[k] = v;
  }
  return out;
}

const ALREADY_MASKED: Record<MaskKind, RegExp> = {
  email: /^user-[0-9a-f]{8}@example\.com$/,
  phone: /^\+1-555-0\d{2}-\d{4}$/,
  first_name: /^(?:Alex|Sam|Jordan|Taylor|Morgan|Casey|Riley|Jamie|Avery|Quinn|Cameron|Drew) [0-9a-f]{4}$/,
  last_name: /^(?:Rivera|Chen|Patel|Kim|Silva|Novak|Costa|Brooks|Hayes|Reed|Ellis|Stone)-[0-9a-f]{4}$/,
  full_name:
    /^(?:Alex|Sam|Jordan|Taylor|Morgan|Casey|Riley|Jamie|Avery|Quinn|Cameron|Drew) (?:Rivera|Chen|Patel|Kim|Silva|Novak|Costa|Brooks|Hayes|Reed|Ellis|Stone) \([0-9a-f]{4}\)$/,
  address: /^\d{3} Example St #[0-9a-f]{4}$/,
  postal: /^00\d{3}$/,
  ip: /^192\.0\.2\.\d{1,3}$/,
  dob: /^\d{4}-\d{2}-\d{2}$/,
  secret: /^redacted-[0-9a-f]{8}$/,
  text: /^Redacted [0-9a-f]{8}$/,
};

function isAlreadyMasked(kind: MaskKind, value: unknown): boolean {
  if (typeof value !== 'string' || kind === 'dob') return false;
  return ALREADY_MASKED[kind].test(value);
}

function matchesExplicit(wanted: ReadonlySet<string>, table: TableMeta | undefined, column: string): boolean {
  const lower = column.toLowerCase();
  if (wanted.has(lower)) return true;
  if (!table) return false;
  return wanted.has(`${table.id.toLowerCase()}.${lower}`) || wanted.has(`${table.name.toLowerCase()}.${lower}`);
}

/**
 * Compute the catalog columns deterministically masked on each table when `"redact": true` is active.
 * Excludes primary keys, foreign-key join endpoints, and constrained enum/CHECK vocabularies.
 */
export function redactedColumnsByTable(schema: DatabaseSchema, options: MaskOptions = {}): Record<string, string[]> {
  const wanted = new Set((options.columns ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  const out: Record<string, string[]> = {};
  for (const table of schema.tables) {
    const locked = structuralColumns(schema, table);
    const peerPii = tableHasPiiPeer(table);
    const cols: string[] = [];
    for (const col of table.columns) {
      if (locked.has(col.name)) continue;
      const explicit = matchesExplicit(wanted, table, col.name);
      if (classifyColumn(table, col, col.name, explicit, peerPii)) {
        cols.push(col.name);
      }
    }
    if (cols.length) {
      out[table.id] = cols;
      if (table.name !== table.id && !out[table.name]) out[table.name] = cols;
    }
  }
  return out;
}

/**
 * Mask a batch of rows for `tableId` (or an untyped SQL/view result when `tableId` is absent or unknown).
 * Returns the masked rows and the column names that were masked.
 */
export function maskTableRows<Row extends Record<string, unknown>>(
  schema: DatabaseSchema,
  tableId: string | undefined,
  rows: readonly Row[],
  options: MaskOptions = {},
): { rows: Row[]; maskedColumns: string[] } {
  if (!rows.length) return { rows: [], maskedColumns: [] };
  const table = tableId ? findTable(schema, tableId) : undefined;
  const locked = table ? structuralColumns(schema, table) : new Set<string>();
  const peerPii = table ? tableHasPiiPeer(table) : false;
  const wanted = new Set((options.columns ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  const salt = options.salt ?? DEFAULT_SALT;
  const label = table?.id ?? tableId ?? 'result';

  const colMap = new Map<string, ColumnMeta>();
  for (const col of table?.columns ?? []) colMap.set(col.name, col);

  const maskedSet = new Set<string>();
  const plan = new Map<string, { kind: MaskKind | 'auto'; max?: number }>();

  const sampleKeys = new Set<string>();
  for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) sampleKeys.add(k);
  for (const col of table?.columns ?? []) sampleKeys.add(col.name);

  for (const colName of sampleKeys) {
    if (locked.has(colName)) continue;
    /* Without a resolved table (e.g. raw SQL / multi-table view), avoid masking obvious key columns like `id` or `*_id`. */
    if (!table && /(^id$|_id$)/i.test(colName) && !matchesExplicit(wanted, undefined, colName)) continue;
    const meta = colMap.get(colName);
    const explicit = matchesExplicit(wanted, table, colName);
    const kind = classifyColumn(
      table ?? ({ id: label, name: label, columns: [] } as unknown as TableMeta),
      meta,
      colName,
      explicit,
      peerPii,
    );
    if (kind) plan.set(colName, { kind, max: meta?.text?.max });
    else if (!meta?.allowed?.length) plan.set(colName, { kind: 'auto', max: meta?.text?.max });
  }

  const out = rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const [colName, value] of Object.entries(row)) {
      if (value === null || value === undefined || locked.has(colName)) continue;
      const spec = plan.get(colName);
      let kind: MaskKind | null = spec?.kind === 'auto' || !spec ? null : spec.kind;
      /* Value-level fallback: an email address or JSON object holding PII in an unrecognised column still gets scrubbed. */
      if (!kind && typeof value === 'string' && EMAIL_VALUE.test(value) && !colMap.get(colName)?.allowed?.length) {
        kind = 'email';
      } else if (!kind && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Uint8Array)) {
        const scrubbed = maskJsonObject(value, fnv1a(`${salt}\0${label}\0${colName}`));
        if (JSON.stringify(scrubbed) !== JSON.stringify(value)) {
          copy[colName] = scrubbed;
          maskedSet.add(colName);
        }
        continue;
      }
      if (!kind) continue;
      if (isAlreadyMasked(kind, value)) {
        maskedSet.add(colName);
        continue;
      }
      const hash = fnv1a(`${salt}\0${label}\0${colName}\0${String(value)}`);
      copy[colName] = maskScalar(kind, value, hash, spec?.max);
      maskedSet.add(colName);
    }
    return copy as Row;
  });

  return { rows: out, maskedColumns: [...maskedSet] };
}

/**
 * Mask a compiled multi-table `ViewResult` using each output column's resolved
 * `(table, column)` origin so joined foreign-key paths receive the exact same
 * deterministic tokens as single-table reads.
 */
export function maskViewResult(schema: DatabaseSchema, result: ViewResult, options: MaskOptions = {}): ViewResult {
  if (!result.rows.length) return result;
  const wanted = new Set((options.columns ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  const salt = options.salt ?? DEFAULT_SALT;

  interface ViewColPlan {
    tableLabel: string;
    colLabel: string;
    locked: boolean;
    allowed: boolean;
    kind: MaskKind | null;
    max?: number;
  }

  const lockedCache = new Map<string, Set<string>>();
  const peerCache = new Map<string, boolean>();
  const getLocked = (t: TableMeta) => {
    let s = lockedCache.get(t.id);
    if (!s) lockedCache.set(t.id, (s = structuralColumns(schema, t)));
    return s;
  };
  const getPeer = (t: TableMeta) => {
    let p = peerCache.get(t.id);
    if (p === undefined) peerCache.set(t.id, (p = tableHasPiiPeer(t)));
    return p;
  };

  const plan = new Map<string, ViewColPlan>();
  for (const col of result.resolved ?? []) {
    if (col.aggregate && col.aggregate !== 'latest' && col.aggregate !== 'min' && col.aggregate !== 'max') {
      plan.set(col.name, { tableLabel: col.table, colLabel: col.column, locked: true, allowed: false, kind: null });
      continue;
    }
    const table = findTable(schema, col.table);
    const meta = table?.columns.find((c) => c.name === col.column);
    const locked = table ? getLocked(table).has(col.column) : false;
    const explicit = matchesExplicit(wanted, table, col.column) || wanted.has(col.name.toLowerCase()) || wanted.has(col.path.toLowerCase());
    const kind = locked
      ? null
      : classifyColumn(
          table ?? ({ id: col.table, name: col.table, columns: [] } as unknown as TableMeta),
          meta,
          col.column,
          explicit,
          table ? getPeer(table) : false,
        );
    plan.set(col.name, {
      tableLabel: table?.id ?? col.table,
      colLabel: col.column,
      locked,
      allowed: Boolean(meta?.allowed?.length),
      kind,
      max: meta?.text?.max,
    });
  }

  const rows = result.rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const [outName, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue;
      const spec = plan.get(outName);
      if (spec?.locked) continue;
      const tableLabel = spec?.tableLabel ?? 'view';
      const colLabel = spec?.colLabel ?? outName;
      let kind = spec?.kind ?? null;
      if (!kind && typeof value === 'string' && EMAIL_VALUE.test(value) && !spec?.allowed) {
        kind = 'email';
      } else if (!kind && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Uint8Array)) {
        copy[outName] = maskJsonObject(value, fnv1a(`${salt}\0${tableLabel}\0${colLabel}`));
        continue;
      }
      if (!kind || isAlreadyMasked(kind, value)) continue;
      const hash = fnv1a(`${salt}\0${tableLabel}\0${colLabel}\0${String(value)}`);
      copy[outName] = maskScalar(kind, value, hash, spec?.max);
    }
    return copy;
  });

  return { ...result, rows };
}

/**
 * Mask group keys, reference labels, and `min`/`max` measures in a `BreakdownResult`.
 */
export function maskBreakdownResult(
  schema: DatabaseSchema,
  baseTableId: string,
  result: BreakdownResult,
  options: MaskOptions = {},
): BreakdownResult {
  if (!result.rows.length) return result;
  const baseTable = findTable(schema, baseTableId);
  const wanted = new Set((options.columns ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  const salt = options.salt ?? DEFAULT_SALT;

  const plan = new Map<
    string,
    { tableLabel: string; colLabel: string; locked: boolean; allowed: boolean; kind: MaskKind | null; max?: number }
  >();
  for (const m of result.resolved ?? []) {
    const canHoldValue =
      (m.kind === 'key' && !m.bucket) || m.kind === 'label' || (m.kind === 'measure' && (m.fn === 'min' || m.fn === 'max'));
    if (!canHoldValue) {
      plan.set(m.name, { tableLabel: baseTableId, colLabel: m.name, locked: true, allowed: false, kind: null });
      continue;
    }
    const resolved = baseTable && m.path ? tryResolvePath(schema, baseTable.id, m.path).resolved : undefined;
    const targetTable = resolved ? findTable(schema, resolved.table.id) : baseTable;
    const colName = resolved?.column.name ?? m.path?.split('.').at(-1) ?? m.name;
    const colMeta = resolved?.column ?? targetTable?.columns.find((c) => c.name === colName);
    const locked = targetTable ? structuralColumns(schema, targetTable).has(colName) : false;
    const explicit =
      matchesExplicit(wanted, targetTable, colName) ||
      wanted.has(m.name.toLowerCase()) ||
      (m.path ? wanted.has(m.path.toLowerCase()) : false);
    const kind = locked
      ? null
      : classifyColumn(
          targetTable ?? ({ id: baseTableId, name: baseTableId, columns: [] } as unknown as TableMeta),
          colMeta,
          colName,
          explicit,
          targetTable ? tableHasPiiPeer(targetTable) : false,
        );
    plan.set(m.name, {
      tableLabel: targetTable?.id ?? baseTableId,
      colLabel: colName,
      locked,
      allowed: Boolean(colMeta?.allowed?.length),
      kind,
      max: colMeta?.text?.max,
    });
  }

  const rows = result.rows.map((row) => {
    const copy: Record<string, unknown> = { ...row };
    for (const [outName, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue;
      const spec = plan.get(outName);
      if (spec?.locked) continue;
      const tableLabel = spec?.tableLabel ?? baseTableId;
      const colLabel = spec?.colLabel ?? outName;
      let kind = spec?.kind ?? null;
      if (!kind && typeof value === 'string' && EMAIL_VALUE.test(value) && !spec?.allowed) {
        kind = 'email';
      }
      if (!kind || isAlreadyMasked(kind, value)) continue;
      const hash = fnv1a(`${salt}\0${tableLabel}\0${colLabel}\0${String(value)}`);
      copy[outName] = maskScalar(kind, value, hash, spec?.max);
    }
    return copy;
  });

  return { ...result, rows };
}

/**
 * Scrub `min`, `max`, and `common` samples on sensitive columns in a `ProfileResult`.
 */
export function maskProfileResult(schema: DatabaseSchema, result: ProfileResult, options: MaskOptions = {}): ProfileResult {
  const table = findTable(schema, result.table);
  const locked = table ? structuralColumns(schema, table) : new Set<string>();
  const peerPii = table ? tableHasPiiPeer(table) : false;
  const wanted = new Set((options.columns ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
  const salt = options.salt ?? DEFAULT_SALT;
  const label = table?.id ?? result.table;

  let anyScrubbed = false;
  const columns = result.columns.map((colProfile) => {
    if (locked.has(colProfile.column)) return colProfile;
    const meta = table?.columns.find((c) => c.name === colProfile.column);
    const explicit = matchesExplicit(wanted, table, colProfile.column);
    const kind = classifyColumn(
      table ?? ({ id: label, name: label, columns: [] } as unknown as TableMeta),
      meta,
      colProfile.column,
      explicit,
      peerPii,
    );
    if (!kind) return colProfile;
    anyScrubbed = true;
    const { min: _min, max: _max, common, ...rest } = colProfile;
    return {
      ...rest,
      ...(common
        ? {
            common: common.map((item) => ({
              frac: item.frac,
              value:
                item.value === null || item.value === undefined || isAlreadyMasked(kind, item.value)
                  ? item.value
                  : maskScalar(kind, item.value, fnv1a(`${salt}\0${label}\0${colProfile.column}\0${String(item.value)}`), meta?.text?.max),
            })),
          }
        : {}),
    };
  });

  return {
    ...result,
    columns,
    ...(anyScrubbed && !result.redacted ? { redacted: 'Sensitive column samples are deterministically masked on this connection.' } : {}),
  };
}

/**
 * Wrap an `Adapter` so every row-bearing read (`query`, `runView`, `runBreakdown`,
 * `scopeReads`, `profile`, and write readbacks) deterministically masks PII,
 * secrets, and `options.columns`, while refusing raw SQL and EXPLAIN.
 */
export function applyRedaction(
  adapter: Adapter,
  introspected: DatabaseSchema,
  name: string,
  options: MaskOptions = {},
): { adapter: Adapter; schema: DatabaseSchema } {
  let currentSchema = introspected;
  const refusedSql = (what: string) =>
    new Refusal(
      `"${name}" masks sensitive columns ("redact": true): ${what}. ` +
        'Use `query`, `breakdown`, `record`, `export`, or a configured `view` instead.',
    );

  const maskTx = <Tx extends (Parameters<NonNullable<Adapter['transaction']>>[0] extends (tx: infer T) => unknown ? T : never)>(
    tx: Tx,
  ): Tx =>
    ({
      ...(tx.lockRecord ? { lockRecord: tx.lockRecord.bind(tx) } : {}),
      query: async (request) => {
        const res = await tx.query(request);
        return { ...res, rows: maskTableRows(currentSchema, request.table, res.rows, options).rows };
      },
      count: tx.count.bind(tx),
      ...(tx.aggregate ? { aggregate: tx.aggregate.bind(tx) } : {}),
      insert: async (request) => {
        const res = await tx.insert(request);
        return res.row ? { ...res, row: maskTableRows(currentSchema, request.table, [res.row], options).rows[0] } : res;
      },
      update: tx.update.bind(tx),
      remove: tx.remove.bind(tx),
      ...(tx.tell ? { tell: tx.tell.bind(tx) } : {}),
      ...(tx.noted ? { noted: tx.noted.bind(tx) } : {}),
    }) as Tx;

  const wrapped: Adapter = {
    dialect: adapter.dialect,
    close: adapter.close.bind(adapter),
    introspect: async () => {
      currentSchema = await adapter.introspect();
      return currentSchema;
    },
    query: async (request) => {
      const res = await adapter.query(request);
      return { ...res, rows: maskTableRows(currentSchema, request.table, res.rows, options).rows };
    },
    count: adapter.count.bind(adapter),
  };

  if (adapter.poolStats) wrapped.poolStats = adapter.poolStats.bind(adapter);
  if (adapter.estimateCount) wrapped.estimateCount = adapter.estimateCount.bind(adapter);
  if (adapter.countEach) wrapped.countEach = adapter.countEach.bind(adapter);
  if (adapter.runView) {
    const runView = adapter.runView.bind(adapter);
    wrapped.runView = async (view, offset) => maskViewResult(currentSchema, await runView(view, offset), options);
  }
  if (adapter.countView) wrapped.countView = adapter.countView.bind(adapter);
  if (adapter.runBreakdown) {
    const runBreakdown = adapter.runBreakdown.bind(adapter);
    wrapped.runBreakdown = async (def, offset) => maskBreakdownResult(currentSchema, def.base, await runBreakdown(def, offset), options);
  }
  if (adapter.countBreakdown) wrapped.countBreakdown = adapter.countBreakdown.bind(adapter);
  if (adapter.aggregate) wrapped.aggregate = adapter.aggregate.bind(adapter);
  if (adapter.scopeReads) {
    const scopeReads = adapter.scopeReads.bind(adapter);
    wrapped.scopeReads = async (scope) => {
      const bound = await scopeReads(scope);
      return {
        query: async (request) => {
          const res = await bound.query(request);
          return { ...res, rows: maskTableRows(currentSchema, request.table, res.rows, options).rows };
        },
        count: bound.count.bind(bound),
        runView: async (view, offset) => maskViewResult(currentSchema, await bound.runView(view, offset), options),
        countView: bound.countView.bind(bound),
        runBreakdown: async (def, offset) => maskBreakdownResult(currentSchema, def.base, await bound.runBreakdown(def, offset), options),
        countBreakdown: bound.countBreakdown.bind(bound),
        ...(bound.aggregate ? { aggregate: bound.aggregate.bind(bound) } : {}),
        ...(bound.countEach ? { countEach: bound.countEach.bind(bound) } : {}),
      };
    };
  }
  if (adapter.runSql) {
    wrapped.runSql = async () => {
      throw refusedSql('raw SQL is refused because arbitrary projections can alias around column masking');
    };
  }
  if (adapter.explainSql) {
    wrapped.explainSql = async () => {
      throw refusedSql('explaining raw SQL is refused when connection masking is active');
    };
  }
  if (adapter.ddl) wrapped.ddl = adapter.ddl.bind(adapter);
  if (adapter.profile) {
    const profile = adapter.profile.bind(adapter);
    wrapped.profile = async (table, limits) => maskProfileResult(currentSchema, await profile(table, limits), options);
  }
  if (adapter.insert) {
    const insert = adapter.insert.bind(adapter);
    wrapped.insert = async (request) => {
      const res = await insert(request);
      return res.row ? { ...res, row: maskTableRows(currentSchema, request.table, [res.row], options).rows[0] } : res;
    };
  }
  if (adapter.update) wrapped.update = adapter.update.bind(adapter);
  if (adapter.remove) wrapped.remove = adapter.remove.bind(adapter);
  if (adapter.transaction) {
    const txFn = adapter.transaction.bind(adapter);
    wrapped.transaction = (run) => txFn((tx) => run(maskTx(tx)));
  }
  if (adapter.scopeTransaction) {
    const scopeTx = adapter.scopeTransaction.bind(adapter);
    wrapped.scopeTransaction = (scope, run) => scopeTx(scope, (tx, catalog) => run(maskTx(tx), catalog));
  }

  const innerView = writeViewOf(adapter);
  lendWriteView(wrapped, {
    over: innerView ? innerView.over : adapter,
    records: (records) => maskTx(innerView ? innerView.records(records) : records),
    catalog: (catalog) => (innerView ? innerView.catalog(catalog) : catalog),
  });

  return { adapter: wrapped, schema: currentSchema };
}
