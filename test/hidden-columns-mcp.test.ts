/**
 * A connection's `"hidden"` in the config file, held by the database MCP: every reading tool answers nothing hidden,
 * and a query, a statement or a breakdown that names a hidden column is refused rather than answered. (The HTTP half of
 * the claim is the engine's, asserted where the generic endpoints are.)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '@mistriwork/engine/host';
import { clearJournal } from '@mistriwork/engine/server/journal.js';
import { runTool } from '../src/server/mcp/registry.js';

const HASH = 'HASH_SENTINEL_7f3a';
const SECRET = 'SECRET_SENTINEL_91c2';
const said = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
/** An answer names no hidden column and carries no hidden value. */
const clean = (value: unknown, where = '') =>
  assert.doesNotMatch(said(value), /password_hash|api_secret|HASH_SENTINEL|SECRET_SENTINEL/, where);
/** A refusal may repeat the name the request sent, as a column that is not there; never a value. */
const valueFree = (value: unknown, where = '') => assert.doesNotMatch(said(value), /HASH_SENTINEL|SECRET_SENTINEL/, where);

function database(directory: string): string {
  const file = join(directory, 'accounts.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, password_hash TEXT, api_secret TEXT);
    CREATE TABLE note (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES account(id), body TEXT, status TEXT, draft_secret TEXT);
    INSERT INTO account VALUES (1, 'Ada', '${HASH}', '${SECRET}'), (2, 'Grace', '${HASH}', '${SECRET}');
    INSERT INTO note VALUES (1, 1, 'First note', 'open', '${SECRET}'), (2, 1, 'Second note', 'done', '${SECRET}');`);
  db.close();
  return file;
}

test('a connection\'s "hidden" covers every MCP tool, and refuses raw SQL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-hidden-mcp-'));
  const id = 'hidden-accounts';
  const registry = new Registry();
  registry.add({
    id,
    name: 'Accounts',
    url: database(directory),
    source: 'config',
    writable: true,
    hidden: { account: ['password_hash'], '*': ['*_secret'] },
  });
  registry.setActive(id);
  await registry.open(id);
  try {
    for (const [name, args] of [
      ['table', { table: 'account' }],
      ['tables', {}],
      ['schema_summary', {}],
      ['record', { table: 'account', key: { id: 1 } }],
      ['query', { q: 'account' }],
      ['profile', { table: 'account' }],
      ['find', { q: HASH }],
      ['find', { q: 'password' }],
    ] as const) {
      const answer = await runTool(registry, name, { connection: id, ...args });
      clean(answer, `${name} ${JSON.stringify(args)}`);
    }
    for (const [name, args] of [
      ['query', { q: `account password_hash = ${HASH}` }],
      ['query', { q: 'account sort api_secret' }],
      ['sql', { statement: 'SELECT password_hash FROM account' }],
      ['breakdown', { q: 'account count by password_hash' }],
    ] as const) {
      const answer = await runTool(registry, name, { connection: id, ...args });
      valueFree(answer, `${name} ${JSON.stringify(args)}`);
      assert.ok(
        answer.isError || (answer.structuredContent as { errors?: unknown[] } | undefined)?.errors?.length,
        `${name} ${JSON.stringify(args)} answered: ${answer.content[0]?.text.slice(0, 200)}`,
      );
    }
  } finally {
    await registry.closeAll();
    clearJournal(id);
    rmSync(directory, { recursive: true, force: true });
  }
});
