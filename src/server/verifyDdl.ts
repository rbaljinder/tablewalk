/**
 * Verify candidate DDL without keeping it.
 *
 * Agents writing migrations otherwise guess whether an `ALTER TABLE` parses,
 * satisfies existing rows, or introduces an unindexed foreign key. Here the
 * candidate script runs against an isolated copy (SQLite) or inside a
 * `BEGIN … ROLLBACK` transaction with tight lock/statement timeouts
 * (PostgreSQL), then diffs and lints the resulting catalog against the schema
 * as it stands now. Nothing survives the call.
 */
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refusal, renderDDL, resolveConnection, scrubSecrets, type DatabaseSchema, type Registry } from '@mistriwork/engine/host';
import { describePostgresCatalog } from '@mistriwork/engine/adapters/postgresCatalog.js';
import { PgConnectionManager } from '@mistriwork/engine/adapters/postgresPool.js';
import { refusePostgresReserved, refuseReservedText } from '@mistriwork/engine/adapters/reservedSql.js';
import { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import { quoteIdent, splitPostgres } from '@mistriwork/engine/server/migrate/database.js';
import { diffSchemas } from '../shared/diff.js';
import { lintCounts, lintSchema, type Finding } from '../shared/lint.js';
import { ToolError } from './mcp/toolkit.js';

const ESCAPE_STATEMENT =
  /^(?:commit|end|rollback|abort|begin|start\s+transaction|savepoint|release\b|vacuum\b|attach\b|detach\b|pragma\s+writable_schema|copy\b|drop\s+database\b|create\s+database\b|cluster\b|reindex\s+system\b|do\b)/i;

const SQLITE_COPY_MAX_BYTES = 64 * 1024 * 1024;

function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart();
  while (rest.startsWith('--') || rest.startsWith('/*')) {
    if (rest.startsWith('--')) {
      const nl = rest.indexOf('\n');
      rest = nl < 0 ? '' : rest.slice(nl + 1).trimStart();
    } else {
      const end = rest.indexOf('*/', 2);
      rest = end < 0 ? '' : rest.slice(end + 2).trimStart();
    }
  }
  return rest;
}

function parseStatements(raw: unknown, dialect: DatabaseSchema['dialect']): string[] {
  const joined = Array.isArray(raw)
    ? raw
        .map((s) => String(s ?? '').trim())
        .filter(Boolean)
        .join(';\n')
    : String(raw ?? '').trim();
  if (!joined) throw new ToolError('invalid_argument', 'verify_ddl: give at least one DDL statement in `sql`.');
  try {
    refuseReservedText(joined, dialect);
    if (dialect === 'postgres') refusePostgresReserved(joined, true);
  } catch (err) {
    if (err instanceof Refusal) throw new ToolError('forbidden', err.message, { cause: err });
    throw err;
  }
  const statements = splitPostgres(joined)
    .map((s) => s.trim())
    .filter((s) => stripLeadingComments(s).length > 0);
  if (!statements.length) throw new ToolError('invalid_argument', 'verify_ddl: `sql` holds only comments or whitespace.');
  for (const [i, stmt] of statements.entries()) {
    const head = stripLeadingComments(stmt);
    if (ESCAPE_STATEMENT.test(head)) {
      throw new ToolError(
        'invalid_argument',
        `Statement ${i + 1} uses transaction or database control ("${head.slice(0, 32)}…"), which verify_ddl refuses so its rollback stays whole.`,
      );
    }
    if (/\bconcurrently\b/i.test(head)) {
      throw new ToolError(
        'invalid_argument',
        `Statement ${i + 1} uses CONCURRENTLY, which cannot run inside a verification transaction. Verify the plain CREATE/DROP INDEX shape here instead.`,
      );
    }
  }
  return statements;
}

function findingKey(f: Finding): string {
  return `${f.rule}\0${f.table}\0${(f.columns ?? []).join(',')}`;
}

export async function verifyDdl(
  registry: Registry,
  id: string,
  schema: DatabaseSchema,
  rawSql: unknown,
  options: { trusted?: boolean } = {},
): Promise<Record<string, unknown>> {
  const config = registry.configOf(id);
  if (!config || config.http || (schema.dialect !== 'sqlite' && schema.dialect !== 'postgres')) {
    throw new ToolError('forbidden', `${schema.dialect} connections cannot verify DDL in this build.`);
  }
  const listed = registry.list().find((c) => c.id === id);
  if (config.hidden || listed?.hidesColumns) {
    throw new ToolError(
      'forbidden',
      `"${config.name}" restricts tables or columns ("hidden" or "blocklist"), so raw DDL verification is refused for the same reason raw SQL is.`,
    );
  }

  const statements = parseStatements(rawSql, schema.dialect);

  let after: DatabaseSchema;
  let mode: 'copy' | 'schema_only' | 'rollback';

  if (schema.dialect === 'sqlite') {
    const dir = await mkdtemp(join(tmpdir(), 'tablewalk-verify-ddl-'));
    const scratch = join(dir, 'verify.db');
    try {
      const sourceFile = registry.sqliteFile(id);
      let seededFromCopy = false;
      if (options.trusted !== false && config.rows !== false && sourceFile && sourceFile !== ':memory:') {
        const info = await stat(sourceFile).catch(() => undefined);
        if (info?.isFile() && info.size <= SQLITE_COPY_MAX_BYTES) {
          try {
            const src = new DatabaseSync(sourceFile, { readOnly: true });
            try {
              src.exec(`VACUUM INTO '${scratch.replace(/'/g, "''")}'`);
              seededFromCopy = true;
            } finally {
              src.close();
            }
          } catch {
            await copyFile(sourceFile, scratch);
            seededFromCopy = true;
          }
        }
      }
      mode = seededFromCopy ? 'copy' : 'schema_only';
      const db = new DatabaseSync(scratch);
      try {
        db.exec('PRAGMA foreign_keys = ON');
        if (!seededFromCopy) {
          /* Reconstruct the table definitions without copying row data. */
          for (const table of schema.tables) {
            if (table.isView) continue;
            db.exec(renderDDL(schema, table.id));
          }
        }
        for (const [i, stmt] of statements.entries()) {
          try {
            db.exec(stmt);
          } catch (err) {
            return {
              connection: id,
              valid: false,
              dialect: 'sqlite',
              rolledBack: true,
              mode,
              failedAt: i + 1,
              statement: stmt,
              errors: [(err as Error).message],
            };
          }
        }
        const brokenFk = db.prepare('PRAGMA foreign_key_check').all() as Array<{ table?: string; parent?: string }>;
        if (brokenFk.length) {
          const first = brokenFk[0];
          return {
            connection: id,
            valid: false,
            dialect: 'sqlite',
            rolledBack: true,
            mode,
            errors: [
              `Foreign-key check failed on "${first.table ?? '?'}" → "${first.parent ?? '?'}" (${brokenFk.length} violation${brokenFk.length === 1 ? '' : 's'}).`,
            ],
          };
        }
      } finally {
        db.close();
      }
      const reader = new SqliteAdapter(scratch, schema.label);
      try {
        after = await reader.introspect();
      } finally {
        await reader.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    if (!config.writable) {
      throw new ToolError(
        'read_only',
        `"${config.name}" is read-only. On PostgreSQL, \`verify_ddl\` runs inside a \`BEGIN … ROLLBACK\` transaction that still acquires DDL locks on live tables, ` +
          'so the connection must be marked `"writable": true` in tablewalk.json (point at a local or staging database, never production).',
      );
    }
    if (config.rows === false) {
      throw new ToolError('forbidden', `"${config.name}" is shape-only ("rows": false), so live DDL verification is refused.`);
    }
    mode = 'rollback';
    const rawTarget = registry.openableUrlOf(id) ?? config.url;
    const resolved = await resolveConnection(config.name, rawTarget, {
      secrets: options.trusted !== false,
      environment: registry.environment,
    });
    const manager = new PgConnectionManager(resolved.url, undefined, undefined, {
      readers: 1,
      writers: 1,
      minIdle: 0,
      lockTimeoutMs: 2_000,
      capMs: 5_000,
    });
    try {
      const outcome = await manager.withWriteClient(async (client) => {
        await client.query('BEGIN');
        try {
          await client.query("SET LOCAL lock_timeout = '2000ms'");
          await client.query("SET LOCAL statement_timeout = '5000ms'");
          if (config.schemas?.length) {
            await client.query(`SET LOCAL search_path TO ${config.schemas.map((s) => quoteIdent('postgres', s)).join(', ')}`);
          }
          for (const [i, stmt] of statements.entries()) {
            try {
              await client.query(stmt);
            } catch (err) {
              return {
                ok: false as const,
                failedAt: i + 1,
                statement: stmt,
                error: scrubSecrets((err as Error).message, resolved.url),
              };
            }
          }
          const catalog = await describePostgresCatalog(client, {
            schemas: config.schemas ?? [],
            label: schema.label,
            dialect: 'postgres',
          });
          return { ok: true as const, catalog };
        } finally {
          await client.query('ROLLBACK').catch(() => {});
        }
      }, true);

      if (!outcome.ok) {
        return {
          connection: id,
          valid: false,
          dialect: 'postgres',
          rolledBack: true,
          mode,
          failedAt: outcome.failedAt,
          statement: outcome.statement,
          errors: [outcome.error],
        };
      }
      after = outcome.catalog;
    } finally {
      await manager.close().catch(() => {});
    }
  }

  const { left: _left, right: _right, ...diff } = diffSchemas(schema, after);
  const beforeFindings = lintSchema(schema);
  const afterFindings = lintSchema(after);
  const beforeKeys = new Set(beforeFindings.map(findingKey));
  const afterKeys = new Set(afterFindings.map(findingKey));
  const introduced = afterFindings.filter((f) => !beforeKeys.has(findingKey(f)));
  const resolvedCount = beforeFindings.filter((f) => !afterKeys.has(findingKey(f))).length;
  const rules: Record<string, { severity: string; why: string }> = {};
  for (const f of introduced) rules[f.rule] ??= { severity: f.severity, why: f.why };

  return {
    connection: id,
    valid: true,
    dialect: schema.dialect,
    rolledBack: true,
    mode,
    statements: statements.length,
    same: diff.same,
    diff: diff.tables,
    introducedLint: {
      counts: lintCounts(introduced),
      rules,
      findings: introduced.map(({ why: _why, ...rest }) => rest),
    },
    ...(resolvedCount ? { resolvedLintCount: resolvedCount } : {}),
    note: 'Verified and rolled back; the live schema was not changed.',
  };
}
