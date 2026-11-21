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

/**
 * Only schema-level DDL statements may run inside `verify_ddl`.
 *
 * A denylist of transaction/escape verbs misses statements like
 * `PREPARE TRANSACTION`, `SET LOCAL statement_timeout = 0`, or
 * `SELECT setval(...)`. Requiring an explicit object-DDL head (`CREATE`,
 * `ALTER`, `DROP`, `COMMENT ON` on schema objects) keeps transactions, session
 * parameters, sequences, cluster objects, and arbitrary queries closed by
 * construction.
 */
const FORBIDDEN_DDL_TARGET =
  /^(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:DATABASE|TABLESPACE|ROLE|USER|GROUP|SYSTEM|SUBSCRIPTION|SERVER|USER\s+MAPPING|FOREIGN\s+DATA\s+WRAPPER|EVENT\s+TRIGGER|OWNED)\b/i;

const ALLOWED_DDL_HEAD =
  /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|UNIQUE|MATERIALIZED|VIRTUAL)\s+)*(?:TABLE|INDEX|VIEW|TRIGGER|TYPE|DOMAIN|SEQUENCE|SCHEMA|EXTENSION|FUNCTION|PROCEDURE|AGGREGATE|RULE|POLICY|STATISTICS|COLLATION|CAST|OPERATOR|PUBLICATION|TEXT\s+SEARCH)\b|ALTER\s+(?:TABLE|INDEX|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|DOMAIN|SCHEMA|FUNCTION|PROCEDURE|AGGREGATE|POLICY|RULE|STATISTICS|COLLATION|OPERATOR|PUBLICATION|TEXT\s+SEARCH)\b|DROP\s+(?:TABLE|INDEX|VIEW|MATERIALIZED\s+VIEW|TRIGGER|TYPE|DOMAIN|SEQUENCE|SCHEMA|EXTENSION|FUNCTION|PROCEDURE|AGGREGATE|POLICY|RULE|STATISTICS|COLLATION|CAST|OPERATOR|PUBLICATION|TEXT\s+SEARCH)\b|COMMENT\s+ON\s+(?:TABLE|COLUMN|INDEX|VIEW|MATERIALIZED\s+VIEW|CONSTRAINT|TRIGGER|TYPE|DOMAIN|SEQUENCE|SCHEMA|FUNCTION|PROCEDURE|AGGREGATE|POLICY|RULE|STATISTICS|COLLATION|CAST|OPERATOR|EXTENSION)\b)/i;

/**
 * PostgreSQL routines and transaction commands whose effects survive `ROLLBACK`
 * or bypass the verification timeout even if embedded in a `DEFAULT`, index
 * expression, or `CREATE FUNCTION` body.
 */
const PG_NON_TRANSACTIONAL_BODY =
  /\b(?:prepare\s+transaction|commit\s+prepared|rollback\s+prepared|setval|pg_sleep|pg_sleep_for|pg_sleep_until|pg_advisory_lock\w*|pg_try_advisory_lock\w*|pg_advisory_unlock\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|dblink\w*|lo_import|lo_export|lo_create|lo_unlink)\b/i;

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

/**
 * Remove SQL comments so embedded `--` or `/* ... *\/` between keywords
 * (`CREATE /* x *\/ DATABASE`) cannot fool head normalization.
 */
function stripAllComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      out += ' ';
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      out += ' ';
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Split a SQLite DDL script into individual statements while keeping
 * `CREATE [TEMP|TEMPORARY] TRIGGER … BEGIN … [CASE … END] … END` intact across
 * the semicolons inside its trigger body.
 */
export function splitSqlite(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  let wordIndex = 0;
  let sawCreate = false;
  let inCreateTrigger = false;
  let triggerBlockDepth = 0;

  const isIdentChar = (c: string) => /[A-Za-z0-9_$]/.test(c);

  const resetStmt = () => {
    wordIndex = 0;
    sawCreate = false;
    inCreateTrigger = false;
    triggerBlockDepth = 0;
  };

  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl < 0 ? sql.length : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '[') {
      const close = sql.indexOf(']', i + 1);
      i = close < 0 ? sql.length : close + 1;
      continue;
    }
    if (ch === ';' && triggerBlockDepth === 0) {
      const piece = sql.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
      resetStmt();
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < sql.length && isIdentChar(sql[end])) end++;
      const upper = sql.slice(i, end).toUpperCase();
      if (wordIndex === 0) {
        if (upper === 'CREATE') sawCreate = true;
      } else if (sawCreate && !inCreateTrigger && triggerBlockDepth === 0) {
        if (upper === 'TEMP' || upper === 'TEMPORARY') {
          /* Still in CREATE TEMP TRIGGER header. */
        } else if (upper === 'TRIGGER') {
          inCreateTrigger = true;
        } else {
          sawCreate = false;
        }
      } else if (inCreateTrigger) {
        if (triggerBlockDepth === 0 && upper === 'BEGIN') {
          triggerBlockDepth = 1;
        } else if (triggerBlockDepth > 0 && upper === 'CASE') {
          triggerBlockDepth++;
        } else if (triggerBlockDepth > 0 && upper === 'END') {
          triggerBlockDepth--;
          if (triggerBlockDepth === 0) {
            inCreateTrigger = false;
          }
        }
      }
      wordIndex++;
      i = end;
      continue;
    }
    i++;
  }

  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
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
  const rawList = dialect === 'sqlite' ? splitSqlite(joined) : splitPostgres(joined);
  const statements = rawList.map((s) => s.trim()).filter((s) => stripLeadingComments(s).length > 0);
  if (!statements.length) throw new ToolError('invalid_argument', 'verify_ddl: `sql` holds only comments or whitespace.');

  for (const [i, stmt] of statements.entries()) {
    const uncommented = stripAllComments(stmt).trim();
    const normalizedHead = uncommented.replace(/\s+/g, ' ');
    const preview = stripLeadingComments(stmt).replace(/\s+/g, ' ').slice(0, 40);

    if (FORBIDDEN_DDL_TARGET.test(normalizedHead) || !ALLOWED_DDL_HEAD.test(normalizedHead)) {
      throw new ToolError(
        'invalid_argument',
        `Statement ${i + 1} ("${preview}…") is not schema DDL. verify_ddl accepts only CREATE, ALTER, DROP, and COMMENT ON schema objects (tables, indexes, views, triggers, types, domains, sequences, schemas, functions, policies) and refuses transaction, session, sequence-value, or database-level commands.`,
      );
    }
    if (/\bconcurrently\b/i.test(uncommented)) {
      throw new ToolError(
        'invalid_argument',
        `Statement ${i + 1} uses CONCURRENTLY, which cannot run inside a verification transaction. Verify the plain CREATE/DROP INDEX shape here instead.`,
      );
    }
    if (dialect === 'postgres') {
      const badCall = PG_NON_TRANSACTIONAL_BODY.exec(uncommented);
      if (badCall) {
        throw new ToolError(
          'invalid_argument',
          `Statement ${i + 1} uses "${badCall[0]}", which has non-transactional or session-escaping effects in PostgreSQL and is refused by verify_ddl.`,
        );
      }
      if (/^ALTER\s+TABLE\b/i.test(normalizedHead) && /\bnextval\s*\(/i.test(uncommented)) {
        throw new ToolError(
          'invalid_argument',
          `Statement ${i + 1} calls nextval() inside ALTER TABLE, which advances sequences outside rollback in PostgreSQL. Verify with GENERATED BY DEFAULT AS IDENTITY or a separate CREATE SEQUENCE instead.`,
        );
      }
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
          if (config.schemas?.length) {
            await client.query(`SET LOCAL search_path TO ${config.schemas.map((s) => quoteIdent('postgres', s)).join(', ')}`);
          }
          for (const [i, stmt] of statements.entries()) {
            try {
              await client.query("SET LOCAL lock_timeout = '2000ms'");
              await client.query("SET LOCAL statement_timeout = '5000ms'");
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
          /* Prove the backend is still inside our transaction block before claiming rollback. */
          await client.query('SAVEPOINT __tablewalk_verify_ddl_fence');
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
