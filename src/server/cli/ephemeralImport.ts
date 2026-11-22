/**
 * Hydrate an ephemeral read-only SQLite database from a `.sql` schema/seed dump,
 * a `.csv` / `.tsv` / `.ndjson` / `.jsonl` dataset, or a directory containing them.
 *
 * Loaded dynamically by `browserMain.ts` ONLY when a user passes a static file or
 * directory target, so ordinary SQLite/PostgreSQL startups pay zero import cost.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const IMPORTABLE_EXT = /\.(?:sql|csv|tsv|ndjson|jsonl)$/i;
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

export interface EphemeralImportResult {
  dbPath: string;
  label: string;
  tableCount: number;
  fkCount: number;
  cleanup: () => void;
}

/** Fast check before importing this module or touching disk when obviously a DB URL or SQLite file. */
export function maybeStaticImportTarget(raw: string | undefined): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed || /^(?:postgres(?:ql)?:|mysql:|mariadb:|sqlite:|file:|https?:)/i.test(trimmed)) return false;
  if (/\.(?:db|sqlite|sqlite3)$/i.test(trimmed)) return false;
  if (IMPORTABLE_EXT.test(trimmed)) return true;
  try {
    return statSync(trimmed, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sanitizeIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `t_${cleaned}` : cleaned;
}

/** Parse RFC-4180 CSV or TSV text into rows of string cells. */
export function parseDelimitedText(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const len = text.length;
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (let i = start; i < len; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

interface ParsedDatasetTable {
  tableName: string;
  columns: Array<{ name: string; sqlType: 'INTEGER' | 'REAL' | 'TEXT'; uniqueNonNull: boolean }>;
  rows: Array<Array<string | number | bigint | null>>;
  pkValues?: Set<string>;
}

function inferDatasetTable(
  tableName: string,
  headers: string[],
  rawRows: Array<Record<string, unknown> | string[]>,
  fromObjects: boolean,
): ParsedDatasetTable {
  const seenNames = new Set<string>();
  const colNames = headers.map((h, idx) => {
    const base = sanitizeIdentifier(h, `col_${idx + 1}`);
    let candidate = base;
    let suffix = 2;
    while (seenNames.has(candidate.toLowerCase())) {
      candidate = `${base}_${suffix++}`;
    }
    seenNames.add(candidate.toLowerCase());
    return candidate;
  });

  const colCount = colNames.length;
  const isInt = Array.from({ length: colCount }, () => true);
  const isReal = Array.from({ length: colCount }, () => true);
  const sawNonNull = Array.from({ length: colCount }, () => false);
  const sawNull = Array.from({ length: colCount }, () => false);
  const seenVals = colNames.map((_, idx) => (idx === 0 || colNames[idx].toLowerCase() === 'id' ? new Set<string>() : null));
  const duplicateVals = Array.from({ length: colCount }, () => false);

  const typedRows: Array<Array<string | number | bigint | null>> = [];

  for (const rawRow of rawRows) {
    const outRow = Array.from<unknown, string | number | bigint | null>({ length: colCount }, () => null);
    for (let c = 0; c < colCount; c++) {
      const rawVal = fromObjects ? (rawRow as Record<string, unknown>)[headers[c]] : (rawRow as string[])[c];
      if (rawVal === undefined || rawVal === null || rawVal === '') {
        sawNull[c] = true;
        outRow[c] = null;
        continue;
      }
      sawNonNull[c] = true;
      if (typeof rawVal === 'number') {
        if (!Number.isInteger(rawVal)) isInt[c] = false;
        outRow[c] = rawVal;
      } else if (typeof rawVal === 'boolean') {
        outRow[c] = rawVal ? 1 : 0;
      } else if (typeof rawVal === 'object') {
        isInt[c] = false;
        isReal[c] = false;
        outRow[c] = JSON.stringify(rawVal);
      } else {
        const s = String(rawVal).trim();
        if (s === '') {
          sawNull[c] = true;
          outRow[c] = null;
          continue;
        }
        if (/^-?(?:0|[1-9]\d*)$/.test(s)) {
          const asBig = BigInt(s);
          if (asBig >= BigInt(Number.MIN_SAFE_INTEGER) && asBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
            outRow[c] = Number(s);
          } else {
            isInt[c] = false;
            isReal[c] = false;
            outRow[c] = String(rawVal);
          }
        } else if (/^-?(?:\d+\.\d+|\d+\.|\.\d+)(?:[eE][+-]?\d+)?$/.test(s) && Number.isFinite(Number(s))) {
          isInt[c] = false;
          outRow[c] = Number(s);
        } else {
          isInt[c] = false;
          isReal[c] = false;
          outRow[c] = String(rawVal);
        }
      }

      const tracker = seenVals[c];
      if (tracker && outRow[c] !== null && !duplicateVals[c]) {
        const key = String(outRow[c]);
        if (tracker.has(key)) duplicateVals[c] = true;
        else tracker.add(key);
      }
    }
    typedRows.push(outRow);
  }

  const columns = colNames.map((name, c) => {
    const sqlType: 'INTEGER' | 'REAL' | 'TEXT' = !sawNonNull[c] ? 'TEXT' : isInt[c] ? 'INTEGER' : isReal[c] ? 'REAL' : 'TEXT';
    const uniqueNonNull = Boolean(seenVals[c] && sawNonNull[c] && !sawNull[c] && !duplicateVals[c]);
    return { name, sqlType, uniqueNonNull };
  });

  const idIdx = columns.findIndex((col) => col.name.toLowerCase() === 'id' && col.uniqueNonNull);
  const pkValues = idIdx >= 0 && seenVals[idIdx] ? seenVals[idIdx]! : undefined;

  return { tableName, columns, rows: typedRows, pkValues };
}

function parseDatasetFile(filePath: string, tableName: string): ParsedDatasetTable {
  const st = statSync(filePath);
  if (st.size > MAX_IMPORT_BYTES) {
    throw new Error(`"${filePath}" is ${(st.size / (1024 * 1024)).toFixed(1)} MB (ephemeral import cap is 128 MB).`);
  }
  const text = readFileSync(filePath, 'utf8');
  const ext = extname(filePath).toLowerCase();

  if (ext === '.ndjson' || ext === '.jsonl') {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const objects: Array<Record<string, unknown>> = [];
    const headerSet = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch (err) {
        throw new Error(`Invalid JSON on line ${i + 1} of "${filePath}": ${(err as Error).message}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Line ${i + 1} of "${filePath}" must be a JSON object.`);
      }
      const obj = parsed as Record<string, unknown>;
      for (const k of Object.keys(obj)) headerSet.add(k);
      objects.push(obj);
    }
    const headers = [...headerSet];
    if (!headers.length) throw new Error(`"${filePath}" contains no JSON object fields.`);
    return inferDatasetTable(tableName, headers, objects, true);
  }

  const delimiter: ',' | '\t' = ext === '.tsv' ? '\t' : ',';
  const grid = parseDelimitedText(text, delimiter);
  if (!grid.length) throw new Error(`"${filePath}" is empty.`);
  const [headers, ...dataRows] = grid;
  return inferDatasetTable(tableName, headers, dataRows, false);
}

function cleanSqlDumpForSqlite(sqlText: string): string {
  return sqlText
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trimStart();
      if (t.startsWith('\\')) return false;
      if (
        /^(?:SET\s+(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|client_encoding|standard_conforming_strings|check_function_bodies|xmloption|client_min_messages|row_security|default_tablespace|default_table_access_method)|SELECT\s+pg_catalog\.set_config)\b/i.test(
          t,
        )
      ) {
        return false;
      }
      return true;
    })
    .join('\n');
}

export function hydrateEphemeralSqlite(rawTarget: string): EphemeralImportResult {
  const resolved = resolve(rawTarget);
  if (!existsSync(resolved)) {
    throw new Error(`File or directory not found: "${rawTarget}".`);
  }
  const st = statSync(resolved);
  const label = sanitizeIdentifier(basename(resolved), 'imported');
  const tempDir = mkdtempSync(join(tmpdir(), 'tablewalk-import-'));
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* Temp cleanup best-effort. */
    }
  };
  process.once('exit', cleanup);

  const dbPath = join(tempDir, `${label}.sqlite`);
  const db = new DatabaseSync(dbPath);
  let fkCount = 0;

  try {
    db.exec('PRAGMA foreign_keys = OFF;');

    const sqlFiles: string[] = [];
    const dataFiles: string[] = [];

    if (st.isDirectory()) {
      const entries = readdirSync(resolved)
        .filter((f) => IMPORTABLE_EXT.test(f))
        .sort();
      if (!entries.length) {
        throw new Error(`Directory "${rawTarget}" contains no .sql, .csv, .tsv, .ndjson, or .jsonl files.`);
      }
      for (const entry of entries) {
        const full = join(resolved, entry);
        if (!statSync(full).isFile()) continue;
        if (/\.sql$/i.test(entry)) sqlFiles.push(full);
        else dataFiles.push(full);
      }
    } else if (/\.sql$/i.test(resolved)) {
      sqlFiles.push(resolved);
    } else {
      dataFiles.push(resolved);
    }

    for (const sqlFile of sqlFiles) {
      const fStat = statSync(sqlFile);
      if (fStat.size > MAX_IMPORT_BYTES) {
        throw new Error(`"${sqlFile}" exceeds the 128 MB ephemeral import cap.`);
      }
      const rawSql = readFileSync(sqlFile, 'utf8');
      db.exec(cleanSqlDumpForSqlite(rawSql));
    }

    if (dataFiles.length > 0) {
      const usedTableNames = new Set<string>();
      const parsedTables: ParsedDatasetTable[] = [];

      for (const file of dataFiles) {
        const stem = sanitizeIdentifier(basename(file), 'dataset');
        let tName = stem;
        let n = 2;
        while (usedTableNames.has(tName.toLowerCase())) tName = `${stem}_${n++}`;
        usedTableNames.add(tName.toLowerCase());
        parsedTables.push(parseDatasetFile(file, tName));
      }

      // Map candidate parent tables that have a unique non-null `id` column.
      const parentByStem = new Map<string, ParsedDatasetTable>();
      for (const pt of parsedTables) {
        if (!pt.pkValues) continue;
        const lower = pt.tableName.toLowerCase();
        parentByStem.set(lower, pt);
        if (lower.endsWith('ies') && lower.length > 3) parentByStem.set(`${lower.slice(0, -3)}y`, pt);
        else if (lower.endsWith('s') && lower.length > 1) parentByStem.set(lower.slice(0, -1), pt);
      }

      db.exec('BEGIN;');
      for (const pt of parsedTables) {
        const colDefs: string[] = [];
        const fkClauses: string[] = [];
        const hasIdPk = pt.columns.some((c) => c.name.toLowerCase() === 'id' && c.uniqueNonNull);

        for (let cIdx = 0; cIdx < pt.columns.length; cIdx++) {
          const col = pt.columns[cIdx];
          const isPk = hasIdPk && col.name.toLowerCase() === 'id';
          colDefs.push(`${quoteIdent(col.name)} ${col.sqlType}${isPk ? ' PRIMARY KEY' : ''}`);

          const fkMatch = /^(.+)_id$/i.exec(col.name);
          if (fkMatch && !isPk) {
            const stem = fkMatch[1].toLowerCase();
            const target = parentByStem.get(stem);
            if (target && target.tableName !== pt.tableName && target.pkValues) {
              // Only declare FK when every non-null value exists in target.id so data stays 100% valid.
              const allPresent = pt.rows.every((r) => r[cIdx] === null || target.pkValues!.has(String(r[cIdx])));
              if (allPresent) {
                fkClauses.push(`FOREIGN KEY (${quoteIdent(col.name)}) REFERENCES ${quoteIdent(target.tableName)}("id")`);
                fkCount++;
              }
            }
          }
        }

        const createSql = `CREATE TABLE ${quoteIdent(pt.tableName)} (${[...colDefs, ...fkClauses].join(', ')});`;
        db.exec(createSql);

        if (pt.rows.length > 0) {
          const placeholders = pt.columns.map(() => '?').join(', ');
          const stmt = db.prepare(`INSERT INTO ${quoteIdent(pt.tableName)} VALUES (${placeholders})`);
          for (const row of pt.rows) {
            stmt.run(...row);
          }
        }
      }
      db.exec('COMMIT;');
    }

    const countRow = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'")
      .get() as { n?: number } | undefined;
    const tableCount = Number(countRow?.n ?? 0);
    if (tableCount === 0) {
      throw new Error(`"${rawTarget}" created 0 tables or views.`);
    }
    db.exec('PRAGMA foreign_keys = ON;');
    db.close();
    return { dbPath, label, tableCount, fkCount, cleanup };
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    cleanup();
    throw err;
  }
}
