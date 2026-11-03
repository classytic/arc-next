/**
 * `FetchEventSource` (`@classytic/arc-next/sse-fetch`) — the header-capable
 * EventSource, and `subscribeToEvents` defaulting to it under
 * `streamAuth: 'header'`.
 *
 * - parser conformance: the WHATWG HTML §9.2.6 examples plus line-ending,
 *   BOM, `id`/`retry` and chunk-boundary rules;
 * - transport: headers (no token in the URL), credentials, events, readyState,
 *   `on*` handlers, abort on close, non-2xx surfaced with the status;
 * - integration: Last-Event-ID on reconnect, a 401 reaching `onAuthError`
 *   without a probe request, 429 honouring `Retry-After`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAuthRecovery,
  _resetAuthWarnings,
  configureAuth,
  configureClient,
  createAuthRefreshHandler,
} from "../src/client.js";
import { subscribeToEvents } from "../src/sse.js";
import {
  createSseParser,
  FetchEventSource,
  type FetchEventSourceEvent,
  type SseParsedEvent,
} from "../src/sse-fetch.js";

// ----------------------------------------------------------------------------
// Parser conformance
// ----------------------------------------------------------------------------

function parse(chunks: string | string[]): { events: SseParsedEvent[]; retries: number[] } {
  const events: SseParsedEvent[] = [];
  const retries: number[] = [];
  const p = createSseParser({ onEvent: (e) => events.push(e), onRetry: (ms) => retries.push(ms) });
  for (const c of Array.isArray(chunks) ? chunks : [chunks]) p.push(c);
  return { events, retries };
}

describe("createSseParser — WHATWG examples", () => {
  it("stock example: three messages, multi-line data joined with LF", () => {
    const { events } = parse(
      "data: This is the first message.\n\n" +
        "data: This is the second message, it\n" +
        "data: has two lines.\n\n" +
        "data: This is the third message.\n\n",
    );
    expect(events.map((e) => e.data)).toEqual([
      "This is the first message.",
      "This is the second message, it\nhas two lines.",
      "This is the third message.",
    ]);
    expect(events.every((e) => e.type === "message")).toBe(true);
  });

  it("named events: add / remove / add", () => {
    const { events } = parse(
      "event: add\ndata: 73857293\n\nevent: remove\ndata: 2153\n\nevent: add\ndata: 113411\n\n",
    );
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ["add", "73857293"],
      ["remove", "2153"],
      ["add", "113411"],
    ]);
  });

  it("YHOO: three data lines become one payload", () => {
    const { events } = parse("data: YHOO\ndata: +2\ndata: 10\n\n");
    expect(events).toEqual([{ type: "message", data: "YHOO\n+2\n10", lastEventId: "" }]);
  });

  it("test stream: comment, id set then reset, leading space kept, unterminated block dropped", () => {
    const { events } = parse(
      ": test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n",
    );
    expect(events).toEqual([
      { type: "message", data: "first event", lastEventId: "1" },
      { type: "message", data: "second event", lastEventId: "" },
    ]);
    const all = parse(
      ": test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n",
    );
    expect(all.events[2]).toEqual({ type: "message", data: " third event", lastEventId: "" });
  });

  it("bare `data` fields: empty string, a single newline, last block discarded", () => {
    const { events } = parse("data\n\ndata\ndata\n\ndata:");
    expect(events.map((e) => e.data)).toEqual(["", "\n"]);
  });

  it("`data:test` and `data: test` are identical (one leading space stripped)", () => {
    const { events } = parse("data:test\n\ndata: test\n\n");
    expect(events.map((e) => e.data)).toEqual(["test", "test"]);
  });
});

describe("createSseParser — framing rules", () => {
  const stream = "event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\rdata: 3\n\n";
  const expected = [
    ["a", "1"],
    ["b", "2"],
    ["message", "3"],
  ];

  it("CRLF, CR and LF all terminate lines", () => {
    expect(parse(stream).events.map((e) => [e.type, e.data])).toEqual(expected);
  });

  it("any chunking — including one character at a time and CR|LF split across chunks", () => {
    expect(parse(stream.split("")).events.map((e) => [e.type, e.data])).toEqual(expected);
    const split = parse(["data: x\r", "\n\r", "\n"]);
    expect(split.events.map((e) => e.data)).toEqual(["x"]);
  });

  it("strips one leading BOM only", () => {
    expect(parse("﻿data: a\n\n").events[0]!.data).toBe("a");
    expect(parse(["﻿data: a\n\n", "﻿data: b\n\n"]).events.map((e) => e.data)).toEqual([
      "a",
      // A second BOM is part of the line, so the field name is not `data`.
    ]);
  });

  it("event type without data dispatches nothing and does not leak into the next event", () => {
    const { events } = parse("event: ghost\n\ndata: real\n\n");
    expect(events).toEqual([{ type: "message", data: "real", lastEventId: "" }]);
  });

  it("id persists across blocks; an id containing NULL is ignored", () => {
    const { events } = parse("id: 7\ndata: a\n\ndata: b\n\nid: x\u0000y\ndata: c\n\n");
    expect(events.map((e) => e.lastEventId)).toEqual(["7", "7", "7"]);
  });

  it("retry: digits only", () => {
    const { retries } = parse("retry: 5000\n\nretry: 5s\n\nretry: -1\n\nretry:250\n\n");
    expect(retries).toEqual([5000, 250]);
  });

  it("unknown fields and comments are ignored", () => {
    const { events } = parse(":hi\nfoo: bar\ndata: ok\n:: still a comment\n\n");
    expect(events.map((e) => e.data)).toEqual(["ok"]);
  });
});

describe("createSseParser — onActivity (Unreleased)", () => {
  it("fires once per non-empty push, a heartbeat comment alone included, before its events", () => {
    const log: string[] = [];
    const p = createSseParser({
      onEvent: (e) => log.push(`event:${e.data}`),
      onActivity: () => log.push("activity"),
    });
    p.push(": heartbeat\n\n");
    p.push("");
    p.push("data: a\n\n");
    p.push("data: b\n");
    p.push("\n");
    expect(log).toEqual(["activity", "activity", "event:a", "activity", "activity", "event:b"]);
  });

  it("initialLastEventId seeds the buffer: an event without id: reports it, a new id replaces it", () => {
    const events: SseParsedEvent[] = [];
    const p = createSseParser({ onEvent: (e) => events.push(e), initialLastEventId: "c1" });
    expect(p.lastEventId).toBe("c1");
    p.push('event: ready\ndata: {"resumed":true}\n\n');
    p.push("id: c2\ndata: x\n\n");
    expect(events.map((e) => e.lastEventId)).toEqual(["c1", "c2"]);
  });
});

// ----------------------------------------------------------------------------
// Transport
// ----------------------------------------------------------------------------

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

/** A controllable streaming SSE response; aborting the request errors the body like a real fetch. */
function sseResponse(signal?: AbortSignal | null) {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  signal?.addEventListener("abort", () => {
    try {
      ctrl.error(new DOMException("aborted", "AbortError"));
    } catch {
      /* already closed */
    }
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
    push: (s: string) => ctrl.enqueue(enc.encode(s)),
    end: () => ctrl.close(),
  };
}

type Stream = ReturnType<typeof sseResponse>;

function mockFetch(responder: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      init,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

/** Responder that opens a live stream per call and records it. */
function liveStreams() {
  const streams: Stream[] = [];
  const m = mockFetch((call) => {
    const s = sseResponse(call.init.signal);
    streams.push(s);
    return s.response;
  });
  return { ...m, streams };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FetchEventSource", () => {
  it("sends Accept + caller headers, maps withCredentials, and opens", async () => {
    const { calls, streams } = liveStreams();
    const es = new FetchEventSource("http://api.test/stream", {
      withCredentials: true,
      headers: { Authorization: "Bearer tok" },
    });
    expect(es.readyState).toBe(FetchEventSource.CONNECTING);
    const opened = vi.fn();
    es.onopen = opened;

    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(es.readyState).toBe(FetchEventSource.OPEN);
    expect(calls[0]!.url).toBe("http://api.test/stream");
    expect(calls[0]!.headers.accept).toBe("text/event-stream");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(calls[0]!.headers["last-event-id"]).toBeUndefined();
    expect(calls[0]!.init.credentials).toBe("include");
    expect(calls[0]!.init.cache).toBe("no-store");
    es.close();
    expect(streams).toHaveLength(1);
  });

  it("withCredentials false → credentials 'same-origin'", async () => {
    const { calls } = liveStreams();
    const es = new FetchEventSource("http://api.test/stream");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.init.credentials).toBe("same-origin");
    es.close();
  });

  it("delivers message and named events to listeners and on* handlers, tracking lastEventId", async () => {
    const { streams } = liveStreams();
    const es = new FetchEventSource("http://api.test/stream");
    const messages: FetchEventSourceEvent[] = [];
    const named: FetchEventSourceEvent[] = [];
    const viaProp: FetchEventSourceEvent[] = [];
    es.addEventListener("message", (e) => messages.push(e));
    es.addEventListener("incident.created", (e) => named.push(e));
    es.onmessage = (e) => viaProp.push(e);

    await vi.waitFor(() => expect(streams).toHaveLength(1));
    await vi.waitFor(() => expect(es.readyState).toBe(1));
    streams[0]!.push('id: 41\ndata: {"a":1}\n\nevent: incident.created\nid: 42\ndata: {"b"');
    streams[0]!.push(":2}\n\n");

    await vi.waitFor(() => expect(named).toHaveLength(1));
    expect(messages).toEqual([
      { type: "message", data: '{"a":1}', lastEventId: "41", origin: "http://api.test" },
    ]);
    expect(viaProp).toHaveLength(1);
    expect(named[0]).toMatchObject({ data: '{"b":2}', lastEventId: "42" });
    expect(es.lastEventId).toBe("42");
    es.close();
  });

  it("removeEventListener detaches", async () => {
    const { streams } = liveStreams();
    const es = new FetchEventSource("http://api.test/stream");
    const fn = vi.fn();
    es.addEventListener("message", fn);
    es.removeEventListener("message", fn);
    await vi.waitFor(() => expect(es.readyState).toBe(1));
    streams[0]!.push("data: x\n\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).not.toHaveBeenCalled();
    es.close();
  });

  it("init.onActivity fires per chunk after open, comment chunks included, never before open", async () => {
    let resolve!: (r: Response) => void;
    let stream!: Stream;
    mockFetch(
      (call) =>
        new Promise<Response>((r) => {
          stream = sseResponse(call.init.signal);
          resolve = r;
        }),
    );
    const onActivity = vi.fn();
    const es = new FetchEventSource("http://api.test/stream", { onActivity });
    const messages = vi.fn();
    es.addEventListener("message", messages);
    await vi.waitFor(() => expect(stream).toBeDefined());
    // Bytes queued before the response resolves are delivered after open.
    expect(onActivity).not.toHaveBeenCalled();
    resolve(stream.response);
    await vi.waitFor(() => expect(es.readyState).toBe(1));
    expect(onActivity).not.toHaveBeenCalled();
    stream.push(": heartbeat\n\n");
    await vi.waitFor(() => expect(onActivity).toHaveBeenCalledTimes(1));
    stream.push("data: x\n\n");
    await vi.waitFor(() => expect(messages).toHaveBeenCalledTimes(1));
    expect(onActivity).toHaveBeenCalledTimes(2);
    es.close();
  });

  it("a throwing onActivity does not break the stream", async () => {
    const { streams } = liveStreams();
    const onActivity = vi.fn(() => {
      throw new Error("boom");
    });
    const errors: unknown[] = [];
    // The callback's error is rethrown on a microtask (like a throwing listener): capture it.
    const realQueue = globalThis.queueMicrotask;
    const qm = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((fn) =>
      realQueue(() => {
        try {
          fn();
        } catch (err) {
          errors.push(err);
        }
      }),
    );
    const es = new FetchEventSource("http://api.test/stream", { onActivity });
    const messages = vi.fn();
    es.addEventListener("message", messages);
    await vi.waitFor(() => expect(es.readyState).toBe(1));
    streams[0]!.push("data: x\n\n");
    await vi.waitFor(() => expect(messages).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(onActivity).toHaveBeenCalled();
    expect(errors[0]).toMatchObject({ message: "boom" });
    expect(es.readyState).toBe(1);
    es.close();
    qm.mockRestore();
  });

  it("records retry: as reconnectionTime", async () => {
    const { streams } = liveStreams();
    const es = new FetchEventSource("http://api.test/stream");
    await vi.waitFor(() => expect(es.readyState).toBe(1));
    streams[0]!.push("retry: 12345\n\n");
    await vi.waitFor(() => expect(es.reconnectionTime).toBe(12345));
    es.close();
  });

  it("close() aborts the fetch, moves to CLOSED and fires no error", async () => {
    const { calls } = liveStreams();
    const es = new FetchEventSource("http://api.test/stream");
    const errors = vi.fn();
    es.addEventListener("error", errors);
    await vi.waitFor(() => expect(es.readyState).toBe(1));

    es.close();
    expect(es.readyState).toBe(FetchEventSource.CLOSED);
    expect(calls[0]!.init.signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).not.toHaveBeenCalled();
  });

  it("close() before the request is sent never fetches", async () => {
    const { fn } = liveStreams();
    const es = new FetchEventSource("http://api.test/stream");
    es.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).not.toHaveBeenCalled();
  });

  it("non-2xx → error event carrying status and headers, CLOSED, never open", async () => {
    mockFetch(() => new Response("rate limited", { status: 429, headers: { "Retry-After": "7" } }));
    const es = new FetchEventSource("http://api.test/stream");
    const opened = vi.fn();
    es.addEventListener("open", opened);
    const errors: FetchEventSourceEvent[] = [];
    es.onerror = (e) => errors.push(e);

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.status).toBe(429);
    expect(errors[0]!.headers?.get("retry-after")).toBe("7");
    expect(es.readyState).toBe(FetchEventSource.CLOSED);
    expect(opened).not.toHaveBeenCalled();
  });

  it("network failure → error with status 0", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const es = new FetchEventSource("http://api.test/stream");
    const errors: FetchEventSourceEvent[] = [];
    es.addEventListener("error", (e) => errors.push(e));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({ status: 0, message: "Failed to fetch" });
  });

  it("a 200 that is not text/event-stream is an error, not an open", async () => {
    mockFetch(
      () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const es = new FetchEventSource("http://api.test/stream");
    const errors: FetchEventSourceEvent[] = [];
    es.addEventListener("error", (e) => errors.push(e));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.status).toBe(200);
    expect(es.readyState).toBe(2);
  });

  it("server ending the stream → error (status of the response) and CLOSED", async () => {
    const { streams } = liveStreams();
    const es = new FetchEventSource("http://api.test/stream");
    const errors: FetchEventSourceEvent[] = [];
    es.addEventListener("error", (e) => errors.push(e));
    await vi.waitFor(() => expect(es.readyState).toBe(1));
    streams[0]!.push("id: 9\n\n");
    streams[0]!.end();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.status).toBe(200);
    expect(es.lastEventId).toBe("9");
    expect(es.readyState).toBe(2);
  });

  it("lastEventId init sends Last-Event-ID", async () => {
    const { calls } = liveStreams();
    const es = new FetchEventSource("http://api.test/stream", { lastEventId: "abc" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.headers["last-event-id"]).toBe("abc");
    expect(es.lastEventId).toBe("abc");
    es.close();
  });
});

// ----------------------------------------------------------------------------
// subscribeToEvents under streamAuth: 'header' (no injected EventSource)
// ----------------------------------------------------------------------------

describe("subscribeToEvents — default FetchEventSource for streamAuth 'header'", () => {
  beforeEach(() => {
    configureClient({ baseUrl: "http://api.test", streamAuth: "header" });
    configureAuth({ getToken: () => "tok_secret", getOrgId: () => "org_1" });
    _resetAuthRecovery();
    _resetAuthWarnings();
  });
  afterEach(() => {
    configureClient({ baseUrl: "" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it("connects with auth headers and no credentials in the URL, then delivers events", async () => {
    const { calls, streams } = liveStreams();
    const onEvent = vi.fn();
    const onConnectionChange = vi.fn();
    const handle = subscribeToEvents({ resource: "incident", onEvent, onConnectionChange });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const { url, headers } = calls[0]!;
    expect(url).not.toContain("tok_secret");
    expect(url).not.toContain("token=");
    expect(url).not.toContain("organizationId=");
    expect(headers.authorization).toBe("Bearer tok_secret");
    expect(headers["x-organization-id"]).toBe("org_1");
    expect(headers.accept).toBe("text/event-stream");

    await vi.waitFor(() => expect(onConnectionChange).toHaveBeenCalledWith(true));
    streams[0]!.push(
      `event: incident.created\nid: e1\ndata: ${JSON.stringify({
        type: "incident.created",
        resource: "incident",
        data: { _id: "i1" },
        timestamp: "2026-10-17T00:00:00.000Z",
      })}\n\n`,
    );
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent.mock.calls[0]![0]).toMatchObject({ type: "incident.created" });
    expect(handle.isConnected()).toBe(true);
    handle.close();
  });

  it("reconnects with Last-Event-ID after the stream drops (no probe request)", async () => {
    const { calls, streams } = liveStreams();
    const handle = subscribeToEvents({ resource: "incident", reconnectDelay: 5 });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    await vi.waitFor(() => expect(handle.isConnected()).toBe(true));

    streams[0]!.push('event: incident.updated\nid: 77\ndata: {"x":1}\n\n');
    // An id on an event type this subscription does not listen to still counts.
    streams[0]!.push('event: other.thing\nid: 78\ndata: {"y":1}\n\n');
    streams[0]!.end();

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.headers["last-event-id"]).toBe("78");
    expect(calls[1]!.headers.authorization).toBe("Bearer tok_secret");
    expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
    handle.close();
  });

  it("a resumed connection that ends before any id keeps its cursor (Last-Event-ID resent)", async () => {
    const { calls, streams } = liveStreams();
    const onResync = vi.fn();
    const handle = subscribeToEvents({
      resource: "incident",
      resumeFrom: "c1",
      onResync,
      reconnectDelay: 5,
    });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(calls[0]!.headers["last-event-id"]).toBe("c1");
    // Empty replay: only the id-less ready frame and a heartbeat, then the line drops.
    streams[0]!.push('event: ready\ndata: {"cursor":"c1","resumed":true}\n\n: hb\n\n');
    await vi.waitFor(() => expect(handle.status().lastActivityAt).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(handle.status().lastEventId).toBe("c1");
    streams[0]!.end();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.headers["last-event-id"]).toBe("c1");
    expect(onResync).not.toHaveBeenCalled();

    // A frame with an id moves it; a later id-less frame does not undo it.
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    streams[1]!.push('event: incident.updated\nid: c2\ndata: {"x":1}\n\n');
    streams[1]!.push('event: ready\ndata: {"cursor":"c2","resumed":true}\n\n');
    await vi.waitFor(() => expect(handle.status().lastEventId).toBe("c2"));
    await new Promise((r) => setTimeout(r, 0));
    streams[1]!.end();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.headers["last-event-id"]).toBe("c2");
    handle.close();
  });

  it("over the wire: headers and a heartbeat are not live; ready is; a drop before ready resends the cursor", async () => {
    const { calls, streams } = liveStreams();
    const healths: string[] = [];
    const handle = subscribeToEvents({
      resource: "incident",
      resumeFrom: "c1",
      onStatus: (s) => healths.push(s.health),
      reconnectDelay: 5,
    });
    await vi.waitFor(() => expect(handle.isConnected()).toBe(true));
    streams[0]!.push("retry: 3000\n\n: hb\n\n");
    await vi.waitFor(() => expect(handle.status().lastActivityAt).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(handle.status().health).toBe("connecting");
    // The server dies after the headers, before its ready (arc's replay burst).
    streams[0]!.end();
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(calls[1]!.headers["last-event-id"]).toBe("c1");
    await vi.waitFor(() => expect(handle.isConnected()).toBe(true));
    expect(handle.status().health).toBe("offline");
    streams[1]!.push('event: ready\ndata: {"cursor":"c1","resumed":true}\n\n');
    await vi.waitFor(() => expect(handle.status().health).toBe("live"));
    // Offline twice: at the failure, then with the scheduled attempt; never live before ready.
    expect(healths).toEqual(["connecting", "offline", "offline", "live"]);
    handle.close();
  });

  it("an id-only checkpoint frame moves the cursor: status(), a stale reconnect and close()", async () => {
    const { calls, streams } = liveStreams();
    const onEvent = vi.fn();
    const handle = subscribeToEvents({
      resource: "incident",
      resumeFrom: "c1",
      onResync: vi.fn(),
      onEvent,
      staleAfterMs: 80,
      reconnectDelay: 5,
    });
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    // arc's replay hub: ready, then `id:` alone after entries this viewer may not see.
    streams[0]!.push('event: ready\ndata: {"cursor":"c1","resumed":true}\n\nid: c9\n\n');
    await vi.waitFor(() => expect(handle.status().lastEventId).toBe("c9"));
    expect(onEvent).not.toHaveBeenCalled();

    // Silence → stale → the reconnect resumes after the checkpoint.
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 2000 });
    expect(calls[1]!.headers["last-event-id"]).toBe("c9");

    await vi.waitFor(() => expect(streams).toHaveLength(2));
    streams[1]!.push("id: c12\n\n");
    await new Promise((r) => setTimeout(r, 10));
    handle.close();
    expect(handle.status().lastEventId).toBe("c12");
  });

  it("a stream that ended normally is not reported as a failure status", async () => {
    const { calls, streams } = liveStreams();
    const handle = subscribeToEvents({ resource: "incident", reconnectDelay: 60_000 });
    await vi.waitFor(() => expect(handle.isConnected()).toBe(true));
    streams[0]!.end();
    await vi.waitFor(() => expect(handle.status().health).toBe("offline"));
    expect(handle.status().lastStatus).toBeUndefined();
    expect(calls).toHaveLength(1);
    handle.close();
  });

  it("close() aborts the in-flight stream", async () => {
    const { calls } = liveStreams();
    const handle = subscribeToEvents({ resource: "incident" });
    await vi.waitFor(() => expect(handle.isConnected()).toBe(true));
    handle.close();
    expect(calls[0]!.init.signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
  });

  it("a 401 reaches onAuthError with the real status and reconnects with the refreshed token — no probe", async () => {
    let token = "stale";
    configureAuth({
      getToken: () => token,
      getOrgId: () => "org_1",
      onAuthError: createAuthRefreshHandler({
        refresh: async () => {
          token = "fresh";
          return "fresh";
        },
      }),
    });
    const statuses: number[] = [];
    const { calls } = mockFetch((call) => {
      if (call.headers.authorization === "Bearer stale") {
        return new Response("", { status: 401 });
      }
      return sseResponse(call.init.signal).response;
    });
    const onConnectionChange = vi.fn((c: boolean) => statuses.push(c ? 1 : 0));
    const handle = subscribeToEvents({ resource: "incident", onConnectionChange });

    await vi.waitFor(() => expect(handle.isConnected()).toBe(true));
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer stale", "Bearer fresh"]);
    // Only stream requests: no HEAD probe, no Range GET.
    expect(calls.every((c) => c.init.method === "GET" && !c.headers.range)).toBe(true);
    handle.close();
  });

  it("onAuthError receives an ArcApiError with status 401", async () => {
    const onAuthError = vi.fn(async () => "skip" as const);
    configureAuth({ getToken: () => "t", getOrgId: () => null, onAuthError });
    mockFetch(() => new Response("", { status: 401 }));
    const handle = subscribeToEvents({ resource: "incident", reconnectDelay: 60_000 });
    await vi.waitFor(() => expect(onAuthError).toHaveBeenCalledTimes(1));
    const ctx = (onAuthError.mock.calls[0] as unknown[])[0] as {
      error: { status: number; code?: string };
    };
    expect(ctx.error.status).toBe(401);
    handle.close();
  });

  it("429 waits the server's Retry-After before reconnecting", async () => {
    const { calls } = mockFetch((call, i) =>
      i === 0
        ? new Response("", { status: 429, headers: { "Retry-After": "240" } })
        : sseResponse(call.init.signal).response,
    );
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const handle = subscribeToEvents({ resource: "incident", reconnectDelay: 5 });
    await vi.waitFor(() =>
      expect(timeoutSpy.mock.calls.some(([, ms]) => ms === 240_000)).toBe(true),
    );
    expect(calls).toHaveLength(1);
    handle.close();
  });
});
