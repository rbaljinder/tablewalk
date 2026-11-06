/*
 * `tablewalk journal` makes the store a writable connection's Undo history is kept in: once, on the connection a config
 * marks writable, and nowhere else. Opening a connection makes nothing, so this command is the only way the browser's
 * Undo outlives its process.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/server/index.ts', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], { encoding: 'utf8' });

const directory = mkdtempSync(join(tmpdir(), 'tablewalk-journal-'));
after(() => rmSync(directory, { recursive: true, force: true }));

function database(name: string): string {
  const file = join(directory, `${name}.db`);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT)');
  db.close();
  return file;
}

function config(name: string, file: string, writable: boolean): string {
  const path = join(directory, `${name}.json`);
  writeFileSync(path, JSON.stringify({ connections: [{ name, url: file, writable }] }));
  return path;
}

const reserved = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '\\_\\_mistri\\_undo\\_%' ESCAPE '\\' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
};

test('a writable connection gets the store once, and the same command again changes nothing', () => {
  const file = database('shop');
  const given = config('shop', file, true);
  assert.deepEqual(reserved(file), []);
  const first = run('journal', '--config', given);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /shop: Undo journal made/);
  assert.deepEqual(reserved(file), ['__mistri_undo_entry', '__mistri_undo_meta']);
  const again = run('journal', '--config', given);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /shop: Undo journal already in place/);
});

test('a read-only connection, or a database named on the command line, is refused and left alone', () => {
  const file = database('ledger');
  const readOnly = run('journal', '--config', config('ledger', file, false));
  assert.equal(readOnly.status, 2);
  assert.match(readOnly.stderr, /read-only/);
  const named = run('journal', '--no-config', file);
  assert.equal(named.status, 2);
  assert.match(named.stderr, /always read-only/);
  assert.deepEqual(reserved(file), []);
});
