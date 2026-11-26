/**
 * HTTP routes for connection-scoped `.sql` workspace folders (DataGrip-style):
 *   - GET  /api/sql/workspace         — list `.sql` files in the attached workspace
 *   - POST /api/sql/workspace/attach  — attach a local folder to a connection / db group (loopback-only)
 *   - POST /api/sql/workspace/detach  — detach a runtime folder (loopback-only)
 *   - GET  /api/sql/files             — read one `.sql` file
 *   - POST /api/sql/files             — create or update a `.sql` file (loopback-only)
 *   - POST /api/sql/files/delete      — delete a `.sql` file (loopback-only)
 *   - POST /api/sql/files/rename      — rename/move a `.sql` file (loopback-only)
 */
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { readJson, send } from '@mistriwork/engine/server/http/reply.js';
import {
  deleteWorkspaceFile,
  getConnectionSqlDir,
  inspectWorkspace,
  readWorkspaceFile,
  renameWorkspaceFile,
  setConnectionSqlDir,
  validateWorkspaceRoot,
  writeWorkspaceFile,
} from '../sqlWorkspace.js';

function resolveConnId(ctx: RequestContext, body?: Record<string, unknown>): string | null {
  const fromBody =
    (typeof body?.conn === 'string' && body.conn.trim() ? body.conn.trim() : '') ||
    (typeof body?.connection === 'string' && body.connection.trim() ? body.connection.trim() : '');
  const fromQuery = ctx.url.searchParams.get('conn')?.trim() || ctx.url.searchParams.get('connection')?.trim() || '';
  const id = fromBody || fromQuery || ctx.registry.active || '';
  return id && ctx.registry.has(id) ? id : null;
}

export async function sqlWorkspaceRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, path, registry, trusted } = ctx;
  if (!path.startsWith('/api/sql/workspace') && !path.startsWith('/api/sql/files')) return false;

  if (path === '/api/sql/workspace' && (req.method === 'GET' || req.method === 'HEAD')) {
    const connId = resolveConnId(ctx);
    if (!connId) {
      send(res, 200, { attached: false, rootName: null, rootPath: null, readOnly: !trusted, files: [] });
      return true;
    }
    res.setHeader('cache-control', 'no-store');
    send(res, 200, inspectWorkspace(registry, connId, trusted));
    return true;
  }

  if (path === '/api/sql/workspace/attach' && req.method === 'POST') {
    if (!trusted) {
      send(res, 403, {
        error: 'Attaching a local SQL folder is allowed only on loopback so an exposed server cannot browse host directories.',
      });
      return true;
    }
    const body = await readJson(req);
    const connId = resolveConnId(ctx, body);
    if (!connId) {
      send(res, 400, { error: 'No active connection to attach a SQL folder to.' });
      return true;
    }
    try {
      const root = validateWorkspaceRoot(String(body.dir ?? ''));
      setConnectionSqlDir(registry, connId, root);
      send(res, 200, inspectWorkspace(registry, connId, trusted));
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (path === '/api/sql/workspace/detach' && req.method === 'POST') {
    if (!trusted) {
      send(res, 403, { error: 'Detaching a SQL folder is allowed only on loopback.' });
      return true;
    }
    const body = await readJson(req);
    const connId = resolveConnId(ctx, body);
    if (!connId) {
      send(res, 400, { error: 'No active connection.' });
      return true;
    }
    setConnectionSqlDir(registry, connId, undefined);
    send(res, 200, inspectWorkspace(registry, connId, trusted));
    return true;
  }

  if (path === '/api/sql/files' && (req.method === 'GET' || req.method === 'HEAD')) {
    const connId = resolveConnId(ctx);
    if (!connId) {
      send(res, 404, { error: 'No active connection.' });
      return true;
    }
    const root = getConnectionSqlDir(registry, connId);
    if (!root) {
      send(res, 404, { error: 'No SQL workspace folder is attached to this connection.' });
      return true;
    }
    const rel = ctx.url.searchParams.get('path') ?? '';
    try {
      res.setHeader('cache-control', 'no-store');
      send(res, 200, readWorkspaceFile(root, rel));
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (path === '/api/sql/files' && req.method === 'POST') {
    if (!trusted) {
      send(res, 403, { error: 'Saving SQL files to disk is allowed only on loopback.' });
      return true;
    }
    const body = await readJson(req);
    const connId = resolveConnId(ctx, body);
    if (!connId) {
      send(res, 400, { error: 'No active connection.' });
      return true;
    }
    const root = getConnectionSqlDir(registry, connId);
    if (!root) {
      send(res, 404, { error: 'No SQL workspace folder is attached to this connection.' });
      return true;
    }
    try {
      const saved = writeWorkspaceFile(root, String(body.path ?? ''), String(body.content ?? ''));
      send(res, 200, { file: saved, workspace: inspectWorkspace(registry, connId, trusted) });
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (path === '/api/sql/files/delete' && req.method === 'POST') {
    if (!trusted) {
      send(res, 403, { error: 'Deleting SQL files from disk is allowed only on loopback.' });
      return true;
    }
    const body = await readJson(req);
    const connId = resolveConnId(ctx, body);
    if (!connId) {
      send(res, 400, { error: 'No active connection.' });
      return true;
    }
    const root = getConnectionSqlDir(registry, connId);
    if (!root) {
      send(res, 404, { error: 'No SQL workspace folder is attached to this connection.' });
      return true;
    }
    try {
      const deleted = deleteWorkspaceFile(root, String(body.path ?? ''));
      send(res, 200, { deleted, workspace: inspectWorkspace(registry, connId, trusted) });
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  if (path === '/api/sql/files/rename' && req.method === 'POST') {
    if (!trusted) {
      send(res, 403, { error: 'Renaming SQL files on disk is allowed only on loopback.' });
      return true;
    }
    const body = await readJson(req);
    const connId = resolveConnId(ctx, body);
    if (!connId) {
      send(res, 400, { error: 'No active connection.' });
      return true;
    }
    const root = getConnectionSqlDir(registry, connId);
    if (!root) {
      send(res, 404, { error: 'No SQL workspace folder is attached to this connection.' });
      return true;
    }
    try {
      const moved = renameWorkspaceFile(root, String(body.from ?? ''), String(body.to ?? ''));
      send(res, 200, { moved, workspace: inspectWorkspace(registry, connId, trusted) });
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
    return true;
  }

  return false;
}
