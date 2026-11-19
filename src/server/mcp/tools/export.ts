/**
 * `export`: pull more rows out of a database than fit in a reply, without the
 * rows passing through the agent's context. The server streams the result to
 * a file under the temp directory and answers with a path, a count, a sample
 * and a sentence on how to read it; the agent works on the file with its own
 * tools (DuckDB, Python, head).
 *
 * It changes no database, but it does write a file, so it is annotated as the
 * one tool that is neither a read nor a database write. It is listed with the
 * reading tools — the registry places it, not the annotation — because a
 * read-only connection is exactly where an agent wants a file of data.
 */
import { mkdir, open, stat, unlink, type FileHandle } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { join } from 'node:path';
import {
  findTable,
  parseQuery,
  primaryKey,
  readRecords,
  readView,
  textToView,
  type Adapter,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/host';
import { MAX_LIMIT } from '@mistriwork/engine/shared/reads.js';
import { resolveOrder, tableDialect, type Order } from '@mistriwork/engine/shared/schema.js';
import { continueGroups, keysetAfter, keysetOrder, pageBounds } from '@mistriwork/engine/shared/keysetPage.js';
import { STATS, type Handler, ToolError } from '../toolkit.js';

export const definitions = [
  {
    name: 'export',
    description:
      'Write a result to a file on this machine instead of returning its rows — for more data than fits in a ' +
      'reply. Give exactly one of `query` (the query language, as `query` takes it) or `sql` (a read-only SELECT, as ' +
      '`sql` takes it). The file is csv (default), ndjson or json, in tablewalk-exports under the temp directory; the ' +
      'answer is its absolute path, row and byte counts, the columns, five sample rows, and how to load it (DuckDB, ' +
      'Python, head) — read the file with your own tools, not through this one. ndjson and csv (or their `.gz`) load ' +
      'straight into Databricks and DuckDB; `compress: "gzip"` writes `.csv.gz`/`.ndjson.gz` for an upload. A `query` export pages through the ' +
      'whole result by key, so it has no row ceiling beyond `limit`; a `sql` export is one read capped at ' +
      `${MAX_LIMIT.toLocaleString('en-US')} rows and says so when it stopped short. At most two run at once.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query language, starting with a table name. Exclusive with `sql`.' },
        sql: { type: 'string', description: 'A read-only SELECT. Exclusive with `query`.' },
        format: { type: 'string', enum: ['csv', 'ndjson', 'json'], description: 'Default csv.' },
        limit: { type: 'number', description: 'Rows wanted. Absent: every row (a `sql` export stops at the cap).' },
        compress: { type: 'string', enum: ['gzip'], description: 'Gzip the file (`.gz`). Default: uncompressed.' },
        name: { type: 'string', description: 'A file name stem: letters, digits, `-` and `_`. Not a path.' },
        connection: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Export to a file',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        path: { type: 'string', description: 'The absolute path of the file written.' },
        format: { type: 'string' },
        rows: { type: 'number' },
        bytes: { type: 'number' },
        columns: { type: 'array', items: { type: 'object' } },
        ms: { type: 'number' },
        truncated: { type: 'boolean', description: 'More rows exist than the file holds, because of a cap rather than `limit`.' },
        paging: { type: 'string', description: 'keyset, offset or single.' },
        sample: { type: 'array', items: { type: 'object' }, description: 'The first five rows.' },
        hint: { type: 'string' },
        note: { type: 'string', description: 'Present when the file is not the whole answer, and why.' },
        stats: STATS,
      },
    },
  },
] as const;

type Name = (typeof definitions)[number]['name'];

/** Rows read per statement, and so the most the server holds of a file at once. */
export const EXPORT_BATCH = 5_000;
/** The most rows an export paged by offset holds: past it the database re-reads every row before each batch. */
export const EXPORT_OFFSET_ROWS = 100_000;
/** Exports running at once in this process. Each holds a statement and a file for as long as it reads. */
export const EXPORTS_IN_FLIGHT = 2;
const SAMPLE_ROWS = 5;
const FORMATS = ['csv', 'ndjson', 'json'] as const;
type Format = (typeof FORMATS)[number];

let inFlight = 0;

type Row = Record<string, unknown>;
interface Column {
  name: string;
  type: string;
}
/** One batch as a source reads it: rows as objects, in `columns` order. */
interface Batch {
  rows: Row[];
}
interface Source {
  columns: Column[];
  paging: 'keyset' | 'offset' | 'single';
  /** Said in the answer when the file is not the whole result. */
  note?: () => string | undefined;
  /** The next batch, or undefined when the result is exhausted. */
  next(): Promise<Batch | undefined>;
  truncated(): boolean;
}

export interface ExportOutcome {
  path: string;
  format: Format;
  rows: number;
  bytes: number;
  columns: Column[];
  ms: number;
  truncated: boolean;
  paging: Source['paging'];
  sample: Row[];
  note?: string;
}

export const handlers = {
  export: async ({ args, adapter, schema, id }) => {
    const format = (args.format ?? 'csv') as string;
    if (!(FORMATS as readonly string[]).includes(format)) {
      throw new ToolError('invalid_argument', 'export: "format" must be "csv", "ndjson" or "json".');
    }
    const text = typeof args.query === 'string' ? args.query.trim() : '';
    const statement = typeof args.sql === 'string' ? args.sql.trim() : '';
    if (!text === !statement) {
      throw new ToolError('invalid_argument', 'export: give exactly one of `query` (the query language) or `sql` (a read-only SELECT).');
    }
    const wanted = args.limit === undefined || args.limit === null ? undefined : Math.floor(Number(args.limit));
    if (wanted !== undefined && !(wanted >= 1))
      throw new ToolError('invalid_argument', 'export: "limit" must be a whole number of at least 1.');
    if (args.compress !== undefined && args.compress !== 'gzip') {
      throw new ToolError('invalid_argument', 'export: "compress" must be "gzip" when given.');
    }
    const stem = args.name === undefined ? undefined : stemOf(String(args.name));

    if (inFlight >= EXPORTS_IN_FLIGHT) {
      throw new ToolError('limit', `At most ${EXPORTS_IN_FLIGHT} exports run at once. Wait for one to finish and ask again.`);
    }
    inFlight++;
    try {
      const source = text ? await querySource(adapter, schema, text, wanted) : await sqlSource(adapter, schema, statement, wanted);
      const outcome = await writeExport({
        source,
        format: format as Format,
        gzip: args.compress === 'gzip',
        connection: id,
        stem: stem ?? source.table,
      });
      const { note, ...rest } = outcome;
      return {
        connection: id,
        ...rest,
        hint: hintFor(outcome.format, outcome.path),
        ...(note ? { note } : {}),
      };
    } finally {
      inFlight--;
    }
  },
} satisfies Record<Name, Handler>;

/** A file stem as the caller named it: refused when it is a path, otherwise reduced to [a-z0-9-_]. */
function stemOf(raw: string): string {
  if (/[\\/]|\.\./.test(raw) || raw.includes('\0')) {
    throw new ToolError('invalid_argument', 'export: "name" is a file name stem, not a path — letters, digits, `-` and `_`.');
  }
  const stem = clean(raw);
  if (!stem) throw new ToolError('invalid_argument', 'export: "name" has nothing usable in it — use letters, digits, `-` and `_`.');
  return stem;
}

function clean(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80);
}

function hintFor(format: Format, path: string): string {
  const quoted = path.replace(/'/g, "''");
  return format === 'csv'
    ? `Load with DuckDB: read_csv_auto('${quoted}'); or \`head\` the file to see the columns.`
    : `Load with DuckDB: read_json_auto('${quoted}'); or \`head\` the file to see its shape.`;
}

/* ---- sources ---------------------------------------------------------- */

function typeOfValue(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  if (value instanceof Date) return 'datetime';
  if (typeof value === 'bigint') return 'integer';
  if (typeof value === 'object') return 'json';
  return typeof value;
}

async function sqlSource(
  adapter: Adapter,
  schema: DatabaseSchema,
  statement: string,
  wanted: number | undefined,
): Promise<Source & { table: string }> {
  if (!adapter.runSql) {
    throw new ToolError('forbidden', `${schema.dialect} connections cannot run SQL in this build. Use \`query\`.`);
  }
  const limit = Math.min(wanted ?? MAX_LIMIT, MAX_LIMIT);
  const result = await adapter.runSql({ text: statement, limit, write: false, refuseReserved: true });
  const names = dedupe(result.columns);
  const rows = result.rows.map((values) => Object.fromEntries(names.map((name, i) => [name, values[i]])) as Row);
  /* A limit the caller set is theirs: only the cap's stopping short is a truncation. */
  const capped = result.truncated && limit === MAX_LIMIT;
  let sent = false;
  return {
    table: 'sql',
    paging: 'single',
    columns: names.map((name, i) => ({ name, type: typeOfValue(result.rows.find((r) => r[i] != null)?.[i]) })),
    truncated: () => capped,
    note: () =>
      capped
        ? `Stopped at the ${MAX_LIMIT.toLocaleString('en-US')}-row cap of a \`sql\` export; more rows match. Export it as a \`query\` (no row ceiling), or split the statement with a WHERE.`
        : undefined,
    next: async () => (sent ? undefined : ((sent = true), { rows })),
  };
}

/** Two columns with one name would collapse in an object: the later ones are numbered. */
function dedupe(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}_${n}`;
  });
}

async function querySource(
  adapter: Adapter,
  schema: DatabaseSchema,
  text: string,
  wanted: number | undefined,
): Promise<Source & { table: string }> {
  const parsed = parseQuery(text, { schema });
  if ((!parsed.query || parsed.errors.length) && adapter.runView) {
    /* A path through a reference is no single-table query and is a view: the
       same one-way fall-through `query` takes. Its rows have no one key to
       resume from, so it pages by offset. */
    const asView = textToView(schema, text, { id: 'export', name: '' });
    if (asView.view && !asView.errors.length) {
      const view = asView.view;
      const total = rowsWanted(wanted, view.limit);
      const types = new Map<string, string>();
      return offsetSource(
        view.base,
        total,
        async (offset, size) => {
          const { result } = await readView(adapter, schema, view, { limit: size, offset }, 'none');
          for (const r of result.resolved ?? []) types.set(r.name, String((r as { type?: string }).type ?? 'unknown'));
          return result;
        },
        (names) => names.map((name) => ({ name, type: types.get(name) ?? 'unknown' })),
      );
    }
  }
  if (!parsed.query || parsed.errors.length) {
    const about = findTable(schema, parsed.query?.table ?? text.split(/\s+/)[0] ?? '');
    const why = parsed.errors.map((e) => e.message ?? String(e)).join('; ');
    throw new ToolError(
      'invalid_argument',
      `export: ${why || 'that query did not parse'}.${about ? ` ${about.name} has: ${about.columns.map((c) => c.name).join(', ')}.` : ''}`,
    );
  }
  const query = parsed.query;
  const table = findTable(schema, query.table);
  if (!table) throw new ToolError('not_found', `export: no table "${query.table}".`);
  const total = rowsWanted(wanted, query.limit);
  const shown = query.columns?.length ? query.columns : undefined;
  const typed = (names: string[]) => names.map((name) => ({ name, type: table.columns.find((c) => c.name === name)?.type ?? 'unknown' }));

  /* A file reads best from the first row to the last: with no sort of its own, the key ascending, not the list's newest first. */
  const key = primaryKey(table);
  const order: Order[] =
    query.orderBy?.length || !key.length
      ? resolveOrder(table, query.orderBy).order
      : key.map((column) => ({ column, direction: 'asc' as const }));
  const dialect = tableDialect(schema, table);
  const keyed = !table.union && keysetOrder(table, order, dialect);
  const read = (
    limit: number,
    offset: number,
    columns: string[] | undefined,
    continuation?: { groups?: ReturnType<typeof keysetAfter>; reverse: false },
  ) =>
    readRecords(
      adapter,
      schema,
      { ...query, ...(columns ? { columns } : {}), orderBy: order, limit, offset: continuation ? 0 : offset },
      'none',
      undefined,
      continuation as never,
    ).then(({ result }) => result);
  if (!keyed) return offsetSource(table.id, total, (offset, size) => read(size, offset, shown), typed);
  return keysetSource(table, order, total, shown, read, query.filter?.groups, dialect, typed);
}

/** The rows the file is to hold: the caller's `limit`, else the query's own, else all of them. */
function rowsWanted(limit: number | undefined, queryLimit: unknown): number {
  const own = typeof queryLimit === 'number' && queryLimit >= 1 ? Math.floor(queryLimit) : Infinity;
  return Math.min(limit ?? Infinity, own);
}

type Page = { columns: string[]; rows: Row[] };

/** Paging by key: each batch is the rows after the last one written, in the table's own total order. */
function keysetSource(
  table: TableMeta,
  order: Order[],
  total: number,
  shown: string[] | undefined,
  read: (
    limit: number,
    offset: number,
    columns: string[] | undefined,
    continuation?: { groups?: ReturnType<typeof keysetAfter>; reverse: false },
  ) => Promise<Page>,
  filterGroups: unknown,
  dialect: DatabaseSchema['dialect'],
  typed: (names: string[]) => Column[],
): Source & { table: string } {
  /* An order column the file does not show is read for the boundary and taken out of the rows. */
  const extra = shown ? order.map((o) => o.column).filter((c) => !shown.includes(c)) : [];
  const columns = shown ? [...shown, ...extra] : undefined;
  let after: Record<string, string | number | boolean | null> | undefined;
  let written = 0;
  let done = false;
  let lost = false;
  let names: Column[] = [];
  let fallback: Source | undefined;
  const source: Source & { table: string } = {
    table: table.id,
    paging: 'keyset',
    get columns() {
      return names;
    },
    truncated: () => fallback?.truncated() ?? false,
    note: () => fallback?.note?.(),
    async next() {
      if (fallback) return fallback.next();
      if (done || written >= total) return undefined;
      const size = Math.min(EXPORT_BATCH, total - written);
      const tail = after && keysetAfter(table, order, after, dialect);
      if (lost || (after && !tail)) return switchToOffset(size);
      const continuation = tail ? { reverse: false as const, groups: continueGroups(filterGroups as never, tail) as never } : undefined;
      const page = await read(size, 0, columns, continuation);
      const bounds = pageBounds(order, page.rows);
      const dropped = new Set(extra);
      const rows = dropped.size ? page.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !dropped.has(k)))) : page.rows;
      if (!names.length) names = typed(page.columns.filter((c) => !dropped.has(c)));
      written += rows.length;
      if (rows.length < size) done = true;
      else if (bounds) after = bounds.last;
      else lost = true;
      return { rows };
    },
  };
  /* A boundary that cannot be said exactly (a value that does not come back as stored): the rest goes by offset, in
     the same total order, and the offset cap applies from there. */
  function switchToOffset(_size: number): Promise<Batch | undefined> {
    const rest = offsetSource(table.id, total - written, (offset, size) => read(size, written + offset, columns), typed, written);
    fallback = rest;
    source.paging = 'offset';
    return rest.next();
  }
  return source;
}

/** Paging by offset, for what has no key to resume from, held to EXPORT_OFFSET_ROWS: a file never grinds the database. */
function offsetSource(
  table: string,
  total: number,
  read: (offset: number, size: number) => Promise<Page>,
  typed: (names: string[]) => Column[],
  already = 0,
): Source & { table: string } {
  const cap = Math.max(EXPORT_OFFSET_ROWS - already, 0);
  const target = Math.min(total, cap);
  let written = 0;
  let done = false;
  let more = false;
  let names: Column[] = [];
  return {
    table,
    paging: 'offset',
    get columns() {
      return names;
    },
    truncated: () => more,
    note: () =>
      more
        ? `Stopped at ${EXPORT_OFFSET_ROWS.toLocaleString('en-US')} rows: this query has no key to page by, and a deeper read by position grinds the database. ` +
          'Narrow it with a filter, or export a table query (which pages by key).'
        : undefined,
    async next() {
      if (done || written >= target) return undefined;
      /* One row past the cap says whether the cap cut anything off. */
      const peek = target === cap && cap < total ? 1 : 0;
      const size = Math.min(EXPORT_BATCH, target + peek - written);
      const page = await read(written, size);
      if (!names.length) names = typed(page.columns);
      let rows = page.rows;
      if (rows.length < size) done = true;
      if (written + rows.length > target) {
        more = true;
        rows = rows.slice(0, target - written);
        done = true;
      }
      written += rows.length;
      return { rows };
    },
  };
}

/* ---- the file --------------------------------------------------------- */

/** The folder exports land in: fixed, never the caller's. */
export const exportDirectory = () => join(tmpdir(), 'tablewalk-exports');

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
}

/** Open a new file, never over an existing one: a taken name gets `-2`, `-3`, … */
async function openNew(directory: string, base: string, extension: string): Promise<{ handle: FileHandle; path: string }> {
  for (let n = 1; n < 10_000; n++) {
    const path = join(directory, `${base}${n === 1 ? '' : `-${n}`}.${extension}`);
    try {
      return { handle: await open(path, 'wx', 0o600), path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new ToolError('internal', 'export: could not find a free file name.');
}

/* Values as a file says them: ids past 2^53 are already strings and stay so; a
   bigint becomes one rather than a Number; a date is ISO. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

const jsonReplacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

/** One CSV field, RFC 4180: null is empty, an empty string is `""`, and nothing is rewritten to suit a spreadsheet. */
function csvCell(value: unknown): string {
  const v = plain(value);
  if (v === null || v === undefined) return '';
  const text = typeof v === 'object' ? JSON.stringify(v, jsonReplacer) : String(v);
  return text === '' || /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function lineOf(format: Format, names: string[], row: Row, first: boolean): string {
  if (format === 'csv') return `${names.map((n) => csvCell(row[n])).join(',')}\r\n`;
  const record: Row = {};
  for (const n of names) record[n] = plain(row[n]) ?? null;
  const json = JSON.stringify(record, jsonReplacer);
  return format === 'ndjson' ? `${json}\n` : `${first ? '[\n' : ',\n'}  ${json}`;
}

async function writeExport(opts: {
  source: Source & { table: string };
  format: Format;
  gzip: boolean;
  connection: string;
  stem: string;
}): Promise<ExportOutcome> {
  const { source, format } = opts;
  const started = Date.now();
  const directory = exportDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const base = `${clean(opts.connection) || 'db'}-${clean(opts.stem) || 'export'}-${stamp(new Date())}`;
  const { handle, path } = await openNew(directory, base, opts.gzip ? `${format}.gz` : format);
  let bytes = 0;
  /* Compressed, the chunks go through gzip into the file's own stream; `bytes` is then the size on disk, read at the end. */
  const gzip = opts.gzip ? createGzip() : undefined;
  const filing = gzip ? pipeline(gzip, handle.createWriteStream()) : undefined;
  filing?.catch(() => {});
  const put = async (chunk: string) => {
    if (!chunk) return;
    if (gzip) {
      if (!gzip.write(chunk)) await Promise.race([once(gzip, 'drain'), filing!]);
      return;
    }
    const buffer = Buffer.from(chunk, 'utf8');
    await handle.write(buffer);
    bytes += buffer.length;
  };
  const sample: Row[] = [];
  let rows = 0;
  try {
    let batch = await source.next();
    const names = source.columns.map((c) => c.name);
    if (format === 'csv') await put(`${names.map(csvCell).join(',')}\r\n`);
    while (batch) {
      const lines: string[] = [];
      for (const row of batch.rows) {
        if (sample.length < SAMPLE_ROWS) sample.push(Object.fromEntries(names.map((n) => [n, plain(row[n]) ?? null])));
        lines.push(lineOf(format, names, row, rows === 0));
        rows++;
      }
      await put(lines.join(''));
      batch = await source.next();
    }
    if (format === 'json') await put(rows ? '\n]\n' : '[]\n');
    if (gzip) {
      gzip.end();
      /* The stream closes the handle it was made from when it finishes. */
      await filing;
      bytes = (await stat(path)).size;
    } else await handle.close();
  } catch (err) {
    /* Never leave half a file that looks whole. */
    gzip?.destroy();
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw err;
  }
  const note = source.note?.();
  return {
    path,
    format,
    rows,
    bytes,
    columns: source.columns,
    ms: Date.now() - started,
    truncated: source.truncated(),
    paging: source.paging,
    sample,
    ...(note ? { note } : {}),
  };
}
