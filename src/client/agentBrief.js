/**
 * "Copy brief for agent": a compact Markdown handoff card for whatever room is
 * on screen — connection id, table, key or active query, foreign keys in both
 * directions, deep link, and the exact MCP tool call to pick up from there.
 */
import { currentEntry, findTable, refsFrom, refsTo, state, toast } from '@mistriwork/kit/client/core.js';
import { shellById } from '@mistriwork/kit/client/shellHost.js';
import { say } from './copy/workbench/agentBrief.js';

/** Build the Markdown brief for the current Workbench view without touching the clipboard (exported for unit tests). */
export function buildAgentBrief() {
  const conn = state.activeConnection ?? 'default';
  const dialect = state.schema?.dialect ?? 'sql';
  const entry = currentEntry();
  const link = typeof location !== 'undefined' ? `${location.pathname}${location.search}` : `/${encodeURIComponent(conn)}`;

  if (entry && (entry.kind === 'row' || (entry.kind === 'page' && entry.key))) {
    const tableId = entry.table;
    const keyJson = JSON.stringify(entry.key ?? {});
    const out = refsFrom(tableId).map((fk) => `${fk.from.columns.join(', ')} -> ${fk.to.table}`);
    const back = refsTo(tableId).map((fk) => `${fk.from.table}.${fk.from.columns.join(', ')}`);
    const lines = [
      say('headingRecord', { table: tableId }),
      say('lineConnection', { connection: conn, dialect }),
      say('lineKey', { key: keyJson }),
      ...(entry.label ? [say('lineLabel', { label: String(entry.label) })] : []),
      say('lineLink', { link }),
      ...(out.length ? [say('linePointsAt', { targets: out.join('; ') })] : []),
      ...(back.length ? [say('linePointedAtBy', { sources: back.slice(0, 8).join('; ') })] : []),
      say('lineMcpCall', {
        tool: 'record',
        args: JSON.stringify({ connection: conn, table: tableId, key: entry.key ?? {} }),
      }),
    ];
    return lines.join('\n');
  }

  if (entry && entry.kind === 'breakdown') {
    const q = String(entry.query ?? entry.table ?? '').trim();
    return [
      say('headingBreakdown', { table: entry.table }),
      say('lineConnection', { connection: conn, dialect }),
      say('lineQuery', { query: q }),
      say('lineLink', { link }),
      say('lineMcpCall', { tool: 'breakdown', args: JSON.stringify({ connection: conn, q }) }),
    ].join('\n');
  }

  if (entry && entry.table && findTable(entry.table)) {
    const tableId = entry.table;
    const bar = shellById('query');
    const typed = bar && 'value' in bar ? String(bar.value ?? '').trim() : '';
    const q = typed || String(entry.query ?? tableId).trim() || tableId;
    const out = refsFrom(tableId).map((fk) => `${fk.from.columns.join(', ')} -> ${fk.to.table}`);
    const back = refsTo(tableId).map((fk) => `${fk.from.table}.${fk.from.columns.join(', ')}`);
    return [
      say('headingTable', { table: tableId }),
      say('lineConnection', { connection: conn, dialect }),
      say('lineQuery', { query: q }),
      say('lineLink', { link }),
      ...(out.length ? [say('linePointsAt', { targets: out.join('; ') })] : []),
      ...(back.length ? [say('linePointedAtBy', { sources: back.slice(0, 8).join('; ') })] : []),
      say('lineMcpCall', { tool: 'query', args: JSON.stringify({ connection: conn, q }) }),
    ].join('\n');
  }

  const tables = String(state.schema?.tables?.length ?? 0);
  const fks = String(state.schema?.foreignKeys?.length ?? 0);
  return [
    say('headingSchema', { connection: conn }),
    say('lineConnection', { connection: conn, dialect }),
    say('lineCounts', { tables, fks }),
    say('lineLink', { link }),
    say('lineMcpCall', { tool: 'schema_summary', args: JSON.stringify({ connection: conn }) }),
  ].join('\n');
}

export async function copyAgentBrief() {
  const text = buildAgentBrief();
  try {
    await navigator.clipboard.writeText(text);
    toast(say('copiedBrief'));
  } catch {
    toast(say('couldNotCopy'), 'error');
  }
}
