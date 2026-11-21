/**
 * Agent table and field blocklists per connection.
 *
 * `hidden` in `tablewalk.json` strips columns within tables, while vault and
 * agent configs often need to fence off entire tables (`audit_*`, `*_secrets`,
 * `auth.sessions`) alongside sensitive fields (`*.*_token`, `customer.tax_id`)
 * before handing an MCP session or CLI lookup to an agent.
 *
 * Built on `@mistriwork/engine/server/columnGrants.js` (`accessibleSchema`,
 * `resourceChecks`, `authorizeColumnWrites`), so blocked tables, blocked
 * columns, and every foreign-key edge touching either are pruned from the
 * catalog and refused across queries, views, breakdowns, records, profiles,
 * exports, shelf resources and writes, while raw SQL and DDL verification are
 * refused outright.
 */
import { Refusal, findTable, type Adapter, type DatabaseSchema } from '@mistriwork/engine/host';
import {
  AppAccessDenied,
  accessibleSchema,
  authorizeColumnWrites,
  resourceChecks,
  type ColumnGrant,
} from '@mistriwork/engine/server/columnGrants.js';
import { lendWriteView, writeViewOf } from '@mistriwork/engine/adapters/storeHost.js';

export interface BlocklistRules {
  tables: string[];
  fields: Record<string, string[]>;
}

export function hasBlocklistRules(rules: BlocklistRules | undefined): rules is BlocklistRules {
  if (!rules) return false;
  if (rules.tables.length > 0) return true;
  return Object.values(rules.fields).some((cols) => cols.length > 0);
}

function parsePatternList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array of pattern strings (for example ["audit_*", "*_secret"]).`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${label} entries must be non-empty strings, not ${JSON.stringify(item)}.`);
    }
    out.push(item.trim());
  }
  return out;
}

function addFieldPattern(target: Record<string, string[]>, tablePattern: string, fieldPattern: string, where: string): void {
  const tbl = tablePattern.trim();
  const col = fieldPattern.trim();
  if (!tbl || !col) {
    throw new Error(`${where}: invalid field blocklist pattern "${tablePattern}.${fieldPattern}".`);
  }
  const list = (target[tbl] ??= []);
  if (!list.includes(col)) list.push(col);
}

function parseFieldsSpec(raw: unknown, where: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`${where}: field blocklist entries must be non-empty strings, not ${JSON.stringify(entry)}.`);
      }
      const trimmed = entry.trim();
      const lastDot = trimmed.lastIndexOf('.');
      if (lastDot === -1) {
        addFieldPattern(out, '*', trimmed, where);
      } else {
        const tbl = trimmed.slice(0, lastDot).trim();
        const col = trimmed.slice(lastDot + 1).trim();
        if (!tbl || !col || (tbl === '*' && /^\*+$/.test(col))) {
          throw new Error(`${where}: "${trimmed}" matches every column of every table — list table patterns under "tables" instead.`);
        }
        addFieldPattern(out, tbl, col, where);
      }
    }
    return out;
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      `${where}: "fields" must be an object of table -> column patterns (e.g. { "*": ["*_token"], "customer": ["ssn"] }) or an array of "table.column" strings.`,
    );
  }
  for (const [table, cols] of Object.entries(raw as Record<string, unknown>)) {
    if (!table.trim()) {
      throw new Error(`${where}: "fields" has an empty table key.`);
    }
    const list = parsePatternList(cols, `${where} fields["${table}"]`);
    if (!list.length) continue;
    for (const col of list) {
      if (table.trim() === '*' && /^\*+$/.test(col)) {
        throw new Error(`${where}: fields["*"] cannot be "*" (that blocks every column of every table; use "tables" instead).`);
      }
      addFieldPattern(out, table, col, where);
    }
  }
  return out;
}

export function mergeBlocklists(a?: BlocklistRules, b?: BlocklistRules): BlocklistRules | undefined {
  if (!hasBlocklistRules(a) && !hasBlocklistRules(b)) return undefined;
  const tables: string[] = [];
  const fields: Record<string, string[]> = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const t of src.tables) {
      if (!tables.includes(t)) tables.push(t);
    }
    for (const [tbl, cols] of Object.entries(src.fields)) {
      const dest = (fields[tbl] ??= []);
      for (const c of cols) {
        if (!dest.includes(c)) dest.push(c);
      }
    }
  }
  const merged: BlocklistRules = { tables, fields };
  return hasBlocklistRules(merged) ? merged : undefined;
}

export function parseBlocklist(raw: unknown, where: string): BlocklistRules | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: "blocklist" must be an object like { "tables": ["audit_*"], "fields": { "*": ["*_token"] } }.`);
  }
  const rec = raw as Record<string, unknown>;
  const unknown = Object.keys(rec).filter((k) => k !== 'tables' && k !== 'fields' && k !== 'columns');
  if (unknown.length) {
    throw new Error(`${where}: unknown key ${unknown.map((k) => `"${k}"`).join(', ')} in "blocklist" (expected "tables" and/or "fields").`);
  }
  const tables = rec.tables !== undefined ? parsePatternList(rec.tables, `${where} blocklist.tables`) : [];
  const fieldsA = rec.fields !== undefined ? parseFieldsSpec(rec.fields, `${where} blocklist`) : {};
  const fieldsB = rec.columns !== undefined ? parseFieldsSpec(rec.columns, `${where} blocklist`) : {};
  return mergeBlocklists({ tables, fields: fieldsA }, { tables: [], fields: fieldsB });
}

export function extractConnectionBlocklist(
  conn: Record<string, unknown>,
  where: string,
  defaults?: BlocklistRules,
): BlocklistRules | undefined {
  const nested = parseBlocklist(conn.blocklist, where);
  const flatTables = conn.blockedTables !== undefined ? parsePatternList(conn.blockedTables, `${where} "blockedTables"`) : [];
  const flatFieldsA = conn.blockedFields !== undefined ? parseFieldsSpec(conn.blockedFields, `${where} "blockedFields"`) : {};
  const flatFieldsB = conn.blockedColumns !== undefined ? parseFieldsSpec(conn.blockedColumns, `${where} "blockedColumns"`) : {};
  const own = mergeBlocklists(nested, mergeBlocklists({ tables: flatTables, fields: flatFieldsA }, { tables: [], fields: flatFieldsB }));
  return mergeBlocklists(defaults, own);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

interface CompiledState {
  grant: ColumnGrant;
  cuts: Map<string, Set<string>>;
}

function compileGrant(schema: DatabaseSchema, rules: BlocklistRules): CompiledState {
  const tableMatchers = rules.tables.map(globToRegExp);
  const fieldRules = Object.entries(rules.fields).map(([tablePat, cols]) => ({
    rawTable: tablePat,
    tableMatcher: tablePat === '*' ? null : globToRegExp(tablePat),
    colMatchers: cols.map(globToRegExp),
  }));

  const readable = new Set<string>();
  const cuts = new Map<string, Set<string>>();

  for (const table of schema.tables) {
    const tableBlocked = tableMatchers.some((re) => re.test(table.id) || re.test(table.name));
    if (tableBlocked) continue;

    const applying = fieldRules.filter((r) => r.tableMatcher === null || r.tableMatcher.test(table.id) || r.tableMatcher.test(table.name));
    if (!applying.length) {
      readable.add(table.id);
      continue;
    }

    const cutCols = table.columns.filter((col) => applying.some((r) => r.colMatchers.some((re) => re.test(col.name))));
    /* If a blocked field covers a primary key column (or every column of the table),
       the table cannot be safely addressed by key without exposing that blocked field,
       so the whole table is withheld from the agent catalog. */
    if (cutCols.some((c) => c.primaryKey) || cutCols.length >= table.columns.length) {
      continue;
    }

    readable.add(table.id);
    if (cutCols.length > 0) {
      cuts.set(table.id, new Set(cutCols.map((c) => c.name)));
    }
  }

  const fields = new Map<string, { read: ReadonlySet<string>; write: ReadonlySet<string> }>();
  for (const [tableId, cut] of cuts) {
    const table = schema.tables.find((t) => t.id === tableId);
    if (!table) continue;
    const visible = new Set(table.columns.map((c) => c.name).filter((c) => !cut.has(c)));
    fields.set(tableId, { read: visible, write: visible });
  }

  return {
    grant: {
      readable,
      writable: readable,
      ...(fields.size ? { fields } : {}),
    },
    cuts,
  };
}

export function withoutBlockedCatalog(schema: DatabaseSchema, rules: BlocklistRules): DatabaseSchema {
  if (!hasBlocklistRules(rules)) return schema;
  const { grant, cuts } = compileGrant(schema, rules);
  const pruned = accessibleSchema(schema, grant);
  const keep = (id: string, cols?: readonly string[]) => cols?.filter((col) => !cuts.get(id)?.has(col));
  return {
    ...pruned,
    tables: pruned.tables.map((table) => {
      const original = schema.tables.find((item) => item.id === table.id);
      const { deletable: _deletable, ...rest } = table as typeof table & { deletable?: boolean };
      const columns = table.columns.map((column) => {
        const { writable: _writable, ...said } = column as typeof column & { writable?: boolean };
        const was = original?.columns.find((item) => item.name === column.name);
        return was?.writable !== undefined ? { ...said, writable: was.writable } : said;
      });
      return {
        ...rest,
        columns,
        ...(original?.deletable !== undefined ? { deletable: original.deletable } : {}),
        ...(table.filterable ? { filterable: keep(table.id, table.filterable) } : {}),
        ...(table.filterIn ? { filterIn: keep(table.id, table.filterIn) } : {}),
        ...(table.sortable ? { sortable: keep(table.id, table.sortable) } : {}),
      };
    }),
  };
}

/**
 * Wrap an opened `Adapter` + `DatabaseSchema` so every blocked table and field
 * is invisible in the catalog and refused across every read, view, breakdown,
 * profile, DDL lookup, raw SQL call, and write.
 */
export function applyBlocklist(
  adapter: Adapter,
  introspected: DatabaseSchema,
  name: string,
  rules: BlocklistRules,
): { adapter: Adapter; schema: DatabaseSchema } {
  if (!hasBlocklistRules(rules)) return { adapter, schema: introspected };

  const refused = (what: string) =>
    new Refusal(
      `"${name}" blocks tables or fields ("blocklist"): ${what}. ` +
        'Blocked tables and columns are withheld from this connection, so nothing can read or write them.',
    );

  let full = introspected;
  let state = compileGrant(full, rules);
  let checks = resourceChecks(full, state.grant);

  const refresh = (next: DatabaseSchema) => {
    full = next;
    state = compileGrant(full, rules);
    checks = resourceChecks(full, state.grant);
  };

  const checked = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof AppAccessDenied) {
        throw refused('this request names a blocked table or field, or traverses a relationship into one');
      }
      throw error;
    }
  };

  const from = <K extends keyof Adapter>(key: K): Adapter[K] => {
    const method = adapter[key];
    return (typeof method === 'function' ? method.bind(adapter) : undefined) as Adapter[K];
  };

  const authorized = <Tx extends Parameters<typeof authorizeColumnWrites>[2]>(tx: Tx): Tx => {
    const inner = authorizeColumnWrites(full, state.grant, tx);
    const guard =
      <Args extends unknown[], R>(run: (...args: Args) => Promise<R>) =>
      (...args: Args): Promise<R> => {
        try {
          return run(...args).catch((error: unknown) => {
            throw error instanceof AppAccessDenied
              ? refused('this write touches a blocked table or field, or would return or remove one')
              : error;
          });
        } catch (error) {
          return Promise.reject(
            error instanceof AppAccessDenied
              ? refused('this write touches a blocked table or field, or would return or remove one')
              : error,
          );
        }
      };
    return {
      ...(inner.lockRecord ? { lockRecord: guard(inner.lockRecord) } : {}),
      query: guard(inner.query),
      count: guard(inner.count),
      ...(inner.aggregate ? { aggregate: guard(inner.aggregate) } : {}),
      insert: guard(inner.insert),
      update: guard(inner.update),
      remove: guard(inner.remove),
      ...(inner.tell ? { tell: guard(inner.tell) } : {}),
    } as Tx;
  };

  const resolveReadableId = (tableRef: string): string => {
    const found = findTable(full, tableRef);
    const id = found?.id ?? tableRef;
    if (!state.grant.readable.has(id)) {
      throw refused(`table "${tableRef}" is on the blocklist`);
    }
    return id;
  };

  const wrapped = Object.create(Object.getPrototypeOf(adapter)) as Adapter;
  Object.assign(wrapped, adapter);
  wrapped.close = from('close');
  wrapped.introspect = async () => {
    refresh(await adapter.introspect());
    return withoutBlockedCatalog(full, rules);
  };
  if (adapter.poolStats) wrapped.poolStats = from('poolStats');
  if (adapter.privileges) wrapped.privileges = from('privileges');
  if (adapter.triggers) wrapped.triggers = from('triggers');
  if (adapter.estimateCount) {
    const est = adapter.estimateCount.bind(adapter);
    wrapped.estimateCount = async (table) => {
      resolveReadableId(table);
      return est(table);
    };
  }
  wrapped.query = async (request) => adapter.query(checked(() => checks.queryFor(request)));
  wrapped.count = async (table, filter, limit) =>
    adapter.count(
      table,
      checked(() => checks.filterFor(table, filter)),
      limit,
    );
  if (adapter.countEach) {
    const countEach = adapter.countEach.bind(adapter);
    wrapped.countEach = async (items, limit) =>
      countEach(
        checked(() => items.map((item) => ({ table: item.table, filter: checks.filterFor(item.table, item.filter) }))),
        limit,
      );
  }
  if (adapter.runView) {
    const runView = adapter.runView.bind(adapter);
    wrapped.runView = async (view, offset) =>
      runView(
        checked(() => checks.viewFor(view)),
        offset,
      );
  }
  if (adapter.countView) {
    const countView = adapter.countView.bind(adapter);
    wrapped.countView = async (view, limit) =>
      countView(
        checked(() => checks.viewFor(view)),
        limit,
      );
  }
  if (adapter.runBreakdown) {
    const runBreakdown = adapter.runBreakdown.bind(adapter);
    wrapped.runBreakdown = async (def, offset) =>
      runBreakdown(
        checked(() => checks.breakdownFor(def)),
        offset,
      );
  }
  if (adapter.countBreakdown) {
    const countBreakdown = adapter.countBreakdown.bind(adapter);
    wrapped.countBreakdown = async (def, limit) =>
      countBreakdown(
        checked(() => checks.breakdownFor(def)),
        limit,
      );
  }
  if (adapter.aggregate) {
    const aggregate = adapter.aggregate.bind(adapter);
    wrapped.aggregate = async (request) => aggregate(checked(() => checks.aggregateFor(request)));
  }
  if (adapter.scopeReads) {
    const scopeReads = adapter.scopeReads.bind(adapter);
    wrapped.scopeReads = async (scope) => {
      const bound = await scopeReads(scope);
      return {
        query: (request) => bound.query(checked(() => checks.queryFor(request))),
        count: (table, filter, limit) =>
          bound.count(
            table,
            checked(() => checks.filterFor(table, filter)),
            limit,
          ),
        runView: (view, offset) =>
          bound.runView(
            checked(() => checks.viewFor(view)),
            offset,
          ),
        countView: (view, limit) =>
          bound.countView(
            checked(() => checks.viewFor(view)),
            limit,
          ),
        runBreakdown: (def, offset) =>
          bound.runBreakdown(
            checked(() => checks.breakdownFor(def)),
            offset,
          ),
        countBreakdown: (def, limit) =>
          bound.countBreakdown(
            checked(() => checks.breakdownFor(def)),
            limit,
          ),
        ...(bound.aggregate ? { aggregate: (request) => bound.aggregate!(checked(() => checks.aggregateFor(request))) } : {}),
      };
    };
  }
  if (adapter.runSql) {
    wrapped.runSql = async () => {
      throw refused(
        'raw SQL is refused because a statement can read any blocked table or column. Use `query`, `breakdown`, `record`, or a configured `view` instead',
      );
    };
  }
  if (adapter.explainSql) {
    wrapped.explainSql = async () => {
      throw refused('explaining raw SQL is refused when a blocklist is active');
    };
  }
  if (adapter.ddl) {
    const ddl = adapter.ddl.bind(adapter);
    wrapped.ddl = async (table) => {
      const id = resolveReadableId(table);
      return state.cuts.has(id) ? undefined : ddl(table);
    };
  }
  if (adapter.profile) {
    const profile = adapter.profile.bind(adapter);
    wrapped.profile = async (table, limits) => {
      const id = resolveReadableId(table);
      const result = await profile(table, limits);
      const cut = state.cuts.get(id);
      return cut ? { ...result, columns: result.columns.filter((column) => !cut.has(column.column)) } : result;
    };
  }
  if (adapter.insert)
    wrapped.insert = (request) => authorized(adapter as unknown as Parameters<typeof authorizeColumnWrites>[2]).insert(request);
  if (adapter.update)
    wrapped.update = (request) => authorized(adapter as unknown as Parameters<typeof authorizeColumnWrites>[2]).update(request);
  if (adapter.remove)
    wrapped.remove = (request) => authorized(adapter as unknown as Parameters<typeof authorizeColumnWrites>[2]).remove(request);
  if (adapter.transaction) wrapped.transaction = (run) => adapter.transaction!((tx) => run(authorized(tx)));
  if (adapter.scopeTransaction) {
    const scopeTx = adapter.scopeTransaction.bind(adapter);
    wrapped.scopeTransaction = (scope, run) => scopeTx(scope, (tx, catalog) => run(authorized(tx), withoutBlockedCatalog(catalog, rules)));
  }
  const innerView = writeViewOf(adapter);
  lendWriteView(wrapped, {
    over: innerView ? innerView.over : adapter,
    records: (records) => authorized(innerView ? innerView.records(records) : records),
    catalog: (catalog) => withoutBlockedCatalog(innerView ? innerView.catalog(catalog) : catalog, rules),
  });

  return {
    adapter: wrapped,
    schema: withoutBlockedCatalog(full, rules),
  };
}
