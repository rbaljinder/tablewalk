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
