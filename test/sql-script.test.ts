import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  computeColumnAggregates,
  diffResultSets,
  extractSqlParameters,
  formatResultExport,
  splitSqlStatements,
  statementAtOffset,
  substituteSqlParameters,
} from '../src/shared/sqlScript.js';
import { isInsideSqlLiteralOrComment, tokenizeSql } from '../src/shared/sqlHighlight.js';

describe('splitSqlStatements & statementAtOffset', () => {
  test('splits multi-statement Postgres scripts while preserving dollar quotes, nested comments, and E-strings', () => {
    const script = [
      '-- First query',
      "SELECT 'a;b' AS s, E'it\\'s;ok' AS e;",
      '/* outer /* nested ; */ comment */',
      'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;',
      'SELECT id, total FROM invoice WHERE total > 100',
    ].join('\n');

    const stmts = splitSqlStatements(script, 'postgres');
    assert.equal(stmts.length, 3);
    assert.match(stmts[0].text, /SELECT 'a;b'/);
    assert.match(stmts[1].text, /CREATE FUNCTION f\(\)/);
    assert.equal(stmts[2].text, 'SELECT id, total FROM invoice WHERE total > 100');
    assert.equal(stmts[2].startLine, 5);

    const mid = script.indexOf('CREATE FUNCTION') + 5;
    assert.equal(statementAtOffset(script, mid, 'postgres')?.index, 1);
    const tail = script.length;
    assert.equal(statementAtOffset(script, tail, 'postgres')?.index, 2);
  });

  test('keeps SQLite CREATE TRIGGER BEGIN...CASE...END...END intact across inner semicolons', () => {
    const script = `
      CREATE TRIGGER tr_inv AFTER INSERT ON invoice
      BEGIN
        UPDATE customer SET total = CASE WHEN NEW.total > 0 THEN total + NEW.total ELSE total END WHERE id = NEW.customer_id;
        INSERT INTO audit_log(msg) VALUES ('added;ok');
      END;
      SELECT count(*) FROM customer;
    `;
    const stmts = splitSqlStatements(script, 'sqlite');
    assert.equal(stmts.length, 2);
    assert.match(stmts[0].text, /^CREATE TRIGGER tr_inv/);
    assert.match(stmts[0].text, /END$/);
    assert.equal(stmts[1].text, 'SELECT count(*) FROM customer');
  });

  test('ignores trailing comment-only chunks', () => {
    const stmts = splitSqlStatements('SELECT 1;\n-- trailing note only\n/* done */', 'postgres');
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].text, 'SELECT 1');
  });
});

describe('extractSqlParameters & substituteSqlParameters', () => {
  test('extracts :param and {{param}} while ignoring Postgres ::casts, strings, and comments', () => {
    const sql = `
      -- :ignored_comment {{also_ignored}}
      SELECT id::text, ':not_a_param', '{{nope}}'
      FROM invoice
      WHERE customer_id = :customer_id
        AND status = {{status}}
        AND total >= :min_total
        AND customer_id != :customer_id
    `;
    assert.deepEqual(extractSqlParameters(sql, 'postgres'), ['customer_id', 'status', 'min_total']);

    const bound = substituteSqlParameters(sql, { customer_id: '42', status: "O'Brien", min_total: '100.50' }, 'postgres');
    assert.match(bound, /id::text/);
    assert.match(bound, /':not_a_param'/);
    assert.match(bound, /customer_id = 42/);
    assert.match(bound, /status = 'O''Brien'/);
    assert.match(bound, /total >= 100\.50/);
    assert.match(bound, /customer_id != 42/);
  });

  test('handles null, booleans, and leading-zero string codes safely', () => {
    const sql = 'SELECT :a, :b, :c, :zip';
    const bound = substituteSqlParameters(sql, { a: 'null', b: 'true', c: 'false', zip: '02138' }, 'postgres');
    assert.equal(bound, "SELECT NULL, TRUE, FALSE, '02138'");
  });
});

describe('formatResultExport, computeColumnAggregates & diffResultSets', () => {
  const cols = ['id', 'name', 'total'];
  const rows = [
    [1, 'Ada, Lovelace', 120.5],
    [2, "O'Neil", 80],
    [3, null, 200],
  ];

  test('exports csv, json, markdown, insert, and in formats', () => {
    const csv = formatResultExport(cols, rows, 'csv');
    assert.equal(csv, 'id,name,total\n1,"Ada, Lovelace",120.5\n2,O\'Neil,80\n3,,200\n');

    const json = JSON.parse(formatResultExport(cols, rows, 'json'));
    assert.equal(json.length, 3);
    assert.equal(json[0].name, 'Ada, Lovelace');
    assert.equal(json[2].name, null);

    const md = formatResultExport(cols, rows, 'markdown');
    assert.match(md, /^\| id \| name \| total \|/);
    assert.match(md, /\| 2 \| O'Neil \| 80 \|/);

    const ins = formatResultExport(cols, rows, 'insert', 'invoice');
    assert.match(ins, /INSERT INTO invoice \(id, name, total\) VALUES \(2, 'O''Neil', 80\);/);
    assert.match(ins, /VALUES \(3, NULL, 200\);/);

    assert.equal(formatResultExport(cols, rows, 'in'), '(1, 2, 3)');
  });

  test('computes aggregates only for numeric columns', () => {
    const aggs = computeColumnAggregates(cols, rows);
    assert.deepEqual(
      aggs.map((a) => a.column),
      ['id', 'total'],
    );
    const total = aggs.find((a) => a.column === 'total')!;
    assert.equal(total.sum, 400.5);
    assert.equal(total.min, 80);
    assert.equal(total.max, 200);
    assert.equal(total.nonNull, 3);
  });

  test('diffs two result sets keyed by id', () => {
    const diff = diffResultSets(
      {
        columns: ['id', 'status', 'total'],
        rows: [
          [1, 'open', 100],
          [2, 'paid', 200],
          [3, 'void', 50],
        ],
      },
      {
        columns: ['id', 'status', 'total'],
        rows: [
          [1, 'open', 100],
          [2, 'refunded', 200],
          [4, 'open', 75],
        ],
      },
    );
    assert.equal(diff.keyColumn, 'id');
    assert.equal(diff.unchangedCount, 1);
    assert.deepEqual(
      diff.rows.map((r) => [r.key, r.status, r.diffColumns]),
      [
        ['2', 'changed', ['status']],
        ['3', 'removed', ['id', 'status', 'total']],
        ['4', 'added', ['id', 'status', 'total']],
      ],
    );
  });
});

describe('tokenizeSql & isInsideSqlLiteralOrComment', () => {
  test('losslessly tokenizes keywords, functions, strings, comments, params, casts, and numbers', () => {
    const sql = "-- head\nSELECT COUNT(id), name::text, 'hi''there', :min_total, {{env}}, 42.5 FROM \"customer\" WHERE id = $1;";
    const tokens = tokenizeSql(sql, 'postgres');
    assert.equal(tokens.map((t) => t.text).join(''), sql);
    assert.ok(tokens.some((t) => t.kind === 'comment' && t.text === '-- head'));
    assert.ok(tokens.some((t) => t.kind === 'keyword' && t.text === 'SELECT'));
    assert.ok(tokens.some((t) => t.kind === 'function' && t.text === 'COUNT'));
    assert.ok(tokens.some((t) => t.kind === 'operator' && t.text === '::'));
    assert.ok(tokens.some((t) => t.kind === 'string' && t.text === "'hi''there'"));
    assert.ok(tokens.some((t) => t.kind === 'param' && t.text === ':min_total'));
    assert.ok(tokens.some((t) => t.kind === 'param' && t.text === '{{env}}'));
    assert.ok(tokens.some((t) => t.kind === 'param' && t.text === '$1'));
    assert.ok(tokens.some((t) => t.kind === 'number' && t.text === '42.5'));
    assert.ok(tokens.some((t) => t.kind === 'ident' && t.text === '"customer"'));
  });

  test('detects when caret sits inside strings or comments', () => {
    const sql = "SELECT 'hello' -- trailing";
    assert.equal(isInsideSqlLiteralOrComment(sql, 10, 'postgres'), true);
    assert.equal(isInsideSqlLiteralOrComment(sql, 22, 'postgres'), true);
    assert.equal(isInsideSqlLiteralOrComment(sql, 7, 'postgres'), false);
    assert.equal(isInsideSqlLiteralOrComment("SELECT 'unterminated", 20, 'postgres'), true);
  });
});
