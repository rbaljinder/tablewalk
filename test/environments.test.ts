/**
 * Multi-environment database management across shared naming/grouping,
 * `tablewalk.json` config persistence, HTTP `/api/connections*`, MCP `openFor`
 * selectors (`db@env`, `@env`, `env`), `connections` topology matrix, cross-env
 * `diff`, schema resource briefs, and accidental production write guardrails.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '@mistriwork/engine/host';
import {
  classifyEnvTier,
  enrichConnectionsWithEnvironments,
  groupConnectionsByDatabase,
  parseEnvironmentSelector,
  resolveConnectionEnvironment,
} from '../src/shared/environments.js';
import { listEnrichedConnections, loadConfigEnvMeta, runTool, setConnectionEnvMeta } from '../src/server/mcp.js';
import { openFor } from '../src/server/mcp/toolkit.js';
import { readResource } from '../src/server/mcp/shelf.js';
import { createApp } from './support/createApp.js';

describe('shared environment model (src/shared/environments.ts)', () => {
  test('infers database, env and tier across naming conventions while keeping plain names neutral', () => {
    assert.deepEqual(resolveConnectionEnvironment({ id: '1', name: 'demo' }), {
      database: 'demo',
      tier: 'other',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '2', name: 'billing-local' }), {
      database: 'billing',
      env: 'local',
      tier: 'local',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '3', name: 'billing_staging' }), {
      database: 'billing',
      env: 'staging',
      tier: 'staging',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '4', name: 'billing.prod' }), {
      database: 'billing',
      env: 'prod',
      tier: 'prod',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '5', name: 'billing@dev' }), {
      database: 'billing',
      env: 'dev',
      tier: 'dev',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '6', name: 'billing (staging)' }), {
      database: 'billing',
      env: 'staging',
      tier: 'staging',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '7', name: 'billing [prod]' }), {
      database: 'billing',
      env: 'prod',
      tier: 'prod',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '8', name: 'prod-billing' }), {
      database: 'billing',
      env: 'prod',
      tier: 'prod',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '9', name: 'staging_billing' }), {
      database: 'billing',
      env: 'staging',
      tier: 'staging',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '10', name: 'app-ro' }), {
      database: 'app',
      env: 'replica',
      tier: 'replica',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '11', name: 'app-replica' }), {
      database: 'app',
      env: 'replica',
      tier: 'replica',
      explicit: false,
    });
    assert.deepEqual(resolveConnectionEnvironment({ id: '12', name: 'eu-west-1', database: 'billing', env: 'production' }), {
      database: 'billing',
      env: 'production',
      tier: 'prod',
      explicit: true,
    });
    assert.equal(classifyEnvTier(undefined, 'reader@db.prod.example.com:5432/shop'), 'prod');
    assert.equal(classifyEnvTier(undefined, 'app@localhost:5432/shop'), 'local');
  });

  test('parses db@env and @env selectors without misreading connection URLs', () => {
    assert.deepEqual(parseEnvironmentSelector('billing@staging'), { database: 'billing', env: 'staging' });
    assert.deepEqual(parseEnvironmentSelector('@staging'), { env: 'staging' });
    assert.equal(parseEnvironmentSelector('demo'), null);
    assert.equal(parseEnvironmentSelector('postgres://user@localhost/billing'), null);
  });

  test('orders siblings and logical database groups along the promotion pipeline and stays idempotent', () => {
    const raw = [
      { id: 'billing-prod', name: 'billing-prod', writable: false, rows: false },
      { id: 'billing-staging', name: 'billing-staging', writable: false },
      { id: 'billing-local', name: 'billing-local', writable: true },
      { id: 'billing-ro', name: 'billing-ro', writable: false },
      { id: 'demo', name: 'demo', writable: true },
    ];
    const enriched = enrichConnectionsWithEnvironments(raw);
    const local = enriched.find((c) => c.id === 'billing-local')!;
    assert.deepEqual(
      local.siblings.map((s) => [s.id, s.tier, s.writable, s.rows]),
      [
        ['billing-staging', 'staging', false, undefined],
        ['billing-ro', 'replica', false, undefined],
        ['billing-prod', 'prod', false, false],
      ],
    );
    const groups = groupConnectionsByDatabase(enriched);
    assert.deepEqual(
      groups.map((g) => [g.database, g.environments.map((e) => e.id)]),
      [
        ['billing', ['billing-local', 'billing-staging', 'billing-ro', 'billing-prod']],
        ['demo', ['demo']],
      ],
    );
    const demoAfterGroup = groups[1].environments[0];
    assert.equal(demoAfterGroup.explicit, undefined);
  });
});

describe('MCP multi-environment routing, guardrails, diff, and shelf brief', () => {
  function buildMultiEnvRegistry(t: { after(fn: () => void): void }) {
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-env-mcp-'));
    const registry = new Registry();
    t.after(async () => {
      await registry.closeAll();
      rmSync(dir, { recursive: true, force: true });
    });

    const mkDb = (filename: string, sql: string) => {
      const path = join(dir, filename);
      const db = new DatabaseSync(path);
      db.exec(sql);
      db.close();
      return path;
    };

    const localDb = mkDb(
      'billing-local.db',
      `CREATE TABLE invoice (id INTEGER PRIMARY KEY, status TEXT NOT NULL, total REAL NOT NULL, draft_note TEXT);
       INSERT INTO invoice VALUES (1, 'local-open', 100, 'wip');`,
    );
    const stagingDb = mkDb(
      'billing-staging.db',
      `CREATE TABLE invoice (id INTEGER PRIMARY KEY, status TEXT NOT NULL, total REAL NOT NULL);
       INSERT INTO invoice VALUES (1, 'staging-open', 250);`,
    );
    const prodDb = mkDb(
      'billing-prod.db',
      `CREATE TABLE invoice (id INTEGER PRIMARY KEY, status TEXT NOT NULL, total REAL NOT NULL);
       INSERT INTO invoice VALUES (1, 'prod-paid', 900);`,
    );
    const authStagingDb = mkDb(
      'auth-staging.db',
      `CREATE TABLE account (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
       INSERT INTO account VALUES (1, 'ops@example.com');`,
    );

    registry.add({ name: 'billing-local', url: localDb, writable: true, source: 'config' });
    registry.add({ name: 'billing-staging', url: stagingDb, writable: false, source: 'config' });
    registry.add({ name: 'eu-primary', url: prodDb, writable: true, source: 'config' });
    registry.add({ name: 'auth-staging', url: authStagingDb, writable: false, rows: false, source: 'config' });

    loadConfigEnvMeta(
      registry,
      JSON.stringify({
        connections: [
          { name: 'billing-local', url: localDb, writable: true },
          { name: 'billing-staging', url: stagingDb },
          { name: 'eu-primary', url: prodDb, database: 'billing', env: 'prod', writable: true },
          { name: 'auth-staging', url: authStagingDb, rows: false },
        ],
      }),
    );

    return { registry, dir, prodDb, localDb };
  }

  test('resolves db@env, @env, connection+env, and reports actionable errors on ambiguous databases or envs', async (t) => {
    const { registry } = buildMultiEnvRegistry(t);
    registry.setActive('billing-local');

    // `connections` tool returns database groups, siblings, and multi-env note.
    const listed = await runTool(registry, 'connections', {});
    assert.equal(listed.isError, false);
    const sc = listed.structuredContent!;
    assert.ok(typeof sc.note === 'string' && sc.note.includes('billing'));
    const dbs = sc.databases as Array<{ database: string; environments: Array<{ id: string; tier: string }> }>;
    assert.deepEqual(
      dbs.map((d) => [d.database, d.environments.map((e) => e.id)]),
      [
        ['billing', ['billing-local', 'billing-staging', 'eu-primary']],
        ['auth', ['auth-staging']],
      ],
    );

    // 1. `connection: "billing@staging"`
    const stagingRows = await runTool(registry, 'query', { q: 'invoice', connection: 'billing@staging' });
    assert.equal(stagingRows.isError, false, stagingRows.content[0].text);
    assert.equal(stagingRows.structuredContent?.connection, 'billing-staging');
    assert.equal((stagingRows.structuredContent!.rows as Array<{ status: string }>)[0].status, 'staging-open');

    // 2. `connection: "@prod"` resolves relative to active `billing` database (`eu-primary`)!
    const prodRows = await runTool(registry, 'query', { q: 'invoice', connection: '@prod' });
    assert.equal(prodRows.isError, false, prodRows.content[0].text);
    assert.equal(prodRows.structuredContent?.connection, 'eu-primary');
    assert.equal((prodRows.structuredContent!.rows as Array<{ status: string }>)[0].status, 'prod-paid');

    // 3. `env: "staging"` with no `connection` resolves active database's staging (`billing-staging`)
    const byEnvArg = await runTool(registry, 'query', { q: 'invoice', env: 'staging' });
    assert.equal(byEnvArg.isError, false);
    assert.equal(byEnvArg.structuredContent?.connection, 'billing-staging');

    // 4. `connection: "billing"` + `env: "prod"`
    const byDbAndEnv = await runTool(registry, 'tables', { connection: 'billing', env: 'prod' });
    assert.equal(byDbAndEnv.isError, false);
    assert.equal(byDbAndEnv.structuredContent?.connection, 'eu-primary');

    // 5. Bare `connection: "billing"` without `env` explains all available environments
    const bareDb = await runTool(registry, 'tables', { connection: 'billing' });
    assert.equal(bareDb.isError, true);
    assert.equal(bareDb._meta?.['tablewalk/code'], 'invalid_argument');
    assert.match(bareDb.content[0].text, /billing@local \(billing-local\)/);
    assert.match(bareDb.content[0].text, /billing@staging \(billing-staging\)/);
    assert.match(bareDb.content[0].text, /billing@prod \(eu-primary\)/);

    // 6. Ambiguous `@staging` when no active connection owns it (or active has no `staging`)
    await assert.rejects(
      () => openFor(registry, '@staging', { fallbackConnection: 'none' }),
      (err: Error & { code?: string }) =>
        err.code === 'invalid_argument' && err.message.includes('"billing@staging"') && err.message.includes('"auth@staging"'),
    );
  });

  test('blocks accidental implicit writes when active connection is prod, and allows explicit prod confirmation', async (t) => {
    const { registry } = buildMultiEnvRegistry(t);
    registry.setActive('eu-primary');

    // Implicit write with neither `connection` nor `env` is refused with `forbidden` and names safer sibling `billing-local`!
    const blockedInsert = await runTool(registry, 'insert', {
      table: 'invoice',
      values: { status: 'oops', total: 1 },
    });
    assert.equal(blockedInsert.isError, true);
    assert.equal(blockedInsert._meta?.['tablewalk/code'], 'forbidden');
    assert.match(blockedInsert.content[0].text, /Active connection "eu-primary" is a production environment/);
    assert.match(blockedInsert.content[0].text, /"connection": "billing-local"/);

    // Implicit `verify_ddl` on active prod is also guarded.
    const blockedVerify = await runTool(registry, 'verify_ddl', {
      sql: 'ALTER TABLE invoice ADD COLUMN memo TEXT',
    });
    assert.equal(blockedVerify.isError, true);
    assert.equal(blockedVerify._meta?.['tablewalk/code'], 'forbidden');

    // Reads on active prod still work implicitly without friction!
    const readOnProd = await runTool(registry, 'query', { q: 'invoice' });
    assert.equal(readOnProd.isError, false);
    assert.equal(readOnProd.structuredContent?.connection, 'eu-primary');

    // Explicit `env: "local"` writes cleanly to `billing-local` even while `eu-primary` is active!
    const localInsert = await runTool(registry, 'insert', {
      env: 'local',
      table: 'invoice',
      values: { status: 'local-new', total: 42 },
    });
    assert.equal(localInsert.isError, false, localInsert.content[0].text);
    assert.equal(localInsert.structuredContent?.connection, 'billing-local');

    // Explicit `connection: "eu-primary"` (or `env: "prod"`) is permitted when intentionally confirmed!
    const confirmedProd = await runTool(registry, 'insert', {
      connection: 'eu-primary',
      dryRun: true,
      table: 'invoice',
      values: { status: 'confirmed', total: 99 },
    });
    assert.equal(confirmedProd.isError, false, confirmedProd.content[0].text);
    assert.equal(confirmedProd.structuredContent?.connection, 'eu-primary');
  });

  test('diff compares @local and @prod schemas, and schema resource brief lists sibling environments', async (t) => {
    const { registry } = buildMultiEnvRegistry(t);
    registry.setActive('billing-local');

    const diffed = await runTool(registry, 'diff', { from: '@local', to: '@prod' });
    assert.equal(diffed.isError, false, diffed.content[0].text);
    assert.equal(diffed.structuredContent?.from, 'billing-local');
    assert.equal(diffed.structuredContent?.to, 'eu-primary');
    assert.equal(diffed.structuredContent?.same, false);
    const tables = diffed.structuredContent?.tables as Array<{ table: string; columnsOnlyLeft?: string[] }>;
    assert.deepEqual(tables[0].columnsOnlyLeft, ['draft_note']);

    let resourceReply: { result?: { contents: Array<{ text: string }> } } | undefined;
    await readResource(registry, { queries: [], pages: [] }, { uri: 'tablewalk://billing-local/schema' }, (ans) => {
      resourceReply = ans as typeof resourceReply;
    });
    const markdown = resourceReply!.result!.contents[0].text;
    assert.match(markdown, /- Environment: `billing` · `local` \(`billing-local`, writable\)/);
    assert.match(markdown, /`billing-staging` \(`staging`, read-only\)/);
    assert.match(markdown, /`eu-primary` \(`prod`, writable\)/);
  });

  test('CLI --mcp loads explicit database and env from tablewalk.json', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-env-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'one.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)');
    db.close();
    const cfgPath = join(dir, 'tablewalk.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        connections: [{ name: 'primary-node', url: dbPath, database: 'orders', env: 'prod' }],
      }),
    );
    const requests = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'connections', arguments: {} } },
    ]
      .map((m) => JSON.stringify(m))
      .join('\n');
    const proc = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/index.ts', '--mcp', '--config', cfgPath], {
      input: `${requests}\n`,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(proc.status, 0, proc.stderr);
    const lines = proc.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const connResult = lines.find((l) => l.id === 2)?.result?.structuredContent;
    assert.equal(connResult.connections[0].database, 'orders');
    assert.equal(connResult.connections[0].env, 'prod');
    assert.equal(connResult.connections[0].tier, 'prod');
  });
});

describe('HTTP /api/connections multi-environment enrichment and round-trip save', () => {
  test('adds, updates metadata without URL, enriches siblings, and round-trips database/env on save', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-env-http-'));
    const registry = new Registry();
    const localDb = join(dir, 'local.db');
    const stagingDb = join(dir, 'staging.db');
    for (const file of [localDb, stagingDb]) {
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT)');
      db.close();
    }
    const configFile = join(dir, 'tablewalk.json');
    registry.add({ name: 'shop-local', url: localDb, writable: true, source: 'config' });
    await registry.open('shop-local');

    const bound = { host: '127.0.0.1', port: 0, allowedHosts: [] as string[] };
    const server = createApp({ registry, bound, configPath: configFile });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    bound.port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${bound.port}`;

    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.closeAll();
      rmSync(dir, { recursive: true, force: true });
    });

    // POST /api/connections with explicit `database` & `env`
    const addRes = await fetch(`${base}/api/connections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'eu-stage', url: stagingDb, database: 'shop', env: 'staging' }),
    });
    assert.equal(addRes.status, 200);
    const addedJson = (await addRes.json()) as {
      connections: Array<{ id: string; database: string; env?: string; tier: string; siblings: Array<{ id: string }> }>;
    };
    const stageEntry = addedJson.connections.find((c) => c.id === 'eu-stage')!;
    assert.equal(stageEntry.database, 'shop');
    assert.equal(stageEntry.env, 'staging');
    assert.equal(stageEntry.tier, 'staging');
    assert.deepEqual(
      stageEntry.siblings.map((s) => s.id),
      ['shop-local'],
    );

    // POST /api/connections/update changing ONLY `env` (blank url)
    const updateRes = await fetch(`${base}/api/connections/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'eu-stage', env: 'prod' }),
    });
    assert.equal(updateRes.status, 200);
    const updatedJson = (await updateRes.json()) as typeof addedJson;
    assert.equal(updatedJson.connections.find((c) => c.id === 'eu-stage')?.tier, 'prod');

    // POST /api/connections/save persists explicit `database` and `env` to tablewalk.json
    const saveRes = await fetch(`${base}/api/connections/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: configFile }),
    });
    assert.equal(saveRes.status, 200);
    const savedDisk = JSON.parse(readFileSync(configFile, 'utf8')) as {
      connections: Array<{ name: string; database?: string; env?: string }>;
    };
    const savedStage = savedDisk.connections.find((c) => c.name === 'eu-stage')!;
    assert.equal(savedStage.database, 'shop');
    assert.equal(savedStage.env, 'prod');

    // Reloading into a fresh registry restores exact explicit metadata
    const reloaded = new Registry();
    reloaded.add({ name: 'shop-local', url: localDb, source: 'config' });
    reloaded.add({ name: 'eu-stage', url: stagingDb, source: 'config' });
    loadConfigEnvMeta(reloaded, readFileSync(configFile, 'utf8'));
    const enrichedReloaded = listEnrichedConnections(reloaded);
    assert.equal(enrichedReloaded.find((c) => c.id === 'eu-stage')?.database, 'shop');
    assert.equal(enrichedReloaded.find((c) => c.id === 'eu-stage')?.tier, 'prod');
    await reloaded.closeAll();
  });

  test('setConnectionEnvMeta clears entry when both database and env are emptied', async () => {
    const registry = new Registry();
    registry.add({ name: 'alpha', url: ':memory:', source: 'session' });
    setConnectionEnvMeta(registry, 'alpha', { database: 'core', env: 'staging' });
    assert.equal(listEnrichedConnections(registry)[0].database, 'core');
    setConnectionEnvMeta(registry, 'alpha', { database: '', env: '' });
    assert.equal(listEnrichedConnections(registry)[0].database, 'alpha');
    assert.equal(listEnrichedConnections(registry)[0].explicit, undefined);
    await registry.closeAll();
  });
});
