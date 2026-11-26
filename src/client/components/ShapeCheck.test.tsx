/** The shape check: findings by table, then by rule with the cost said once; a table heading is the way there. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const gone: unknown[] = [];
let result: Record<string, unknown> = {};
let byTool: Record<string, Record<string, unknown>> = {};
let activeEntry: Record<string, unknown> | undefined;
const mockState: Record<string, unknown> = { activeConnection: 'demo' };
vi.mock('@mistriwork/kit/client/core.js', () => ({
  state: mockState,
  api: async (_url: string, body?: { name?: string }) => ({
    structuredContent: (body?.name && byTool[body.name]) || result,
  }),
  currentEntry: () => activeEntry,
  findTable: (id: string) => ({ id, name: id, approxRows: id === 'invoice' ? 4200 : undefined }),
  go: (...args: unknown[]) => gone.push(args),
  tableView: (table: string, query?: string) => (query ? { kind: 'table', table, query } : { kind: 'table', table }),
  breakdownView: (table: string, query?: string) => ({ kind: 'breakdown', table, query }),
}));

const draw = (tree: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{tree}</QueryClientProvider>);
const { ShapeCheckDialog } = await import('./ShapeCheck.js');

afterEach(() => {
  cleanup();
  gone.length = 0;
  result = {};
  byTool = {};
  activeEntry = undefined;
  mockState.activeConnection = 'demo';
  delete mockState.connections;
  delete mockState.schema;
});

test('counts by severity, groups by table then rule, and the heading opens the table', async () => {
  const user = userEvent.setup();
  result = {
    counts: { high: 1, medium: 1, low: 0 },
    rules: { 'unindexed-fk': { why: 'every join scans' } },
    findings: [
      { table: 'invoice', rule: 'unindexed-fk', severity: 'high', message: 'customer_id has no index' },
      { table: 'invoice', rule: 'unindexed-fk', severity: 'high', message: 'sold_by has no index' },
      { table: 'note', rule: 'naive-timestamp', severity: 'medium', message: 'written_on has no zone', why: 'midnight moves' },
    ],
  };
  const onClose = vi.fn();
  draw(<ShapeCheckDialog onClose={onClose} />);
  await screen.findByText(/1 high, 1 medium, 0 low/);
  expect(screen.getAllByText('every join scans')).toHaveLength(1);
  expect(screen.getByText('customer_id has no index')).toBeInTheDocument();
  expect(screen.getByText('~4,200 rows')).toBeInTheDocument();
  expect(screen.getByText('midnight moves')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^invoice/ }));
  expect(gone).toEqual([[{ kind: 'table', table: 'invoice' }, 'reset']]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('copies CREATE INDEX DDL, walks anomalous rows, and compares sibling environment drift', async () => {
  const user = userEvent.setup();

  mockState.activeConnection = 'billing-local';
  mockState.connections = [
    { id: 'billing-local', name: 'billing-local', database: 'billing', env: 'local' },
    { id: 'billing-prod', name: 'billing-prod', database: 'billing', env: 'prod' },
  ];
  byTool = {
    lint: {
      counts: { high: 1, medium: 0, low: 0 },
      rules: { 'unindexed-foreign-key': { why: 'scans child rows' } },
      findings: [
        {
          table: 'invoice',
          rule: 'unindexed-foreign-key',
          severity: 'high',
          columns: ['customer_id'],
          message: 'customer_id → customer.id has no index behind it',
        },
      ],
    },
    anomalies: {
      scannedTables: 4,
      counts: { high: 1, medium: 0, low: 0 },
      findings: [
        {
          table: 'invoice',
          rule: 'temporal-inversion',
          severity: 'high',
          rows: 3,
          message: '3 rows have paid_at before issued_at',
          query: 'invoice paid_at < issued_at',
        },
      ],
    },
    diff: {
      from: 'billing-local',
      to: 'billing-prod',
      same: false,
      tables: [
        {
          table: 'draft_quote',
          onlyIn: 'left',
        },
        {
          table: 'invoice',
          columnsOnlyLeft: ['po_number'],
          changed: [],
        },
      ],
    },
  };

  const onClose = vi.fn();
  draw(<ShapeCheckDialog onClose={onClose} />);
  const copyBtn = await screen.findByRole('button', { name: 'Copy index SQL' });
  await user.click(copyBtn);
  expect(await navigator.clipboard.readText()).toBe('CREATE INDEX idx_invoice_customer_id ON invoice (customer_id);');
  expect(await screen.findByRole('button', { name: 'Copied SQL' })).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Data anomalies' }));
  await screen.findByText('3 rows have paid_at before issued_at');

  await user.click(screen.getByRole('tab', { name: 'Environment drift' }));
  await screen.findByText(/Columns only here: po_number/);
  expect(screen.getByText('Only in this environment')).toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Data anomalies' }));
  await user.click(await screen.findByRole('button', { name: 'Walk rows' }));
  expect(gone).toEqual([[{ kind: 'table', table: 'invoice', query: 'invoice paid_at < issued_at' }, 'reset']]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('inspects live index & scan health (perf) and explores foreign-key join paths', async () => {
  const user = userEvent.setup();
  mockState.schema = {
    tables: [
      { id: 'invoice_line', name: 'invoice_line', columns: [{ name: 'id' }] },
      { id: 'country', name: 'country', columns: [{ name: 'code' }] },
    ],
  };
  byTool = {
    perf: {
      scannedTables: 5,
      counts: { high: 0, medium: 1, low: 0 },
      rules: { 'duplicate-index': { why: 'writes maintain both indexes' } },
      findings: [
        {
          table: 'invoice',
          rule: 'duplicate-index',
          severity: 'medium',
          index: 'idx_invoice_cust',
          coveredBy: 'idx_invoice_cust_status',
          message: 'Index idx_invoice_cust (customer_id) is a leading prefix of idx_invoice_cust_status',
          suggestedSql: 'DROP INDEX CONCURRENTLY idx_invoice_cust;',
        },
      ],
    },
    path: {
      from: 'invoice_line',
      to: 'country',
      connected: true,
      paths: [
        {
          length: 2,
          unindexedHops: 1,
          summary: 'invoice_line.invoice_id -> invoice.id ; invoice.country_code -> country.code',
          queryHint: 'invoice_line invoice_id.country_code.name != ""',
          hops: [
            {
              from: 'invoice_line',
              to: 'invoice',
              direction: 'to-many',
              via: ['invoice_id'],
              targetColumns: ['id'],
              indexed: false,
              scannedApproxRows: 4200,
              suggestedIndex: 'CREATE INDEX idx_invoice_line_invoice_id ON invoice_line (invoice_id);',
            },
            {
              from: 'invoice',
              to: 'country',
              direction: 'to-one',
              via: ['country_code'],
              targetColumns: ['code'],
              indexed: true,
            },
          ],
        },
      ],
    },
  };

  const onClose = vi.fn();
  draw(<ShapeCheckDialog onClose={onClose} initialTab="paths" />);

  await screen.findByText(/1 shortest foreign-key path between invoice_line and country/);
  const joinCopyBtn = screen.getByRole('button', { name: 'Copy JOIN SQL' });
  await user.click(joinCopyBtn);
  expect(await navigator.clipboard.readText()).toContain('JOIN invoice t1 ON t0.id = t1.invoice_id');

  const hopCopyBtn = screen.getByRole('button', { name: 'Copy index SQL' });
  await user.click(hopCopyBtn);
  expect(await navigator.clipboard.readText()).toBe('CREATE INDEX idx_invoice_line_invoice_id ON invoice_line (invoice_id);');

  await user.click(screen.getByRole('tab', { name: 'Index & scan health' }));
  await screen.findByText(/Index idx_invoice_cust \(customer_id\) is a leading prefix/);
  expect(screen.getByRole('figure', { name: 'Findings distribution' })).toBeInTheDocument();
  expect(screen.getByText('DROP INDEX CONCURRENTLY idx_invoice_cust;')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Copy SQL' }));
  expect(await navigator.clipboard.readText()).toBe('DROP INDEX CONCURRENTLY idx_invoice_cust;');

  await user.click(screen.getByRole('tab', { name: 'Join paths' }));
  await user.click(await screen.findByRole('button', { name: 'Walk rows' }));
  expect(gone).toEqual([[{ kind: 'table', table: 'invoice_line', query: 'invoice_line invoice_id.country_code.name != ""' }, 'reset']]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a clean schema says so', async () => {
  result = { findings: [] };
  draw(<ShapeCheckDialog onClose={() => {}} />);
  await screen.findByText(/Nothing to report/);
});
