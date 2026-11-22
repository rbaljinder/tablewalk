/**
 * The database browser's modes that answer and exit rather than serve: the schema in words (`--export md`,
 * `mermaid`, `json`), `--diff` and `--lint`. Each is a build step — its answer on stdout, every startup line
 * already sent to stderr — and a build step that starts a web server is one nobody wires into CI. An App's
 * exports (types, OpenAPI, AsyncAPI) are the App framework's. With Apps named, the App framework's main (in the mistri
 * package) loads and vets them first, then hands the mode back here.
 */
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import type { Registry } from '@mistriwork/engine/host';

/** `--export md | markdown | mermaid | json | agent` (the formats startFor and browserMain give this main). */
export async function exportSchemaText(given: string, registry: Registry): Promise<void> {
  const format = given.toLowerCase();
  try {
    const activeId = registry.active!;
    const { schema } = await registry.open(activeId);
    if (format === 'agent') {
      const text = await renderAgentBrief(registry, activeId, schema);
      process.stdout.write(`${text}\n`);
      return;
    }
    const { toMarkdown, toMermaid, toSchemaJson } = await import('@mistriwork/engine/shared/schematext.js');
    const text =
      format === 'mermaid' ? toMermaid(schema) : format === 'json' ? JSON.stringify(toSchemaJson(schema), null, 2) : toMarkdown(schema);
    process.stdout.write(`${text}\n`);
  } catch (error) {
    console.error(`tablewalk: ${startupReport(error)}`);
    process.exitCode = 1;
  } finally {
    await registry.closeAll();
  }
}

async function renderAgentBrief(
  registry: Registry,
  activeId: string,
  schema: Awaited<ReturnType<Registry['open']>>['schema'],
): Promise<string> {
  const [{ getConnectionRuntimePolicy, listEnrichedConnections }, { describeSchema, primaryKey, referencesFrom, referencesTo }] =
    await Promise.all([import('../mcp/toolkit.js'), import('@mistriwork/engine/host')]);

  type Shaped = {
    hubs: Array<{ table: { name: string }; from: string[] }>;
    leaves: Array<{ name: string }>;
    joins: Array<{ table: { name: string }; connects: string[] }>;
    chain: Array<{ name: string }>;
    start?: { name: string };
  };

  const enriched = listEnrichedConnections(registry);
  const shape = describeSchema(schema) as Shaped;
  const lines: string[] = [];

  lines.push(`# Database brief: ${schema.label} (${schema.dialect})`);
  lines.push('');

  if (enriched.length > 0) {
    lines.push('## Connections & guardrails');
    lines.push('');
    for (const conn of enriched) {
      const cfg = registry.configOf(conn.id);
      const pol = getConnectionRuntimePolicy(registry, conn.id);
      const target = conn.env ? `${conn.database}@${conn.env}` : conn.name;
      const flags = [
        conn.writable ? 'writable' : 'read-only',
        ...(cfg?.rows === false ? ['rows:false'] : []),
        ...(pol?.redactsRows ? ['redact'] : []),
        ...(pol?.maxRows !== undefined ? [`maxRows:${pol.maxRows}`] : []),
        ...(pol?.timeoutMs !== undefined ? [`timeout:${pol.timeoutMs}ms`] : []),
        ...(pol?.focused ? ['focused'] : []),
      ];
      lines.push(`- \`${target}\` (${conn.dialect}${conn.id === activeId ? ', active' : ''}) — ${flags.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Schema orientation');
  lines.push('');
  const baseTables = schema.tables.filter((t) => !t.isView);
  const views = schema.tables.filter((t) => t.isView);
  lines.push(
    `- **Shape:** ${baseTables.length} tables${views.length ? `, ${views.length} views` : ''}, ${schema.foreignKeys.length} foreign keys`,
  );
  if (shape.hubs.length) {
    lines.push(`- **Hub tables:** ${shape.hubs.map((h) => `\`${h.table.name}\` (referenced by ${h.from.length})`).join(', ')}`);
  }
  if (shape.leaves.length) {
    lines.push(`- **Event tables:** ${shape.leaves.map((t) => `\`${t.name}\``).join(', ')}`);
  }
  if (shape.joins.length) {
    lines.push(`- **Join tables:** ${shape.joins.map((j) => `\`${j.table.name}\` (${j.connects.join(' <-> ')})`).join(', ')}`);
  }
  if (shape.chain.length > 1) {
    lines.push(`- **Deepest walk:** ${shape.chain.map((t) => `\`${t.name}\``).join(' -> ')}`);
  }
  lines.push('');

  lines.push('## Key tables');
  lines.push('');
  lines.push('| Table | Rows | Key | Outgoing FKs | Referenced by |');
  lines.push('| --- | --- | --- | --- | --- |');
  const shown = schema.tables.slice(0, 25);
  for (const table of shown) {
    const pk = primaryKey(table);
    const out = referencesFrom(schema, table.id).map((fk) => `${fk.from.columns.join('+')}->${fk.to.table}`);
    const inc = referencesTo(schema, table.id).map((fk) => fk.from.table);
    const rowsLabel = table.isView ? 'view' : table.approxRows !== undefined ? `~${table.approxRows}` : '-';
    lines.push(
      `| \`${table.id}\` | ${rowsLabel} | ${pk.length ? `\`${pk.join(', ')}\`` : 'none'} | ${out.slice(0, 4).join(', ') || '-'} | ${[...new Set(inc)].slice(0, 4).join(', ') || '-'} |`,
    );
  }
  if (schema.tables.length > shown.length) {
    lines.push(`| _+${schema.tables.length - shown.length} more_ | | | _call \`tables\` for full list_ | |`);
  }
  lines.push('');

  const sampleTable = shape.start?.name ?? shape.leaves[0]?.name ?? shape.hubs[0]?.table.name ?? baseTables[0]?.id ?? 'table_name';
  const sampleFk = schema.foreignKeys[0];
  lines.push('## Fast agent queries');
  lines.push('');
  lines.push('```sh');
  lines.push(`npx tablewalk --query "${sampleTable} limit 10" --format tsv`);
  if (sampleFk) {
    const targetMeta = schema.tables.find((t) => t.id === sampleFk.to.table || t.name === sampleFk.to.table);
    const targetCol = targetMeta?.columns.find((c) => !c.primaryKey)?.name ?? targetMeta?.columns[0]?.name;
    if (targetCol && sampleFk.from.columns.length === 1) {
      lines.push(`npx tablewalk --query "${sampleFk.from.table} show ${sampleFk.from.columns[0]}.${targetCol} limit 10" --format tsv`);
    }
    lines.push(`npx tablewalk --call path --args '{"from":"${sampleFk.from.table}","to":"${sampleFk.to.table}"}' --format md`);
  }
  lines.push('npx tablewalk --call perf --format md');
  lines.push('```');

  return lines.join('\n');
}

export interface ConnectionCheckEntry {
  id: string;
  name: string;
  target: string;
  database: string;
  env?: string;
  tier: string;
  dialect: string;
  ok: boolean;
  ms: number;
  tables?: number;
  views?: number;
  foreignKeys?: number;
  guardrails: string[];
  error?: string;
}

/** `--check [--format json | md]`: dial target connection(s), verify credentials and guardrails, print report, and exit. */
export async function checkConnections(registry: Registry, options: { singleId?: string; format?: string } = {}): Promise<void> {
  const fmt = options.format?.trim().toLowerCase();
  if (fmt !== undefined && fmt !== 'json' && fmt !== 'md') {
    console.error(`tablewalk: --check supports --format json or md — not "${options.format}".`);
    process.exitCode = 1;
    await registry.closeAll().catch(() => {});
    return;
  }

  const { getConnectionRuntimePolicy, listEnrichedConnections } = await import('../mcp/toolkit.js');
  try {
    const all = listEnrichedConnections(registry);
    const targets = options.singleId ? all.filter((c) => c.id === options.singleId) : all;
    const results: ConnectionCheckEntry[] = [];

    for (const conn of targets) {
      const cfg = registry.configOf(conn.id);
      const pol = getConnectionRuntimePolicy(registry, conn.id);
      const guardrails = [
        conn.writable ? 'writable' : 'read-only',
        ...(cfg?.rows === false ? ['rows:false'] : []),
        ...(pol?.redactsRows ? ['redact'] : []),
        ...(pol?.maxRows !== undefined ? [`maxRows:${pol.maxRows}`] : []),
        ...(pol?.timeoutMs !== undefined ? [`timeout:${pol.timeoutMs}ms`] : []),
        ...(pol?.focused ? ['focused'] : []),
      ];
      const targetLabel = conn.env ? `${conn.database}@${conn.env}` : conn.name;
      const started = performance.now();
      try {
        const { schema } = await registry.open(conn.id);
        const ms = Math.max(0, Math.round(performance.now() - started));
        /* Re-read runtime policy after open in case focus/redact resolved lazily on dial. */
        const postPol = getConnectionRuntimePolicy(registry, conn.id);
        const finalGuardrails = [
          conn.writable ? 'writable' : 'read-only',
          ...(cfg?.rows === false ? ['rows:false'] : []),
          ...(postPol?.redactsRows ? ['redact'] : []),
          ...(postPol?.maxRows !== undefined ? [`maxRows:${postPol.maxRows}`] : []),
          ...(postPol?.timeoutMs !== undefined ? [`timeout:${postPol.timeoutMs}ms`] : []),
          ...(postPol?.focused ? ['focused'] : []),
        ];
        const views = schema.tables.filter((t) => t.isView).length;
        const tables = schema.tables.length - views;
        results.push({
          id: conn.id,
          name: conn.name,
          target: targetLabel,
          database: conn.database,
          ...(conn.env ? { env: conn.env } : {}),
          tier: conn.tier,
          dialect: schema.dialect,
          ok: true,
          ms,
          tables,
          views,
          foreignKeys: schema.foreignKeys.length,
          guardrails: finalGuardrails,
        });
      } catch (err) {
        const ms = Math.max(0, Math.round(performance.now() - started));
        results.push({
          id: conn.id,
          name: conn.name,
          target: targetLabel,
          database: conn.database,
          ...(conn.env ? { env: conn.env } : {}),
          tier: conn.tier,
          dialect: conn.dialect,
          ok: false,
          ms,
          guardrails,
          error: startupReport(err),
        });
      }
    }

    const failed = results.filter((r) => !r.ok).length;
    const passed = results.length - failed;
    if (failed > 0) process.exitCode = 1;

    if (fmt === 'json') {
      process.stdout.write(
        `${JSON.stringify({ ok: failed === 0, count: results.length, passed, failed, connections: results }, null, 2)}\n`,
      );
      return;
    }

    if (fmt === 'md') {
      const mdLines = [
        '| Target | Dialect | Status | Latency | Shape | Guardrails |',
        '| --- | --- | --- | --- | --- | --- |',
        ...results.map((r) => {
          const status = r.ok ? 'ok' : `FAIL: ${(r.error ?? 'error').replace(/\|/g, '\\|').replace(/\s+/g, ' ')}`;
          const shape = r.ok ? `${r.tables} tables, ${r.views} views, ${r.foreignKeys} FKs` : '-';
          return `| \`${r.target}\` | ${r.dialect} | ${status} | ${r.ms} ms | ${shape} | ${r.guardrails.join(', ')} |`;
        }),
      ];
      process.stdout.write(`${mdLines.join('\n')}\n`);
      return;
    }

    const lines = results.map((r) =>
      r.ok
        ? `ok    ${r.target} (${r.dialect}) — ${r.tables} tables, ${r.views} views, ${r.foreignKeys} FKs in ${r.ms} ms [${r.guardrails.join(', ')}]`
        : `FAIL  ${r.target} (${r.dialect}) — ${r.error ?? 'failed'} (${r.ms} ms) [${r.guardrails.join(', ')}]`,
    );
    lines.push(`${passed}/${results.length} connections ready${failed ? ` (${failed} failed)` : ''}.`);
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    await registry.closeAll();
  }
}

export async function diffConnections(other: string, registry: Registry): Promise<void> {
  const { diffSchemas, diffReport } = await import('../../shared/diff.js');
  try {
    const mine = await registry.open(registry.active!);
    let theirs;
    try {
      theirs = await registry.open(other);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
    const diff = diffSchemas(mine.schema, theirs.schema);
    process.stdout.write(`${diffReport(diff)}\n`);
    /* diff(1)'s convention, and the one a CI step wants: zero means the same,
       one means different. Anything else here would need a flag to mean what
       every other diff already means without one. */
    if (!diff.same) process.exitCode = 1;
  } finally {
    await registry.closeAll();
  }
}

/* Print and exit, like --export: this is a build step, and a build step
   that starts a web server is one nobody wires into CI. */
export async function lintConnection(given: string, failOn: string | undefined, registry: Registry): Promise<void> {
  const { lintSchema, lintReport, lintCounts } = await import('../../shared/lint.js');
  try {
    const { schema } = await registry.open(registry.active!);
    const findings = lintSchema(schema);
    const format = given.toLowerCase();
    if (format !== 'text' && format !== 'json') {
      console.error(`--lint takes text or json — not "${given}".`);
      process.exitCode = 1;
      return;
    }
    if (failOn) {
      const levels = ['high', 'medium', 'low'];
      const at = levels.indexOf(failOn.toLowerCase());
      if (at === -1) {
        console.error(`--fail-on takes high, medium or low — not "${failOn}".`);
        process.exitCode = 1;
        return;
      }
      /* At least this severe: `--fail-on medium` fails on medium *and* high,
         which is the reading that makes a threshold useful. */
      const worst = levels.slice(0, at + 1);
      if (findings.some((f) => worst.includes(f.severity))) process.exitCode = 1;
    }
    process.stdout.write(
      format === 'json'
        ? `${JSON.stringify({ connection: registry.active, counts: lintCounts(findings), findings }, null, 2)}\n`
        : `${lintReport(findings)}\n`,
    );
  } finally {
    await registry.closeAll();
  }
}
