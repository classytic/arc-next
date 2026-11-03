/**
 * A `fetch`-based `EventSource` that can send headers.
 *
 * The WHATWG `EventSource` cannot set request headers, so a browser that
 * authenticates its stream with a bearer token has to put it in the URL, where
 * access logs, proxies and crash reports keep it. This implementation opens
 * the stream with `fetch` instead, so the token travels in `Authorization`
 * exactly like every other request.
 *
 * It satisfies {@link EventSourceConstructor}, so it drops into
 * `configureClient({ eventSource: FetchEventSource })`; with
 * `streamAuth: 'header'` and nothing injected, `subscribeToEvents` loads it on
 * demand (a dynamic import, so native-`EventSource` consumers of `/sse` never
 * ship it).
 *
 * Differences from the native `EventSource`, all deliberate:
 * - **No self-reconnect.** A failure moves to `CLOSED` and fires `error`.
 *   Reconnect and backoff belong to the caller (`subscribeToEvents` owns them),
 *   so the policy lives in one place. The server's `retry:` value is exposed as
 *   {@link FetchEventSource.reconnectionTime}, and `Last-Event-ID` is sent when
 *   the next instance is given `lastEventId` (or the header).
 * - **The `error` event carries the HTTP verdict**: `status` (`0` = no response,
 *   e.g. network or CORS failure) and the response `headers`, so a 401 or a
 *   429 + `Retry-After` is handled without a second probe request.
 * - **Liveness**: `init.onActivity` runs for every received chunk after `open`,
 *   heartbeat comments included, which the native `EventSource` never exposes.
 *
 * Runtime: any environment with streaming `fetch` (`Response.body` as a
 * `ReadableStream`), `TextDecoder` and `AbortController` — every modern
 * browser, Node 18+, Bun, Deno. React Native's `fetch` does not stream response
 * bodies, so on RN keep injecting `react-native-sse`.
 *
 * Server-safe module (no React, no `"use client"`, no side effects).
 */

import type { EventSourceEventLike, EventSourceInitLike, EventSourceLike } from "./client.js";

// ============================================================================
// Parser — WHATWG HTML §9.2.6 "Interpreting an event stream"
// ============================================================================

/** One dispatched SSE event, as the stream defined it. */
export interface SseParsedEvent {
  /** The `event:` field, or `'message'` when the block had none. */
  type: string;
  /** `data:` lines joined with `\n` (the final newline removed). */
  data: string;
  /** The stream's last event ID at dispatch time (persists across blocks until changed). */
  lastEventId: string;
}

/** Callbacks for {@link createSseParser}. */
export interface SseParserHandlers {
  onEvent: (event: SseParsedEvent) => void;
  /** A valid `retry:` field (ASCII digits only), in milliseconds. */
  onRetry?: (ms: number) => void;
  /**
   * Fired once per non-empty `push()`, before any event that chunk completes, comment-only chunks
   * (`": heartbeat\n\n"`) included: the liveness signal of a quiet but healthy stream.
   */
  onActivity?: () => void;
  /**
   * The last event ID buffer to start from: the `Last-Event-ID` this connection sent. WHATWG keeps
   * the buffer across reconnects, so an event without `id:` reports it rather than `""`. Default `""`.
   */
  initialLastEventId?: string;
}

/** Incremental SSE parser. Feed decoded text in any chunking; call `reset()` per connection. */
export interface SseParser {
  push(chunk: string): void;
  /** The last event ID buffer — what `Last-Event-ID` should carry on reconnect. */
  readonly lastEventId: string;
  /** Start a new stream (pending data discarded, BOM handling re-armed). The last event ID persists. */
  reset(): void;
}

/**
 * Create a spec-conformant incremental SSE parser.
 *
 * Handles CRLF / LF / CR line endings (including a CR at the end of one chunk
 * and its LF at the start of the next), a leading BOM, comments, `id` with
 * NULL rejection, digits-only `retry`, and the rule that an unterminated final
 * block is discarded rather than dispatched.
 */
export function createSseParser(handlers: SseParserHandlers): SseParser {
  let buffer = "";
  let firstChunk = true;
  /** The previous chunk ended in CR, so a leading LF here is the same line break. */
  let pendingCr = false;
  let dataBuffer = "";
  let eventType = "";
  let lastEventIdBuffer = handlers.initialLastEventId ?? "";

  const dispatch = (): void => {
    if (dataBuffer === "") {
      eventType = "";
      return;
    }
    const data = dataBuffer.endsWith("\n") ? dataBuffer.slice(0, -1) : dataBuffer;
    const type = eventType || "message";
    dataBuffer = "";
    eventType = "";
    handlers.onEvent({ type, data, lastEventId: lastEventIdBuffer });
  };

  const processLine = (line: string): void => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return; // comment
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        dataBuffer += `${value}\n`;
        break;
      case "id":
        if (!value.includes("\u0000")) lastEventIdBuffer = value;
        break;
      case "retry":
        if (/^[0-9]+$/.test(value)) handlers.onRetry?.(Number.parseInt(value, 10));
        break;
      default:
        // Unknown field — ignored per spec.
        break;
    }
  };

  return {
    push(chunk: string): void {
      let text = chunk;
      if (firstChunk && text.length > 0) {
        firstChunk = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      if (chunk.length > 0) handlers.onActivity?.();
      if (pendingCr && text.startsWith("\n")) text = text.slice(1);
      pendingCr = false;
      buffer += text;

      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer.charCodeAt(i);
        if (ch !== 0x0a && ch !== 0x0d) continue;
        const line = buffer.slice(start, i);
        if (ch === 0x0d) {
          if (i + 1 < buffer.length) {
            if (buffer.charCodeAt(i + 1) === 0x0a) i++;
          } else {
            pendingCr = true;
          }
        }
        start = i + 1;
        processLine(line);
      }
      buffer = buffer.slice(start);
    },
    get lastEventId(): string {
      return lastEventIdBuffer;
    },
    reset(): void {
      buffer = "";
      firstChunk = true;
      pendingCr = false;
      dataBuffer = "";
      eventType = "";
    },
  };
}

// ============================================================================
// FetchEventSource
// ============================================================================

/** Event delivered to {@link FetchEventSource} listeners. */
export interface FetchEventSourceEvent extends EventSourceEventLike {
  type: string;
  /** Message payload (`message` and named events). */
  data?: string;
  lastEventId?: string;
  /** Origin of the stream URL (`message` and named events). */
  origin?: string;
  /**
   * `error` only: the HTTP status of the stream response, or `0` when there
   * was none (network failure, CORS rejection, abort by the runtime).
   */
  status?: number;
  /** `error` only: the response headers when a response arrived (`Retry-After` on a 429). */
  headers?: { get(name: string): string | null };
  /** `error` only: human-readable reason. */
  message?: string;
}

type Listener = (event: FetchEventSourceEvent) => void;

/** Init for {@link FetchEventSource}: the SDK's {@link EventSourceInitLike} plus fetch-specific knobs. */
export interface FetchEventSourceInit extends EventSourceInitLike {
  /** Send `Last-Event-ID` with this value (a reconnect resuming where the last stream stopped). */
  lastEventId?: string;
  /** Overrides the `withCredentials` mapping (`true` → `'include'`, else `'same-origin'`). */
  credentials?: RequestCredentials;
  /** The fetch to use. Default: `globalThis.fetch`, read at connect time. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

function originOf(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).origin;
  } catch {
    return "";
  }
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * `EventSource` over `fetch`: request headers (auth), `credentials`, abortable.
 *
 * @example
 * configureClient({ baseUrl, streamAuth: 'header', eventSource: FetchEventSource });
 *
 * @example
 * const es = new FetchEventSource('/api/stream', {
 *   headers: { Authorization: `Bearer ${token}` },
 * });
 * es.addEventListener('incident.created', (e) => console.log(e.data));
 * es.onerror = (e) => console.warn('stream failed', e.status);
 */
export class FetchEventSource implements EventSourceLike {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSED = CLOSED;
  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSED = CLOSED;

  readonly url: string;
  readonly withCredentials: boolean;
  /** `0` connecting, `1` open, `2` closed (never re-opens — see module docs). */
  readyState: 0 | 1 | 2 = CONNECTING;
  /** The stream's last event ID; pass it as `lastEventId` to the next instance. */
  lastEventId: string;
  /** Server-requested reconnect delay from `retry:` (ms). Default 3000. */
  reconnectionTime = 3000;

  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly controller = new AbortController();

  constructor(url: string, init: FetchEventSourceInit = {}) {
    this.url = url;
    this.withCredentials = init.withCredentials === true;
    this.lastEventId = init.lastEventId ?? headerValue(init.headers, "Last-Event-ID") ?? "";
    // Connect after construction returns, so listeners attached synchronously
    // (the normal `new` → `addEventListener` pattern) see `open`.
    queueMicrotask(() => {
      void this.run(init);
    });
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Close the stream and abort the underlying fetch. Fires no event (like the native one). */
  close(): void {
    this.readyState = CLOSED;
    this.controller.abort();
  }

  /** A method, not an inline compare: `readyState` changes across awaits, which TS narrowing cannot see. */
  private closed(): boolean {
    return this.readyState === CLOSED;
  }

  private emit(event: FetchEventSourceEvent): void {
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) {
      try {
        fn(event);
      } catch (err) {
        // A throwing listener must not break the stream or its siblings.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    const prop =
      event.type === "open"
        ? this.onopen
        : event.type === "message"
          ? this.onmessage
          : event.type === "error"
            ? this.onerror
            : null;
    prop?.call(this, event);
  }

  private fail(status: number, message: string, headers?: Headers): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.controller.abort();
    this.emit({ type: "error", status, message, ...(headers ? { headers } : {}) });
  }

  private async run(init: FetchEventSourceInit): Promise<void> {
    if (this.readyState === CLOSED) return;
    const doFetch = init.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = { Accept: "text/event-stream", ...init.headers };
    if (this.lastEventId && !headerValue(init.headers, "Last-Event-ID")) {
      headers["Last-Event-ID"] = this.lastEventId;
    }

    let res: Response;
    try {
      res = await doFetch(this.url, {
        method: "GET",
        headers,
        credentials: init.credentials ?? (this.withCredentials ? "include" : "same-origin"),
        cache: "no-store",
        signal: this.controller.signal,
      });
    } catch (err) {
      this.fail(0, err instanceof Error ? err.message : "network error");
      return;
    }

    if (this.closed()) {
      void res.body?.cancel().catch(() => {});
      return;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      this.fail(res.status, `HTTP ${res.status}`, res.headers);
      return;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!/^text\/event-stream\b/i.test(contentType)) {
      void res.body?.cancel().catch(() => {});
      this.fail(res.status, `Expected text/event-stream, got "${contentType}"`, res.headers);
      return;
    }
    if (!res.body || typeof res.body.getReader !== "function") {
      this.fail(
        res.status,
        "Response body is not a readable stream (this runtime's fetch cannot stream; use react-native-sse on React Native)",
        res.headers,
      );
      return;
    }

    this.readyState = OPEN;
    this.emit({ type: "open" });

    const origin = originOf(this.url);
    const parser = createSseParser({
      // The id this connection resumed from persists until the server sends a new one.
      initialLastEventId: this.lastEventId,
      onEvent: (e) => {
        this.lastEventId = e.lastEventId;
        if (this.readyState !== OPEN) return;
        this.emit({ type: e.type, data: e.data, lastEventId: e.lastEventId, origin });
      },
      onRetry: (ms) => {
        this.reconnectionTime = ms;
      },
      onActivity: () => {
        if (this.readyState !== OPEN || !init.onActivity) return;
        try {
          init.onActivity();
        } catch (err) {
          // A throwing callback must not break the stream (same rule as listeners).
          queueMicrotask(() => {
            throw err;
          });
        }
      },
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.closed()) break;
        if (done) {
          parser.push(decoder.decode());
          // `lastEventId` from an id-only block (no data) still counts.
          this.lastEventId = parser.lastEventId;
          this.fail(res.status, "Stream ended", res.headers);
          break;
        }
        parser.push(decoder.decode(value, { stream: true }));
        this.lastEventId = parser.lastEventId;
      }
    } catch (err) {
      this.fail(res.status, err instanceof Error ? err.message : "Stream read failed", res.headers);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released / aborted */
      }
    }
  }
}
