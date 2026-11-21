/** The agent console: the tools listed with their badges, a call made by hand, and the live MCP trail. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const calls: Array<Record<string, unknown>> = [];
let mockActivity: Record<string, unknown> = { seq: 0, calls: [], egress: {}, mcpEndpoint: null };
const refreshUndo = vi.fn();

vi.mock('@mistriwork/kit/client/shellMode.js', () => ({
  shell: () => ({ undo: { refresh: refreshUndo } }),
}));

vi.mock('@mistriwork/kit/client/core.js', () => ({
  state: { activeConnection: 'demo' },
  toast: () => {},
  trapFocus: () => () => {},
  api: async (path: string, body: Record<string, unknown>) => {
    if (path === '/api/agent/tools') {
      return {
        tools: [
          {
            name: 'query',
            description: 'Run a query.',
            annotations: { title: 'Query', readOnlyHint: true },
            inputSchema: { properties: { q: { type: 'string', description: 'the line' }, limit: { type: 'number' } }, required: ['q'] },
          },
          {
            name: 'export',
            description: 'Write a file.',
            annotations: { title: 'Export to a file', readOnlyHint: false, destructiveHint: false },
            inputSchema: { properties: { query: { type: 'string' } } },
          },
          {
            name: 'revert',
            description: 'Undo a write.',
            annotations: { title: 'Undo the last write', readOnlyHint: false, destructiveHint: true },
            inputSchema: {
              properties: {
                confirm: { type: 'boolean' },
                expectedId: { type: 'integer' },
                keys: { type: 'array', items: { type: 'object' } },
                tables: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          {
            name: 'update_row',
            description: 'Change a row.',
            annotations: { destructiveHint: true },
            inputSchema: { properties: { key: { type: 'object' } } },
          },
        ],
      };
    }
    if (path === '/api/agent/activity') return mockActivity;
    calls.push(body);
    return {
      structuredContent: {
        path: '/tmp/tablewalk-exports/demo.csv',
        rows: [{ id: 1, route: '/users/1', link: '/demo/customer/~1' }],
        stats: { rowsRead: 1, ms: 4 },
      },
      content: [{ text: 'x' }],
    };
  },
}));
const { AgentConsole } = await import('./AgentConsole.js');

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <div className="agent-console">
        <AgentConsole onClose={onClose} />
      </div>
    </QueryClientProvider>,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  mockActivity = { seq: 0, calls: [], egress: {}, mcpEndpoint: null };
  refreshUndo.mockClear();
});

test('lists the tools with what they may do, calls with typed arguments, and links only link fields', async () => {
  const user = userEvent.setup();
  draw();
  const options = await screen.findAllByRole('option');
  expect(options).toHaveLength(4);
  expect(within(options[0]).getByText('read-only')).toBeInTheDocument();
  expect(within(options[1]).getByText('writes file')).toBeInTheDocument();
  expect(within(options[1]).queryByText('writes')).toBeNull();
  expect(within(options[3]).getByText('destructive')).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Query');
  expect(screen.getByText('required')).toBeInTheDocument();
  await user.type(screen.getByRole('textbox', { name: 'q' }), 'customer');
  await user.type(screen.getByRole('textbox', { name: 'limit' }), '5');
  await user.click(screen.getByRole('button', { name: 'Call tool' }));
  await screen.findByText('rowsRead 1');
  expect(calls).toEqual([{ name: 'query', arguments: { q: 'customer', limit: 5 } }]);
  expect(document.querySelector('.agent-answer')).toHaveTextContent('"rowsRead": 1');
  expect(screen.getByRole('button', { name: 'open /demo/customer/~1' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /tablewalk-exports/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /\/users\/1/ })).toBeNull();
  expect(document.querySelector('.agent-transcript h4')).toHaveTextContent('This session — 1 call · 1 row read');
});

test('coerces integer and array arguments and rejects non-JSON objects and arrays', async () => {
  const user = userEvent.setup();
  draw();
  await screen.findAllByRole('option');
  await user.click(screen.getByRole('option', { name: /revert/ }));
  await user.type(screen.getByRole('textbox', { name: 'confirm' }), 'true');
  await user.type(screen.getByRole('textbox', { name: 'expectedId' }), '7');
  fireEventInput(screen.getByRole('textbox', { name: 'keys (json)' }), '[{"id": 1}, {"id": 2}]');
  fireEventInput(screen.getByRole('textbox', { name: 'tables (json)' }), 'invoice, customer');
  await user.click(screen.getByRole('button', { name: 'Call tool' }));
  await screen.findByText('rowsRead 1');
  expect(calls).toEqual([
    {
      name: 'revert',
      arguments: {
        confirm: true,
        expectedId: 7,
        keys: [{ id: 1 }, { id: 2 }],
        tables: ['invoice', 'customer'],
      },
    },
  ]);

  calls.length = 0;
  await user.click(screen.getByRole('option', { name: /update_row/ }));
  await user.type(screen.getByRole('textbox', { name: 'key (json)' }), '{{not json');
  await user.click(screen.getByRole('button', { name: 'Call tool' }));
  expect(document.querySelector('.agent-error')).toHaveTextContent('"key" is not JSON: {not json');
  expect(calls).toEqual([]);
});

test('shows the live MCP trail, endpoint URL, dry-run badge and refreshes Undo on external MCP writes', async () => {
  mockActivity = {
    seq: 2,
    egress: { demo: 3 },
    mcpEndpoint: 'http://localhost:4111/mcp',
    calls: [
      {
        seq: 2,
        via: 'mcp',
        tool: 'insert',
        args: { table: 'customer', dryRun: true },
        ms: 6,
        isError: false,
        dryRun: true,
        undoId: 9,
        answer: {
          isError: false,
          structuredContent: {
            connection: 'demo',
            dryRun: true,
            link: '/demo/customer/~42',
            stats: { ms: 6, rowsWritten: 0 },
          },
          content: [{ text: '{"dryRun":true}' }],
        },
      },
    ],
  };
  const user = userEvent.setup();
  draw();
  await screen.findAllByRole('option');
  expect(await screen.findByRole('button', { name: 'MCP http://localhost:4111/mcp' })).toBeInTheDocument();
  expect(document.querySelector('.agent-live-trail h4')).toHaveTextContent('Live MCP trail — 1 call · 3 rows read');
  expect(refreshUndo).toHaveBeenCalledTimes(1);
  await user.click(within(document.querySelector('.agent-live-trail') as HTMLElement).getByRole('button'));
  expect(await screen.findByRole('button', { name: 'open /demo/customer/~42' })).toBeInTheDocument();
});

function fireEventInput(node: HTMLElement, value: string) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}

test('target connection bar displays environment/posture badges and forwards pinned connection to /api/agent/call', async () => {
  const user = userEvent.setup();
  const { state } = await import('@mistriwork/kit/client/core.js');
  (state as Record<string, unknown>).activeConnection = 'billing-local';
  (state as Record<string, unknown>).connections = [
    { id: 'billing-local', name: 'billing-local', writable: true },
    { id: 'billing-staging', name: 'billing-staging', writable: false },
    { id: 'billing-prod', name: 'billing-prod', writable: false, rows: false },
  ];
  try {
    draw();
    await screen.findAllByRole('option');
    const targetGroup = screen.getByRole('group', { name: 'Target connection' });
    expect(within(targetGroup).getByText('writable')).toBeInTheDocument();
    expect(within(targetGroup).getByText('shape-only')).toBeInTheDocument();

    await user.click(within(targetGroup).getByRole('button', { name: /billing-staging/ }));
    await user.type(screen.getByRole('textbox', { name: 'q' }), 'customer');
    await user.click(screen.getByRole('button', { name: 'Call tool' }));
    await screen.findByText('rowsRead 1');
    expect(calls).toEqual([{ name: 'query', arguments: { q: 'customer', connection: 'billing-staging' } }]);
  } finally {
    (state as Record<string, unknown>).activeConnection = 'demo';
    delete (state as Record<string, unknown>).connections;
  }
});
