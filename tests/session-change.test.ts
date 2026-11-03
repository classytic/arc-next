/**
 * `configureAuth({ onSessionChange })`: opt-in hook for 403s that mean the session's STATE changed
 * (a second factor became required after a deploy), parallel to the 401 `onAuthError` path. A tab
 * left open must be able to step up and retry instead of showing the 403 until reload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAuthRecovery,
  _resetAuthWarnings,
  type ArcApiError,
  type AuthErrorContext,
  configureAuth,
  configureClient,
  handleApiRequest,
} from "../src/client.js";
import { initSDK } from "../src/sdk/init.js";

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
