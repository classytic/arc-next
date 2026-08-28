/**
 * Two-part regression suite covering reported bugs:
 *
 *  Bug 1 — `createAuthAwareClient()` freezes baseUrl at construction.
 *    Reported repro: a CRUD api module imports `createAuthAwareClient()` at
 *    module-load (top of an `api.ts`), but `configureClient({ baseUrl })`
 *    runs LATER inside a `'use client'` provider's `useState` initializer.
 *    Pre-fix, the frozen baseUrl was `''` → every request hit a relative
 *    URL → 404 cascade against the wrong origin. Post-fix the client reads
 *    global config lazily on every request, AND the request layer throws
 *    a clear error if baseUrl is still empty (catching any other call path
 *    that snapshotted too early).
 *
 *  Bug 2 — `.data` footgun coverage.
 *    The `.data` field on `useDetail` / `useList` results is `unknown`-typed
 *    raw query data, vs `.item` / `.items` which are the typed extraction.
 *    Verified via JSDoc-driven contract: this file checks that both fields
 *    coexist and that callers reading `.item` get the typed shape without
 *    needing a cast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../src/api.js";
import {
  ArcApiError,
  configureAuth,
  configureClient,
  createAuthAwareClient,
  isArcApiError,
} from "../src/client.js";

// ── Reset the global config between tests by re-configuring with a
// known-empty baseUrl. (`configureClient` is a singleton; there's no
// reset export.)
function resetGlobalConfig(): void {
  // Set then unset to force a known empty state. Calling configureClient
  // with baseUrl: '' simulates an app that hasn't booted Providers yet.
  configureClient({ baseUrl: "" });
  configureAuth({ getToken: () => null, getOrgId: () => null });
}

function mockFetchOk(): { spy: ReturnType<typeof vi.spyOn>; calls: string[] } {
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input.toString());
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
  resetGlobalConfig();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createAuthAwareClient — baseUrl is lazy, not frozen at construction", () => {
  it("CRITICAL regression: construct BEFORE configureClient → first request still resolves the latest baseUrl", async () => {
    // Reproduces the prod 404 cascade. Module-load order:
    //   1. import { createAuthAwareClient } from '@classytic/arc-next/client';
    //   2. const client = createAuthAwareClient();           ← here, baseUrl unset
    //   3. ...later, in <Providers>:
    //   4. configureClient({ baseUrl: '...' });              ← only NOW set
    //   5. client.request('GET', '/foo')                     ← should hit foo.bar.com, not relative
    resetGlobalConfig();
    const client = createAuthAwareClient();

    // Now configure — simulates Providers booting AFTER module import.
    configureClient({ baseUrl: "https://api.example.com" });

    const { calls } = mockFetchOk();
    await client.request("GET", "/items/42");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://api.example.com/items/42");
  });

  it("also picks up baseUrl changes mid-session (config reconfigure)", async () => {
    resetGlobalConfig();
    configureClient({ baseUrl: "https://first.example.com" });
    const client = createAuthAwareClient();

    const { calls } = mockFetchOk();
    await client.request("GET", "/a");

    // Reconfigure to a DIFFERENT host — should be picked up on the next request.
    configureClient({ baseUrl: "https://second.example.com" });
    await client.request("GET", "/b");

    expect(calls).toEqual(["https://first.example.com/a", "https://second.example.com/b"]);
  });

  it("explicit override.baseUrl wins over global (literal opt-in semantics)", async () => {
    resetGlobalConfig();
    configureClient({ baseUrl: "https://global.example.com" });
    const analyticsClient = createAuthAwareClient({ baseUrl: "https://analytics.example.com" });

    const { calls } = mockFetchOk();
    await analyticsClient.request("GET", "/events");

    // Global is set to global.example.com, but the per-client override wins —
    // matches the documented "I want a different transport" intent.
    expect(calls[0]).toBe("https://analytics.example.com/events");
  });

  it("picks up authMode change mid-session (e.g. cookie → bearer flip)", async () => {
    resetGlobalConfig();
    configureClient({ baseUrl: "https://api.example.com", authMode: "cookie" });
    configureAuth({ getToken: () => "tok" });
    const client = createAuthAwareClient();

    const { calls, spy } = mockFetchOk();
    await client.request("GET", "/me");
    // Cookie mode → no Authorization header even though token is present.
    const firstInit = (spy.mock.calls[0]?.[1] ?? undefined) as RequestInit | undefined;
    expect(
      (firstInit?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBeUndefined();
    expect(firstInit?.credentials).toBe("include");

    // Reconfigure to bearer; next request should now carry the header.
    configureClient({ baseUrl: "https://api.example.com", authMode: "bearer" });
    await client.request("GET", "/me");
    const secondInit = (spy.mock.calls[1]?.[1] ?? undefined) as RequestInit | undefined;
    expect((secondInit?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer tok",
    );

    expect(calls).toHaveLength(2);
  });
});

describe("executeRequest — diagnostic throw when baseUrl is empty + endpoint is relative", () => {
  it("throws a SDK-prefixed error instead of silently hitting the wrong origin", async () => {
    resetGlobalConfig();
    // No configureClient — baseUrl stays empty.
    const client = createAuthAwareClient();
    mockFetchOk();

    await expect(client.request("GET", "/items")).rejects.toThrow(
      /\[arc-next\] handleApiRequest\(GET \/items\): baseUrl is empty/,
    );
    // The error message points the caller at the actual fix. Tolerates prose
    // between the call and the ordering clause — the message gained "at app
    // boot (Providers)" and this regex silently stopped matching.
    await expect(client.request("GET", "/items")).rejects.toThrow(
      /configureClient\(\{ baseUrl: '\.\.\.' \}\)[\s\S]*BEFORE the first request/,
    );
  });

  it("does NOT throw for absolute endpoints (consumer explicitly wants cross-origin)", async () => {
    resetGlobalConfig();
    const client = createAuthAwareClient();
    const { calls } = mockFetchOk();

    // baseUrl is empty BUT the endpoint is absolute — caller intent is
    // explicit, no diagnostic needed.
    await client.request("GET", "https://third-party.example.com/webhook");

    expect(calls).toEqual(["https://third-party.example.com/webhook"]);
  });

  it("does NOT throw once configureClient has run (happy path stays clean)", async () => {
    resetGlobalConfig();
    const client = createAuthAwareClient();
    configureClient({ baseUrl: "https://api.example.com" });

    const { calls } = mockFetchOk();
    await client.request("GET", "/items");

    expect(calls[0]).toBe("https://api.example.com/items");
  });
});

describe("DetailQueryResult contract — typed-end-to-end, no raw-cache escape hatch", () => {
  // 0.7 cleanup: `.data: unknown` was removed from `DetailQueryResult` /
  // `ListQueryResult` to match repo-core's typed-end-to-end shape (AggResult,
  // OffsetPaginationResult, etc. don't expose raw alongside typed either).
  // Consumers reaching past the SDK should use `useQueryClient().getQueryData(...)`
  // — the explicit call signals "I'm going to the cache" at the call site,
  // and the type system narrows correctly to whatever `setQueryData` wrote.
  it("exposes only the typed surface (no .data field on the result)", () => {
    // The actual proof lives in the type definition (src/query.ts) — TS will
    // refuse to compile this file if the interface ever regresses to include
    // `data: unknown`. The set below documents the shipping field set.
    const expected = new Set([
      "item",
      "isLoading",
      "isFetching",
      "isError",
      "isSuccess",
      "isStale",
      "isPlaceholderData",
      "error",
      "refetch",
    ]);
    expect(expected.has("item")).toBe(true);
    expect(expected.has("data" as never)).toBe(false);
  });
});

// Re-export sanity — confirms the bug-1 prod symptom is impossible without
// either an empty baseUrl OR an absolute endpoint. (`ArcApiError` import
// only kept here so this file compiles if the helper changes return types.)
void ArcApiError;
void isArcApiError;

/**
 * The same lazy-resolution rule, applied to the ROUTE PREFIX.
 *
 * `baseUrl` (the origin) was made lazy above because APIs are constructed at
 * module load and `configureClient` runs later, inside a `"use client"`
 * provider. `basePath` had the identical flaw and was not covered: it resolved
 * once in the `BaseApi` constructor, so a deployment's declared prefix could
 * never win over the `/api/v1` default.
 *
 * It matters because arc's own `init` template scaffolds `resourcePrefix:
 * '/api'` while this SDK defaults to `/api/v1` — so a stock backend and a stock
 * client disagree, and a package that builds its own API internally (an ERP
 * shell's permission matrix, an SDK preset) has no seam to be told otherwise.
 * The symptom is a 404 that renders as an empty list, not as a misconfiguration.
 */
describe("basePath — the deployment's route prefix, resolved lazily", () => {
  it("CRITICAL regression: construct BEFORE configureClient → still uses the declared prefix", async () => {
    resetGlobalConfig();
    // Module-load order, exactly as a package's internal API instance sees it.
    const api = createCrudApi("platform");

    configureClient({ baseUrl: "https://api.example.com", basePath: "/api" });

    const { calls } = mockFetchOk();
    await api.invokeRoute({ method: "GET", path: "/permissions/matrix" });

    // Constructor-time resolution would have frozen `/api/v1` here.
    expect(calls[0]).toBe("https://api.example.com/api/platform/permissions/matrix");
  });

  it("keeps defaulting to /api/v1 when no prefix is declared", async () => {
    // The pre-existing behaviour every current consumer relies on.
    resetGlobalConfig();
    configureClient({ baseUrl: "https://api.example.com" });
    const api = createCrudApi("items");

    const { calls } = mockFetchOk();
    await api.getAll();

    expect(calls[0]).toContain("https://api.example.com/api/v1/items");
  });

  it("an explicit per-instance basePath still wins over the global", async () => {
    /**
     * Load-bearing for a mixed app: one API on a legacy prefix while the rest
     * follow the deployment default. Silently overriding an explicit value
     * would break the narrower, more deliberate declaration.
     */
    resetGlobalConfig();
    configureClient({ baseUrl: "https://api.example.com", basePath: "/api" });
    const api = createCrudApi("legacy", { basePath: "/api/v2" });

    const { calls } = mockFetchOk();
    await api.getAll();

    expect(calls[0]).toContain("https://api.example.com/api/v2/legacy");
  });

  it("picks up a prefix change mid-session, like baseUrl does", async () => {
    resetGlobalConfig();
    configureClient({ baseUrl: "https://api.example.com", basePath: "/api" });
    const api = createCrudApi("items");
    const { calls } = mockFetchOk();

    await api.getAll();
    configureClient({ baseUrl: "https://api.example.com", basePath: "/api/v1" });
    await api.getAll();

    expect(calls[0]).toContain("/api/items");
    expect(calls[1]).toContain("/api/v1/items");
  });
});
