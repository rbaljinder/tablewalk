import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { Registry } from '@mistriwork/engine/host';
import { makeDemoDatabase } from './make-demo-db.js';
import { redactedColumnsByTable } from '../src/server/mask.js';
import { analyzePostgresActivityContention } from '../src/server/perf.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'src/server/index.ts');

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, TABLEWALK_OPEN: '0', MISTRI_OPEN: '0', DATABASE_URL: '', ...env },
  });
}

describe('1.0.0-rc.22 features', () => {
  test('redactedColumnsByTable identifies PII and explicit columns while sparing primary and foreign keys', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-rc22-mask-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'demo.db');
    makeDemoDatabase(dbPath);

    const registry = new Registry();
    t.after(() => registry.closeAll());
    const added = registry.add({ name: 'demo', url: dbPath, source: 'config' });
    const { schema } = await registry.open(added.id);

    const mapped = redactedColumnsByTable(schema, { columns: ['invoice.status', 'product.name'] });
    assert.ok(mapped.customer?.includes('email'), 'customer.email should be flagged as masked');
    assert.ok(mapped.customer?.includes('name'), 'customer.name should be flagged on person/customer table');
    assert.ok(!mapped.customer?.includes('id'), 'primary key customer.id must never be masked');
    assert.ok(!mapped.customer?.includes('country_code'), 'FK endpoint customer.country_code must never be masked');
    assert.ok(mapped.employee?.includes('first_name'));
    assert.ok(mapped.employee?.includes('last_name'));
    assert.ok(mapped.product?.includes('name'), 'explicit product.name in redactColumns should be flagged');
  });

  test('analyzePostgresActivityContention flags blocked PIDs and long-running sessions without leaking blocked tables', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-rc22-perf-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'demo.db');
    makeDemoDatabase(dbPath);

    const registry = new Registry();
    t.after(() => registry.closeAll());
    const added = registry.add({ name: 'demo', url: dbPath, source: 'config' });
    const { schema } = await registry.open(added.id);

    const findings = analyzePostgresActivityContention(schema, 'billing-prod', [
      {
        pid: 4102,
        state: 'active',
        wait_event_type: 'Lock',
        wait_event: 'transactionid',
        blocking_pids: [3990],
        age_seconds: 14.2,
        schema_name: 'public',
        table_name: 'invoice',
      },
      {
        pid: 3990,
        state: 'idle in transaction',
        wait_event_type: 'Client',
        wait_event: 'ClientRead',
        blocking_pids: [],
        age_seconds: 65,
        schema_name: 'public',
        table_name: 'invoice',
      },
      {
        pid: 5500,
        state: 'active',
        blocking_pids: [5501],
        age_seconds: 20,
        schema_name: 'public',
        table_name: 'secret_unlisted_audit',
      },
    ]);

    assert.equal(findings.length, 2, 'unlisted/blocked table must be excluded');
    assert.equal(findings[0].rule, 'lock-contention');
    assert.equal(findings[0].severity, 'high');
    assert.match(findings[0].message, /PID 4102.*blocked for 14s on invoice waiting on PID 3990/);
    assert.ok(findings[0].suggestedSql?.includes('pg_blocking_pids'));

    assert.equal(findings[1].rule, 'long-running-query');
    assert.equal(findings[1].severity, 'medium');
    assert.match(findings[1].message, /PID 3990.*"idle in transaction" for 65s/);
  });

  test('CLI --check verifies multi-environment connections, guardrails, JSON/Markdown formats, and non-zero failure exit', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-rc22-check-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const localDb = join(dir, 'local.db');
    const stagingDb = join(dir, 'staging.db');
    makeDemoDatabase(localDb);
    makeDemoDatabase(stagingDb);

    const okConfig = join(dir, 'ok.json');
    writeFileSync(
      okConfig,
      JSON.stringify({
        environments: {
          local: { writable: true },
          staging: { redact: true, maxRows: 2500, timeoutMs: 4000 },
        },
        connections: [
          { name: 'billing-local', database: 'billing', env: 'local', url: localDb },
          { name: 'billing-staging', database: 'billing', env: 'staging', url: stagingDb },
        ],
      }),
    );

    const jsonRun = runCli(['--config', okConfig, '--check', '--format', 'json']);
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const parsed = JSON.parse(jsonRun.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.count, 2);
    assert.equal(parsed.passed, 2);
    assert.equal(parsed.connections[0].target, 'billing@local');
    assert.ok(parsed.connections[0].guardrails.includes('writable'));
    assert.equal(parsed.connections[1].target, 'billing@staging');
    assert.ok(parsed.connections[1].guardrails.includes('redact'));
    assert.ok(parsed.connections[1].guardrails.includes('maxRows:2500'));

    const mdRun = runCli(['--config', okConfig, '--check', '--format', 'md']);
    assert.equal(mdRun.status, 0, mdRun.stderr);
    assert.match(mdRun.stdout, /\| `billing@local` \| sqlite \| ok \|/);
    assert.match(mdRun.stdout, /\| `billing@staging` \| sqlite \| ok \|/);

    const badConfig = join(dir, 'bad.json');
    writeFileSync(
      badConfig,
      JSON.stringify({
        connections: [
          { name: 'billing-local', database: 'billing', env: 'local', url: localDb },
          { name: 'billing-broken', database: 'billing', env: 'prod', url: 'postgres://nobody:${MISSING_PROD_SECRET}@127.0.0.1:1/db' },
        ],
      }),
    );
    const badRun = runCli(['--config', badConfig, '--check', '--format', 'json']);
    assert.equal(badRun.status, 1);
    const badParsed = JSON.parse(badRun.stdout);
    assert.equal(badParsed.ok, false);
    assert.equal(badParsed.passed, 1);
    assert.equal(badParsed.failed, 1);
  });

  test('CLI --export agent prints a compact operational brief with connections, hubs, FKs, and tailored commands', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-rc22-export-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'demo.db');
    makeDemoDatabase(dbPath);

    const res = runCli([dbPath, '--export', 'agent']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /# Database brief:/);
    assert.match(res.stdout, /## Connections & guardrails/);
    assert.match(res.stdout, /## Schema orientation/);
    assert.match(res.stdout, /\*\*Deepest walk:\*\*/);
    assert.match(res.stdout, /## Key tables/);
    assert.match(res.stdout, /`invoice`/);
    assert.match(res.stdout, /## Fast agent queries/);
    assert.match(res.stdout, /--format tsv/);
  });
});
