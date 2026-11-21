/**
 * The reference shelf: what a client can put in front of a model without a
 * tool call. The schema brief per connection, one table or one record page in
 * full through templates, the team's named views, queries and pages, argument
 * completion for them, and the Markdown each is rendered as. The App reference
 * (`tablewalk docs`) is the App framework's, and an agent building an App reads
 * it through `tablewalk observe --mcp` (observe/mcp.ts): this server serves no App.
 */
import {
  findTable,
  referencesFrom,
  referencesTo,
  renderDDL,
  tableNamed,
  textToView,
  toMarkdown,
  type Registry,
  type DatabaseSchema,
  type ViewDef,
} from '@mistriwork/engine/host';
import { validateView } from '@mistriwork/engine/shared/view.js';
import { queriesFor, type SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import type { PageDef, PageSection } from '@mistriwork/engine/shared/page.js';
// Pure like shape.js, and split out for exactly this reason: the same brief
// the browser downloads and the CLI prints, offered as ambient context.
import { openFor, ToolError } from './toolkit.js';
import type { Answer } from './protocol.js';

/**
 * The team's own work, as things an agent can read and run by name.
 *
 * A tablewalk.json carries named views, statements and page definitions, and a
 * layouts file carries the pages someone built in the browser. Those are the
 * questions a team has decided are worth asking — "customers over their
 * limit", "everything about one work order" — written down by the people who
 * know the schema. An agent that cannot see them re-derives them badly, and
 * an agent that can see them starts where the team already got to.
 *
 * Resources rather than tools: they are documents, they do not change when
 * read, and a client can put them in front of a model without spending a
 * call. Nothing is executed by reading the shelf; `query`, `sql` and `export`
 * run named views and saved queries when asked.
 */
export interface Shelf {
  views?: ViewDef[];
  queries: SavedQuery[];
  pages: PageDef[];
  /** Pages saved from the browser, read per connection when asked. */
  savedPages?: (connection: string) => Promise<Record<string, unknown>>;
}

const shelfByRegistry = new WeakMap<Registry, Shelf>();

export function bindShelf(registry: Registry, shelf: Shelf): void {
  shelfByRegistry.set(registry, shelf);
}

export function shelfOf(registry: Registry): Shelf {
  return shelfByRegistry.get(registry) ?? { views: [], queries: [], pages: [] };
}

export function viewsFor(all: readonly ViewDef[] | undefined, connectionId: string, connectionName?: string): ViewDef[] {
  if (!all?.length) return [];
  return all.filter(
    (v) => !v.connection || v.connection === connectionId || (connectionName !== undefined && v.connection === connectionName),
  );
}

export function resolveNamedView(
  schema: DatabaseSchema,
  all: readonly ViewDef[] | undefined,
  connectionId: string,
  connectionName: string | undefined,
  wanted: string,
): ViewDef {
  const mine = viewsFor(all, connectionId, connectionName);
  const needle = wanted.trim().toLowerCase();
  const found = mine.find((v) => v.id.toLowerCase() === needle || v.name.toLowerCase() === needle);
  if (!found) {
    const known = mine.map((v) => v.name || v.id);
    throw new ToolError(
      'not_found',
      known.length
        ? `No configured view "${wanted}" on "${connectionId}". Known views: ${known.join(', ')}.`
        : `No configured view "${wanted}" on "${connectionId}" — its tablewalk.json defines no views.`,
    );
  }
  if (found.text) {
    const parsed = textToView(schema, found.text, { id: found.id, name: found.name });
    if (!parsed.view || parsed.errors.length) {
      throw new ToolError(
        'invalid_argument',
        `Configured view "${found.name || found.id}" does not match "${connectionId}": ${parsed.errors.map((e) => e.message).join('; ') || 'invalid view text'}.`,
      );
    }
    return parsed.view;
  }
  const problem = validateView(schema, found);
  if (problem) {
    throw new ToolError('invalid_argument', `Configured view "${found.name || found.id}" does not match "${connectionId}": ${problem}`);
  }
  return found;
}

export function resolveSavedQuery(all: SavedQuery[], connectionId: string, connectionName: string | undefined, wanted: string): SavedQuery {
  const mine = queriesFor(all, connectionId, connectionName);
  const needle = wanted.trim().toLowerCase();
  const found = mine.find((q) => q.name.toLowerCase() === needle);
  if (!found) {
    const known = mine.map((q) => q.name);
    throw new ToolError(
      'not_found',
      known.length
        ? `No saved query "${wanted}" on "${connectionId}". Known queries: ${known.join(', ')}.`
        : `No saved query "${wanted}" on "${connectionId}" — its tablewalk.json defines no queries.`,
    );
  }
  return found;
}

function queriesBrief(shelf: Shelf, connection: string, name: string): string {
  const mine = queriesFor(shelf.queries, connection, name);
  if (!mine.length) return `# Named queries — ${name}\n\nNone written down for this connection.`;
  const lines = [
    `# Named queries — ${name}`,
    '',
    `${mine.length} statement${mine.length === 1 ? '' : 's'} from your config. Run one with \`sql\` or \`export\` by passing \`saved: "<name>"\`.`,
    '',
  ];
  for (const query of mine) {
    lines.push(`## ${query.name}`, '');
    if (query.description) lines.push(query.description, '');
    lines.push('```sql', query.sql.trim(), '```', '');
  }
  return lines.join('\n').trim();
}

function viewsBrief(shelf: Shelf, connection: string, name: string): string {
  const mine = viewsFor(shelf.views, connection, name);
  if (!mine.length) return `# Named views — ${name}\n\nNone defined for this connection.`;
  const lines = [
    `# Named views — ${name}`,
    '',
    `${mine.length} multi-table view${mine.length === 1 ? '' : 's'} from your config. ` +
      'Run one with `query` or `export` by passing `view: "<name>"` (works across `"hidden"`-column connections too, where raw SQL is refused).',
    '',
  ];
  for (const view of mine) {
    const title = view.name && view.name !== view.id ? `${view.name} (\`${view.id}\`)` : view.name || view.id;
    lines.push(`## ${title}`, '', `- Base table: \`${view.base}\``);
    if (view.text) {
      lines.push('', '```text', view.text.trim(), '```', '');
      continue;
    }
    if (view.columns?.length) {
      lines.push(`- Columns: ${view.columns.map((c) => (c.alias ? `\`${c.path}\` as \`${c.alias}\`` : `\`${c.path}\``)).join(', ')}`);
    }
    if (view.aggregates?.length) {
      lines.push(
        `- Aggregates: ${view.aggregates
          .map((a) => `\`${a.fn}${a.column ? `(${a.column})` : ''}\` via \`${a.via}\`${a.alias ? ` as \`${a.alias}\`` : ''}`)
          .join(', ')}`,
      );
    }
    if (view.orderBy?.length) {
      lines.push(`- Sort: ${view.orderBy.map((o) => `\`${o.path}\` ${o.direction}`).join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function pagesBrief(pages: PageDef[], saved: Record<string, unknown>, connId: string, name: string): string {
  const all = [
    ...pages.map((p) => ({ id: p.id, name: p.name, base: p.base, sections: p.sections?.length ?? 0, from: 'config' })),
    ...Object.entries(saved).map(([id, page]) => {
      const def = page as { name?: string; label?: string; base?: string; sections?: unknown[] };
      return { id, name: def.name ?? def.label ?? id, base: def.base ?? '?', sections: def.sections?.length ?? 0, from: 'browser' };
    }),
  ];
  if (!all.length) return `# Pages — ${name}\n\nNone defined for this connection.`;
  const lines = [
    `# Pages — ${name}`,
    '',
    'A page is one record with everything around it — counts, lists and related rows — ' +
      `assembled by whoever knows this schema. Read \`tablewalk://${encodeURIComponent(connId)}/page/<id>\` for a page's full sections and filters.`,
    '',
    '| id | page | root table | sections | from |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const page of all) lines.push(`| \`${page.id}\` | ${page.name} | ${page.base} | ${page.sections} | ${page.from} |`);
  return lines.join('\n');
}

function describeSection(section: Record<string, unknown>, index: number): string {
  const kind = String(section.kind ?? 'section');
  const title = typeof section.title === 'string' && section.title ? `"${section.title}"` : `#${index + 1}`;
  const parts = [`- **${kind}** ${title}`];
  if (typeof section.from === 'string') parts.push(`from \`${section.from}\``);
  const via =
    typeof section.path === 'string' && section.path
      ? section.path
      : typeof section.whose === 'string' && section.whose
        ? section.whose
        : '';
  if (via) parts.push(`via \`${via}\``);
  if (typeof section.of === 'string' && section.of) parts.push(`of \`${section.of}\``);
  const fields = Array.isArray(section.paths) ? section.paths : kind === 'fields' && Array.isArray(section.show) ? section.show : [];
  if (fields.length) parts.push(`fields: ${fields.map((p) => `\`${String(p)}\``).join(', ')}`);
  const cols = Array.isArray(section.columns) ? section.columns : kind === 'list' && Array.isArray(section.show) ? section.show : [];
  if (cols.length) parts.push(`columns: ${cols.map((c) => `\`${String(c)}\``).join(', ')}`);
  if (typeof section.fn === 'string') parts.push(`measure: \`${section.fn}${section.column ? `(${String(section.column)})` : ''}\``);
  if (typeof section.by === 'string') parts.push(`by \`${section.by}\``);
  const filterText =
    typeof section.filter === 'string' && section.filter
      ? section.filter
      : typeof section.query === 'string' && section.query
        ? section.query
        : '';
  if (filterText) parts.push(`filter: \`${filterText}\``);
  if (typeof section.when === 'string' && section.when) parts.push(`when: \`${section.when}\``);
  return parts.join(' — ');
}

function pageBrief(
  page: { id: string; name?: string; label?: string; base?: string; sections?: readonly (PageSection | Record<string, unknown>)[] },
  source: 'config' | 'browser',
): string {
  const displayName = page.name ?? page.label;
  const title = displayName && displayName !== page.id ? `${displayName} (\`${page.id}\`)` : page.id;
  const lines = [`# Page — ${title}`, '', `- Root table: \`${page.base ?? '?'}\``, `- Source: ${source}`, ''];
  const sections = page.sections ?? [];
  if (!sections.length) {
    lines.push('No sections configured.');
    return lines.join('\n');
  }
  lines.push('## Sections', '');
  sections.forEach((s, i) => {
    lines.push(describeSection(s as Record<string, unknown>, i));
  });
  return lines.join('\n');
}

/**
 * One table as Markdown: the DDL, then the part no DDL states — what points
 * here. The same facts the `table` tool answers, shaped for attachment
 * rather than for parsing.
 */
export function tableBrief(schema: DatabaseSchema, table: ReturnType<typeof findTable> & object): string {
  const lines = [`## ${table.id}`, '', '```sql', renderDDL(schema, table.id).trim(), '```', ''];
  /* The DDL above is a reconstruction and drops checks, so a vocabulary read
     out of one would vanish here if it were not said again. */
  const vocab = table.columns.filter((c) => c.allowed?.length);
  if (vocab.length) {
    lines.push('Allowed values:', ...vocab.map((c) => `- ${c.name}: ${c.allowed!.map((v) => `\`${v}\``).join(', ')}`), '');
  }
  const out = referencesFrom(schema, table.id);
  if (out.length) {
    lines.push('Points at:', ...out.map((fk) => `- ${fk.from.columns.join(', ')} → ${fk.to.table}`), '');
  }
  const back = referencesTo(schema, table.id);
  if (back.length) {
    lines.push(
      'Pointed at by:',
      ...back.map((fk) => `- ${fk.from.table} via ${fk.from.columns.join(', ')}${fk.onDelete ? ` (on delete ${fk.onDelete})` : ''}`),
      '',
    );
  }
  if (!out.length && !back.length) lines.push('No foreign keys in either direction.', '');
  return lines.join('\n');
}

/* Resources are the reference shelf: things a client can attach to a
   conversation without spending a tool call, @-mentionable where the
   client supports it. The schema brief per connection is concrete;
   tables and individual pages come as templates, because listing sixty-six
   of them per connection would drown the resources everyone wants. */
export function listResources(registry: Registry, shelf: Shelf, answer: Answer): void {
  return answer({
    result: {
      resources: registry.list().flatMap((c) => [
        {
          uri: `tablewalk://${encodeURIComponent(c.id)}/schema`,
          name: `${c.name} — schema brief`,
          description: 'Every table with its columns and keys, and the foreign-key graph in both directions, as Markdown.',
          mimeType: 'text/markdown',
        },
        /* Listed only where there is something on the shelf: an empty
           document offered per connection is three lines of nothing in
           every client's resource picker. */
        ...(viewsFor(shelf.views, c.id, c.name).length
          ? [
              {
                uri: `tablewalk://${encodeURIComponent(c.id)}/views`,
                name: `${c.name} — named views`,
                description: 'Multi-table views from tablewalk.json, runnable via `query` or `export` (`view: "<name>"`).',
                mimeType: 'text/markdown',
              },
            ]
          : []),
        ...(queriesFor(shelf.queries, c.id, c.name).length
          ? [
              {
                uri: `tablewalk://${encodeURIComponent(c.id)}/queries`,
                name: `${c.name} — named queries`,
                description: 'The statements this team wrote down, runnable via `sql` or `export` (`saved: "<name>"`).',
                mimeType: 'text/markdown',
              },
            ]
          : []),
        ...(shelf.pages.some((p) => !p.connection || p.connection === c.id || p.connection === c.name)
          ? [
              {
                uri: `tablewalk://${encodeURIComponent(c.id)}/pages`,
                name: `${c.name} — pages`,
                description: 'Record pages defined for this connection: the root table each starts from, and how much is on it.',
                mimeType: 'text/markdown',
              },
            ]
          : []),
      ]),
    },
  });
}

export function listResourceTemplates(answer: Answer): void {
  return answer({
    result: {
      resourceTemplates: [
        {
          uriTemplate: 'tablewalk://{connection}/table/{table}',
          name: 'One table in full',
          description: 'DDL plus foreign keys in both directions, as Markdown. {connection} is a connection id, {table} a table id.',
          mimeType: 'text/markdown',
        },
        {
          uriTemplate: 'tablewalk://{connection}/page/{page}',
          name: 'One record page in full',
          description: 'Root table and every section, field group, metric, related list and filter of a configured or saved page.',
          mimeType: 'text/markdown',
        },
      ],
    },
  });
}

/* Argument completion for the resource templates: the same
   errors-teach spirit, moved before the mistake — a client that asks
   here never mistypes a table or page id at all. */
export async function completeArgument(registry: Registry, params: Record<string, unknown>, answer: Answer, shelf?: Shelf): Promise<void> {
  const { ref, argument, context } = params as {
    ref?: { type?: string; uri?: string };
    argument?: { name?: string; value?: string };
    context?: { arguments?: Record<string, string> };
  };
  const prefix = String(argument?.value ?? '').toLowerCase();
  let values: string[] = [];
  if (ref?.type === 'ref/resource' || ref?.type === 'ref/prompt') {
    if (argument?.name === 'connection') {
      values = registry.list().map((c) => c.id);
    } else if (argument?.name === 'table' || argument?.name === 'tables') {
      const conn = context?.arguments?.connection ?? registry.active ?? '';
      try {
        const { schema } = await openFor(registry, conn);
        values = schema.tables.map((t) => t.id);
      } catch {
        /* An unknown connection completes to nothing, not to an error —
           half-typed context is the normal state of a completion. */
      }
    } else if (argument?.name === 'page') {
      const activeShelf = shelf ?? shelfOf(registry);
      const conn = context?.arguments?.connection ?? registry.active ?? '';
      const label = registry.list().find((c) => c.id === conn)?.name;
      const fromConfig = activeShelf.pages
        .filter((p) => !p.connection || p.connection === conn || (label !== undefined && p.connection === label))
        .map((p) => p.id);
      const saved = conn ? Object.keys((await activeShelf.savedPages?.(conn).catch(() => ({}))) ?? {}) : [];
      values = [...new Set([...fromConfig, ...saved])];
    }
  }
  const matched = values.filter((v) => v.toLowerCase().startsWith(prefix));
  return answer({
    result: {
      completion: {
        values: matched.slice(0, 100),
        total: matched.length,
        hasMore: matched.length > 100,
      },
    },
  });
}

export async function readResource(registry: Registry, shelf: Shelf, params: Record<string, unknown>, answer: Answer): Promise<void> {
  const uri = String((params as { uri?: string }).uri ?? '');
  const match = /^tablewalk:\/\/([^/]+)\/(schema|views|queries|pages|table\/(.+)|page\/(.+))$/.exec(uri);
  if (!match) {
    return answer({ error: { code: -32002, message: `No resource at "${uri}".` } });
  }
  try {
    const connId = decodeURIComponent(match[1]);
    const named = registry.list().find((c) => c.id === connId);
    const label = named?.name ?? connId;
    if (match[2] === 'views' || match[2] === 'queries' || match[2] === 'pages') {
      /* The shelf is config and files, not the database — answered
         without opening a connection, so a resource about a database
         that is down still reads. */
      const text =
        match[2] === 'views'
          ? viewsBrief(shelf, connId, label)
          : match[2] === 'queries'
            ? queriesBrief(shelf, connId, label)
            : pagesBrief(
                shelf.pages.filter((p) => !p.connection || p.connection === connId || p.connection === label),
                (await shelf.savedPages?.(connId)) ?? {},
                connId,
                label,
              );
      return answer({
        result: { contents: [{ uri, mimeType: 'text/markdown', text }] },
      });
    }
    if (match[4] !== undefined) {
      const pageId = decodeURIComponent(match[4]);
      const fromConfig = shelf.pages.find(
        (p) => (p.id === pageId || p.name === pageId) && (!p.connection || p.connection === connId || p.connection === label),
      );
      if (fromConfig) {
        return answer({
          result: { contents: [{ uri, mimeType: 'text/markdown', text: pageBrief(fromConfig, 'config') }] },
        });
      }
      const saved = (await shelf.savedPages?.(connId)) ?? {};
      const savedPage = saved[pageId] as { name?: string; base?: string; sections?: readonly Record<string, unknown>[] } | undefined;
      if (savedPage && typeof savedPage === 'object') {
        return answer({
          result: { contents: [{ uri, mimeType: 'text/markdown', text: pageBrief({ id: pageId, ...savedPage }, 'browser') }] },
        });
      }
      return answer({ error: { code: -32002, message: `No page "${pageId}" behind "${uri}".` } });
    }
    const { schema } = await openFor(registry, connId);
    if (match[2] === 'schema') {
      return answer({
        result: { contents: [{ uri, mimeType: 'text/markdown', text: toMarkdown(schema) as string }] },
      });
    }
    const table = tableNamed(schema, decodeURIComponent(match[3]));
    if (!table) {
      return answer({ error: { code: -32002, message: `No table "${decodeURIComponent(match[3])}" behind "${uri}".` } });
    }
    return answer({
      result: { contents: [{ uri, mimeType: 'text/markdown', text: tableBrief(schema, table) }] },
    });
  } catch (err) {
    return answer({ error: { code: -32002, message: (err as Error).message } });
  }
}
