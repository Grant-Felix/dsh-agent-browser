/**
 * A minimal remote-protocol transport over the platform WebSocket.
 *
 * This is NOT the Chrome DevTools Protocol: it is the request/response and event
 * framing CDP uses (`{id, method, params}` out; `{id, result}` / `{id, error}` and
 * `{type:'event', method, params}` back). The backend sits on top of it and keeps
 * all protocol semantics — see `backends/chromium.js`.
 *
 * Node >= 22 ships a global `WebSocket`, so there is no dependency here.
 */

/** One CDP command failure, carrying the protocol error code. */
export class RemoteError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

const CLOSED = 'remote connection is closed';

/** A connected CDP endpoint: one browser or one flat session. */
export class RemoteClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;
  #closeReason = null;

  /** @param socket - an OPEN WebSocket speaking CDP. */
  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => this.#shutdown(CLOSED));
    socket.addEventListener('error', () => this.#shutdown('remote socket error'));
  }

  /**
   * Open a CDP connection.
   * @param url - the `webSocketDebuggerUrl` of a browser or page target.
   * @param options - connect timeout.
   * @returns the connected client.
   */
  static connect(url, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(new RemoteError(`cannot open the remote socket: ${error?.message ?? error}`));
        return;
      }
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Already gone.
        }
        reject(new RemoteError(`connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new RemoteClient(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new RemoteError('the remote socket refused the connection'));
        },
        { once: true },
      );
    });
  }

  /** Whether this connection can still carry commands. */
  get connected() {
    return !this.#closed;
  }

  /** Why the connection ended, when it did. */
  get closeReason() {
    return this.#closeReason;
  }

  /**
   * Send one command.
   * @param method - CDP method, e.g. `Page.navigate`.
   * @param params - method parameters.
   * @param sessionId - flat-session target, when the command is session-scoped.
   * @param timeoutMs - per-command budget.
   * @returns the command result.
   */
  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    if (this.#closed) return Promise.reject(new RemoteError(CLOSED, { method }));
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RemoteError(`${method} timed out after ${timeoutMs}ms`, { method }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new RemoteError(`${method} could not be sent: ${error?.message ?? error}`, { method }));
      }
    });
  }

  /**
   * Subscribe to one event.
   * @param method - CDP event name, e.g. `Page.screencastFrame`.
   * @param listener - called with `(params, sessionId)`.
   * @param sessionId - when given, deliver only events of that flat session.
   * @returns the unsubscribe function.
   */
  on(method, listener, sessionId) {
    const entry = { listener, sessionId };
    let set = this.#listeners.get(method);
    if (!set) {
      set = new Set();
      this.#listeners.set(method, set);
    }
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  /** Close the connection; pending commands reject. */
  close() {
    this.#shutdown('closed by caller');
    try {
      this.#socket.close();
    } catch {
      // Already gone.
    }
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        // Two error shapes travel on this transport: CDP puts `{code, message}`
        // in `error`, and some peers send `error` as a code STRING with the
        // text at the top level. Reading only the nested form reported the real
        // failure as "CDP error undefined" and hid it.
        const nested = typeof message.error === 'object' ? message.error : null;
        const text =
          (nested ? nested.message : undefined) ??
          message.message ??
          (typeof message.error === 'string' ? message.error : undefined) ??
          'protocol error';
        pending.reject(
          new RemoteError(text, {
            code: nested ? nested.code : message.error,
            data: nested ? nested.data : message,
            method: pending.method,
          }),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const set = this.#listeners.get(message.method);
    if (!set) return;
    for (const entry of [...set]) {
      if (entry.sessionId && entry.sessionId !== message.sessionId) continue;
      try {
        entry.listener(message.params ?? {}, message.sessionId);
      } catch {
        // A listener must never break the socket pump.
      }
    }
  }

  #shutdown(reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new RemoteError(`${reason} (while awaiting ${pending.method})`, { method: pending.method }));
    }
    this.#pending.clear();
    this.#listeners.clear();
  }
}

/**
 * Poll an HTTP endpoint until it answers, for cold-start readiness.
 * @param url - the URL to poll.
 * @param options - timeout and interval.
 * @returns the parsed JSON body.
 */
export async function waitForJson(url, { timeoutMs = 20_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1000, Math.min(4000, deadline - Date.now()))) });
      if (response.ok) return await response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message ?? String(error);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new RemoteError(`${url} did not answer within ${timeoutMs}ms (last: ${lastError})`);
}
