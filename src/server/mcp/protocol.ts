/**
 * MCP over stdio: the handshake, one JSON message per line both ways, the
 * dispatch of each method to the module that answers it, and the requests
 * this server makes of the client (elicitation).
 *
 * Hand-rolled JSON-RPC rather than a protocol SDK, for the same reason the
 * client has no framework: the surface actually used — initialize, ping,
 * tools/list, tools/call, over newline-delimited stdio — is five methods that
 * have been stable across every protocol revision, and a dependency would be
 * larger than the code it replaced.
 */
import { createInterface } from 'node:readline';
import { attributeWrites, type Registry } from '@mistriwork/engine/host';
import { inSpan, parseTraceparent, tracing } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { agentTools, runTool } from './registry.js';
import { setElicitor } from './tools/write.js';
import { bindShelf, completeArgument, listResources, listResourceTemplates, readResource, type Shelf } from './shelf.js';
import { getPrompt, listPrompts } from './prompts.js';

/** Protocol revisions this server knows. Answered back when the client asks
    for one of them; otherwise the newest we speak, per the spec's rule. */
const KNOWN_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'];
const DEFAULT_VERSION = KNOWN_VERSIONS[KNOWN_VERSIONS.length - 1];

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** A reply to the request being answered: its result, or its error. */
export type Answer = (reply: { result: unknown } | { error: { code: number; message: string } }) => void;

function instructionsFor(registry: Registry): string {
  return (
    (registry.list().some((c) => c.writable)
      ? `tablewalk exposes relational databases; ${registry
          .list()
          .filter((c) => c.writable)
          .map((c) => c.id)
          .join(', ')} ` + 'accept writes (insert, update, delete, insert_graph, delete_graph, revert), the rest are read-only. '
      : 'tablewalk exposes relational databases read-only. ') +
    'Call `schema_summary` first ' +
    'to orient, `table` for definitions and both directions of foreign keys, ' +
    '`query` for rows (its language is documented on the tool), and `record` to ' +
    'see one row with everything that points at it. Results carry a `link` a ' +
    'human can open in the tablewalk UI.'
  );
}

/**
 * Speak MCP over stdio until stdin closes.
 *
 * stdout is the protocol channel and carries nothing else — the caller has
 * already pointed every log at stderr. One JSON message per line, both ways,
 * which is the whole framing.
 */
export function serveMcp(
  registry: Registry,
  version: string,
  shelf: Shelf = { views: [], queries: [], pages: [] },
  options: { input?: NodeJS.ReadableStream } = {},
): void {
  bindShelf(registry, shelf);
  const write = (message: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  /* Resource uris the client asked to hear about. Only the schema briefs
     change today — refresh rewrites them — and a subscription is the one
     honest channel for saying a *content* changed: the list did not. */
  const subscribed = new Set<string>();
  const notify = (method: string, params: Record<string, unknown>) => write({ jsonrpc: '2.0', method, params });

  const rl = createInterface({ input: options.input ?? process.stdin });
  /* Requests run in the order they arrive, one at a time.

     Dispatch used to fire per line without awaiting, which let a pipelining
     client race itself: an update followed immediately by the query that
     checks it could read the row from before the write. Interactive clients
     await each response and never notice; correctness for the client that
     does not costs one promise chain. A chain off a failure keeps going —
     one bad request must not silence every later one. */
  let inOrder: Promise<unknown> = Promise.resolve();
  /* A tools/call can be withdrawn with notifications/cancelled: the one
     running now is stopped through its signal, and one still waiting in the
     chain starts already cancelled and answers so. Other methods answer at
     once and are not worth withdrawing. */
  let running: { id: string | number; controller: AbortController } | undefined;
  const waiting = new Set<string | number>();
  const withdrawn = new Set<string | number>();
  const cancel = (requestId: unknown) => {
    if (running && running.id === requestId) running.controller.abort();
    else if ((typeof requestId === 'string' || typeof requestId === 'number') && waiting.has(requestId)) withdrawn.add(requestId);
  };
  /* Requests this server makes of the client — elicitation — and the
     answers it is waiting for, by id. Answered outside the dispatch chain,
     because the call waiting on the answer *is* the chain's current link. */
  let asked = 0;
  const pending = new Map<string, (answer: Rpc) => void>();
  const ask = (method: string, params: Record<string, unknown>): Promise<Rpc> =>
    new Promise((resolve, reject) => {
      const id = `tablewalk-${++asked}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The client did not answer.'));
      }, 120_000);
      timer.unref();
      pending.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      write({ jsonrpc: '2.0', id, method, params });
    });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'That line is not JSON.' } });
      return;
    }
    /* A response to something we asked: no method, an id we are holding. */
    if (msg.method === undefined && typeof msg.id === 'string' && pending.has(msg.id)) {
      const settle = pending.get(msg.id)!;
      pending.delete(msg.id);
      settle(msg);
      return;
    }
    /* A cancel is read out of turn: the call it names is the chain's
       current link, or waiting behind it. */
    if (msg.method === 'notifications/cancelled') {
      cancel((msg.params as { requestId?: unknown } | undefined)?.requestId);
      return;
    }
    if (msg.method === 'tools/call' && (typeof msg.id === 'string' || typeof msg.id === 'number')) waiting.add(msg.id);
    inOrder = inOrder.catch(() => {}).then(() => dispatch(msg));
  });
  /* Exit only after the work is done, database connections are closed, and
     stdout has drained — in that order. */
  rl.on('close', () => {
    void inOrder
      .catch(() => {})
      .then(async () => {
        await registry.closeAll().catch(() => {});
        await registry.closeServices().catch(() => {});
        process.stdout.write('', () => process.exit(0));
      });
  });

  async function dispatch(msg: Rpc): Promise<void> {
    const { id, method, params = {} } = msg;
    // Notifications get no reply, including the one that ends the handshake.
    if (id === undefined || id === null) return;
    const answer: Answer = (reply) => write({ jsonrpc: '2.0', id, ...reply });

    try {
      if (method === 'initialize') {
        const asked = String((params as { protocolVersion?: string }).protocolVersion ?? '');
        /* A client that can put a question to the person gets asked, and
           the destructive tools stop trusting a `confirm: true` the model
           wrote itself. One that cannot keeps the two-call gate. */
        const caps = (params as { capabilities?: Record<string, unknown> }).capabilities ?? {};
        setElicitor(
          caps.elicitation
            ? async (message, title) => {
                const answer = await ask('elicitation/create', {
                  message,
                  requestedSchema: {
                    type: 'object',
                    properties: { confirm: { type: 'boolean', title, description: 'Yes to go ahead.' } },
                    required: ['confirm'],
                  },
                });
                const result = (answer as { result?: { action?: string; content?: { confirm?: unknown } } }).result;
                return result?.action === 'accept' && result.content?.confirm === true;
              }
            : null,
        );
        return write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: KNOWN_VERSIONS.includes(asked) ? asked : DEFAULT_VERSION,
            capabilities: { tools: {}, resources: { subscribe: true }, completions: {}, prompts: {} },
            serverInfo: { name: 'tablewalk', version },
            /* Said as it is: a server listing six write tools that calls itself
               read-only hands the model a system-level sentence its own tool
               list contradicts. */
            instructions: instructionsFor(registry),
          },
        });
      }
      if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} });
      if (method === 'resources/list') return listResources(registry, shelf, answer);
      if (method === 'resources/templates/list') return listResourceTemplates(answer);
      if (method === 'prompts/list') return listPrompts(answer);
      if (method === 'prompts/get') return await getPrompt(registry, params, answer);

      if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
        const uri = String((params as { uri?: string }).uri ?? '');
        if (method === 'resources/subscribe') subscribed.add(uri);
        else subscribed.delete(uri);
        return write({ jsonrpc: '2.0', id, result: {} });
      }

      if (method === 'completion/complete') return await completeArgument(registry, params, answer, shelf);
      if (method === 'resources/read') return await readResource(registry, shelf, params, answer);
      if (method === 'tools/list') {
        return write({ jsonrpc: '2.0', id, result: { tools: agentTools(registry) } });
      }
      if (method === 'tools/call') {
        const name = String((params as { name?: string }).name ?? '');
        const args = (params as { arguments?: Record<string, unknown> }).arguments ?? {};
        waiting.delete(id);
        const controller = new AbortController();
        if (withdrawn.delete(id)) controller.abort();
        running = { id, controller };
        // An agent's writes, for the record history of any App this process binds.
        /* A tool call is a span: the tool's name travels (a fixed list), its
           arguments do not. A client that carries W3C trace context in
           `_meta.traceparent` makes the call a child of its own trace. */
        const meta = (params as { _meta?: { traceparent?: unknown; tracestate?: unknown } })._meta;
        const known = tracing() && agentTools(registry).some((tool) => tool.name === name);
        const result = await inSpan(
          `tools/call ${known ? name : '_OTHER'}`,
          {
            kind: 'server',
            remote: parseTraceparent(meta?.traceparent, meta?.tracestate),
            attributes: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': known ? name : undefined },
          },
          (span) => {
            span.detail(() => ({ arguments: args }));
            return attributeWrites({ via: 'agent' }, () => runTool(registry, name, args, { signal: controller.signal, via: 'mcp' })).then(
              (answer) => {
                if (answer.isError) span.fail('tool_error');
                return answer;
              },
            );
          },
        ).finally(() => {
          running = undefined;
        });
        write({ jsonrpc: '2.0', id, result });
        /* A refresh that succeeded has rewritten the connection's brief.
           Anyone subscribed hears it in the protocol's own words, after the
           answer — a client should never learn of the change before the call
           that caused it returns. */
        if (name === 'refresh' && !result.isError) {
          const conn = String(result.structuredContent?.connection ?? '');
          const uri = `tablewalk://${encodeURIComponent(conn)}/schema`;
          if (subscribed.has(uri)) notify('notifications/resources/updated', { uri });
        }
        return;
      }
      return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `No such method: ${method}` } });
    } catch (err) {
      return write({ jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } });
    }
  }
}

/**
 * Streamable HTTP MCP (`POST /mcp` on the running browser server).
 *
 * Shares the browser's `Registry`, Undo journal, `sessionEgress` and live
 * activity trail, so an external agent and the human in the browser look at
 * one session instead of two processes. Returns `undefined` when every message
 * in the payload is a notification (`202 Accepted`).
 */
export async function answerMcpHttp(
  registry: Registry,
  shelf: Shelf,
  payload: unknown,
  options: { version: string; signal?: AbortSignal; trusted?: boolean },
): Promise<Record<string, unknown> | Array<Record<string, unknown>> | undefined> {
  bindShelf(registry, shelf);

  const one = async (raw: unknown): Promise<Record<string, unknown> | undefined> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } };
    }
    const msg = raw as Rpc;
    const { id, method, params = {} } = msg;
    if (id === undefined || id === null) return undefined;
    let captured: Record<string, unknown> | undefined;
    const answer: Answer = (reply) => {
      captured = { jsonrpc: '2.0', id, ...reply };
    };
    try {
      if (method === 'initialize') {
        const asked = String((params as { protocolVersion?: string }).protocolVersion ?? '');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: KNOWN_VERSIONS.includes(asked) ? asked : DEFAULT_VERSION,
            capabilities: { tools: {}, resources: {}, completions: {}, prompts: {} },
            serverInfo: { name: 'tablewalk', version: options.version },
            instructions: instructionsFor(registry),
          },
        };
      }
      if (method === 'ping' || method === 'resources/subscribe' || method === 'resources/unsubscribe') {
        return { jsonrpc: '2.0', id, result: {} };
      }
      if (method === 'resources/list') {
        listResources(registry, shelf, answer);
        return captured;
      }
      if (method === 'resources/templates/list') {
        listResourceTemplates(answer);
        return captured;
      }
      if (method === 'prompts/list') {
        listPrompts(answer);
        return captured;
      }
      if (method === 'prompts/get') {
        await getPrompt(registry, params, answer);
        return captured;
      }
      if (method === 'completion/complete') {
        await completeArgument(registry, params, answer, shelf);
        return captured;
      }
      if (method === 'resources/read') {
        await readResource(registry, shelf, params, answer);
        return captured;
      }
      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: agentTools(registry, { trusted: options.trusted }) } };
      }
      if (method === 'tools/call') {
        const name = String((params as { name?: string }).name ?? '');
        const args = (params as { arguments?: Record<string, unknown> }).arguments ?? {};
        const meta = (params as { _meta?: { traceparent?: unknown; tracestate?: unknown } })._meta;
        const known = tracing() && agentTools(registry, { trusted: options.trusted }).some((tool) => tool.name === name);
        const result = await inSpan(
          `tools/call ${known ? name : '_OTHER'}`,
          {
            kind: 'server',
            remote: parseTraceparent(meta?.traceparent, meta?.tracestate),
            attributes: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': known ? name : undefined },
          },
          (span) => {
            span.detail(() => ({ arguments: args }));
            return attributeWrites({ via: 'agent' }, () =>
              runTool(registry, name, args, { signal: options.signal, trusted: options.trusted, via: 'mcp' }),
            ).then((out) => {
              if (out.isError) span.fail('tool_error');
              return out;
            });
          },
        );
        return { jsonrpc: '2.0', id, result };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `No such method: ${method}` } };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } };
    }
  };

  if (Array.isArray(payload)) {
    if (!payload.length) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty JSON-RPC batch.' } };
    const replies: Array<Record<string, unknown>> = [];
    for (const item of payload) {
      const r = await one(item);
      if (r !== undefined) replies.push(r);
    }
    return replies.length ? replies : undefined;
  }
  return one(payload);
}
