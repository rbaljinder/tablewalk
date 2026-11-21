/**
 * `--mcp`: no HTTP server at all — or, when `TABLEWALK_MCP_URL` names a running
 * loopback `tablewalk` server (`http://localhost:4111/mcp`), a stdio bridge
 * onto that server so stdio-only MCP clients share one `Registry`, Undo stack,
 * egress counter and live activity trail with the browser.
 */
import { createInterface } from 'node:readline';
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import { serveMcp, setAdvertiseOutputSchema, setToolProfile } from '../mcp.js';
import { layoutsFor, pagesPath } from '@mistriwork/engine/server/layouts.js';
import type { Registry, ViewDef } from '@mistriwork/engine/host';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import type { SavedQuery } from '@mistriwork/engine/shared/sqlsaved.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import { startTelemetry } from '@mistriwork/engine/adapters/telemetry/start.js';

export async function serveMcpMode(
  opts: Options,
  registry: Registry,
  shelf: { views?: ViewDef[]; queries: SavedQuery[]; pages: PageDef[] },
  packageVersion: () => Promise<string>,
): Promise<void> {
  /* The version is what the package says it is, best-effort — serverInfo is
     a courtesy field. */
  const version = await packageVersion();
  /* Before the server starts answering, and fatal if it does not name a
     profile: a typo that silently fell back to every tool would be a
     surprise measured in tokens rather than in errors. */
  try {
    setToolProfile(opts.tools);
  } catch (err) {
    console.error(`tablewalk: ${startupReport(err)}`);
    process.exit(1);
  }
  setAdvertiseOutputSchema(opts.outputSchema);
  /* OpenTelemetry, when OTEL_* says so: a span per tool call, and the
     statements beneath it. Nothing is loaded otherwise. */
  const telemetry = await startTelemetry(process.env, version, undefined, 'tablewalk');
  process.stdin.once('close', () => {
    void telemetry.shutdown();
  });
  serveMcp(registry, version, {
    /* The same config the browser reads, so the shelf an agent sees is the
       shelf the team keeps — not a second list that drifts. */
    views: shelf.views,
    queries: shelf.queries,
    pages: shelf.pages,
    savedPages: (connection) => layoutsFor(connection, pagesPath()),
  });
  console.log('tablewalk: speaking MCP on stdio');
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/**
 * Forward newline-delimited stdio MCP messages to a running loopback
 * `tablewalk` server's `/mcp` endpoint.
 */
export function bridgeMcpToHttp(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.error(`tablewalk: TABLEWALK_MCP_URL "${rawUrl}" is not a valid URL (expected http://localhost:4111/mcp).`);
    process.exit(1);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    (parsed.protocol === 'http:' && !LOOPBACK_HOST.test(parsed.hostname))
  ) {
    console.error(
      `tablewalk: TABLEWALK_MCP_URL must point at loopback (http://localhost:<port>/mcp) or an https:// endpoint, not "${rawUrl}".`,
    );
    process.exit(1);
  }
  const target = parsed.pathname === '/' ? new URL('/mcp', parsed).toString() : parsed.toString();
  const write = (line: string) => {
    process.stdout.write(`${line}\n`);
  };
  const rl = createInterface({ input: process.stdin });
  let inOrder: Promise<unknown> = Promise.resolve();
  let running: { id: string | number; controller: AbortController } | undefined;
  const waiting = new Set<string | number>();
  const withdrawn = new Set<string | number>();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: string | number | null; method?: string; params?: { requestId?: unknown } };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'That line is not JSON.' } }));
      return;
    }
    if (msg.method === 'notifications/cancelled') {
      const reqId = msg.params?.requestId;
      if (running && running.id === reqId) running.controller.abort();
      else if ((typeof reqId === 'string' || typeof reqId === 'number') && waiting.has(reqId)) withdrawn.add(reqId);
      return;
    }
    const id = msg.id;
    if (msg.method === 'tools/call' && (typeof id === 'string' || typeof id === 'number')) waiting.add(id);
    inOrder = inOrder
      .catch(() => {})
      .then(async () => {
        const controller = new AbortController();
        if (typeof id === 'string' || typeof id === 'number') {
          waiting.delete(id);
          if (withdrawn.delete(id)) controller.abort();
          running = { id, controller };
        }
        try {
          const res = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: trimmed,
            signal: controller.signal,
          });
          if (res.status === 202) return;
          const body = (await res.text()).trim();
          if (!res.ok) {
            let errText = body;
            try {
              const j = JSON.parse(body) as { error?: { message?: string } | string };
              if (typeof j.error === 'string') errText = j.error;
              else if (j.error?.message) errText = j.error.message;
            } catch {
              /* Keep raw text. */
            }
            if (id !== undefined && id !== null) {
              write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: errText || `HTTP ${res.status}` } }));
            }
            return;
          }
          if (body) write(body);
        } catch (err) {
          if (id !== undefined && id !== null) {
            const message = controller.signal.aborted
              ? 'Cancelled: the client withdrew this call.'
              : `Could not reach ${target}: ${(err as Error).message}`;
            write(
              JSON.stringify(
                controller.signal.aborted
                  ? {
                      jsonrpc: '2.0',
                      id,
                      result: { content: [{ type: 'text', text: message }], _meta: { 'tablewalk/code': 'cancelled' }, isError: true },
                    }
                  : { jsonrpc: '2.0', id, error: { code: -32603, message } },
              ),
            );
          }
        } finally {
          running = undefined;
        }
      });
  });

  rl.on('close', () => {
    void inOrder
      .catch(() => {})
      .then(() => {
        process.stdout.write('', () => process.exit(0));
      });
  });
  console.error(`tablewalk: bridging stdio MCP to ${target}`);
}
