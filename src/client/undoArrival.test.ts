import { beforeEach, expect, test, vi } from 'vitest';
import { setAppConfigured } from '@mistriwork/kit/client/connectionScope.js';
import { establishSessionIdentity, lockSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';

/* The Workbench's menu names the last edit on arrival, and on a reload that is the only time it asks: nothing has been
   written in this tab yet. The kit mounts the `sql` slot before it has named a connection (app.js runs
   `initConnections` after it), so a history read from there answered nothing, and a write the journal still held — kept
   through a restart by `tablewalk journal` — was never offered by the menu or Cmd+Z. The read belongs where a
   connection is known: `loadStores`, which the kit runs on arrival and again on every switch. */
const { api, state } = vi.hoisted(() => ({
  api: vi.fn(),
  state: { activeConnection: undefined as string | undefined, canWrite: true, connections: [{ id: 'scratch', writable: true }] },
}));
vi.mock('@mistriwork/kit/client/core.js', async (original) => ({ ...(await original<object>()), api, state }));
vi.mock('@mistriwork/kit/client/savedPages.js', async (original) => ({
  ...(await original<object>()),
  loadSavedPages: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sqlsaved.js', async (original) => ({ ...(await original<object>()), loadSavedSql: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./sql.js', async (original) => ({ ...(await original<object>()), initSql: vi.fn() }));
const { workbenchShell } = await import('./workbench.js');
const { canUndo, undoDescription } = await import('./undo.js');

beforeEach(() => {
  api.mockReset();
  setAppConfigured(false);
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: false });
  state.activeConnection = undefined;
});

test('a reload offers the last write the journal kept, once the connection is named', async () => {
  api.mockImplementation(async (path: string) =>
    path === '/api/revert' ? { reverted: false, next: { id: 6, kind: 'update', summary: 'Updated customer 2' }, writes: [] } : {},
  );
  // The boot's order (kit app.js): the `sql` slot, then the connection, then the per-connection stores.
  workbenchShell.menu('sql');
  state.activeConnection = 'scratch';
  await workbenchShell.loadStores();
  await vi.waitFor(() => expect(undoDescription()).toBe('Updated customer 2'));
  expect(canUndo()).toBe(true);
  expect(api).toHaveBeenCalledWith('/api/revert', expect.objectContaining({ conn: 'scratch' }));
});

test('a switch asks again for the connection arrived at', async () => {
  api.mockImplementation(async (path: string, body: { conn?: string }) =>
    path === '/api/revert' ? { next: body.conn === 'scratch' ? { id: 3, summary: 'Updated customer 1' } : null, writes: [] } : {},
  );
  state.connections = [
    { id: 'scratch', writable: true },
    { id: 'other', writable: true },
  ];
  state.activeConnection = 'other';
  await workbenchShell.loadStores();
  await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/revert', expect.objectContaining({ conn: 'other' })));
  expect(canUndo()).toBe(false);
  state.activeConnection = 'scratch';
  await workbenchShell.loadStores();
  await vi.waitFor(() => expect(undoDescription()).toBe('Updated customer 1'));
});
