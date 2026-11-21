/**
 * Structured, zero-PII JSONL audit log for MCP and CLI tool executions.
 *
 * Loaded on demand only when `--audit-log <path|stderr>` or `TABLEWALK_AUDIT_LOG`
 * is set, keeping plain CLI cold-start module counts untouched.
 *
 * Security invariant: audit entries record ONLY operational metadata (timestamp,
 * transport, connection/database/env, tool name, status/error code, wall ms,
 * row-movement counts, remaining row budget, redaction/dryRun flags) — NEVER row
 * values, query literals, raw SQL text, or connection credentials.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface AuditLogRecord {
  ts: string;
  via: 'mcp' | 'console';
  tool: string;
  connection?: string;
  database?: string;
  env?: string;
  tier?: string;
  fanout?: number;
  ok: boolean;
  errorCode?: string;
  ms: number;
  rowsRead?: number;
  rowsWritten?: number;
  rowsDeleted?: number;
  rowsRemaining?: number;
  redacted?: boolean;
  dryRun?: boolean;
}

export function createAuditLogger(spec: string): (record: AuditLogRecord) => void {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error('Audit log target must be a file path or "stderr".');
  }
  const toStderr = trimmed === 'stderr' || trimmed === '-';
  const targetPath = toStderr ? '' : resolve(trimmed);
  if (!toStderr) {
    mkdirSync(dirname(targetPath), { recursive: true });
  }

  return (record: AuditLogRecord) => {
    const line = `${JSON.stringify(record)}\n`;
    if (toStderr) {
      process.stderr.write(line);
      return;
    }
    try {
      appendFileSync(targetPath, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* Never crash a live MCP session if the audit disk fills; report to stderr once per failure. */
      process.stderr.write(`tablewalk: failed to append audit log entry to ${targetPath}\n`);
    }
  };
}
