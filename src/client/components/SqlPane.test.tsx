/**
 * The SQL pane: a statement run, its result drawn or its error kept in
 * the database's own words, and rows that open as records when the
 * columns can say whose they are.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { columnKind } from '@mistriwork/engine/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const customer: TableMeta = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('credit_limit', 'REAL'),
  ] as TableMeta['columns'],
};
const calls: Array<Record<string, unknown>> = [];
const pathCalls: Array<[string, Record<string, unknown> | undefined]> = [];
const gone: unknown[] = [];
const toasts: string[] = [];
const memStore = new Map<string, unknown>();
let reply: Record<string, unknown> = {};
let apiRouter: ((path: string, body?: Record<string, unknown>) => Record<string, unknown> | undefined) | null = null;
vi.mock('@mistriwork/kit/client/core.js', () => ({
  state: {
    activeConnection: 'demo',
    page: 0,
    schema: { label: 'shop', dialect: 'sqlite', tables: [customer], foreignKeys: [] },
    connections: [{ id: 'demo', writable: true }],
  },
  api: async (path: string, body?: Record<string, unknown>) => {
    pathCalls.push([path, body]);
    if (body !== undefined) calls.push(body);
    return apiRouter?.(path, body) ?? reply;
  },
  go: (e: unknown, mode: string) => gone.push([e, mode]),
  render: () => {},
  toast: (m: string) => toasts.push(m),
  el: (tag: string, attrs: Record<string, unknown> = {}) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'hidden') (node as HTMLElement).hidden = Boolean(v);
      else node.setAttribute(k, String(v));
    }
    return node;
  },
  findTable: (id: string) => (id === 'customer' ? customer : undefined),
  columnKind,
  columnDisplay: () => null,
  columnLabel: () => null,
  emptyWord: () => 'null',
  prefersPages: () => false,
  currentEntry: () => null,
  refsTo: () => [],
  refsFrom: () => [],
  keyOf: () => null,
  rowLabel: () => '',
  openRecord: () => {},
  tableView: () => ({}),
  quote: (v: unknown) => String(v),
  labelColumn: () => null,
  primaryKey: (t: TableMeta) => t.columns.filter((c) => c.primaryKey).map((c) => c.name),
  loadJson: (k: string) => memStore.get(k) ?? {},
  saveJson: (k: string, v: unknown) => {
    memStore.set(k, v);
    return true;
  },
  viewportBox: (n: Element) => n.getBoundingClientRect(),
}));
vi.mock('../sqlcomplete.js', () => ({ sqlSuggestions: () => [], tokenAt: () => ({ word: '', start: 0 }) }));
vi.mock('@mistriwork/kit/client/prompt.js', () => ({ promptFor: async () => 'Over limit' }));
const kept: Array<{ name: string; sql: string; source: string }> = [];
const refreshedUndo = vi.fn();
const advancedSource = vi.fn();
vi.mock('../undo.js', () => ({ refreshUndo: () => refreshedUndo() }));
vi.mock('@mistriwork/kit/client/recordSource.js', () => ({ advanceRecordSource: () => advancedSource() }));
vi.mock('../sqlsaved.js', () => ({
  savedStatements: () => kept,
  saveStatement: (name: string, sql: string) => {
    kept.push({ name, sql, source: 'saved' });
    return true;
  },
  removeStatement: (name: string) => {
    const i = kept.findIndex((k) => k.name === name);
    if (i >= 0) kept.splice(i, 1);
  },
}));

const { SqlPane } = await import('./SqlPane.js');

function draw(draft = '') {
  const client = new QueryClient();
  const onClose = vi.fn();
  const onDraft = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <div className="sql-panel">
        <SqlPane draft={draft} onDraft={onDraft} onClose={onClose} />
      </div>
    </QueryClientProvider>,
  );
  return { client, onClose, onDraft };
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  pathCalls.length = 0;
  gone.length = 0;
  toasts.length = 0;
  kept.length = 0;
  memStore.clear();
  apiRouter = null;
  refreshedUndo.mockReset();
  advancedSource.mockReset();
  reply = {};
});

test('names the database, runs on ⌘↵, and draws the rows walkable when the key is there', async () => {
  const user = userEvent.setup();
  reply = {
    columns: ['id', 'name'],
    rows: [
      [1, 'Nia'],
      [2, 'Ola'],
    ],
    ms: 3,
    truncated: true,
    bounded: false,
  };
  const { onClose, onDraft } = draw('select id, name from customer');
  expect(document.querySelector('.sql-target')).toHaveTextContent('shop · sqlite');
  const input = screen.getByRole('combobox', { name: 'SQL statement' });
  expect(input).toHaveFocus();
  await user.type(input, ' limit 2');
  expect(onDraft).toHaveBeenLastCalledWith('select id, name from customer limit 2');
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  await screen.findByText('2 rows');
  expect(calls).toEqual([{ text: 'select id, name from customer limit 2', limit: 500, write: false }]);
  expect(document.querySelector('.sql-truncated')).toHaveTextContent('first 2 of what the database returned');
  expect(document.querySelector('.sql-walk')).toHaveTextContent('Rows open as customer records.');
  await user.click(screen.getByText('Ola'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(gone).toEqual([[{ kind: 'row', table: 'customer', key: { id: 2 }, label: '2' }, 'reset']]);
});

test('an error is kept in the database’s words; no rows still says the shape', async () => {
  const user = userEvent.setup();
  reply = { errors: [{ message: 'no such table: custmer' }] };
  draw('select * from custmer');
  await user.click(screen.getByRole('button', { name: 'Run ⌘↵' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no such table: custmer');
  reply = { columns: ['id'], rows: [], ms: 1 };
  await user.click(screen.getByRole('button', { name: 'Run ⌘↵' }));
  await screen.findByText('No rows.');
  expect(document.querySelector('.sql-empty')).toHaveTextContent('The statement returned these columns: id.');
});

test('a write shows the statement first, runs on the write connection, and refreshes caches and Undo', async () => {
  const user = userEvent.setup();
  reply = { affected: 3 };
  const { client } = draw('update customer set credit_limit = 0');
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  await user.click(screen.getByRole('button', { name: 'Run as write…' }));
  expect(screen.getByRole('dialog').querySelector('pre')).toHaveTextContent('update customer set credit_limit = 0');
  await user.click(screen.getByRole('button', { name: 'Run as write' }));
  await screen.findByText('3 rows changed.');
  expect(calls).toEqual([{ text: 'update customer set credit_limit = 0', limit: 500, write: true }]);
  expect(toasts).toEqual(['3 rows changed.']);
  expect(advancedSource).toHaveBeenCalledTimes(1);
  expect(refreshedUndo).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledTimes(1);
});

test('a saved statement becomes a chip that fills the box, and can be forgotten', async () => {
  const user = userEvent.setup();
  draw('select 1');
  await user.click(screen.getByRole('button', { name: 'Save…' }));
  const chip = await screen.findByRole('button', { name: 'Over limit' });
  const input = screen.getByRole('combobox', { name: 'SQL statement' }) as HTMLTextAreaElement;
  input.value = '';
  await user.click(chip);
  expect(input.value).toBe('select 1');
  await user.click(screen.getByRole('button', { name: 'Forget Over limit' }));
  expect(screen.queryByRole('button', { name: 'Over limit' })).toBeNull();
});

test('renders sibling environment pills in SQL header and highlights production target when confirming a SQL write', async () => {
  const user = userEvent.setup();
  const { state } = await import('@mistriwork/kit/client/core.js');
  const onSwitchConnection = vi.fn();
  (state as Record<string, unknown>).activeConnection = 'billing-prod';
  (state as Record<string, unknown>).connections = [
    { id: 'billing-local', name: 'billing-local', writable: true },
    { id: 'billing-prod', name: 'billing-prod', writable: true },
  ];
  try {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <div className="sql-panel">
          <SqlPane draft="select count(*) from customer" onDraft={() => {}} onSwitchConnection={onSwitchConnection} onClose={() => {}} />
        </div>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('separator', { name: 'Drag to resize SQL panel' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize SQL statement and SQL results' })).toBeInTheDocument();
    const localPill = screen.getByRole('button', { name: 'local' });
    await user.click(localPill);
    expect(onSwitchConnection).toHaveBeenCalledWith('billing-local', 'select count(*) from customer');

    reply = {
      structuredContent: {
        environments: [
          {
            connection: 'billing-local',
            name: 'billing-local',
            env: 'local',
            tier: 'local',
            ok: true,
            ms: 2,
            result: { columns: ['cnt'], rows: [[5]] },
          },
          { connection: 'billing-prod', name: 'billing-prod', env: 'prod', tier: 'prod', ok: false, ms: 1, error: 'Refused: masked' },
        ],
      },
    };
    await user.click(screen.getByRole('button', { name: 'Compare envs' }));
    expect(calls).toContainEqual({ name: 'sql', arguments: { statement: 'select count(*) from customer', envs: 'all' } });
    await screen.findByText('1 row · 2 ms');
    await user.click(screen.getByRole('tab', { name: /prod/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Refused: masked');

    reply = {
      structuredContent: {
        plan: ['SCAN customer', 'SEARCH invoice USING INDEX idx_invoice_customer (customer_id=?)'],
        stats: { ms: 3 },
      },
    };
    await user.click(screen.getByRole('button', { name: 'Explain' }));
    expect(calls).toContainEqual({
      name: 'explain',
      arguments: { statement: 'select count(*) from customer', connection: 'billing-prod' },
    });
    await screen.findByText('2 plan nodes');
    expect(screen.getByText('1 sequential scan')).toBeInTheDocument();
    expect(screen.getByText('1 index seek')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run as write…' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Production environment (billing-prod)');
  } finally {
    (state as Record<string, unknown>).activeConnection = 'demo';
    (state as Record<string, unknown>).connections = [{ id: 'demo', writable: true }];
  }
});

test('Verify DDL dry-runs candidate migration SQL and renders structural diff and introduced lint warnings', async () => {
  const user = userEvent.setup();
  draw('ALTER TABLE customer ADD COLUMN account_manager_id INTEGER REFERENCES customer(id)');
  reply = {
    structuredContent: {
      valid: true,
      dialect: 'sqlite',
      statements: 1,
      same: false,
      diff: [{ table: 'customer', columnsOnlyRight: ['account_manager_id'] }],
      introducedLint: {
        findings: [
          {
            table: 'customer',
            rule: 'unindexed-fk',
            severity: 'high',
            message: 'account_manager_id references customer without a leading index.',
          },
        ],
      },
      stats: { ms: 5 },
    },
  };
  await user.click(screen.getByRole('button', { name: 'Verify DDL' }));
  expect(calls).toContainEqual({
    name: 'verify_ddl',
    arguments: {
      sql: 'ALTER TABLE customer ADD COLUMN account_manager_id INTEGER REFERENCES customer(id)',
      connection: 'demo',
    },
  });
  await screen.findByText('Valid dry run · rolled back');
  expect(screen.getByText('+ customer: added account_manager_id')).toBeInTheDocument();
  expect(screen.getByText(/\[high\] customer \(unindexed-fk\)/)).toBeInTheDocument();
});

test('renders real-time SQL syntax highlighting tokens synchronized with editor text', () => {
  draw("-- top\nSELECT COUNT(id), 'Ada', :min_credit, 500 FROM customer");
  const layer = document.querySelector('.sql-highlight-layer');
  expect(layer).not.toBeNull();
  expect(layer!.querySelector('.sql-tok-comment')).toHaveTextContent('-- top');
  expect(layer!.querySelector('.sql-tok-keyword')).toHaveTextContent('SELECT');
  expect(layer!.querySelector('.sql-tok-function')).toHaveTextContent('COUNT');
  expect(layer!.querySelector('.sql-tok-string')).toHaveTextContent("'Ada'");
  expect(layer!.querySelector('.sql-tok-param')).toHaveTextContent(':min_credit');
  expect(layer!.querySelector('.sql-tok-number')).toHaveTextContent('500');
});

test('runs statement at caret on Run and runs all statements on Run script', async () => {
  const user = userEvent.setup();
  const scriptSql = 'SELECT 1 AS a;\nSELECT 2 AS b;';
  reply = { columns: ['b'], rows: [[2]], ms: 2 };
  draw(scriptSql);

  expect(screen.getByText('Statement 2 of 2')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Run script (2)' })).toBeInTheDocument();

  // Caret is at the end (statement 2), so Run executes only statement 2.
  await user.click(screen.getByRole('button', { name: 'Run ⌘↵' }));
  await screen.findByText('1 row');
  expect(calls[0]).toEqual({ text: 'SELECT 2 AS b', limit: 500, write: false });

  // Run script sends full text to /api/sql/script and renders per-statement cards.
  apiRouter = (path) =>
    path === '/api/sql/script'
      ? {
          totalMs: 4,
          totalStatements: 2,
          statements: [
            { index: 0, sql: 'SELECT 1 AS a', startLine: 1, endLine: 1, ok: true, ms: 2, columns: ['a'], rows: [[1]] },
            { index: 1, sql: 'SELECT 2 AS b', startLine: 2, endLine: 2, ok: true, ms: 2, columns: ['b'], rows: [[2]] },
          ],
        }
      : reply;
  await user.click(screen.getByRole('button', { name: 'Run script (2)' }));
  await screen.findByText('2 of 2 statements ran');
  expect(screen.getByText('Statement 1 · L1–1')).toBeInTheDocument();
  expect(screen.getByText('Statement 2 · L2–2')).toBeInTheDocument();
});

test('extracts inline named parameters and binds them before execution', async () => {
  const user = userEvent.setup();
  reply = {
    columns: ['id', 'credit_limit'],
    rows: [
      [1, 100],
      [2, 300],
    ],
    ms: 3,
  };
  draw('SELECT id, credit_limit FROM customer WHERE credit_limit >= :min_limit');

  const paramInput = screen.getByRole('textbox', { name: 'min_limit' });
  await user.type(paramInput, '250');
  await user.click(screen.getByRole('button', { name: 'Run ⌘↵' }));

  await screen.findByText('2 rows');
  expect(calls[0]).toEqual({
    text: 'SELECT id, credit_limit FROM customer WHERE credit_limit >= 250',
    limit: 500,
    write: false,
  });
  // Numeric aggregate footer appears for credit_limit.
  expect(screen.getByText(/credit_limit: sum 400 · avg 200 · min 100 · max 300/)).toBeInTheDocument();
});

test('opens Files workspace sidebar, loads disk .sql files into tabs, and records execution history', async () => {
  const user = userEvent.setup();
  apiRouter = (path) => {
    if (path === '/api/sql/workspace') {
      return {
        attached: true,
        rootName: 'queries',
        rootPath: '/tmp/queries',
        readOnly: false,
        files: [{ path: 'reports/top.sql', folder: 'reports', name: 'top.sql', size: 32, mtimeMs: 1 }],
      };
    }
    if (path.startsWith('/api/sql/files?')) {
      return { path: 'reports/top.sql', content: 'SELECT id, name FROM customer;' };
    }
    return { columns: ['id', 'name'], rows: [[1, 'Ada']], ms: 2 };
  };

  draw('SELECT 1');
  await user.click(screen.getByRole('button', { name: 'Files' }));
  await screen.findByText('Folder: queries');
  await user.click(screen.getByRole('button', { name: 'top.sql' }));

  const editor = screen.getByRole('combobox', { name: 'SQL statement' }) as HTMLTextAreaElement;
  expect(editor.value).toBe('SELECT id, name FROM customer;');
  expect(screen.getByRole('button', { name: 'Save file ⌘S' })).toBeInTheDocument();

  // Execute and verify History tab logs the run.
  await user.click(screen.getByRole('button', { name: 'Run ⌘↵' }));
  await screen.findByText('1 row');
  await user.click(screen.getByRole('tab', { name: 'History' }));
  expect(await screen.findByText('SELECT id, name FROM customer;')).toBeInTheDocument();
});

test('supports Diff envs view when Compare envs returns rows from multiple environments', async () => {
  const user = userEvent.setup();
  const { state } = await import('@mistriwork/kit/client/core.js');
  (state as Record<string, unknown>).activeConnection = 'billing-local';
  (state as Record<string, unknown>).connections = [
    { id: 'billing-local', name: 'billing-local', writable: true },
    { id: 'billing-prod', name: 'billing-prod', writable: false },
  ];
  try {
    reply = {
      structuredContent: {
        environments: [
          {
            connection: 'billing-local',
            name: 'billing-local',
            env: 'local',
            tier: 'local',
            ok: true,
            ms: 2,
            result: {
              columns: ['id', 'status'],
              rows: [
                [1, 'open'],
                [2, 'paid'],
              ],
            },
          },
          {
            connection: 'billing-prod',
            name: 'billing-prod',
            env: 'prod',
            tier: 'prod',
            ok: true,
            ms: 4,
            result: {
              columns: ['id', 'status'],
              rows: [
                [1, 'open'],
                [2, 'refunded'],
              ],
            },
          },
        ],
      },
    };
    draw('SELECT id, status FROM invoice');
    await user.click(screen.getByRole('button', { name: 'Compare envs' }));
    const diffBtn = await screen.findByRole('button', { name: 'Diff envs' });
    await user.click(diffBtn);
    expect(screen.getByText('Comparing local → prod by id')).toBeInTheDocument();
    expect(screen.getByText('paid → refunded')).toBeInTheDocument();
  } finally {
    (state as Record<string, unknown>).activeConnection = 'demo';
    (state as Record<string, unknown>).connections = [{ id: 'demo', writable: true }];
  }
});
