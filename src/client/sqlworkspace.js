/**
 * Browser-side SQL workspace state scoped by database group:
 *  - Folder-imported `.sql` files (works even without a local disk attach or on non-loopback servers)
 *  - Recent SQL execution history ring (last 30 runs per database)
 *  - Remembered `:param` / `{{param}}` parameter bindings
 *
 * Scoped by logical database name when environment metadata is configured so
 * sibling environments (`billing-local`, `billing-staging`, `billing-prod`)
 * share one SQL workspace automatically.
 */
import { loadJson, saveJson } from '@mistriwork/kit/client/core.js';

const FILES_KEY = 'tw-sql-ws-files-v1';
const HISTORY_KEY = 'tw-sql-ws-history-v1';
const PARAMS_KEY = 'tw-sql-ws-params-v1';

const MAX_IMPORTED_FILES = 200;
const MAX_IMPORTED_BYTES = 1_500_000;
const MAX_HISTORY_ENTRIES = 30;

/** @typedef {{ path: string, folder: string, name: string, content: string, updatedAt: string }} BrowserSqlFile */
/** @typedef {{ id: string, sql: string, at: string, ms: number, ok: boolean, rowCount?: number, affected?: number, error?: string, connectionName?: string }} SqlHistoryEntry */

function normalizeRelPath(raw) {
  const parts = String(raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) return '';
  let joined = parts.join('/');
  if (!joined.toLowerCase().endsWith('.sql')) joined += '.sql';
  return joined;
}

function splitFolderName(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx >= 0 ? { folder: relPath.slice(0, idx), name: relPath.slice(idx + 1) } : { folder: '', name: relPath };
}

function readMap(key) {
  const raw = loadJson(key, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** @param {string} scopeKey @returns {BrowserSqlFile[]} */
export function importedFilesFor(scopeKey) {
  const all = readMap(FILES_KEY);
  const list = all[scopeKey];
  return Array.isArray(list) ? list : [];
}

/**
 * Strip a shared top-level folder prefix from browser folder uploads
 * (e.g. `my-queries/billing/a.sql` + `my-queries/b.sql` -> `billing/a.sql` + `b.sql`).
 * @param {Array<{ path: string, content: string }>} entries
 */
export function stripCommonRoot(entries) {
  const cleaned = entries.map((e) => ({ path: normalizeRelPath(e.path), content: String(e.content ?? '') })).filter((e) => e.path);
  if (!cleaned.length) return [];
  const firstSegs = cleaned.map((e) => (e.path.includes('/') ? e.path.slice(0, e.path.indexOf('/')) : ''));
  const first = firstSegs[0];
  if (first && firstSegs.every((s) => s === first)) {
    return cleaned.map((e) => ({ path: e.path.slice(first.length + 1), content: e.content }));
  }
  return cleaned;
}

/**
 * Merge imported `.sql` files into the browser workspace for `scopeKey`.
 * @param {string} scopeKey
 * @param {Array<{ path: string, content: string }>} entries
 * @returns {{ files: BrowserSqlFile[], added: number, skipped: number }}
 */
export function importSqlFiles(scopeKey, entries) {
  const normalized = stripCommonRoot(entries);
  const existing = new Map(importedFilesFor(scopeKey).map((f) => [f.path, f]));
  const now = new Date().toISOString();
  let totalBytes = [...existing.values()].reduce((acc, f) => acc + f.content.length, 0);
  let added = 0;
  let skipped = 0;

  for (const entry of normalized) {
    if (!entry.path) continue;
    const prev = existing.get(entry.path);
    const delta = entry.content.length - (prev?.content.length ?? 0);
    if (!prev && existing.size >= MAX_IMPORTED_FILES) {
      skipped++;
      continue;
    }
    if (totalBytes + delta > MAX_IMPORTED_BYTES) {
      skipped++;
      continue;
    }
    const { folder, name } = splitFolderName(entry.path);
    existing.set(entry.path, { path: entry.path, folder, name, content: entry.content, updatedAt: now });
    totalBytes += delta;
    added++;
  }

  const files = [...existing.values()].sort((a, b) => a.path.localeCompare(b.path));
  const all = readMap(FILES_KEY);
  all[scopeKey] = files;
  saveJson(FILES_KEY, all);
  return { files, added, skipped };
}

/** @param {string} scopeKey @param {string} relPath @param {string} content @returns {BrowserSqlFile[]} */
export function upsertImportedFile(scopeKey, relPath, content) {
  const path = normalizeRelPath(relPath);
  if (!path) return importedFilesFor(scopeKey);
  return importSqlFiles(scopeKey, [{ path, content }]).files;
}

/** @param {string} scopeKey @param {string} relPath @returns {BrowserSqlFile[]} */
export function deleteImportedFile(scopeKey, relPath) {
  const next = importedFilesFor(scopeKey).filter((f) => f.path !== relPath);
  const all = readMap(FILES_KEY);
  all[scopeKey] = next;
  saveJson(FILES_KEY, all);
  return next;
}

/** @param {string} scopeKey */
export function clearImportedFiles(scopeKey) {
  const all = readMap(FILES_KEY);
  delete all[scopeKey];
  saveJson(FILES_KEY, all);
}

/** @param {string} scopeKey @returns {SqlHistoryEntry[]} */
export function historyFor(scopeKey) {
  const all = readMap(HISTORY_KEY);
  const list = all[scopeKey];
  return Array.isArray(list) ? list : [];
}

/** @param {string} scopeKey @param {Omit<SqlHistoryEntry, 'id' | 'at'>} entry @returns {SqlHistoryEntry[]} */
export function recordHistory(scopeKey, entry) {
  const sql = String(entry.sql ?? '').trim();
  if (!sql) return historyFor(scopeKey);
  const prev = historyFor(scopeKey).filter((item) => !(item.sql === sql && item.connectionName === entry.connectionName));
  const next = [
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
      ...entry,
      sql,
    },
    ...prev,
  ].slice(0, MAX_HISTORY_ENTRIES);
  const all = readMap(HISTORY_KEY);
  all[scopeKey] = next;
  saveJson(HISTORY_KEY, all);
  return next;
}

/** @param {string} scopeKey */
export function clearHistory(scopeKey) {
  const all = readMap(HISTORY_KEY);
  delete all[scopeKey];
  saveJson(HISTORY_KEY, all);
}

/** @param {string} scopeKey @returns {Record<string, string>} */
export function paramValuesFor(scopeKey) {
  const all = readMap(PARAMS_KEY);
  const rec = all[scopeKey];
  return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : {};
}

/** @param {string} scopeKey @param {Record<string, string>} values */
export function saveParamValues(scopeKey, values) {
  const all = readMap(PARAMS_KEY);
  all[scopeKey] = values;
  saveJson(PARAMS_KEY, all);
}
