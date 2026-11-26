/**
 * Dialect-aware SQL script utilities shared by the browser editor and the server:
 *   - Multi-statement splitting with exact source spans (for DataGrip-style caret execution and scripts)
 *   - Named parameter extraction and safe literal substitution (`:param`, `{{param}}`)
 *   - Raw SQL result export (`csv`, `json`, `markdown`, `insert`, `in`)
 *   - Result-set diffing across sibling environments and numeric column aggregates
 *
 * Pure TypeScript with zero Node or DOM dependencies so Vite bundles it into the client
 * and Node imports the exact same rules on the server.
 */

export type SqlDialect = 'postgres' | 'sqlite';

export interface SqlStatementSpan {
  /** Zero-based statement index in the script. */
  index: number;
  /** Trimmed SQL statement text (without trailing semicolon). */
  text: string;
  /** Inclusive start offset of `text` in the original buffer. */
  start: number;
  /** Exclusive end offset of `text` in the original buffer. */
  end: number;
  /** Inclusive start offset of the raw chunk (including leading whitespace/comments). */
  rawStart: number;
  /** Exclusive end offset of the raw chunk (including trailing semicolon). */
  rawEnd: number;
  /** 1-based start line of `text`. */
  startLine: number;
  /** 1-based end line of `text`. */
  endLine: number;
}

const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

function matchDollarTag(sql: string, pos: number): string | null {
  if (sql[pos] !== '$') return null;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(pos, pos + 64));
  return m ? m[0] : null;
}

function stripCommentsAndSpace(sql: string, dialect: SqlDialect): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (dialect === 'postgres' && sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    if (!/\s/.test(ch)) {
      out += ch;
    }
    i++;
  }
  return out;
}

function lineAt(sql: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, sql.length);
  for (let i = 0; i < end; i++) {
    if (sql[i] === '\n') line++;
  }
  return line;
}

/**
 * Split a SQL script into individual statements with exact character and line spans.
 * Keeps PostgreSQL dollar-quoted bodies (`$$…$$`, `$tag$…$tag$`), nested block comments,
 * `E'…'` escapes, and SQLite `CREATE TRIGGER … BEGIN … [CASE … END] … END` blocks intact.
 */
export function splitSqlStatements(sql: string, dialect: SqlDialect = 'postgres'): SqlStatementSpan[] {
  const out: SqlStatementSpan[] = [];
  let rawStart = 0;
  let i = 0;

  // SQLite trigger tracking (`CREATE [TEMP|TEMPORARY] TRIGGER ... BEGIN ... END`)
  let wordIndex = 0;
  let sawCreate = false;
  let inCreateTrigger = false;
  let triggerBlockDepth = 0;

  const resetTrigger = () => {
    wordIndex = 0;
    sawCreate = false;
    inCreateTrigger = false;
    triggerBlockDepth = 0;
  };

  const pushSlice = (sliceStart: number, sliceEnd: number, rawEnd: number) => {
    let s = sliceStart;
    let e = sliceEnd;
    while (s < e && /\s/.test(sql[s])) s++;
    while (e > s && /\s/.test(sql[e - 1])) e--;
    if (s >= e) return;
    const text = sql.slice(s, e);
    if (!stripCommentsAndSpace(text, dialect)) return;
    out.push({
      index: out.length,
      text,
      start: s,
      end: e,
      rawStart: sliceStart,
      rawEnd,
      startLine: lineAt(sql, s),
      endLine: lineAt(sql, Math.max(s, e - 1)),
    });
  };

  while (i < sql.length) {
    const ch = sql[i];

    // Single-line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }

    // Block comment (nested on Postgres)
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (dialect === 'postgres' && sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    // Postgres E'...' escape string
    if (dialect === 'postgres' && (ch === 'E' || ch === 'e') && sql[i + 1] === "'" && (i === 0 || !isIdentChar(sql[i - 1]))) {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === '\\' && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Single-quoted string or double-quoted identifier (or SQLite backtick)
    if (ch === "'" || ch === '"' || (dialect === 'sqlite' && ch === '`')) {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // SQLite bracketed identifier [...]
    if (dialect === 'sqlite' && ch === '[') {
      const close = sql.indexOf(']', i + 1);
      if (close < 0) break;
      i = close + 1;
      continue;
    }

    // Postgres dollar-quoted string
    if (dialect === 'postgres' && ch === '$') {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) {
          i = sql.length;
          break;
        }
        i = end + tag.length;
        continue;
      }
    }

    // SQLite trigger block tracking
    if (dialect === 'sqlite' && /[A-Za-z_]/.test(ch)) {
      const wordStart = i;
      while (i < sql.length && isIdentChar(sql[i])) i++;
      const word = sql.slice(wordStart, i).toUpperCase();
      if (wordIndex === 0) {
        sawCreate = word === 'CREATE';
      } else if (sawCreate && !inCreateTrigger) {
        if (word === 'TRIGGER') inCreateTrigger = true;
        else if (word !== 'TEMP' && word !== 'TEMPORARY') sawCreate = false;
      } else if (inCreateTrigger) {
        if (word === 'BEGIN' || word === 'CASE') triggerBlockDepth++;
        else if (word === 'END' && triggerBlockDepth > 0) triggerBlockDepth--;
      }
      wordIndex++;
      continue;
    }

    if (ch === ';' && triggerBlockDepth === 0) {
      pushSlice(rawStart, i, i + 1);
      rawStart = i + 1;
      resetTrigger();
      i++;
      continue;
    }

    i++;
  }

  pushSlice(rawStart, sql.length, sql.length);
  return out;
}

/**
 * Return the statement enclosing `offset` (caret position), DataGrip-style:
 *   - Inside a statement's trimmed span → that statement
 *   - On trailing whitespace/semicolon right after a statement → that statement
 *   - Between statements → the nearest preceding statement (or the first if before all)
 */
export function statementAtOffset(sql: string, offset: number, dialect: SqlDialect = 'postgres'): SqlStatementSpan | null {
  const statements = splitSqlStatements(sql, dialect);
  if (!statements.length) return null;
  if (statements.length === 1) return statements[0];
  const clamped = Math.max(0, Math.min(offset, sql.length));
  for (const stmt of statements) {
    if (clamped >= stmt.start && clamped <= stmt.rawEnd) return stmt;
  }
  for (const stmt of statements) {
    if (clamped >= stmt.rawStart && clamped <= stmt.rawEnd) return stmt;
  }
  let best = statements[0];
  for (const stmt of statements) {
    if (stmt.start <= clamped) best = stmt;
  }
  return best;
}

interface ParamToken {
  name: string;
  start: number;
  end: number;
}

/** Scan named parameters (`:param` and `{{param}}`) outside SQL strings, comments, identifiers, and `::cast`. */
function scanParameters(sql: string, dialect: SqlDialect = 'postgres'): ParamToken[] {
  const tokens: ParamToken[] = [];
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (dialect === 'postgres' && sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    if (dialect === 'postgres' && (ch === 'E' || ch === 'e') && sql[i + 1] === "'" && (i === 0 || !isIdentChar(sql[i - 1]))) {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === '\\' && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || (dialect === 'sqlite' && ch === '`')) {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (dialect === 'postgres' && ch === '$') {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) break;
        i = end + tag.length;
        continue;
      }
    }

    // {{param}}
    if (ch === '{' && sql[i + 1] === '{') {
      const m = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/.exec(sql.slice(i));
      if (m) {
        tokens.push({ name: m[1], start: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
    }

    // :param (never ::cast, and never glued to an identifier before it like foo:bar)
    if (ch === ':') {
      if (sql[i + 1] === ':') {
        i += 2;
        continue;
      }
      const prev = i > 0 ? sql[i - 1] : '';
      if (!prev || !/[A-Za-z0-9_:]/.test(prev)) {
        const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
        if (m) {
          tokens.push({ name: m[1], start: i, end: i + m[0].length });
          i += m[0].length;
          continue;
        }
      }
    }

    i++;
  }

  return tokens;
}

/** Return unique named parameters in order of first appearance. */
export function extractSqlParameters(sql: string, dialect: SqlDialect = 'postgres'): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const token of scanParameters(sql, dialect)) {
    if (!seen.has(token.name)) {
      seen.add(token.name);
      names.push(token.name);
    }
  }
  return names;
}

function sqlLiteralFor(raw: string): string {
  const trimmed = raw.trim();
  if (/^null$/i.test(trimmed)) return 'NULL';
  if (/^true$/i.test(trimmed)) return 'TRUE';
  if (/^false$/i.test(trimmed)) return 'FALSE';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    // Keep integers past 2^53 or high-precision decimals exact by keeping numeric text as-is.
    return trimmed;
  }
  return `'${raw.replace(/'/g, "''")}'`;
}

/**
 * Substitute named parameters (`:param`, `{{param}}`) outside strings, comments, and casts.
 * Any parameter missing from `values` is left untouched so callers can spot unbound names.
 */
export function substituteSqlParameters(sql: string, values: Record<string, string>, dialect: SqlDialect = 'postgres'): string {
  const tokens = scanParameters(sql, dialect);
  if (!tokens.length) return sql;
  let out = '';
  let last = 0;
  for (const token of tokens) {
    out += sql.slice(last, token.start);
    if (Object.prototype.hasOwnProperty.call(values, token.name)) {
      out += sqlLiteralFor(values[token.name]);
    } else {
      out += sql.slice(token.start, token.end);
    }
    last = token.end;
  }
  out += sql.slice(last);
  return out;
}

function sqlValueLiteral(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
  if (typeof val === 'bigint') return val.toString();
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Bind JSON-typed parameter values (`string | number | boolean | null`) into `:param` / `{{param}}`
 * placeholders (used by MCP `sql` and `export` tools). Preserves JSON types safely: numbers stay numeric,
 * booleans become TRUE/FALSE, null becomes NULL, and strings are always single-quoted and escaped.
 */
export function bindTypedSqlParameters(
  sql: string,
  params: Record<string, unknown> | undefined,
  dialect: SqlDialect = 'postgres',
): { sql: string; required: string[]; missing: string[] } {
  const tokens = scanParameters(sql, dialect);
  if (!tokens.length) return { sql, required: [], missing: [] };
  const required: string[] = [];
  const missing: string[] = [];
  const seenReq = new Set<string>();
  const seenMiss = new Set<string>();
  let out = '';
  let last = 0;

  for (const token of tokens) {
    if (!seenReq.has(token.name)) {
      seenReq.add(token.name);
      required.push(token.name);
    }
    out += sql.slice(last, token.start);
    if (params && Object.prototype.hasOwnProperty.call(params, token.name) && params[token.name] !== undefined) {
      out += sqlValueLiteral(params[token.name]);
    } else {
      if (!seenMiss.has(token.name)) {
        seenMiss.add(token.name);
        missing.push(token.name);
      }
      out += sql.slice(token.start, token.end);
    }
    last = token.end;
  }
  out += sql.slice(last);
  return { sql: out, required, missing };
}

function csvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function mdCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  return str.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export type ResultExportFormat = 'csv' | 'json' | 'markdown' | 'insert' | 'in';

/** Format raw SQL result rows for copy or file download. */
export function formatResultExport(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  format: ResultExportFormat,
  tableName = 'table_name',
): string {
  if (format === 'csv') {
    const lines = [columns.map(csvCell).join(',')];
    for (const row of rows) lines.push(columns.map((_, i) => csvCell(row[i])).join(','));
    return `${lines.join('\n')}\n`;
  }
  if (format === 'json') {
    const objs = rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null])));
    return `${JSON.stringify(objs, null, 2)}\n`;
  }
  if (format === 'markdown') {
    const head = `| ${columns.map(mdCell).join(' | ')} |`;
    const sep = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = rows.map((row) => `| ${columns.map((_, i) => mdCell(row[i])).join(' | ')} |`);
    return [head, sep, ...body].join('\n');
  }
  if (format === 'insert') {
    const colList = columns.map(quoteIdent).join(', ');
    const target = quoteIdent(tableName);
    return rows
      .map((row) => `INSERT INTO ${target} (${colList}) VALUES (${columns.map((_, i) => sqlValueLiteral(row[i])).join(', ')});`)
      .join('\n');
  }
  // 'in': unique non-null values from the first column formatted as an SQL IN (...) clause.
  const seen = new Set<string>();
  const literals: string[] = [];
  for (const row of rows) {
    const v = row[0];
    if (v === null || v === undefined) continue;
    const lit = sqlValueLiteral(v);
    if (!seen.has(lit)) {
      seen.add(lit);
      literals.push(lit);
    }
  }
  return `(${literals.join(', ')})`;
}

export interface ColumnAggregate {
  column: string;
  count: number;
  nonNull: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

/** Compute client-side summary aggregates for numeric columns in a result page. */
export function computeColumnAggregates(columns: readonly string[], rows: readonly (readonly unknown[])[]): ColumnAggregate[] {
  if (!rows.length) return [];
  const out: ColumnAggregate[] = [];
  for (let c = 0; c < columns.length; c++) {
    let nonNull = 0;
    let numeric = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const row of rows) {
      const v = row[c];
      if (v === null || v === undefined || v === '') continue;
      nonNull++;
      const num = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
      if (Number.isFinite(num) && Math.abs(num) <= Number.MAX_SAFE_INTEGER) {
        numeric++;
        sum += num;
        if (num < min) min = num;
        if (num > max) max = num;
      }
    }
    if (nonNull > 0 && numeric === nonNull) {
      out.push({
        column: columns[c],
        count: rows.length,
        nonNull,
        sum,
        avg: sum / numeric,
        min,
        max,
      });
    }
  }
  return out;
}

export interface ResultSetDiffRow {
  key: string;
  status: 'added' | 'removed' | 'changed';
  left?: Record<string, unknown>;
  right?: Record<string, unknown>;
  diffColumns: string[];
}

export interface ResultSetDiff {
  columns: string[];
  keyColumn: string | null;
  rows: ResultSetDiffRow[];
  unchangedCount: number;
}

/**
 * Diff two SQL result sets side-by-side (e.g., Compare envs `local` vs `prod`).
 * Keys rows by the first shared `id` column if unique in both sets, else by positional row index.
 */
export function diffResultSets(
  left: { columns: readonly string[]; rows: readonly (readonly unknown[])[] },
  right: { columns: readonly string[]; rows: readonly (readonly unknown[])[] },
): ResultSetDiff {
  const columns = [...new Set([...left.columns, ...right.columns])];
  const leftObjs = left.rows.map((r) => Object.fromEntries(left.columns.map((c, i) => [c, r[i] ?? null])));
  const rightObjs = right.rows.map((r) => Object.fromEntries(right.columns.map((c, i) => [c, r[i] ?? null])));

  const shared = left.columns.filter((c) => right.columns.includes(c));
  const candidate = shared.find((c) => /^id$/i.test(c)) ?? shared[0] ?? null;
  const uniqueIn = (list: Record<string, unknown>[], col: string) => {
    const s = new Set<string>();
    for (const row of list) {
      const v = row[col];
      if (v === null || v === undefined) return false;
      const k = String(v);
      if (s.has(k)) return false;
      s.add(k);
    }
    return true;
  };
  const keyColumn = candidate && uniqueIn(leftObjs, candidate) && uniqueIn(rightObjs, candidate) ? candidate : null;

  const keyFor = (row: Record<string, unknown>, idx: number) => (keyColumn ? String(row[keyColumn]) : `#${idx + 1}`);
  const leftMap = new Map<string, Record<string, unknown>>();
  const rightMap = new Map<string, Record<string, unknown>>();
  leftObjs.forEach((r, i) => leftMap.set(keyFor(r, i), r));
  rightObjs.forEach((r, i) => rightMap.set(keyFor(r, i), r));

  const allKeys = [...new Set([...leftMap.keys(), ...rightMap.keys()])];
  const diffRows: ResultSetDiffRow[] = [];
  let unchangedCount = 0;

  for (const key of allKeys) {
    const l = leftMap.get(key);
    const r = rightMap.get(key);
    if (l && !r) {
      diffRows.push({ key, status: 'removed', left: l, diffColumns: columns });
    } else if (!l && r) {
      diffRows.push({ key, status: 'added', right: r, diffColumns: columns });
    } else if (l && r) {
      const diffCols = columns.filter((c) => JSON.stringify(l[c] ?? null) !== JSON.stringify(r[c] ?? null));
      if (diffCols.length > 0) {
        diffRows.push({ key, status: 'changed', left: l, right: r, diffColumns: diffCols });
      } else {
        unchangedCount++;
      }
    }
  }

  return { columns, keyColumn, rows: diffRows, unchangedCount };
}
