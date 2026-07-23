/**
 * Global auth auto-injection — the handleApiRequest ↔ hooks parity contract.
 *
 * Regression suite for the Somriddhi "post-login loading storm": query HOOKS
 * injected the configureAuth() token, but DIRECT BaseApi calls (invokeRoute /
 * aggregate / getAll outside hooks) went through the global handleApiRequest,
 * which ignored configureAuth — every such call fired unauthenticated, ate a
 * 401 → onAuthError refresh → retry cycle, and tripled round-trips per call.
 *
 * The contract under test:
 *   - `undefined` token/orgId  → inherit configureAuth() (same as hooks)
 *   - explicit `token: null`   → deliberately unauthenticated (public)
 *   - explicit per-call values → always win over the global context
 *   - no configureAuth at all  → nothing injected (SSR / public bundles)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../src/api.js";
import {
  _resetAuthRecovery,
  _resetAuthWarnings,
  configureAuth,
  configureClient,
  handleApiRequest,
} from "../src/client.js";

function mockFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch);
  return { spy, calls };
}

beforeEach(() => {
  configureClient({ baseUrl: "http://api.test" });
  configureAuth({ getToken: () => "global-token", getOrgId: () => "org-42" });
  _resetAuthRecovery();
  _resetAuthWarnings();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleApiRequest — global configureAuth injection", () => {
  it("injects Authorization + x-organization-id when the caller passes neither", async () => {
    const { calls } = mockFetch();

    await handleApiRequest("GET", "/reports");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.Authorization).toBe("Bearer global-token");
    expect(calls[0]?.headers["x-organization-id"]).toBe("org-42");
  });

  it("explicit per-call token/orgId win over the global context", async () => {
    const { calls } = mockFetch();

    await handleApiRequest("GET", "/reports", {
      token: "explicit-token",
      organizationId: "org-explicit",
    });

    expect(calls[0]?.headers.Authorization).toBe("Bearer explicit-token");
    expect(calls[0]?.headers["x-organization-id"]).toBe("org-explicit");
  });

  it("explicit token: null stays unauthenticated (deliberate public call)", async () => {
    const { calls } = mockFetch();

    await handleApiRequest("GET", "/public-feed", { token: null });

    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("injects nothing when configureAuth was never called", async () => {
    // Simulate a bundle that only configured the client (SSR / public reader).
    configureAuth(undefined as never); // reset to no auth context
    const { calls } = mockFetch();

    await handleApiRequest("GET", "/public-feed");

    expect(calls[0]?.headers.Authorization).toBeUndefined();
    expect(calls[0]?.headers["x-organization-id"]).toBeUndefined();
  });
});

describe("BaseApi direct calls — parity with hooks (the Somriddhi regression)", () => {
  it("invokeRoute (custom route, e.g. /aggregations/:name) carries auth on the FIRST request", async () => {
    const { calls } = mockFetch();
    const api = createCrudApi("point-accounts", { basePath: "/api" });

    await api.invokeRoute({ method: "GET", path: "/aggregations/liability" });

    // Exactly one request — no 401 → refresh → retry cycle.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api.test/api/point-accounts/aggregations/liability");
    expect(calls[0]?.headers.Authorization).toBe("Bearer global-token");
    expect(calls[0]?.headers["x-organization-id"]).toBe("org-42");
  });

  it("aggregate() carries auth on the first request", async () => {
    const { calls } = mockFetch();
    const api = createCrudApi("redemptions", { basePath: "/api" });

    await api.aggregate({ name: "payoutSummary" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.Authorization).toBe("Bearer global-token");
  });

  it("getAll() outside hooks carries auth on the first request", async () => {
    const { calls } = mockFetch();
    const api = createCrudApi("painters", { basePath: "/api" });

    await api.getAll({ params: { limit: 5 } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.Authorization).toBe("Bearer global-token");
    expect(calls[0]?.headers["x-organization-id"]).toBe("org-42");
  });

  it("per-call token on a BaseApi method overrides the global context", async () => {
    const { calls } = mockFetch();
    const api = createCrudApi("painters", { basePath: "/api" });

    await api.getAll({ token: "call-token", organizationId: "org-call" });

    expect(calls[0]?.headers.Authorization).toBe("Bearer call-token");
    expect(calls[0]?.headers["x-organization-id"]).toBe("org-call");
  });

  it("cookie authMode still sends no Authorization header", async () => {
    configureClient({ baseUrl: "http://api.test", authMode: "cookie" });
    const { calls } = mockFetch();
    const api = createCrudApi("painters", { basePath: "/api" });

    await api.getAll({});

    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });
});
