/**
 * The MCP stdio transport: one JSON-RPC message per line on stdin, one per line
 * on stdout. That is the whole wire format, so it is written here rather than
 * pulled in as the SDK and its dependency tree — `npx edisnote-mcp` then starts
 * in well under a second and there is nothing to audit but this folder.
 *
 * stdout belongs to the protocol. Anything else printed there corrupts the
 * stream, so diagnostics go to stderr.
 */

import { createInterface } from 'node:readline';

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const INVALID_PARAMS = -32602;
export const METHOD_NOT_FOUND = -32601;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

/**
 * Answers one decoded message. Returns the response object, or null for a
 * notification (no id), which JSON-RPC says must never be answered.
 *
 * @param {Record<string, (params: any) => any>} handlers
 */
export async function dispatch(handlers, message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    // A response to something we sent (we send no requests) or garbage.
    if (message && 'id' in message && !('result' in message) && !('error' in message)) {
      return { jsonrpc: '2.0', id: message.id ?? null, error: { code: INVALID_REQUEST, message: 'Invalid request' } };
    }
    return null;
  }
  const isNotification = !('id' in message);
  const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : null;
  if (isNotification) {
    if (handler) await Promise.resolve(handler(message.params ?? {})).catch(() => {});
    return null;
  }
  if (!handler) {
    return { jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${message.method}` } };
  }
  try {
    const result = await handler(message.params ?? {});
    return { jsonrpc: '2.0', id: message.id, result: result ?? {} };
  } catch (err) {
    const code = err instanceof RpcError ? err.code : INTERNAL_ERROR;
    const error = { code, message: err?.message || 'Internal error' };
    if (err instanceof RpcError && err.data !== undefined) error.data = err.data;
    if (!(err instanceof RpcError)) process.stderr.write(`edisnote-mcp: ${err?.stack || err}\n`);
    return { jsonrpc: '2.0', id: message.id, error };
  }
}

/**
 * Runs the server until stdin closes. Returns `notify`, for messages the
 * server starts itself (list_changed).
 */
export function serveStdio(handlers, { input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  // Replies still being worked out when stdin closes. Exiting on 'close'
  // without waiting for these dropped every answer but the first in testing.
  const inFlight = new Set();

  lines.on('line', (line) => {
    const work = answer(line).finally(() => inFlight.delete(work));
    inFlight.add(work);
  });

  async function answer(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
      return;
    }
    // Batches left the spec in 2025-06-18; older clients may still send them.
    if (Array.isArray(message)) {
      const replies = (await Promise.all(message.map((m) => dispatch(handlers, m)))).filter(Boolean);
      if (replies.length) send(replies);
      return;
    }
    const reply = await dispatch(handlers, message);
    if (reply) send(reply);
  }

  return {
    notify: (method, params) => send(params ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method }),
    closed: new Promise((done) => lines.on('close', () => Promise.allSettled([...inFlight]).then(() => done()))),
  };
}
