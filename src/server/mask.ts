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
import { findTable, referencesFrom, referencesTo, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/host';

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

function matchesExplicit(wanted: ReadonlySet<string>, table: TableMeta | undefined, column: string): boolean {
  const lower = column.toLowerCase();
  if (wanted.has(lower)) return true;
  if (!table) return false;
  return wanted.has(`${table.id.toLowerCase()}.${lower}`) || wanted.has(`${table.name.toLowerCase()}.${lower}`);
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
      const hash = fnv1a(`${salt}\0${label}\0${colName}\0${String(value)}`);
      copy[colName] = maskScalar(kind, value, hash, spec?.max);
      maskedSet.add(colName);
    }
    return copy as Row;
  });

  return { rows: out, maskedColumns: [...maskedSet] };
}
