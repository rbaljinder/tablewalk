/**
 * Dialect-aware SQL tokenizer for real-time syntax highlighting and editor
 * context detection (comments, strings, dollar-quotes, parameters, functions,
 * keywords, operators, and numbers).
 *
 * Pure, dependency-free, and linear-time so every keystroke in the SQL editor
 * highlights immediately without blocking input or inflating the bundle.
 */

export type SqlDialect = 'postgres' | 'sqlite';

export type SqlTokenKind = 'plain' | 'keyword' | 'function' | 'string' | 'number' | 'comment' | 'param' | 'ident' | 'operator' | 'punct';

export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
  start: number;
  end: number;
}

const SQL_KEYWORDS = new Set([
  'ALL',
  'ALTER',
  'ANALYZE',
  'AND',
  'AS',
  'ASC',
  'BEGIN',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'CHECK',
  'COLLATE',
  'COLUMN',
  'COMMIT',
  'CONFLICT',
  'CONSTRAINT',
  'CREATE',
  'CROSS',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'DEFAULT',
  'DELETE',
  'DESC',
  'DISTINCT',
  'DO',
  'DROP',
  'ELSE',
  'END',
  'EXCEPT',
  'EXISTS',
  'EXPLAIN',
  'FALSE',
  'FETCH',
  'FILTER',
  'FIRST',
  'FOLLOWING',
  'FOREIGN',
  'FROM',
  'FULL',
  'GROUP',
  'HAVING',
  'IF',
  'ILIKE',
  'IN',
  'INDEX',
  'INNER',
  'INSERT',
  'INTERSECT',
  'INTO',
  'IS',
  'JOIN',
  'KEY',
  'LAST',
  'LATERAL',
  'LEFT',
  'LIKE',
  'LIMIT',
  'MATERIALIZED',
  'NATURAL',
  'NOT',
  'NOTHING',
  'NULL',
  'NULLS',
  'OFFSET',
  'ON',
  'ONLY',
  'OR',
  'ORDER',
  'OUTER',
  'OVER',
  'PARTITION',
  'PLACING',
  'PRECEDING',
  'PRIMARY',
  'RANGE',
  'RECURSIVE',
  'REFERENCES',
  'RENAME',
  'REPLACE',
  'RETURNING',
  'RIGHT',
  'ROLLBACK',
  'ROW',
  'ROWS',
  'SCHEMA',
  'SELECT',
  'SET',
  'SIMILAR',
  'SOME',
  'TABLE',
  'TEMP',
  'TEMPORARY',
  'THEN',
  'TO',
  'TRIGGER',
  'TRUE',
  'UNBOUNDED',
  'UNION',
  'UNIQUE',
  'UPDATE',
  'USING',
  'VALUES',
  'VIEW',
  'WHEN',
  'WHERE',
  'WINDOW',
  'WITH',
]);

const SQL_FUNCTIONS = new Set([
  'ABS',
  'ARRAY_AGG',
  'AVG',
  'BOOL_AND',
  'BOOL_OR',
  'CEIL',
  'CEILING',
  'COALESCE',
  'CONCAT',
  'CONCAT_WS',
  'COUNT',
  'DATE',
  'DATE_PART',
  'DATE_TRUNC',
  'DATETIME',
  'DENSE_RANK',
  'EXTRACT',
  'FIRST_VALUE',
  'FLOOR',
  'GENERATE_SERIES',
  'GREATEST',
  'GROUP_CONCAT',
  'IFNULL',
  'IIF',
  'JSON_AGG',
  'JSON_ARRAY',
  'JSON_BUILD_OBJECT',
  'JSON_EXTRACT',
  'JSON_OBJECT',
  'JSONB_AGG',
  'JSONB_BUILD_OBJECT',
  'JSONB_EXTRACT_PATH',
  'JSONB_EXTRACT_PATH_TEXT',
  'LAG',
  'LAST_VALUE',
  'LEAD',
  'LEAST',
  'LEFT',
  'LENGTH',
  'LOWER',
  'LTRIM',
  'MAX',
  'MIN',
  'NOW',
  'NTH_VALUE',
  'NTILE',
  'NULLIF',
  'PERCENT_RANK',
  'POSITION',
  'POWER',
  'PRINTF',
  'RANDOM',
  'RANK',
  'REGEXP_MATCH',
  'REGEXP_REPLACE',
  'REPLACE',
  'RIGHT',
  'ROUND',
  'ROW_NUMBER',
  'RTRIM',
  'SPLIT_PART',
  'SQRT',
  'STRFTIME',
  'STRING_AGG',
  'SUBSTR',
  'SUBSTRING',
  'SUM',
  'TIME',
  'TO_CHAR',
  'TO_DATE',
  'TO_NUMBER',
  'TO_TIMESTAMP',
  'TRIM',
  'TYPEOF',
  'UNNEST',
  'UPPER',
]);

const isWordStart = (ch: string) => /[A-Za-z_]/.test(ch);
const isWordChar = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
const isDigit = (ch: string) => ch >= '0' && ch <= '9';

function matchDollarTag(sql: string, pos: number): string | null {
  if (sql[pos] !== '$') return null;
  if (pos > 0 && isWordChar(sql[pos - 1])) return null;
  let i = pos + 1;
  if (i < sql.length && sql[i] === '$') return '$$';
  if (i >= sql.length || !isWordStart(sql[i])) return null;
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
  return i < sql.length && sql[i] === '$' ? sql.slice(pos, i + 1) : null;
}

/** Tokenize SQL text into contiguous spans covering `[0, sql.length)` losslessly. */
export function tokenizeSql(sql: string, dialect: SqlDialect = 'postgres'): SqlToken[] {
  const tokens: SqlToken[] = [];
  const n = sql.length;
  let i = 0;

  const push = (kind: SqlTokenKind, start: number, end: number) => {
    if (end <= start) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === kind && prev.end === start) {
      prev.text += sql.slice(start, end);
      prev.end = end;
      return;
    }
    tokens.push({ kind, text: sql.slice(start, end), start, end });
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      const start = i;
      while (i < n && (sql[i] === ' ' || sql[i] === '\t' || sql[i] === '\n' || sql[i] === '\r')) i++;
      push('plain', start, i);
      continue;
    }

    // Line comment: -- ...
    if (ch === '-' && next === '-') {
      const start = i;
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      push('comment', start, i);
      continue;
    }

    // Block comment: /* ... */ (nested in Postgres)
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (dialect === 'postgres' && sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      push('comment', start, i);
      continue;
    }

    // Postgres E'...' escape string
    if (dialect === 'postgres' && (ch === 'E' || ch === 'e') && next === "'" && (i === 0 || !isWordChar(sql[i - 1]))) {
      const start = i;
      i += 2;
      while (i < n) {
        if (sql[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          if (sql[i] === "'") {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      push('string', start, i);
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          i++;
          if (sql[i] === "'") {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      push('string', start, i);
      continue;
    }

    // Postgres dollar-quoted string: $$...$$ or $tag$...$tag$
    if (dialect === 'postgres' && ch === '$') {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const start = i;
        i += tag.length;
        const closeAt = sql.indexOf(tag, i);
        i = closeAt >= 0 ? closeAt + tag.length : n;
        push('string', start, i);
        continue;
      }
      // Positional parameter $1, $2
      if (isDigit(next)) {
        const start = i;
        i += 2;
        while (i < n && isDigit(sql[i])) i++;
        push('param', start, i);
        continue;
      }
    }

    // Double-quoted identifier
    if (ch === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          i++;
          if (sql[i] === '"') {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      push('ident', start, i);
      continue;
    }

    // SQLite backtick identifier
    if (dialect === 'sqlite' && ch === '`') {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '`') {
          i++;
          if (sql[i] === '`') {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      push('ident', start, i);
      continue;
    }

    // Mustache parameter: {{name}}
    if (ch === '{' && next === '{') {
      const m = /^\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/.exec(sql.slice(i));
      if (m) {
        push('param', i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }

    // Postgres type cast `::` vs named parameter `:name`
    if (ch === ':') {
      if (next === ':') {
        push('operator', i, i + 2);
        i += 2;
        continue;
      }
      if (isWordStart(next) && (i === 0 || !isWordChar(sql[i - 1]))) {
        const start = i;
        i += 2;
        while (i < n && /[A-Za-z0-9_]/.test(sql[i])) i++;
        push('param', start, i);
        continue;
      }
    }

    // Numbers (integers, decimals, scientific notation, hex 0x...)
    if (isDigit(ch) || (ch === '.' && isDigit(next))) {
      const start = i;
      if (ch === '0' && (next === 'x' || next === 'X')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(sql[i])) i++;
      } else {
        while (i < n && isDigit(sql[i])) i++;
        if (sql[i] === '.' && isDigit(sql[i + 1] ?? '')) {
          i++;
          while (i < n && isDigit(sql[i])) i++;
        }
        if (
          (sql[i] === 'e' || sql[i] === 'E') &&
          (isDigit(sql[i + 1] ?? '') || ((sql[i + 1] === '+' || sql[i + 1] === '-') && isDigit(sql[i + 2] ?? '')))
        ) {
          i++;
          if (sql[i] === '+' || sql[i] === '-') i++;
          while (i < n && isDigit(sql[i])) i++;
        }
      }
      push('number', start, i);
      continue;
    }

    // Words (keywords, functions, identifiers)
    if (isWordStart(ch)) {
      const start = i;
      i++;
      while (i < n && isWordChar(sql[i])) i++;
      const word = sql.slice(start, i);
      const upper = word.toUpperCase();
      // Peek ahead skipping spaces for `(` to recognize function calls.
      let p = i;
      while (p < n && (sql[p] === ' ' || sql[p] === '\t')) p++;
      const followedByParen = sql[p] === '(';
      const precededByDot = start > 0 && sql[start - 1] === '.';

      if (!precededByDot && followedByParen && (SQL_FUNCTIONS.has(upper) || !SQL_KEYWORDS.has(upper))) {
        push('function', start, i);
      } else if (!precededByDot && SQL_KEYWORDS.has(upper)) {
        push('keyword', start, i);
      } else {
        push('plain', start, i);
      }
      continue;
    }

    // Multi-char operators
    const two = sql.slice(i, i + 2);
    const three = sql.slice(i, i + 3);
    if (three === '->>' || three === '#>>') {
      push('operator', i, i + 3);
      i += 3;
      continue;
    }
    if (two === '->' || two === '#>' || two === '||' || two === '<>' || two === '!=' || two === '<=' || two === '>=') {
      push('operator', i, i + 2);
      i += 2;
      continue;
    }

    // Single-char operators & punctuation
    if ('=<>+-*/%~&|^!@'.includes(ch)) {
      push('operator', i, i + 1);
      i++;
      continue;
    }
    if ('(),;.'.includes(ch)) {
      push('punct', i, i + 1);
      i++;
      continue;
    }

    push('plain', i, i + 1);
    i++;
  }

  return tokens;
}

/** True when `offset` sits strictly inside a SQL comment or string literal. */
export function isInsideSqlLiteralOrComment(sql: string, offset: number, dialect: SqlDialect = 'postgres'): boolean {
  if (offset <= 0) return false;
  const tokens = tokenizeSql(sql, dialect);
  for (const tok of tokens) {
    if (tok.kind !== 'comment' && tok.kind !== 'string') continue;
    // Strictly inside, or at the trailing edge of an unterminated literal/comment.
    if (offset > tok.start && offset < tok.end) return true;
    if (offset === tok.end && tok.end === sql.length) {
      if (tok.kind === 'comment' && tok.text.startsWith('--')) return true;
      if (tok.kind === 'comment' && tok.text.startsWith('/*') && !tok.text.endsWith('*/')) return true;
      if (tok.kind === 'string' && tok.text.startsWith("'") && (tok.text.length === 1 || !tok.text.endsWith("'"))) return true;
    }
  }
  return false;
}
