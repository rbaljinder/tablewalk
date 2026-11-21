/** The query modal: starts from the line handed in, Enter runs a flattened line, Escape hands nothing on. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { state } from '@mistriwork/kit/client/core.js';
import { AskDialog } from './Ask.js';

afterEach(() => {
  cleanup();
  const s = state as Record<string, unknown>;
  delete s.activeConnection;
  delete s.connections;
  s.schema = { tables: [], foreignKeys: [] };
});

test('Enter runs the line, flattened, and closes; a blank line runs nothing', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const onClose = vi.fn();
  render(<AskDialog initial="invoice count by status" onRun={onRun} onClose={onClose} />);
  const box = screen.getByRole('textbox', { name: 'Query' });
  await waitFor(() => expect(box).toHaveFocus());
  expect(screen.getByRole('dialog', { name: 'Write a query' })).toBeInTheDocument();
  await user.clear(box);
  await user.keyboard('{Enter}');
  expect(onRun).not.toHaveBeenCalled();
  await user.type(box, 'invoice  where total > 100{Shift>}{Enter}{/Shift}sort total');
  await user.keyboard('{Enter}');
  expect(onRun).toHaveBeenCalledWith('invoice where total > 100 sort total');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape cancels without running', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const onClose = vi.fn();
  render(<AskDialog initial="customer" onRun={onRun} onClose={onClose} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Query' })).toHaveFocus());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onRun).not.toHaveBeenCalled();
});

test('renders active environment and masked badge plus live query/breakdown preview', async () => {
  const user = userEvent.setup();
  const s = state as Record<string, unknown>;
  s.activeConnection = 'billing-staging';
  s.connections = [{ id: 'billing-staging', name: 'billing-staging', database: 'billing', env: 'staging', redactsRows: true }];
  s.schema = {
    dialect: 'sqlite',
    label: 'billing',
    readAt: '2026-11-21T00:00:00Z',
    tables: [
      {
        id: 'invoice',
        name: 'invoice',
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'status', type: 'text', nullable: false, primaryKey: false, allowed: ['open', 'paid'] },
          { name: 'total', type: 'numeric', nullable: false, primaryKey: false },
        ],
      },
    ],
    foreignKeys: [],
  };

  render(<AskDialog initial="invoice count by status" onRun={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText('Target: billing')).toBeInTheDocument();
  expect(screen.getByText('staging')).toBeInTheDocument();
  expect(screen.getByText('masked')).toBeInTheDocument();
  expect(screen.getByText('Breakdown over invoice')).toBeInTheDocument();

  const box = screen.getByRole('textbox', { name: 'Query' });
  await waitFor(() => expect(box).toHaveFocus());
  await user.clear(box);
  await user.type(box, 'invoice status = open limit 5');
  expect(document.querySelector('.ask-preview')?.textContent).toMatch(/invoice/i);
});
