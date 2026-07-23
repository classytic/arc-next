/**
 * 0.12 executor-level guarantees:
 *
 *   1. `autoIdempotency` is applied by the request EXECUTOR — one key per
 *      logical request, minted before the retry loops, so every backoff
 *      retry reuses the SAME `Idempotency-Key`. GET/DELETE excluded;
 *      caller-supplied keys win.
 *   2. `createServerClient` — request-scoped credentials, no module
 *      singletons, no server-side warnings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureAuth,
  configureClient,
  createServerClient,
  handleApiRequest,
} from "../src/client.js";

function okJson(body: unknown = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function capturedHeaders(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  const init = fetchMock.mock.calls[call]![1] as RequestInit;
  return init.headers as Record<string, string>;
}

beforeEach(() => {
  configureClient({ baseUrl: "https://api.test" });
  configureAuth({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("executor-level autoIdempotency", () => {
  it("mints an Idempotency-Key for POST when autoIdempotency is on", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okJson()));
    vi.stubGlobal("fetch", fetchMock);
    configureClient({ baseUrl: "https://api.test", autoIdempotency: true });

    await handleApiRequest("POST", "/things", { body: { a: 1 } });

    const headers = capturedHeaders(fetchMock);
    expect(headers["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("reuses the SAME key across backoff retries of one logical request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":"down"}', {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(okJson());
    vi.stubGlobal("fetch", fetchMock);
    configureClient({
      baseUrl: "https://api.test",
      autoIdempotency: true,
      retry: { attempts: 2, backoff: () => 0 },
    });

    await handleApiRequest("POST", "/things", { body: { a: 1 } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = capturedHeaders(fetchMock, 0)["Idempotency-Key"];
    const second = capturedHeaders(fetchMock, 1)["Idempotency-Key"];
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("never mints keys for GET, and caller-supplied keys win", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okJson()));
    vi.stubGlobal("fetch", fetchMock);
    configureClient({ baseUrl: "https://api.test", autoIdempotency: true });

    await handleApiRequest("GET", "/things");
    expect(capturedHeaders(fetchMock, 0)["Idempotency-Key"]).toBeUndefined();

    await handleApiRequest("PATCH", "/things/1", { body: {}, idempotencyKey: "mine" });
    expect(capturedHeaders(fetchMock, 1)["Idempotency-Key"]).toBe("mine");
  });

  it("stays off by default", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okJson()));
    vi.stubGlobal("fetch", fetchMock);

    await handleApiRequest("POST", "/things", { body: {} });
    expect(capturedHeaders(fetchMock)["Idempotency-Key"]).toBeUndefined();
  });
});

describe("createServerClient", () => {
  it("sends the request-scoped token and org — independent of global singletons", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okJson()));
    vi.stubGlobal("fetch", fetchMock);
    // Global auth points elsewhere — the server client must NOT read it.
    configureAuth({ getToken: () => "GLOBAL", getOrgId: () => "global-org" });

    const client = createServerClient({
      baseUrl: "https://server.test",
      token: "request-token",
      organizationId: "org-42",
    });
    await client.request("GET", "/orders");

    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://server.test/orders");
    const headers = capturedHeaders(fetchMock);
    expect(headers.Authorization).toBe("Bearer request-token");
    expect(headers["x-organization-id"]).toBe("org-42");
  });

  it("supports unauthenticated requests (token omitted)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okJson()));
    vi.stubGlobal("fetch", fetchMock);

    const client = createServerClient({ baseUrl: "https://server.test" });
    await client.request("GET", "/public");

    const headers = capturedHeaders(fetchMock);
    expect(headers.Authorization).toBeUndefined();
    expect(headers["x-organization-id"]).toBeUndefined();
  });

  it("emits no SSR warning — request-scoped construction is the sanctioned server path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createServerClient({ baseUrl: "https://server.test", token: "t" });
    expect(warn).not.toHaveBeenCalled();
  });
});
