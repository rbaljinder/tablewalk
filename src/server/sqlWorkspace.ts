/**
 * Connection-scoped `.sql` workspace folders on disk (DataGrip-style):
 *   - Configured per connection (`"sqlDir"` in tablewalk.json), top-level (`"sqlDir"` / `--sql-dir` / `TABLEWALK_SQL_DIR`),
 *     or attached at runtime from loopback (`POST /api/sql/workspace/attach`).
 *   - Automatically shared across sibling environments of the same logical database (`billing@local` / `staging` / `prod`).
 *   - Strictly confined to the workspace root: rejects absolute paths, `..`, dot-directories, symlinks escaping root,
 *     non-`.sql` extensions, and files over 1 MiB.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { Registry } from '@mistriwork/engine/host';
import type { SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import { listEnrichedConnections } from './mcp/toolkit.js';

export const MAX_WORKSPACE_FILES = 500;
export const MAX_WORKSPACE_DEPTH = 6;
export const MAX_SQL_FILE_BYTES = 1024 * 1024;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo']);

export interface WorkspaceSqlFile {
  /** Forward-slash path relative to workspace root, e.g. `billing/overdue.sql`. */
  path: string;
  /** File basename, e.g. `overdue.sql`. */
  name: string;
  /** Parent folder relative to root (`""` for top-level files). */
  folder: string;
  size: number;
  mtimeMs: number;
}

export interface WorkspaceState {
  attached: boolean;
  rootName: string | null;
  rootPath: string | null;
  readOnly: boolean;
  files: WorkspaceSqlFile[];
}

interface WorkspaceStore {
  defaultDir?: string;
  /** Map from scope key (`@db:<database>` or `conn:<id>`) to resolved root folder path. */
  byScope: Map<string, string>;
}

const stores = new WeakMap<Registry, WorkspaceStore>();

function storeFor(registry: Registry): WorkspaceStore {
  let s = stores.get(registry);
  if (!s) {
    s = { byScope: new Map() };
    stores.set(registry, s);
  }
  return s;
}

/** Resolve the workspace scope key for a connection: shared across sibling envs of a logical database. */
export function workspaceScopeKey(registry: Registry, connectionId: string): string {
  const enriched = listEnrichedConnections(registry).find((c) => c.id === connectionId);
  if (enriched?.database && (enriched.siblings.length > 0 || enriched.explicit)) {
    return `@db:${enriched.database.toLowerCase()}`;
  }
  return `conn:${connectionId}`;
}

export function setDefaultSqlDir(registry: Registry, dir: string | undefined): void {
  const store = storeFor(registry);
  store.defaultDir = dir ? resolve(dir) : undefined;
}

export function setConnectionSqlDir(registry: Registry, connectionId: string, dir: string | undefined): void {
  const store = storeFor(registry);
  const key = workspaceScopeKey(registry, connectionId);
  if (!dir) {
    store.byScope.delete(key);
    store.byScope.delete(`conn:${connectionId}`);
    return;
  }
  store.byScope.set(key, resolve(dir));
}

export function getConnectionSqlDir(registry: Registry, connectionId: string): string | undefined {
  const store = stores.get(registry);
  if (!store) return undefined;
  const scope = workspaceScopeKey(registry, connectionId);
  return store.byScope.get(scope) ?? store.byScope.get(`conn:${connectionId}`) ?? store.defaultDir;
}

export function validateWorkspaceRoot(rawDir: string): string {
  const trimmed = rawDir.trim();
  if (!trimmed || trimmed.includes('\0')) throw new Error('A folder path is required.');
  const abs = resolve(trimmed);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`Folder does not exist: ${trimmed}`);
  }
  if (!st.isDirectory()) throw new Error(`Not a directory: ${trimmed}`);
  return realpathSync(abs);
}

/** Validate a relative `.sql` path and confirm it stays strictly inside `rootDir` (including symlinks). */
export function resolveWorkspaceFile(
  rootDir: string,
  rawRelPath: string,
  options?: { mustExist?: boolean },
): {
  absPath: string;
  relPath: string;
  rootReal: string;
} {
  const rootReal = realpathSync(resolve(rootDir));
  const trimmed = rawRelPath.trim();
  if (!trimmed || trimmed.includes('\0')) {
    throw new Error('A .sql file path is required.');
  }
  if (/^[/\\]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error('File path must be relative to the workspace folder.');
  }
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized) {
    throw new Error('A .sql file path is required.');
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.startsWith('.')) {
      throw new Error(`Invalid workspace file path: "${rawRelPath}".`);
    }
  }
  if (extname(normalized).toLowerCase() !== '.sql') {
    throw new Error('Workspace files must have a .sql extension.');
  }
  const candidate = resolve(rootReal, ...parts);
  const relCheck = relative(rootReal, candidate);
  if (!relCheck || relCheck.startsWith('..') || relCheck.includes(`..${sep}`)) {
    throw new Error('Path escapes the workspace folder.');
  }

  // Verify the nearest existing ancestor's realpath stays inside rootReal so symlinks cannot escape.
  let probe = candidate;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const probeReal = realpathSync(probe);
  if (probeReal !== rootReal && !probeReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error('Symlink escapes the workspace folder.');
  }

  if (options?.mustExist) {
    if (!existsSync(candidate)) throw new Error(`SQL file not found: ${normalized}`);
    const fileReal = realpathSync(candidate);
    if (!fileReal.startsWith(`${rootReal}${sep}`)) {
      throw new Error('Symlink escapes the workspace folder.');
    }
    const st = statSync(fileReal);
    if (!st.isFile()) throw new Error(`Not a file: ${normalized}`);
  }

  return { absPath: candidate, relPath: parts.join('/'), rootReal };
}

/** Scan `rootDir` for `.sql` files (up to MAX_WORKSPACE_FILES, depth MAX_WORKSPACE_DEPTH). */
export function listWorkspaceFiles(rootDir: string): WorkspaceSqlFile[] {
  const rootReal = realpathSync(resolve(rootDir));
  const files: WorkspaceSqlFile[] = [];

  const walk = (dir: string, relPrefix: string, depth: number) => {
    if (depth > MAX_WORKSPACE_DEPTH || files.length >= MAX_WORKSPACE_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_WORKSPACE_FILES) break;
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        try {
          const real = realpathSync(full);
          if (!real.startsWith(`${rootReal}${sep}`)) continue;
        } catch {
          continue;
        }
        walk(full, rel, depth + 1);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
        try {
          const st = statSync(full);
          if (st.size > MAX_SQL_FILE_BYTES) continue;
          files.push({
            path: rel,
            name: entry.name,
            folder: relPrefix,
            size: st.size,
            mtimeMs: Math.round(st.mtimeMs),
          });
        } catch {
          /* Skip unreadable file. */
        }
      }
    }
  };

  walk(rootReal, '', 0);
  files.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  return files;
}

export function readWorkspaceFile(rootDir: string, relPath: string): { path: string; content: string; size: number; mtimeMs: number } {
  const { absPath, relPath: clean } = resolveWorkspaceFile(rootDir, relPath, { mustExist: true });
  const st = statSync(absPath);
  if (st.size > MAX_SQL_FILE_BYTES) {
    throw new Error(`SQL file exceeds the 1 MiB limit (${clean}).`);
  }
  const content = readFileSync(absPath, 'utf8');
  return { path: clean, content, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

export function writeWorkspaceFile(
  rootDir: string,
  relPath: string,
  content: string,
): { path: string; name: string; folder: string; size: number; mtimeMs: number } {
  const byteLen = Buffer.byteLength(content, 'utf8');
  if (byteLen > MAX_SQL_FILE_BYTES) {
    throw new Error('SQL file content exceeds the 1 MiB limit.');
  }
  const { absPath, relPath: clean, rootReal } = resolveWorkspaceFile(rootDir, relPath);
  const parent = dirname(absPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const parentReal = realpathSync(parent);
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error('Target directory escapes the workspace folder.');
  }
  writeFileSync(absPath, content, 'utf8');
  const st = statSync(absPath);
  const parts = clean.split('/');
  const name = parts[parts.length - 1];
  const folder = parts.slice(0, -1).join('/');
  return { path: clean, name, folder, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

export function deleteWorkspaceFile(rootDir: string, relPath: string): { path: string } {
  const { absPath, relPath: clean } = resolveWorkspaceFile(rootDir, relPath, { mustExist: true });
  unlinkSync(absPath);
  return { path: clean };
}

export function renameWorkspaceFile(rootDir: string, fromRel: string, toRel: string): { from: string; to: string } {
  const src = resolveWorkspaceFile(rootDir, fromRel, { mustExist: true });
  const dst = resolveWorkspaceFile(rootDir, toRel);
  if (existsSync(dst.absPath)) throw new Error(`Target file already exists: ${dst.relPath}`);
  const parent = dirname(dst.absPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  renameSync(src.absPath, dst.absPath);
  return { from: src.relPath, to: dst.relPath };
}

export function inspectWorkspace(registry: Registry, connectionId: string, trusted: boolean): WorkspaceState {
  const dir = getConnectionSqlDir(registry, connectionId);
  if (!dir || !existsSync(dir)) {
    return { attached: false, rootName: null, rootPath: null, readOnly: !trusted, files: [] };
  }
  return {
    attached: true,
    rootName: basename(dir),
    rootPath: trusted ? dir : null,
    readOnly: !trusted,
    files: listWorkspaceFiles(dir),
  };
}

/** Surface attached workspace `.sql` files as named queries for `/api/queries` and the MCP shelf. */
export function workspaceQueriesFor(registry: Registry, connectionId: string): SavedQuery[] {
  const dir = getConnectionSqlDir(registry, connectionId);
  if (!dir || !existsSync(dir)) return [];
  const files = listWorkspaceFiles(dir).slice(0, 64);
  const out: SavedQuery[] = [];
  for (const file of files) {
    if (file.size > 32 * 1024) continue;
    try {
      const { content } = readWorkspaceFile(dir, file.path);
      if (!content.trim()) continue;
      out.push({
        name: file.path,
        sql: content,
        description: `Workspace SQL file (${basename(dir)}/${file.path})`,
        connection: connectionId,
      });
    } catch {
      /* Skip unreadable file. */
    }
  }
  return out;
}
