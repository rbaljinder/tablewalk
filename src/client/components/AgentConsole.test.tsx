/** The agent console: the tools listed with their badges, a call made by hand, the answer as an agent gets it. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const calls: Array<Record<string, unknown>> = [];
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

function fireEventInput(node: HTMLElement, value: string) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}
