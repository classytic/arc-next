/**
 * `./server` — forwarding the incoming request's identity to arc.
 *
 * Pinned: only the allowlisted headers travel (never hop-by-hop ones like
 * `host` / `content-length`, which describe the other connection), each client
 * is per-request (two requests never share a cookie), and the module is safe to
 * import where no browser globals exist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../src/api.js";
import {
  createRequestClient,
  FORWARDED_REQUEST_HEADERS,
  forwardRequestHeaders,
} from "../src/server.js";

const incoming = (init: Record<string, string>) => new Headers(init);

describe("forwardRequestHeaders", () => {
  it("copies identity, tenant, locale and trace headers — nothing else", () => {
    const out = forwardRequestHeaders(
      incoming({
        Cookie: "session=abc",
        Authorization: "Bearer t",
        "X-Organization-Id": "org-1",
        traceparent: "00-abc-def-01",
        Host: "shop.example.com",
        "Content-Length": "42",
        Connection: "keep-alive",
        "X-Forwarded-For": "1.2.3.4",
      }),
    );
    expect(out).toEqual({
      cookie: "session=abc",
      authorization: "Bearer t",
      "x-organization-id": "org-1",
      traceparent: "00-abc-def-01",
    });
  });

  it("forwards a custom list, e.g. x-forwarded-for when arc trusts the Next server", () => {
    const out = forwardRequestHeaders(incoming({ "X-Forwarded-For": "1.2.3.4" }), [
      ...FORWARDED_REQUEST_HEADERS,
      "x-forwarded-for",
    ]);
    expect(out).toEqual({ "x-forwarded-for": "1.2.3.4" });
  });

  it("skips absent and empty values", () => {
    expect(forwardRequestHeaders(incoming({ cookie: "" }))).toEqual({});
  });
});

describe("createRequestClient", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ method: "offset", data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
  });
  afterEach(() => fetchMock.mockRestore());

  const sentHeaders = (call: number) =>
    (fetchMock.mock.calls[call]![1] as RequestInit).headers as Record<string, string>;

  it("sends the request's cookie on every call, plus static defaultHeaders", async () => {
    const client = createRequestClient({
      baseUrl: "http://arc.internal",
      headers: incoming({ cookie: "session=alice", host: "shop.example.com" }),
      defaultHeaders: { "x-internal": "1" },
    });
    await createCrudApi("orders", { client }).getAll();
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^http:\/\/arc\.internal\/api\/v1\/orders/);
    expect(sentHeaders(0)).toMatchObject({ cookie: "session=alice", "x-internal": "1" });
    expect(sentHeaders(0).host).toBeUndefined();
  });

  it("two requests never share identity — each client carries only its own", async () => {
    const alice = createRequestClient({
      baseUrl: "http://arc.internal",
      headers: incoming({ cookie: "session=alice" }),
    });
    const bob = createRequestClient({
      baseUrl: "http://arc.internal",
      headers: incoming({ cookie: "session=bob" }),
    });
    await Promise.all([
      createCrudApi("orders", { client: alice }).getAll(),
      createCrudApi("orders", { client: bob }).getAll(),
    ]);
    const cookies = [sentHeaders(0).cookie, sentHeaders(1).cookie].sort();
    expect(cookies).toEqual(["session=alice", "session=bob"]);
  });
});
