/** "Copy brief for agent": builds a token-tight Markdown handoff for each Workbench room. */
import { afterEach, expect, test, vi } from 'vitest';

let entry: Record<string, unknown> | null = null;
const toasts: Array<{ message: string; tone?: string }> = [];

vi.mock('@mistriwork/kit/client/shellHost.js', () => ({
  shellById: () => null,
}));

vi.mock('@mistriwork/kit/client/core.js', () => ({
  currentEntry: () => entry,
  findTable: (id: string) => (id === 'invoice' || id === 'customer' ? { id, name: id } : null),
  refsFrom: (id: string) =>
    id === 'invoice' ? [{ from: { table: 'invoice', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } }] : [],
  refsTo: (id: string) =>
    id === 'invoice' ? [{ from: { table: 'invoice_line', columns: ['invoice_id'] }, to: { table: 'invoice', columns: ['id'] } }] : [],
  state: {
    activeConnection: 'demo',
    schema: { dialect: 'sqlite', tables: [{ id: 'customer' }, { id: 'invoice' }], foreignKeys: [{}] },
  },
  toast: (message: string, tone?: string) => {
    toasts.push({ message, tone });
  },
}));

const { buildAgentBrief, copyAgentBrief } = await import('./agentBrief.js');

afterEach(() => {
  entry = null;
  toasts.length = 0;
});

test('formats schema, table query, breakdown and record briefs with MCP calls', async () => {
  expect(buildAgentBrief()).toContain('MCP `schema_summary`: `{"connection":"demo"}`');

  entry = { kind: 'table', table: 'invoice', query: 'invoice status = open' };
  const tableText = buildAgentBrief();
  expect(tableText).toContain('## tablewalk — `invoice` query');
  expect(tableText).toContain('customer_id -> customer');
  expect(tableText).toContain('invoice_line.invoice_id');
  expect(tableText).toContain('MCP `query`: `{"connection":"demo","q":"invoice status = open"}`');

  entry = { kind: 'breakdown', table: 'invoice', query: 'invoice count by status' };
  expect(buildAgentBrief()).toContain('MCP `breakdown`: `{"connection":"demo","q":"invoice count by status"}`');

  entry = { kind: 'row', table: 'invoice', key: { id: 42 }, label: 'INV-0042' };
  const rowText = buildAgentBrief();
  expect(rowText).toContain('## tablewalk — `invoice` record');
  expect(rowText).toContain('- Key: `{"id":42}`');
  expect(rowText).toContain('- Label: INV-0042');
  expect(rowText).toContain('MCP `record`: `{"connection":"demo","table":"invoice","key":{"id":42}}`');

  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await copyAgentBrief();
  expect(writeText).toHaveBeenCalledWith(rowText);
  expect(toasts).toEqual([{ message: 'Copied brief for agent', tone: undefined }]);
});

test('includes logical database environment and sibling postures when multiple environments exist', async () => {
  const { state } = await import('@mistriwork/kit/client/core.js');
  (state as Record<string, unknown>).activeConnection = 'billing-local';
  (state as Record<string, unknown>).connections = [
    { id: 'billing-local', name: 'billing-local', writable: true },
    { id: 'billing-staging', name: 'billing-staging', writable: false },
    { id: 'billing-prod', name: 'billing-prod', writable: false, rows: false },
  ];
  try {
    entry = { kind: 'table', table: 'invoice', query: 'invoice status = open' };
    const brief = buildAgentBrief();
    expect(brief).toContain('- Environment: `billing` · `local` (writable)');
    expect(brief).toContain('`billing-staging` (staging, read-only)');
    expect(brief).toContain('`billing-prod` (prod, shape-only)');
  } finally {
    (state as Record<string, unknown>).activeConnection = 'demo';
    delete (state as Record<string, unknown>).connections;
  }
});
