import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import {
  _resetAuthRecovery,
  _resetAuthWarnings,
  type ArcApiError,
  type AuthErrorContext,
  configureAuth,
  configureClient,
  createAuthAwareClient,
  createAuthRefreshHandler,
  createClient,
  handleApiRequest,
} from "../../src/client/client.js";
import { withBulk } from "../../src/client/presets/bulk.js";
import { withSoftDelete } from "../../src/client/presets/soft-delete.js";
import type { CrudApi } from "../../src/query/hooks.js";
import { initSDK } from "../../src/sdk/init.js";

describe("auth context injection", () => {
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
});

describe("401 refresh and retry", () => {
  /**
   * 401 → refresh → retry interceptor — spec from the mentora ticket.
   *
   * Every test here drives `configureAuth({ onAuthError })` against a mocked
   * fetch so the wire behavior is fully observable. Concurrent dedup is the
   * load-bearing part: N parallel 401s must collapse onto one handler call,
   * not stampede the refresh endpoint.
   */

  function mockFetchSequence(responses: Array<Response | (() => Response | Promise<Response>)>) {
    const queue = [...responses];
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error(`mockFetchSequence: out of responses (call #${calls.length})`);
      const r = typeof next === "function" ? next() : next;
      return Promise.resolve(r as Response);
    }) as typeof globalThis.fetch);
    return { spy, calls };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  beforeEach(() => {
    configureClient({ baseUrl: "http://api.test" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
    _resetAuthRecovery();
    _resetAuthWarnings();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("configureAuth({ onAuthError }) — lazy 401 recovery", () => {
    it("200 response → handler is NOT called", async () => {
      const onAuthError = vi.fn();
      configureAuth({ getToken: () => "tok-a", onAuthError });
      const { spy } = mockFetchSequence([json({ ok: true })]);

      const result = await handleApiRequest("GET", "/items");

      expect(result).toEqual({ ok: true });
      expect(onAuthError).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("401 + retry → request re-issued with the setToken-injected token, second response delivered", async () => {
      // Drive through createClient so the per-client auth injection mirrors
      // what real consumers wire. (The global `handleApiRequest` now ALSO
      // auto-injects from configureAuth — see global-auth-injection.test.ts —
      // but per-client `getToken` re-reads on every request, which is also
      // what re-fires after recovery.)
      const { createClient } = await import("../../src/client/client.js");
      configureAuth({
        getToken: () => "stale-token",
        onAuthError: async ({ setToken }) => {
          setToken("fresh-token");
          return "retry";
        },
      });
      const client = createClient({
        baseUrl: "http://api.test",
        getToken: () => "stale-token", // per-client; mirrors createAuthAwareClient
      });
      const { calls } = mockFetchSequence([
        json({ error: "expired" }, 401),
        json({ ok: true, value: 42 }),
      ]);

      const result = await client.request<{ value: number }>("GET", "/items");

      expect(result).toEqual({ ok: true, value: 42 });
      expect(calls).toHaveLength(2);
      expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer stale-token",
      );
      // Retry carries the injected fresh token — setToken trumps both per-client
      // and global getToken (handler knows best at refresh time).
      expect((calls[1]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer fresh-token",
      );
    });

    it("401 + retry without setToken → retry re-reads getToken() (out-of-band refresh path)", async () => {
      let cached = "stale-token";
      configureAuth({
        getToken: () => cached,
        onAuthError: async () => {
          // Simulate the consumer mutating their own auth lib's cache out-of-band
          // (signal write, store update, etc.) instead of using setToken.
          cached = "fresh-token";
          return "retry";
        },
      });
      const { calls } = mockFetchSequence([json({ error: "expired" }, 401), json({ ok: true })]);

      await handleApiRequest("GET", "/items");

      expect(calls).toHaveLength(2);
      expect((calls[1]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer fresh-token",
      );
    });

    it("401, handler returns 'skip' → original 401 surfaces; no retry fetched", async () => {
      const onAuthError = vi.fn().mockResolvedValue("skip" as const);
      configureAuth({ getToken: () => "tok", onAuthError });
      const { calls } = mockFetchSequence([json({ error: "expired" }, 401)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({
        name: "ArcApiError",
        status: 401,
      });
      expect(onAuthError).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
    });

    it("401, handler throws → thrown error propagates, no retry fetched", async () => {
      const refreshFailure = new Error("refresh endpoint 500");
      configureAuth({
        getToken: () => "tok",
        onAuthError: async () => {
          throw refreshFailure;
        },
      });
      const { calls } = mockFetchSequence([json({ error: "expired" }, 401)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toBe(refreshFailure);
      expect(calls).toHaveLength(1);
    });

    it("401, no onAuthError configured → default behavior (401 surfaces immediately, no extra fetches)", async () => {
      configureAuth({ getToken: () => "tok" }); // no onAuthError
      const { calls } = mockFetchSequence([json({ error: "expired" }, 401)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({ status: 401 });
      expect(calls).toHaveLength(1);
    });

    it("maxAuthRetries:1 (default) — second 401 surfaces, no infinite loop", async () => {
      const onAuthError = vi.fn(async ({ setToken }: { setToken: (t: string | null) => void }) => {
        setToken("next-token");
        return "retry" as const;
      });
      configureAuth({ getToken: () => "tok", onAuthError });
      // First 401 → handler → retry. Retry also 401 → cap hit → surface.
      const { calls } = mockFetchSequence([
        json({ error: "expired" }, 401),
        json({ error: "still expired" }, 401),
      ]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({ status: 401 });
      expect(onAuthError).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
    });

    it("maxAuthRetries:0 → handler is never invoked even with onAuthError configured", async () => {
      const onAuthError = vi.fn();
      configureAuth({ getToken: () => "tok", onAuthError, maxAuthRetries: 0 });
      const { calls } = mockFetchSequence([json({ error: "expired" }, 401)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({ status: 401 });
      expect(onAuthError).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    });

    it("403 does NOT trigger handler when retryOn403 is false (default)", async () => {
      const onAuthError = vi.fn();
      configureAuth({ getToken: () => "tok", onAuthError });
      const { calls } = mockFetchSequence([json({ error: "denied" }, 403)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({ status: 403 });
      expect(onAuthError).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    });

    it("403 DOES trigger handler when retryOn403:true", async () => {
      configureAuth({
        getToken: () => "tok",
        retryOn403: true,
        onAuthError: async ({ setToken }) => {
          setToken("fresh");
          return "retry";
        },
      });
      const { calls } = mockFetchSequence([json({ error: "denied" }, 403), json({ ok: true })]);

      const result = await handleApiRequest("GET", "/items");
      expect(result).toEqual({ ok: true });
      expect(calls).toHaveLength(2);
    });

    it("2xx, 4xx (non-auth), 5xx never trigger the handler", async () => {
      const onAuthError = vi.fn();
      configureAuth({ getToken: () => "tok", onAuthError });

      for (const status of [200, 400, 404, 422, 500, 503]) {
        _resetAuthRecovery();
        const { spy } = mockFetchSequence([json({ status }, status)]);
        const p = handleApiRequest("GET", "/items");
        if (status >= 400) {
          await expect(p).rejects.toBeDefined();
        } else {
          await p;
        }
        spy.mockRestore();
      }

      expect(onAuthError).not.toHaveBeenCalled();
    });

    it("aborted request does NOT call onAuthError (caller abandoned the request)", async () => {
      const onAuthError = vi.fn().mockResolvedValue("retry" as const);
      configureAuth({ getToken: () => "tok", onAuthError });
      mockFetchSequence([json({ error: "expired" }, 401)]);

      const controller = new AbortController();
      const p = handleApiRequest("GET", "/items", { signal: controller.signal });
      controller.abort();

      await expect(p).rejects.toBeDefined();
      // Either the abort fired before the 401 (no handler) or after (also no
      // handler — we honor the abort and skip the retry). Either way: 0 calls.
      expect(onAuthError).not.toHaveBeenCalled();
    });

    it("CRITICAL — 10 concurrent 401s collapse to ONE handler call; all 10 retry with the same fresh token", async () => {
      const onAuthError = vi.fn(async ({ setToken }: { setToken: (t: string | null) => void }) => {
        // Simulate a non-trivial refresh delay so all 10 requests pile up
        // behind the same in-flight promise.
        await new Promise((r) => setTimeout(r, 30));
        setToken("shared-fresh-token");
        return "retry" as const;
      });
      configureAuth({ getToken: () => "stale", onAuthError });

      // Mock: every call returns 401, retry returns 200. We need 20 responses
      // total (10 initial 401s + 10 retries).
      const responses: Response[] = [];
      for (let i = 0; i < 10; i++) responses.push(json({ error: "expired" }, 401));
      for (let i = 0; i < 10; i++) responses.push(json({ ok: true, i }));
      const { calls } = mockFetchSequence(responses);

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => handleApiRequest(`GET`, `/items/${i}`)),
      );

      // Every request succeeded.
      expect(results).toHaveLength(10);
      results.forEach((r) => {
        expect(r).toMatchObject({ ok: true });
      });

      // The handler fired ONCE despite 10 concurrent 401s — this is the dedup
      // contract; without it, every concurrent 401 would hit the refresh
      // endpoint and stampede.
      expect(onAuthError).toHaveBeenCalledTimes(1);

      // 20 fetches total: 10 initial 401s, 10 retries.
      expect(calls).toHaveLength(20);
      // All 10 retries carry the SAME fresh token from the single refresh.
      const retryHeaders = calls
        .slice(10)
        .map((c) => (c.init?.headers as Record<string, string> | undefined)?.Authorization);
      expect(new Set(retryHeaders)).toEqual(new Set(["Bearer shared-fresh-token"]));
    });

    it("after dedup settles, a LATER 401 starts a fresh recovery cycle (no stale decision replay)", async () => {
      const onAuthError = vi.fn(async ({ setToken }: { setToken: (t: string | null) => void }) => {
        setToken("first-refresh");
        return "retry" as const;
      });
      configureAuth({ getToken: () => "stale", onAuthError });
      mockFetchSequence([json({ error: "expired" }, 401), json({ ok: 1 })]);

      await handleApiRequest("GET", "/a");
      expect(onAuthError).toHaveBeenCalledTimes(1);

      // Second request — token has gone stale again (e.g. another long pause).
      onAuthError.mockClear();
      onAuthError.mockImplementation(
        async ({ setToken }: { setToken: (t: string | null) => void }) => {
          setToken("second-refresh");
          return "retry" as const;
        },
      );
      const { calls } = mockFetchSequence([json({ error: "expired" }, 401), json({ ok: 2 })]);

      await handleApiRequest("GET", "/b");

      // Handler ran AGAIN (not stuck on the first refresh's promise).
      expect(onAuthError).toHaveBeenCalledTimes(1);
      expect((calls[1]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer second-refresh",
      );
    });

    it("handler receives ArcApiError carrying the 401 contract (status, json, endpoint, method)", async () => {
      let captured = null as
        | Parameters<NonNullable<Parameters<typeof configureAuth>[0]["onAuthError"]>>[0]
        | null;
      configureAuth({
        getToken: () => "tok",
        onAuthError: async (ctx) => {
          captured = ctx;
          return "skip";
        },
      });
      mockFetchSequence([json({ code: "unauthorized", message: "token expired" }, 401)]);

      await expect(handleApiRequest("POST", "/items")).rejects.toBeDefined();

      expect(captured).toBeDefined();
      expect(captured?.error.status).toBe(401);
      expect(captured?.error.code).toBe("unauthorized");
      expect(captured?.request).toEqual({ method: "POST", endpoint: "/items" });
      expect(captured?.attempt).toBe(1);
    });
  });

  describe("createAuthRefreshHandler — generic adapter for any refresh fn", () => {
    it("refresh returns a token → setToken + retry", async () => {
      const refresh = vi.fn().mockResolvedValue("newly-minted");
      configureAuth({
        getToken: () => "stale",
        onAuthError: createAuthRefreshHandler({ refresh }),
      });
      const { calls } = mockFetchSequence([json({}, 401), json({ ok: true })]);

      const result = await handleApiRequest("GET", "/items");

      expect(result).toEqual({ ok: true });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect((calls[1]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer newly-minted",
      );
    });

    it("refresh returns null (session truly expired) → skip; original 401 surfaces", async () => {
      configureAuth({
        getToken: () => "stale",
        onAuthError: createAuthRefreshHandler({ refresh: async () => null }),
      });
      const { calls } = mockFetchSequence([json({}, 401)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({ status: 401 });
      expect(calls).toHaveLength(1);
    });

    it("refresh throws → default skips (consumer sees the original 401, not a misleading refresh trace)", async () => {
      configureAuth({
        getToken: () => "stale",
        onAuthError: createAuthRefreshHandler({
          refresh: async () => {
            throw new Error("refresh network down");
          },
        }),
      });
      mockFetchSequence([json({}, 401)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({ status: 401 });
    });

    it('onRefreshError: "throw" propagates the refresh failure', async () => {
      const refreshFail = new Error("refresh endpoint dead");
      configureAuth({
        getToken: () => "stale",
        onAuthError: createAuthRefreshHandler({
          refresh: async () => {
            throw refreshFail;
          },
          onRefreshError: "throw",
        }),
      });
      mockFetchSequence([json({}, 401)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toBe(refreshFail);
    });
  });
});

describe("403 session change", () => {
  /**
   * `configureAuth({ onSessionChange })`: opt-in hook for 403s that mean the session's STATE changed
   * (a second factor became required after a deploy), parallel to the 401 `onAuthError` path. A tab
   * left open must be able to step up and retry instead of showing the 403 until reload.
   */

  const STEP_UP = "auth.second_factor_required";
  const isStepUp = (e: ArcApiError) => e.code === STEP_UP;

  function mockFetchSequence(responses: Response[]) {
    const queue = [...responses];
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init });
      const next = queue.shift();
      if (!next) throw new Error(`mockFetchSequence: out of responses (call #${calls.length})`);
      return Promise.resolve(next);
    }) as typeof globalThis.fetch);
    return { spy, calls };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const forbidden = (code: string) => json({ code, message: "Forbidden", status: 403 }, 403);
  const authHeader = (c: { init: RequestInit | undefined }) =>
    (c.init?.headers as Record<string, string> | undefined)?.Authorization;

  beforeEach(() => {
    configureClient({ baseUrl: "http://api.test" });
    configureAuth({ getToken: () => null });
    _resetAuthRecovery();
    _resetAuthWarnings();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("configureAuth({ onSessionChange }): 403 session-state hook", () => {
    it("matched 403 → handler runs, 'retry' re-issues the request with the setToken token", async () => {
      const handler = vi.fn(async (ctx: AuthErrorContext) => {
        ctx.setToken("stepped-up");
        return "retry" as const;
      });
      configureAuth({ getToken: () => "tok", onSessionChange: { match: isStepUp, handler } });
      const { calls } = mockFetchSequence([forbidden(STEP_UP), json({ ok: true })]);

      await expect(handleApiRequest("GET", "/items")).resolves.toEqual({ ok: true });

      expect(handler).toHaveBeenCalledTimes(1);
      const ctx = handler.mock.calls[0]?.[0];
      expect(ctx?.error.status).toBe(403);
      expect(ctx?.error.code).toBe(STEP_UP);
      expect(ctx?.request).toEqual({ method: "GET", endpoint: "/items" });
      expect(ctx?.attempt).toBe(1);
      expect(calls).toHaveLength(2);
      expect(authHeader(calls[1] as (typeof calls)[number])).toBe("Bearer stepped-up");
    });

    it("unmatched 403 surfaces immediately: no handler call, no extra fetch", async () => {
      const handler = vi.fn(async () => "retry" as const);
      configureAuth({ getToken: () => "tok", onSessionChange: { match: isStepUp, handler } });
      const { calls } = mockFetchSequence([forbidden("arc.forbidden")]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({
        status: 403,
        code: "arc.forbidden",
      });
      expect(handler).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    });

    it("not configured → a code-matching 403 surfaces as before (opt-in)", async () => {
      configureAuth({ getToken: () => "tok" });
      const { calls } = mockFetchSequence([forbidden(STEP_UP)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({ status: 403 });
      expect(calls).toHaveLength(1);
    });

    it("predicate only sees 403s: a 401 or 400 carrying the same code never reaches it", async () => {
      const match = vi.fn(isStepUp);
      const handler = vi.fn(async () => "retry" as const);
      configureAuth({ getToken: () => "tok", onSessionChange: { match, handler } });
      mockFetchSequence([
        json({ code: STEP_UP, message: "x", status: 401 }, 401),
        json({ code: STEP_UP, message: "x", status: 400 }, 400),
      ]);

      await expect(handleApiRequest("GET", "/a")).rejects.toMatchObject({ status: 401 });
      await expect(handleApiRequest("GET", "/b")).rejects.toMatchObject({ status: 400 });
      expect(match).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it("'skip' surfaces the original 403 without a retry", async () => {
      const handler = vi.fn(async () => "skip" as const);
      configureAuth({ getToken: () => "tok", onSessionChange: { match: isStepUp, handler } });
      const { calls } = mockFetchSequence([forbidden(STEP_UP)]);

      await expect(handleApiRequest("POST", "/items", { body: {} })).rejects.toMatchObject({
        status: 403,
        code: STEP_UP,
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
    });

    it("a matched 403 goes to onSessionChange, not onAuthError, even with retryOn403", async () => {
      const onAuthError = vi.fn(async () => "retry" as const);
      const handler = vi.fn(async () => "retry" as const);
      configureAuth({
        getToken: () => "tok",
        retryOn403: true,
        onAuthError,
        onSessionChange: { match: isStepUp, handler },
      });
      mockFetchSequence([forbidden(STEP_UP), json({ ok: 1 }), forbidden("arc.expired"), json({})]);

      await handleApiRequest("GET", "/a");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(onAuthError).not.toHaveBeenCalled();

      // An unmatched 403 still takes the retryOn403 path.
      await handleApiRequest("GET", "/b");
      expect(onAuthError).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("separate budgets: 401 refresh, then a 403 step-up on the retry, then success", async () => {
      const onAuthError = vi.fn(async (ctx: AuthErrorContext) => {
        ctx.setToken("refreshed");
        return "retry" as const;
      });
      const handler = vi.fn(async (ctx: AuthErrorContext) => {
        ctx.setToken("stepped-up");
        return "retry" as const;
      });
      configureAuth({
        getToken: () => "stale",
        onAuthError,
        onSessionChange: { match: isStepUp, handler },
      });
      const { calls } = mockFetchSequence([
        json({ code: "arc.unauthorized" }, 401),
        forbidden(STEP_UP),
        json({ ok: true }),
      ]);

      await expect(handleApiRequest("GET", "/me")).resolves.toEqual({ ok: true });
      expect(onAuthError).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(calls.map(authHeader)).toEqual([
        "Bearer stale",
        "Bearer refreshed",
        "Bearer stepped-up",
      ]);
    });

    it("maxAuthRetries caps the step-up loop: a second matched 403 surfaces", async () => {
      const handler = vi.fn(async () => "retry" as const);
      configureAuth({ getToken: () => "tok", onSessionChange: { match: isStepUp, handler } });
      const { calls } = mockFetchSequence([forbidden(STEP_UP), forbidden(STEP_UP)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({ status: 403 });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
    });

    it("maxAuthRetries:0 → handler never runs", async () => {
      const handler = vi.fn(async () => "retry" as const);
      configureAuth({
        getToken: () => "tok",
        maxAuthRetries: 0,
        onSessionChange: { match: isStepUp, handler },
      });
      mockFetchSequence([forbidden(STEP_UP)]);

      await expect(handleApiRequest("GET", "/items")).rejects.toMatchObject({ status: 403 });
      expect(handler).not.toHaveBeenCalled();
    });

    it("aborted request does not run the handler", async () => {
      const handler = vi.fn(async () => "retry" as const);
      configureAuth({ getToken: () => "tok", onSessionChange: { match: isStepUp, handler } });
      const controller = new AbortController();
      vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
        controller.abort();
        return forbidden(STEP_UP);
      }) as typeof globalThis.fetch);

      await expect(
        handleApiRequest("GET", "/items", { signal: controller.signal }),
      ).rejects.toBeDefined();
      expect(handler).not.toHaveBeenCalled();
    });

    it("concurrent matched 403s collapse onto ONE handler call (one step-up dialog, not N)", async () => {
      const handler = vi.fn(async (ctx: AuthErrorContext) => {
        await new Promise((r) => setTimeout(r, 20));
        ctx.setToken("stepped-up");
        return "retry" as const;
      });
      configureAuth({ getToken: () => "tok", onSessionChange: { match: isStepUp, handler } });
      const responses: Response[] = [];
      for (let i = 0; i < 5; i++) responses.push(forbidden(STEP_UP));
      for (let i = 0; i < 5; i++) responses.push(json({ i }));
      const { calls } = mockFetchSequence(responses);

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => handleApiRequest("GET", `/items/${i}`)),
      );

      expect(results).toHaveLength(5);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(new Set(calls.slice(5).map(authHeader))).toEqual(new Set(["Bearer stepped-up"]));
    });

    it("a 401 refresh in flight is not replayed for a concurrent matched 403 (dedup is per hook)", async () => {
      let releaseRefresh: () => void = () => {};
      const onAuthError = vi.fn(
        () =>
          new Promise<"skip">((resolve) => {
            releaseRefresh = () => resolve("skip");
          }),
      );
      const handler = vi.fn(async () => "skip" as const);
      configureAuth({
        getToken: () => "tok",
        onAuthError,
        onSessionChange: { match: isStepUp, handler },
      });
      mockFetchSequence([json({ code: "arc.unauthorized" }, 401), forbidden(STEP_UP)]);

      const a = handleApiRequest("GET", "/a");
      const b = handleApiRequest("GET", "/b");
      await expect(b).rejects.toMatchObject({ status: 403 });
      expect(handler).toHaveBeenCalledTimes(1);
      releaseRefresh();
      await expect(a).rejects.toMatchObject({ status: 401 });
      expect(onAuthError).toHaveBeenCalledTimes(1);
    });
  });

  describe("initSDK({ onSessionChange })", () => {
    it("passes the hook through to the global client", async () => {
      const handler = vi.fn(async (ctx: AuthErrorContext) => {
        ctx.setToken("stepped-up");
        return "retry" as const;
      });
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(forbidden(STEP_UP))
        .mockResolvedValueOnce(json({ ok: true }));
      initSDK({
        baseUrl: "http://api.test",
        getToken: () => "tok",
        fetch: fetchMock,
        captureErrors: false,
        onSessionChange: { match: isStepUp, handler },
      });

      await expect(handleApiRequest("GET", "/things")).resolves.toEqual({ ok: true });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe("anonymous requests (auth: omit)", () => {
  /**
   * `auth: "omit"`: an anonymous request carries NO credential of any kind, whoever is signed in,
   * so arc's http-cache (which serves anything credentialed `private, no-store`) can share it at
   * the CDN. Per call, and per resource for reads (`readAuth: "omit"`), never by default.
   */

  interface Sent {
    url: string;
    init: RequestInit;
    headers: Record<string, string>;
  }
  let sent: Sent[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    sent.push({
      url,
      init,
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    return new Response(JSON.stringify({ method: "offset", data: [], page: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const CREDENTIALS = [
    "authorization",
    "cookie",
    "x-api-key",
    "x-internal-api-key",
    "x-organization-id",
  ];
  const anonymous = (s: Sent) => {
    for (const name of CREDENTIALS) expect(s.headers[name], name).toBeUndefined();
    expect(s.init.credentials).toBe("omit");
  };

  beforeEach(() => {
    sent = [];
    configureClient({
      baseUrl: "http://api.test",
      fetch: fetchMock,
      internalApiKey: "internal-key",
      defaultHeaders: { Cookie: "session=1", "x-api-key": "k" },
    });
    configureAuth({ getToken: () => "user-token", getOrgId: () => "org-1" });
  });
  afterEach(() => {
    configureClient({ baseUrl: "" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  describe("auth: omit", () => {
    it("a signed-in read sends credentials by default (inherit is the default)", async () => {
      await createCrudApi("courses", { basePath: "/api" }).getAll();
      expect(sent[0]!.headers.authorization).toBe("Bearer user-token");
      expect(sent[0]!.headers["x-organization-id"]).toBe("org-1");
    });

    it("per call: no Authorization, org, keys or cookies, credentials omit", async () => {
      await createCrudApi("courses", { basePath: "/api" }).getAll({ options: { auth: "omit" } });
      anonymous(sent[0]!);
    });

    it("an explicit token or a beforeRequest interceptor cannot re-identify the request", async () => {
      configureClient({
        baseUrl: "http://api.test",
        fetch: fetchMock,
        beforeRequest: (ctx) => ({
          ...ctx,
          headers: { ...ctx.headers, Authorization: "Bearer x" },
        }),
      });
      await createCrudApi("courses", { basePath: "/api" }).getAll({
        token: "explicit",
        organizationId: "org-2",
        options: { auth: "omit" },
      });
      anonymous(sent[0]!);
    });

    it("per resource (readAuth): every GET is anonymous, writes still authenticate", async () => {
      const catalog = createCrudApi("catalog", { basePath: "/api", readAuth: "omit" });
      await catalog.getAll();
      await catalog.getById({ id: "c1" });
      await catalog.create({ data: { name: "x" } });
      anonymous(sent[0]!);
      anonymous(sent[1]!);
      expect(sent[2]!.headers.authorization).toBe("Bearer user-token");
    });

    it("per-client transports honour it too (createClient, createAuthAwareClient)", async () => {
      const own = createClient({
        baseUrl: "http://api.test",
        fetch: fetchMock,
        getToken: () => "client-token",
        getOrgId: () => "client-org",
        authMode: "header",
        headerName: "x-api-key",
      });
      await own.request("GET", "/api/catalog", { auth: "omit" });
      await createAuthAwareClient().request("GET", "/api/catalog", { auth: "omit" });
      anonymous(sent[0]!);
      anonymous(sent[1]!);
    });

    it("a 401 on an anonymous read never triggers the auth-refresh retry", async () => {
      const onAuthError = vi.fn(async () => "retry" as const);
      configureAuth({ getToken: () => "user-token", onAuthError });
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "unauthorized", message: "no" }), { status: 401 }),
      );
      await expect(
        createCrudApi("courses", { basePath: "/api" }).getAll({ options: { auth: "omit" } }),
      ).rejects.toMatchObject({ status: 401 });
      expect(onAuthError).not.toHaveBeenCalled();
    });
  });
});

describe("optional tokens and API-key auth", () => {
  /**
   * v0.4.1 Bugfix Tests — Independent test suite
   *
   * Each describe block tests a specific fix in isolation.
   */

  // ============================================================================
  // Shared helpers
  // ============================================================================

  function createMockApi(): CrudApi<
    { _id: string; name: string },
    { name: string },
    { name: string }
  > {
    return {
      getAll: vi.fn().mockResolvedValue({
        success: true,
        data: [{ _id: "1", name: "Item" }],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      }),
      getById: vi.fn().mockResolvedValue({ success: true, data: { _id: "1", name: "Item" } }),
      create: vi.fn().mockResolvedValue({ success: true, data: { _id: "1", name: "New" } }),
      update: vi.fn().mockResolvedValue({ success: true, data: { _id: "1", name: "Updated" } }),
      delete: vi.fn().mockResolvedValue({ success: true }),
      count: vi.fn().mockResolvedValue(0),
    };
  }

  // ============================================================================
  // Fix #1: token defaults to null in mutation methods
  // ============================================================================

  describe("Fix #1: token optional in mutation methods", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { _id: "1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("create() works without token", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      await api.create({ data: { name: "Test" } });
      expect(fetchMock).toHaveBeenCalled();
    });

    it("update() works without token", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      await api.update({ id: "1", data: { name: "Updated" } });
      expect(fetchMock).toHaveBeenCalled();
    });

    it("delete() works without token", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      await api.delete({ id: "1" });
      expect(fetchMock).toHaveBeenCalled();
    });

    it("upload() works without token", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      await api.upload({ data: new FormData() });
      expect(fetchMock).toHaveBeenCalled();
    });

    it("request() works without token", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      await api.request("POST", "/api/items/custom", { data: { action: "test" } });
      expect(fetchMock).toHaveBeenCalled();
    });

    it("restore() works without token", async () => {
      const api = withSoftDelete(createCrudApi("items", { basePath: "/api" }));
      await api.restore({ id: "1" });
      expect(fetchMock).toHaveBeenCalled();
    });

    it("bulkCreate() works without token", async () => {
      const api = withBulk(createCrudApi("items", { basePath: "/api" }));
      await api.bulkCreate({ data: [{ name: "A" }] });
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Fix #2: SSE close() → reconnect()
  // ============================================================================

  // ============================================================================
  // Fix #5: Non-JSON error responses
  // ============================================================================

  // ============================================================================
  // M2M API Key Auth
  // ============================================================================

  describe("M2M API key auth (service-to-service)", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("global header auth sends x-api-key", async () => {
      configureClient({ baseUrl: "http://svc.internal", authMode: "header" });
      configureAuth({ getToken: () => "svc_key", headerName: "x-api-key" });

      await handleApiRequest("GET", "/data", { token: "svc_key" });

      const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["x-api-key"]).toBe("svc_key");
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("per-client header auth sends x-admin-key", async () => {
      configureClient({ baseUrl: "http://default.test" });

      const admin = createClient({
        baseUrl: "http://admin.internal",
        authMode: "header",
        getToken: () => "admin_key",
        headerName: "x-admin-key",
      });

      await admin.request("GET", "/admin/stats");

      const [url, opts] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://admin.internal/admin/stats");
      const headers = (opts as RequestInit).headers as Record<string, string>;
      expect(headers["x-admin-key"]).toBe("admin_key");
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("two services with different auth modes work side by side", async () => {
      // Need fresh Response per call
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      configureClient({ baseUrl: "http://api.test", authMode: "bearer" });

      const analytics = createClient({
        baseUrl: "http://analytics.internal",
        authMode: "header",
        getToken: () => "analytics_key",
        headerName: "x-analytics-key",
      });

      // Service A (bearer)
      await handleApiRequest("GET", "/users", { token: "jwt_token" });
      const aHeaders = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(aHeaders["Authorization"]).toBe("Bearer jwt_token");

      // Service B (api key)
      await analytics.request("GET", "/events");
      const bHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(bHeaders["x-analytics-key"]).toBe("analytics_key");
      expect(bHeaders["Authorization"]).toBeUndefined();
    });
  });
});
