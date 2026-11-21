/**
 * Fixture SQL serialization, keyless table refusals on `fixture` and `record`,
 * and `diff` opening `from` when named by its own schema's argument.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Registry, type Adapter, type DatabaseSchema } from '@mistriwork/engine/host';
import { extractFixture } from '../src/server/fixture.js';
import { runTool } from '../src/server/mcp/registry.js';

const dir = mkdtempSync(join(tmpdir(), 'tablewalk-fixture-sql-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('extractFixture qualifies non-default schemas and formats Date, bigint, Uint8Array and JSON literals', async () => {
  const schema: DatabaseSchema = {
    dialect: 'postgres',
    label: 'billing',
    readAt: '2026-11-21T00:00:00.000Z',
    foreignKeys: [],
    tables: [
      {
        id: 'billing.event',
        name: 'event',
        schema: 'billing',
        isView: false,
        columns: [
          { name: 'id', type: 'bigint', nullable: false, primaryKey: true },
          { name: 'happened_at', type: 'timestamptz', nullable: false, primaryKey: false },
          { name: 'payload', type: 'jsonb', nullable: false, primaryKey: false },
          { name: 'digest', type: 'bytea', nullable: false, primaryKey: false },
          { name: 'score', type: 'double precision', nullable: false, primaryKey: false },
        ],
      },
    ],
  };
  const row = {
    id: 9007199254740993n,
    happened_at: new Date('2026-11-21T08:30:00.000Z'),
    payload: { kind: "o'clock", seq: 9007199254740993n },
    digest: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    score: Number.NaN,
  };
  const adapter = {
    query: async () => ({ columns: ['id', 'happened_at', 'payload', 'digest', 'score'], rows: [row], total: 1 }),
  } as unknown as Adapter;

  const pgOut = await extractFixture(adapter, schema, 'billing.event', { id: 1 });
  assert.match(pgOut.sql, /INSERT INTO "billing"\."event"/);
  assert.match(
    pgOut.sql,
    /VALUES \(9007199254740993, '2026-11-21T08:30:00\.000Z', '\{"kind":"o''clock","seq":"9007199254740993"\}', '\\xdeadbeef', 'NaN'\);/,
  );

  const sqliteOut = await extractFixture(
    adapter,
    { ...schema, dialect: 'sqlite', tables: [{ ...schema.tables[0]!, id: 'event', schema: '' }] },
    'event',
    { id: 1 },
  );
  assert.match(sqliteOut.sql, /INSERT INTO "event"/);
  assert.match(sqliteOut.sql, /X'deadbeef'/);
});

test('keyless tables are refused by fixture and record, and diff honors from', async () => {
  const pathA = join(dir, 'a.db');
  const pathB = join(dir, 'b.db');
  const dbA = new DatabaseSync(pathA);
  dbA.exec(`CREATE TABLE audit_log (note TEXT); INSERT INTO audit_log VALUES ('first'), ('second');`);
  dbA.close();
  const dbB = new DatabaseSync(pathB);
  dbB.exec(`CREATE TABLE audit_log (note TEXT, extra INTEGER);`);
  dbB.close();

  const registry = new Registry();
  registry.add({ id: 'a', name: 'a', url: pathA, source: 'config' });
  registry.add({ id: 'b', name: 'b', url: pathB, source: 'config' });
  registry.setActive('a');

  try {
    for (const tool of ['fixture', 'record'] as const) {
      const res = await runTool(registry, tool, { connection: 'a', table: 'audit_log', key: {} });
      assert.equal(res.isError, true, tool);
      assert.equal(res._meta?.['tablewalk/code'], 'invalid_argument');
      assert.match(res.content[0].text, /has no primary key/);
    }

    const diffed = await runTool(registry, 'diff', { from: 'b', to: 'a' });
    assert.equal(diffed.isError, false, diffed.content[0].text);
    assert.equal(diffed.structuredContent?.from, 'b');
    assert.equal(diffed.structuredContent?.to, 'a');
  } finally {
    await registry.closeAll();
  }
});
