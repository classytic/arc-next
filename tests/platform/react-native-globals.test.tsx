/**
 * Runtime matrix: React Native.
 *
 * The public surface runs under the globals React Native actually has, so a
 * browser-only assumption fails here instead of on a device:
 *
 * - `window` is defined (RN sets it), but there is no `localStorage`,
 *   `BroadcastChannel`, `EventSource` or `crypto.randomUUID`
 *   (`crypto.getRandomValues` stays, as `react-native-get-random-values` provides it);
 * - `fetch` behaves like RN's whatwg-fetch: a GET/HEAD with `cache: 'no-store'`
 *   or `'no-cache'` gets `_=<timestamp>` appended, and the fake server rejects
 *   that param with 400 the way arc's strict query validation does.
 *
 * Each case pins a bug that shipped: SSE never connected (follower path with no
 * relay), every list call 400'd (`no-store` default), auto-idempotency threw
 * (`crypto.randomUUID`), and `useCount` fired without a token.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import {
  _uuid,
  configureAuth,
  configureClient,
  type EventSourceInitLike,
} from "../../src/client/client.js";
import { createCrudHooks } from "../../src/query/hooks.js";
import { useMutationWithTransition } from "../../src/query/mutation.js";
import { subscribeToEvents, useEventStream } from "../../src/realtime/sse.js";
import { createTestQueryClient, createWrapper } from "../harness/query-client.js";

// ----------------------------------------------------------------------------
// Simulated React Native globals
// ----------------------------------------------------------------------------

const STRIPPED = ["localStorage", "BroadcastChannel", "EventSource"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let savedCrypto: PropertyDescriptor | undefined;

beforeAll(() => {
  for (const name of STRIPPED) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    delete (globalThis as Record<string, unknown>)[name];
  }
  // RN identifies itself this way; it also has fetch + (polyfilled) streams but
  // its fetch cannot stream a body, so the SDK keys its transport choice on it.
  Object.defineProperty(navigator, "product", { configurable: true, value: "ReactNative" });
  savedCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: real.getRandomValues.bind(real) },
  });
});

afterAll(() => {
  for (const [name, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, name, desc);
  }
  if (savedCrypto) Object.defineProperty(globalThis, "crypto", savedCrypto);
  delete (navigator as unknown as Record<string, unknown>).product;
});

/** RN's whatwg-fetch cache-buster, then a server that rejects unknown params like arc does. */
interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
}
let sent: Sent[] = [];

function whatwgUrl(url: string, init: RequestInit): string {
  const method = (init.method ?? "GET").toUpperCase();
  if (
    (method === "GET" || method === "HEAD") &&
    (init.cache === "no-store" || init.cache === "no-cache")
  ) {
    const re = /([?&])_=[^&]*/;
    if (re.test(url)) return url.replace(re, `$1_=${Date.now()}`);
    return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
  }
  return url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const rnFetch = vi.fn(async (input: string, init: RequestInit = {}) => {
  const url = whatwgUrl(input, init);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  sent.push({ url, method: (init.method ?? "GET").toUpperCase(), headers });
  const u = new URL(url);
  if (u.searchParams.has("_")) {
    return json(400, {
      code: "arc.validation_error",
      message: "querystring must NOT have additional properties: _",
      status: 400,
    });
  }
  if (u.searchParams.get("_count") === "true") return json(200, { count: 3 });
  if (/\/incidents\/[^/]+$/.test(u.pathname)) return json(200, { _id: "i1", title: "Smoke" });
  if (init.method === "POST") return json(201, { _id: "i2", title: "New" });
  return json(200, {
    method: "offset",
    data: [{ _id: "i1" }],
    page: 1,
    limit: 20,
    total: 1,
    pages: 1,
    hasNext: false,
    hasPrev: false,
  });
});

beforeEach(() => {
  sent = [];
  rnFetch.mockClear();
  vi.stubGlobal("fetch", rnFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  configureClient({ baseUrl: "" });
  configureAuth({ getToken: () => null, getOrgId: () => null });
});

// ----------------------------------------------------------------------------
// An EventSource shaped like react-native-sse: addEventListener only, headers init
// ----------------------------------------------------------------------------

class RnEventSource {
  static instances: RnEventSource[] = [];
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  closed = false;
  constructor(
    public url: string,
    public init?: EventSourceInitLike,
  ) {
    RnEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    const ev = {
      type,
      data: data === undefined ? null : JSON.stringify(data),
      lastEventId: null,
    } as unknown as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  static latest() {
    return RnEventSource.instances[RnEventSource.instances.length - 1];
  }
}

// ----------------------------------------------------------------------------

describe("runtime: React Native globals", () => {
  it("the simulation is faithful (no storage, relay, EventSource or randomUUID; window present)", () => {
    expect(typeof window).toBe("object");
    expect(typeof localStorage).toBe("undefined");
    expect(typeof BroadcastChannel).toBe("undefined");
    expect(typeof EventSource).toBe("undefined");
    expect(typeof globalThis.crypto.randomUUID).toBe("undefined");
    expect(navigator.product).toBe("ReactNative");
  });

  it("the fetch shim reproduces whatwg-fetch: an explicit no-store GET gains _= and is rejected", async () => {
    configureClient({ baseUrl: "http://api.test", cache: "no-store", fetch: rnFetch });
    const api = createCrudApi("incidents", { basePath: "/api" });
    await expect(api.getAll({})).rejects.toMatchObject({ status: 400 });
    expect(sent[0]!.url).toMatch(/[?&]_=\d+/);
  });
});

describe("runtime: React Native — SSE", () => {
  beforeEach(() => {
    RnEventSource.instances = [];
    configureAuth({ getToken: () => "tok_secret", getOrgId: () => "org_1" });
  });

  it("useEventStream connects through the injected EventSource (no localStorage, no BroadcastChannel)", async () => {
    configureClient({ baseUrl: "http://api.test", eventSource: RnEventSource });
    const qc = createTestQueryClient();
    const { result, unmount } = renderHook(() => useEventStream({ resource: "incident" }), {
      wrapper: createWrapper(qc),
    });

    await waitFor(() => expect(RnEventSource.instances).toHaveLength(1));
    act(() => RnEventSource.latest()!.emit("open"));
    expect(result.current.isConnected).toBe(true);

    act(() =>
      RnEventSource.latest()!.emit("incident.created", {
        type: "incident.created",
        resource: "incident",
        data: { _id: "i9" },
        timestamp: "2026-10-16T00:00:00.000Z",
      }),
    );
    expect(result.current.eventCount).toBe(1);
    unmount();
    qc.clear();
  });

  it("streamAuth 'header' sends Authorization / x-organization-id as headers and keeps the token out of the URL", async () => {
    configureClient({
      baseUrl: "http://api.test",
      eventSource: RnEventSource,
      streamAuth: "header",
    });
    const handle = subscribeToEvents({ resource: "incident" });
    const es = RnEventSource.latest()!;

    expect(es.url).not.toContain("tok_secret");
    expect(es.url).not.toContain("token=");
    expect(es.url).not.toContain("organizationId=");
    expect(es.init?.headers).toMatchObject({
      Authorization: "Bearer tok_secret",
      "x-organization-id": "org_1",
    });

    // The failure probe authenticates the same way, so it cannot misread a
    // header-authed stream as a 401.
    es.emit("error");
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]!.url).not.toContain("tok_secret");
    expect(sent[0]!.headers.authorization).toBe("Bearer tok_secret");
    handle.close();
  });

  it("streamAuth 'header' without an injected EventSource refuses rather than leaking the token into the URL", () => {
    configureClient({ baseUrl: "http://api.test", streamAuth: "header" });
    expect(() => subscribeToEvents({ resource: "incident" })).toThrow(/eventSource/);
  });

  it("no EventSource at all is a clear configuration error", () => {
    configureClient({ baseUrl: "http://api.test" });
    expect(() => subscribeToEvents({ resource: "incident" })).toThrow(/No EventSource/);
  });
});

describe("runtime: React Native — reads", () => {
  type Incident = { _id: string; title?: string };
  const api = createCrudApi<Incident>("incidents", { basePath: "/api" });
  const hooks = createCrudHooks<Incident>({ api, entityKey: "incidents", singular: "Incident" });

  it("list / detail / count requests carry no _ param and succeed", async () => {
    configureClient({ baseUrl: "http://api.test", fetch: rnFetch });
    configureAuth({ getToken: () => "tok", getOrgId: () => "org_1" });
    const qc = createTestQueryClient();
    const { result } = renderHook(
      () => ({
        list: hooks.useList({ limit: 20 }),
        detail: hooks.useDetail("i1"),
        count: hooks.useCount({ status: "open" }),
      }),
      { wrapper: createWrapper(qc) },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
      expect(result.current.detail.isSuccess).toBe(true);
      expect(result.current.count.isSuccess).toBe(true);
    });
    expect(result.current.count.data).toBe(3);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const s of sent) expect(new URL(s.url).searchParams.has("_")).toBe(false);
    qc.clear();
  });

  it("useCount stays disabled without a token (bearer)", async () => {
    configureClient({ baseUrl: "http://api.test", fetch: rnFetch });
    configureAuth({ getToken: () => null, getOrgId: () => null });
    const qc = createTestQueryClient();
    const { result } = renderHook(() => hooks.useCount(), { wrapper: createWrapper(qc) });

    expect(result.current.fetchStatus).toBe("idle");
    await act(async () => {
      await Promise.resolve();
    });
    expect(rnFetch).not.toHaveBeenCalled();
    qc.clear();
  });
});

describe("runtime: React Native — idempotency without crypto.randomUUID", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("the executor mints a v4 Idempotency-Key from getRandomValues", async () => {
    configureClient({ baseUrl: "http://api.test", fetch: rnFetch, autoIdempotency: true });
    configureAuth({ getToken: () => "tok", getOrgId: () => null });
    await createCrudApi("incidents", { basePath: "/api" }).create({ data: { title: "New" } });
    expect(sent[0]!.headers["idempotency-key"]).toMatch(UUID_V4);
  });

  it("the mutation layer mints its per-mutate key the same way", async () => {
    configureClient({ baseUrl: "http://api.test", autoIdempotency: true });
    const mutationFn = vi.fn(async (_v: { options: Record<string, unknown> }) => "ok");
    const qc = createTestQueryClient();
    const { result } = renderHook(
      () => useMutationWithTransition({ mutationFn, showToast: false, useTransition: false }),
      { wrapper: createWrapper(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ options: {} });
    });
    expect(mutationFn.mock.calls[0]![0].options.idempotencyKey).toMatch(UUID_V4);
    qc.clear();
  });

  it("with no random source at all, minting fails loudly instead of using Math.random", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    try {
      expect(() => _uuid()).toThrow(/react-native-get-random-values/);
    } finally {
      if (desc) Object.defineProperty(globalThis, "crypto", desc);
    }
  });
});
