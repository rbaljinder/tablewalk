/**
 * Completion for the SQL editor.
 *
 * The query language's completer knows the grammar it is completing, because
 * tablewalk wrote that grammar. SQL is somebody else's language and this is not
 * a parser for it — writing one to power a dropdown would be a large amount of
 * code that is wrong in a different way for each dialect.
 *
 * What it does instead is answer two questions from the current statement at
 * the caret: **what is in scope** (tables, aliases, CTEs, foreign keys, and
 * named parameters), and **what kind of thing goes here**. Both are answerable
 * with a scan, and both degrade cleanly while staying silent inside comments
 * and string literals.
 */
import { findTable, state } from '@mistriwork/kit/client/core.js';
import { isInsideSqlLiteralOrComment } from '../shared/sqlHighlight.js';
import { extractSqlParameters, statementAtOffset } from '../shared/sqlScript.js';
import { say } from './copy/workbench/sqlcomplete.js';

/* Keywords offered as a last resort, in the order they occur in a statement
   rather than alphabetically — the point of the list is to suggest what comes
   next, and `WHERE` is a likelier next word than `ALL`. */
const KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'LIMIT',
  'OFFSET',
  'JOIN',
  'LEFT JOIN',
  'INNER JOIN',
  'RIGHT JOIN',
  'CROSS JOIN',
  'ON',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'IS NULL',
  'IS NOT NULL',
  'BETWEEN',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'DISTINCT',
  'WITH',
  'UNION',
  'UNION ALL',
  'ASC',
  'DESC',
  'EXISTS',
  'OVER(',
  'PARTITION BY',
  'FILTER(',
  'INSERT INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE FROM',
  'RETURNING',
];

const COMMON_FUNCTIONS = [
  'COUNT(',
  'SUM(',
  'AVG(',
  'MIN(',
  'MAX(',
  'COALESCE(',
  'NULLIF(',
  'LOWER(',
  'UPPER(',
  'LENGTH(',
  'ROUND(',
  'SUBSTR(',
  'TRIM(',
  'REPLACE(',
  'CAST(',
  'ROW_NUMBER()',
  'RANK()',
  'LAG(',
  'LEAD(',
];

const POSTGRES_EXTRAS = [
  'ILIKE',
  'DATE_TRUNC(',
  'STRING_AGG(',
  'JSONB_BUILD_OBJECT(',
  'JSON_AGG(',
  'NOW()',
  'CURRENT_TIMESTAMP',
  'GENERATE_SERIES(',
  'ON CONFLICT',
];

const SQLITE_EXTRAS = ['STRFTIME(', 'GROUP_CONCAT(', 'JSON_EXTRACT(', 'IFNULL(', 'IIF(', 'DATETIME('];

/** Words after which a table name is what comes next. */
const EXPECTS_TABLE = /\b(from|join|update|into|table)\s+(\w*)$/i;
const EXPECTS_JOIN = /\bjoin\s+(\w*)$/i;

/** Words after which a column name is what comes next. */
const EXPECTS_COLUMN = /\b(select|where|on|and|or|by|having|set|distinct|returning|,|\(|=|<|>|<=|>=|!=|<>|\+|-)\s*(\w*)$/i;

const NON_ALIAS_KEYWORDS =
  /^(where|join|left|right|inner|outer|cross|full|natural|on|group|order|limit|offset|having|union|intersect|except|set|values|using|and|or|returning|window)$/i;

/** Extract CTE names declared via `WITH [RECURSIVE] name AS (...)` in a statement. */
export function ctesOf(text) {
  const names = [];
  const seen = new Set();
  const re = /(?:^|[\s(,])(?:with\s+(?:recursive\s+)?|,\s*)([A-Za-z_]\w*)(?:\s*\([^)]*\))?\s+as\s*\(/gi;
  for (const m of text.matchAll(re)) {
    const name = m[1];
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

/**
 * Tables named in the statement, by the name they are referred to.
 *
 * Both directions: the alias if there is one, and the table's own name, since
 * `FROM customer` makes `customer.id` valid too. Matching is deliberately loose
 * about the shape of what follows — `AS` optional, a comma or newline ending
 * it — because the alternative is a parser.
 */
export function scopeOf(text) {
  const scope = new Map();
  const pattern = /\b(?:from|join|update|into)\s+([A-Za-z_][\w.$]*)(?:\s+(?:as\s+)?([A-Za-z_]\w*))?/gi;

  for (const match of text.matchAll(pattern)) {
    const [, name, alias] = match;
    // `FROM customer WHERE` — `WHERE` is not an alias, and neither is any other
    // word that can legally follow a table name.
    const isKeyword = alias && NON_ALIAS_KEYWORDS.test(alias);
    const table = findTable(name) ?? state.schema?.tables.find((t) => t.name === name || t.id === name);
    if (!table) continue;
    scope.set(table.name, table);
    scope.set(table.id, table);
    if (alias && !isKeyword) scope.set(alias, table);
  }
  return scope;
}

/** The word being typed, and where it starts. Splits on SQL's punctuation including `.` for qualified columns. */
export function tokenAt(text, caret) {
  const before = text.slice(0, caret);
  const start = Math.max(
    0,
    ...[' ', '\n', '\t', ',', '.', '(', ')', '=', '<', '>', '+', '-', '*', '/', ';'].map((c) => before.lastIndexOf(c) + 1),
  );
  return { word: before.slice(start), start };
}

const columnItem = (table, column, detail) => ({
  kind: column.primaryKey ? 'key' : column.references ? 'ref' : 'column',
  label: column.name,
  value: column.name,
  detail: detail ?? `${table.name} · ${column.type}`,
});

function aliasForTable(scope, table) {
  for (const [k, v] of scope) {
    if (v === table && k !== table.name && k !== table.id) return k;
  }
  return table.name;
}

function fkJoinSuggestions(scope, word) {
  const fks = state.schema?.foreignKeys ?? [];
  if (!fks.length || !scope.size) return [];
  const inScope = new Set(scope.values());
  const lower = word.toLowerCase();
  const out = [];
  const seen = new Set();

  for (const fk of fks) {
    const fromTable = state.schema.tables.find((t) => t.id === fk.from.table || t.name === fk.from.table);
    const toTable = state.schema.tables.find((t) => t.id === fk.to.table || t.name === fk.to.table);
    if (!fromTable || !toTable) continue;
    const fromIn = inScope.has(fromTable);
    const toIn = inScope.has(toTable);
    if (fromIn === toIn) continue;

    const target = fromIn ? toTable : fromTable;
    if (lower && !target.name.toLowerCase().startsWith(lower) && !target.id.toLowerCase().startsWith(lower)) continue;
    const existing = fromIn ? fromTable : toTable;
    const existingRef = aliasForTable(scope, existing);
    const fromCols = Array.isArray(fk.from.columns) ? fk.from.columns : [];
    const toCols = Array.isArray(fk.to.columns) ? fk.to.columns : [];
    if (!fromCols.length || fromCols.length !== toCols.length) continue;
    const predicates = fromCols.map((fc, i) => {
      const tc = toCols[i];
      const leftExpr = fromIn ? `${target.name}.${tc}` : `${target.name}.${fc}`;
      const rightExpr = fromIn ? `${existingRef}.${fc}` : `${existingRef}.${tc}`;
      return `${leftExpr} = ${rightExpr}`;
    });
    const clause = `${target.id} ON ${predicates.join(' AND ')}`;
    if (seen.has(clause)) continue;
    seen.add(clause);
    out.push({
      kind: 'table',
      label: clause,
      value: clause,
      detail: say('fkJoin', { ref: `${existingRef}.${(fromIn ? fromCols : toCols).join(', ')}` }),
    });
  }
  return out;
}

/**
 * What could come next, given where the caret is.
 *
 * Ordering within the list matters more than the list itself: the first entry
 * is what Tab accepts, so it has to be the likeliest thing rather than the
 * alphabetically first. Columns of tables actually in the statement come before
 * every other table's columns, and keywords come last — a keyword is always
 * *possible*, which is exactly why it is never the best guess.
 */
export function sqlSuggestions(text, caret) {
  if (!state.schema) return [];
  const dialect = state.schema.dialect === 'sqlite' ? 'sqlite' : 'postgres';
  if (isInsideSqlLiteralOrComment(text, caret, dialect)) return [];

  const { word } = tokenAt(text, caret);
  const before = text.slice(0, caret);
  const activeStmt = statementAtOffset(text, caret, dialect);
  const stmtText = activeStmt ? activeStmt.text : text;
  const scope = scopeOf(stmtText);
  const ctes = ctesOf(stmtText);
  const lower = word.toLowerCase();
  const starts = (name) => name.toLowerCase().startsWith(lower);
  const contains = (name) => lower.length >= 2 && !starts(name) && name.toLowerCase().includes(lower);

  /* Named parameter completion (`:min...`) — suggests parameters declared anywhere in the script. */
  if (word.startsWith(':') && !before.endsWith('::')) {
    const params = extractSqlParameters(text, dialect);
    const needle = word.slice(1).toLowerCase();
    return params
      .filter((p) => !needle || p.toLowerCase().startsWith(needle))
      .map((p) => ({
        kind: 'param',
        label: `:${p}`,
        value: `:${p}`,
        detail: say('param'),
        noSpace: true,
      }));
  }

  /* `alias.` — the one case with a definite answer. Nothing else can follow a
     qualified name, so nothing else is offered. */
  const qualified = /([A-Za-z_]\w*)\.(\w*)$/.exec(before);
  if (qualified) {
    const [, prefix, partial] = qualified;
    const table = scope.get(prefix) ?? findTable(prefix) ?? state.schema.tables.find((t) => t.name === prefix);
    if (!table) return [];
    const pLower = partial.toLowerCase();
    const prefixCols = table.columns.filter((c) => c.name.toLowerCase().startsWith(pLower));
    const fuzzyCols =
      pLower.length >= 2
        ? table.columns.filter((c) => !c.name.toLowerCase().startsWith(pLower) && c.name.toLowerCase().includes(pLower))
        : [];
    return [...prefixCols, ...fuzzyCols].map((c) => ({ ...columnItem(table, c), value: c.name }));
  }

  const out = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.kind}:${item.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  const tableItem = (t) => ({
    kind: t.isView ? 'view' : 'table',
    label: t.name,
    value: t.id,
    detail: say('columns', { count: t.columns.length }),
  });

  if (EXPECTS_TABLE.test(before)) {
    // After JOIN, offer FK-guided JOIN ... ON clauses first when tables are already in scope.
    if (EXPECTS_JOIN.test(before)) {
      for (const fkItem of fkJoinSuggestions(scope, word)) push(fkItem);
    }
    for (const cte of ctes) {
      if (starts(cte)) push({ kind: 'view', label: cte, value: cte, detail: say('cte') });
    }
    for (const t of state.schema.tables) {
      if (starts(t.name) || starts(t.id)) push(tableItem(t));
    }
    for (const t of state.schema.tables) {
      if (contains(t.name) || contains(t.id)) push(tableItem(t));
    }
    return out;
  }

  if (EXPECTS_COLUMN.test(before) || word) {
    const scopedTables = [...new Set(scope.values())];
    for (const table of scopedTables) {
      for (const column of table.columns) {
        if (starts(column.name)) push(columnItem(table, column));
      }
    }
    for (const table of scopedTables) {
      for (const column of table.columns) {
        if (contains(column.name)) push(columnItem(table, column));
      }
    }
    /* Aliases and table names themselves, so `c.` is reachable by typing `c`
       and accepting rather than by remembering it. */
    for (const [name, table] of scope) {
      if (starts(name) && name !== table.name) {
        push({ kind: 'alias', label: name, value: name, detail: say('alias', { name: table.name }) });
      }
    }
    /* Every other table's columns, once the statement's own are exhausted. A
       column typed before its FROM clause exists is a real way people write
       SQL, and offering nothing there is worse than offering a long list. */
    if (!out.length) {
      for (const table of state.schema.tables) {
        if (scope.has(table.name)) continue;
        for (const column of table.columns) {
          if (starts(column.name) || contains(column.name)) {
            push(columnItem(table, column, say('notInThisStatement', { name: table.name })));
          }
        }
      }
    }
  }

  const dialectExtras = dialect === 'sqlite' ? SQLITE_EXTRAS : POSTGRES_EXTRAS;
  if (!word || EXPECTS_TABLE.test(before) === false) {
    for (const keyword of KEYWORDS) {
      if (starts(keyword)) {
        push({ kind: 'keyword', label: keyword, value: keyword, detail: '', noSpace: keyword.endsWith('(') });
      }
    }
    for (const fn of [...COMMON_FUNCTIONS, ...dialectExtras]) {
      if (starts(fn)) {
        const isFn = fn.includes('(');
        push({
          kind: isFn ? 'fn' : 'keyword',
          label: fn,
          value: fn,
          detail: isFn ? say('fn') : '',
          noSpace: fn.endsWith('('),
        });
      }
    }
  }

  // Tables last among the non-keywords: a bare word is more often a column.
  for (const table of state.schema.tables) {
    if ((starts(table.name) || contains(table.name)) && !scope.has(table.name)) push(tableItem(table));
  }

  return out;
}
