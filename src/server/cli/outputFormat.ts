/**
 * Compact, token-lean CLI output formatters (`--format <json|ndjson|tsv|md>`).
 *
 * Loaded on demand only for `--query`, `--call`, and `--batch` CLI runs so plain
 * `--help`, `--mcp`, and `serve` cold starts load zero extra modules.
 */

export type CliOutputFormat = 'json' | 'ndjson' | 'tsv' | 'md';

export function parseCliOutputFormat(raw: string | undefined): CliOutputFormat {
  if (raw === undefined || raw.trim() === '') return 'json';
  const norm = raw.trim().toLowerCase();
  if (norm === 'json') return 'json';
  if (norm === 'ndjson' || norm === 'jsonl') return 'ndjson';
  if (norm === 'tsv') return 'tsv';
  if (norm === 'md' || norm === 'markdown') return 'md';
  throw new Error(`--format takes json, ndjson, tsv, or md — not ${JSON.stringify(raw)}.`);
}

interface TabularView {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  footer?: string;
}

function cellText(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') return String(val);
  if (Array.isArray(val)) {
    if (val.every((x) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
      return val.join(', ');
    }
    return JSON.stringify(val);
  }
  return JSON.stringify(val);
}

function escapeTsv(raw: string): string {
  return raw.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

function escapeMd(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderTsv(table: TabularView): string {
  if (!table.columns.length) return '';
  const lines = [table.columns.map(escapeTsv).join('\t')];
  for (const row of table.rows) {
    lines.push(table.columns.map((col) => escapeTsv(cellText(row[col]))).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function renderMd(table: TabularView): string {
  if (!table.columns.length) return table.footer ? `${table.footer}\n` : '_Empty result._\n';
  const head = `| ${table.columns.map(escapeMd).join(' | ')} |`;
  const sep = `| ${table.columns.map(() => '---').join(' | ')} |`;
  const lines = [head, sep];
  for (const row of table.rows) {
    lines.push(`| ${table.columns.map((col) => escapeMd(cellText(row[col]))).join(' | ')} |`);
  }
  if (table.footer) lines.push('', table.footer);
  return `${lines.join('\n')}\n`;
}

function columnsFromRows(declared: unknown, rows: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  if (Array.isArray(declared)) {
    for (const col of declared) {
      if (typeof col === 'string' && col && !out.includes(col)) out.push(col);
      else if (col && typeof col === 'object' && typeof (col as { name?: unknown }).name === 'string') {
        const name = (col as { name: string }).name;
        if (name && !out.includes(name)) out.push(name);
      }
    }
  }
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
}

function extractFanoutTable(payload: Record<string, unknown>): TabularView {
  const envs = (payload.environments as Array<Record<string, unknown>>) ?? [];
  const allRows: Array<Record<string, unknown>> = [];
  const dynamicCols: string[] = [];
  const addCol = (c: string) => {
    if (!dynamicCols.includes(c)) dynamicCols.push(c);
  };

  const anyRowArrays = envs.some((e) => e.ok === true && e.result && Array.isArray((e.result as Record<string, unknown>).rows));

  if (anyRowArrays) {
    for (const entry of envs) {
      const envLabel = String(entry.env ?? entry.tier ?? entry.connection ?? '');
      const conn = String(entry.connection ?? '');
      if (entry.ok === true && entry.result && typeof entry.result === 'object') {
        const res = entry.result as Record<string, unknown>;
        const rows = Array.isArray(res.rows) ? (res.rows as Array<Record<string, unknown>>) : [];
        for (const c of columnsFromRows(res.columns, rows)) addCol(c);
        if (rows.length === 0) {
          allRows.push({ env: envLabel, connection: conn });
        } else {
          for (const r of rows) {
            allRows.push({ env: envLabel, connection: conn, ...r });
          }
        }
      } else {
        addCol('error');
        allRows.push({
          env: envLabel,
          connection: conn,
          error: `${String(entry.code ?? 'error')}: ${String(entry.error ?? 'failed')}`,
        });
      }
    }
    return {
      columns: ['env', 'connection', ...dynamicCols],
      rows: allRows,
    };
  }

  /* Summary matrix across environments (e.g. `lint`, `perf`, `schema_summary`, `tables`, `anomalies`). */
  for (const entry of envs) {
    const envLabel = String(entry.env ?? entry.tier ?? entry.connection ?? '');
    const conn = String(entry.connection ?? '');
    const row: Record<string, unknown> = {
      env: envLabel,
      connection: conn,
      ok: Boolean(entry.ok),
    };
    if (entry.ok === true && entry.result && typeof entry.result === 'object') {
      const res = entry.result as Record<string, unknown>;
      if (res.counts && typeof res.counts === 'object' && !Array.isArray(res.counts)) {
        for (const [ck, cv] of Object.entries(res.counts as Record<string, unknown>)) {
          addCol(ck);
          row[ck] = cv;
        }
      }
      for (const [k, v] of Object.entries(res)) {
        if (k === 'connection' || k === 'stats' || k === 'counts' || k === 'rules' || k === 'link') continue;
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
          addCol(k);
          row[k] = v;
        } else if (Array.isArray(v) && (k === 'tables' || k === 'findings' || k === 'paths' || k === 'matches')) {
          const countKey = `${k}Count`;
          addCol(countKey);
          row[countKey] = v.length;
        }
      }
    } else {
      addCol('error');
      row.error = `${String(entry.code ?? 'error')}: ${String(entry.error ?? 'failed')}`;
    }
    allRows.push(row);
  }
  return {
    columns: ['env', 'connection', 'ok', ...dynamicCols],
    rows: allRows,
  };
}

function toTabular(toolName: string, payload: Record<string, unknown>): TabularView {
  if (payload.fanout === true && Array.isArray(payload.environments)) {
    return extractFanoutTable(payload);
  }

  if (Array.isArray(payload.rows)) {
    const rows = payload.rows as Array<Record<string, unknown>>;
    const columns = columnsFromRows(payload.columns, rows);
    const footer =
      payload.truncated === true
        ? `_Truncated at ${rows.length}${typeof payload.total === 'number' ? ` of ${payload.total}` : ''} rows._`
        : undefined;
    return { columns: columns.length ? columns : ['result'], rows, footer };
  }

  if (toolName === 'tables' && Array.isArray(payload.tables)) {
    const rows = payload.tables as Array<Record<string, unknown>>;
    const cols = ['id', 'columns', 'approxRows', 'isView'].filter((k) => rows.some((r) => r[k] !== undefined) || k !== 'isView');
    return { columns: cols, rows };
  }

  if (toolName === 'connections' && Array.isArray(payload.connections)) {
    const rows = payload.connections as Array<Record<string, unknown>>;
    const preferred = ['id', 'database', 'env', 'tier', 'dialect', 'tables', 'writable', 'rows', 'redactsRows', 'maxRows', 'active'];
    const cols = preferred.filter((k) => rows.some((r) => r[k] !== undefined));
    return { columns: cols.length ? cols : ['id', 'name'], rows };
  }

  if (Array.isArray(payload.findings)) {
    const rows = payload.findings as Array<Record<string, unknown>>;
    const preferred = ['severity', 'rule', 'table', 'index', 'columns', 'rows', 'approxRows', 'message', 'query', 'suggestedSql'];
    const cols = preferred.filter((k) => rows.some((r) => r[k] !== undefined));
    return {
      columns: cols.length ? cols : ['severity', 'rule', 'table', 'message'],
      rows,
      footer: rows.length === 0 ? '_0 findings._' : typeof payload.note === 'string' ? `_${payload.note}_` : undefined,
    };
  }

  if (toolName === 'path' && Array.isArray(payload.paths)) {
    const rawPaths = payload.paths as Array<Record<string, unknown>>;
    const rows = rawPaths.map((p) => {
      const hopsList = Array.isArray(p.hops) ? (p.hops as Array<Record<string, unknown>>) : [];
      const fallbackRoute = [
        String(payload.from ?? ''),
        ...hopsList.map((h) => `${h.direction === 'to-many' ? '<-' : '->'} ${String(h.to ?? '')}`),
      ].join(' ');
      const unindexed = typeof p.unindexedHops === 'number' ? p.unindexedHops : hopsList.filter((h) => h.indexed === false).length;
      return {
        length: p.length ?? hopsList.length,
        summary: typeof p.summary === 'string' ? p.summary : fallbackRoute.trim(),
        unindexedHops: unindexed,
        queryHint: p.queryHint ?? '',
      };
    });
    return {
      columns: ['length', 'summary', 'unindexedHops', 'queryHint'],
      rows,
      footer: rows.length === 0 && typeof payload.note === 'string' ? `_${payload.note}_` : undefined,
    };
  }

  if (Array.isArray(payload.matches)) {
    const rows = payload.matches as Array<Record<string, unknown>>;
    const cols = columnsFromRows(undefined, rows);
    return { columns: cols.length ? cols : ['table', 'column', 'match'], rows };
  }

  if (toolName === 'record') {
    if (Array.isArray(payload.records)) {
      const rows = (payload.records as Array<Record<string, unknown>>)
        .filter((r) => r.record && typeof r.record === 'object')
        .map((r) => r.record as Record<string, unknown>);
      return { columns: columnsFromRows(undefined, rows), rows };
    }
    if (payload.record && typeof payload.record === 'object' && !Array.isArray(payload.record)) {
      const entries = Object.entries(payload.record as Record<string, unknown>).map(([column, value]) => ({ column, value }));
      return { columns: ['column', 'value'], rows: entries };
    }
  }

  /* Generic scalar/object summary. */
  const kvRows = Object.entries(payload)
    .filter(([k]) => k !== 'stats')
    .map(([field, value]) => ({ field, value }));
  return { columns: ['field', 'value'], rows: kvRows };
}

export function formatCliOutput(toolName: string, payload: Record<string, unknown>, format: CliOutputFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(payload, null, 2)}\n`;
  }
  if (format === 'ndjson') {
    if (payload.fanout === true && Array.isArray(payload.environments)) {
      return payload.environments.length ? `${payload.environments.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
    }
    const list =
      (Array.isArray(payload.rows) && payload.rows) ||
      (Array.isArray(payload.findings) && payload.findings) ||
      (toolName === 'tables' && Array.isArray(payload.tables) && payload.tables) ||
      (toolName === 'connections' && Array.isArray(payload.connections) && payload.connections) ||
      undefined;
    if (list) {
      return list.length ? `${list.map((item) => JSON.stringify(item)).join('\n')}\n` : '';
    }
    return `${JSON.stringify(payload)}\n`;
  }

  const tabular = toTabular(toolName, payload);
  return format === 'tsv' ? renderTsv(tabular) : renderMd(tabular);
}
