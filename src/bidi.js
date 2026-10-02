/**
 * A thin WebDriver BiDi client, sharing the CDP transport.
 *
 * BiDi frames the same way CDP does — `{id, method, params}` out, `{id, result}`
 * or `{id, error}` back, `{type:'event', method, params}` for events — so the
 * WebSocket pump in `remote.js` carries it unchanged. What differs is negotiated at
 * connect time (`session.new`) and what comes back: values are RemoteValue
 * trees, not JSON, which is what this module unwraps.
 */
import { RemoteClient, RemoteError } from './remote.js';

/** Events worth subscribing to, most specific first; unknown ones are dropped. */
export const BIDI_EVENTS = [
  'browsingContext.load',
  'browsingContext.domContentLoaded',
  'browsingContext.navigationStarted',
  'browsingContext.contextDestroyed',
];

/**
 * Unwrap one BiDi RemoteValue into a plain JavaScript value.
 *
 * The protocol describes values as trees (`{type:'object', value:[[key, tree]]}`),
 * so a nested page result only becomes usable after a recursive pass. Unknown
 * types are reported as a marker object rather than silently becoming undefined —
 * a wrong shape must be visible, not quietly empty.
 * @param remote - the RemoteValue.
 * @returns the plain value.
 */
export function unwrapRemote(remote) {
  if (!remote || typeof remote !== 'object') return undefined;
  switch (remote.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
      return remote.value ?? '';
    case 'boolean':
      return remote.value === true;
    case 'number': {
      if (typeof remote.value === 'string') return Number(remote.value);
      return typeof remote.value === 'number' ? remote.value : Number.NaN;
    }
    case 'bigint':
      return typeof remote.value === 'string' ? BigInt(remote.value) : BigInt(0);
    case 'array':
    case 'set':
      return (remote.value ?? []).map((item) => unwrapRemote(item));
    case 'object':
    case 'map': {
      const entries = remote.value ?? [];
      const out = {};
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [key, value] = entry;
        const name = typeof key === 'string' ? key : key?.type === 'string' ? key.value : String(unwrapRemote(key));
        out[name] = unwrapRemote(value);
      }
      return out;
    }
    case 'date':
      return remote.value ? new Date(remote.value) : null;
    case 'regexp':
      return remote.value?.pattern ?? '';
    case 'node':
      return { __node: remote.value?.nodeType ?? 'node', sharedId: remote.value?.sharedId ?? null };
    case 'window':
      return { __window: remote.value?.context ?? null };
    case 'function':
      return { __function: true };
    default:
      return { __unknownRemoteType: remote.type };
  }
}

/** One BiDi command failure, carrying the protocol error name. */
export class BidiError extends Error {
  constructor(message, { error, method, stacktrace } = {}) {
    super(message);
    this.name = 'BidiError';
    this.error = error;
    this.method = method;
    this.stacktrace = stacktrace;
  }
}

/** A connected BiDi session. */
export class BidiClient {
  #transport;
  #sessionId = null;

  constructor(transport) {
    this.#transport = transport;
  }

  /**
   * Open a BiDi connection and start a session.
   * @param url - the WebSocket endpoint, e.g. `ws://127.0.0.1:PORT/session`.
   * @returns the started client.
   */
  static async connect(url, { timeoutMs = 10_000 } = {}) {
    const transport = await RemoteClient.connect(url, { timeoutMs });
    const client = new BidiClient(transport);
    try {
      const started = await client.send('session.new', { capabilities: {} }, timeoutMs);
      client.#sessionId = started?.sessionId ?? null;
    } catch (error) {
      // Some builds have the session created by the transport itself; a failure
      // here is only fatal if commands do not work afterwards.
      client.#sessionError = error?.message ?? String(error);
    }
    return client;
  }

  #sessionError = null;

  get connected() {
    return this.#transport.connected;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get sessionError() {
    return this.#sessionError;
  }

  /**
   * Send one BiDi command.
   * @param method - e.g. `browsingContext.navigate`.
   * @param params - command parameters.
   * @returns the command result.
   */
  async send(method, params = {}, timeoutMs = 30_000) {
    try {
      return await this.#transport.send(method, params, undefined, timeoutMs);
    } catch (error) {
      if (error instanceof RemoteError) {
        const detail = error.data ?? {};
        throw new BidiError(`${method} failed: ${error.message}`, {
          error: detail?.error ?? error.code,
          method,
          stacktrace: detail?.stacktrace,
        });
      }
      throw error;
    }
  }

  /** Subscribe to one event; returns the unsubscribe function. */
  on(method, listener) {
    return this.#transport.on(method, (params) => listener(params));
  }

  /**
   * Ask the browser for the events this project needs.
   *
   * Subscriptions are per-session in BiDi, and an unknown event name fails the
   * whole call, so the list is trimmed to what this build accepts instead of
   * assuming a version.
   * @returns the events actually subscribed.
   */
  async subscribe(events = BIDI_EVENTS) {
    const accepted = [];
    for (const event of events) {
      try {
        await this.send('session.subscribe', { events: [event] }, 8000);
        accepted.push(event);
      } catch {
        // Not supported by this build; the caller must cope without it.
      }
    }
    return accepted;
  }

  close() {
    this.#transport.close();
  }
}

/** Evaluate an expression and unwrap the result, raising page exceptions. */
export async function bidiEvaluate(client, context, expression, { timeoutMs = 15_000 } = {}) {
  const result = await client.send(
    'script.evaluate',
    { expression, target: { context }, awaitPromise: true, resultOwnership: 'none' },
    timeoutMs,
  );
  const details = result?.exceptionDetails;
  if (details) {
    const text = details.exception?.description ?? details.text ?? 'evaluation failed';
    throw new BidiError(String(text).slice(0, 400), { method: 'script.evaluate' });
  }
  return unwrapRemote(result?.result);
}
