import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClientOverrides } from "../../src/query/query-client.js";

// Each test gets a fresh module to avoid singleton leakage between tests.
async function loadFresh() {
  vi.resetModules();
  return import("../../src/query/query-client.js");
}

describe("getQueryClient", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns a QueryClient instance", async () => {
    const { getQueryClient } = await loadFresh();
    const client = getQueryClient();
    expect(client).toBeInstanceOf(QueryClient);
  });

  it("returns same instance on repeated calls (browser singleton)", async () => {
    const { getQueryClient } = await loadFresh();
    const a = getQueryClient();
    const b = getQueryClient();
    expect(a).toBe(b);
  });

  it("has correct default options", async () => {
    const { getQueryClient } = await loadFresh();
    const client = getQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(5 * 60 * 1000);
    expect(defaults.queries?.gcTime).toBe(30 * 60 * 1000);
    // retry is a guard FUNCTION since the arc 2.22 quota work: default cap 0,
    // and quota.exceeded errors never retry regardless of the cap.
    const retry = defaults.queries?.retry as (n: number, e: unknown) => boolean;
    expect(retry(0, new Error("flaky"))).toBe(false); // default cap 0
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });

  it("applies overrides on first call", async () => {
    const { getQueryClient } = await loadFresh();
    const client = getQueryClient({ staleTime: 1_000, gcTime: 5_000 });
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(1_000);
    expect(defaults.queries?.gcTime).toBe(5_000);
    // Non-overridden values keep defaults (retry guard keeps cap 0)
    const retry2 = defaults.queries?.retry as (n: number, e: unknown) => boolean;
    expect(retry2(0, new Error("flaky"))).toBe(false);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });

  it("ignores overrides on subsequent calls and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getQueryClient } = await loadFresh();

    const first = getQueryClient({ staleTime: 1_000 });
    const second = getQueryClient({ staleTime: 99_000 });

    // Same singleton returned
    expect(second).toBe(first);

    // First call's overrides win
    expect(first.getDefaultOptions().queries?.staleTime).toBe(1_000);

    // Warning emitted
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("overrides are ignored"));

    warnSpy.mockRestore();
  });

  it("does not warn when second call has no overrides", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getQueryClient } = await loadFresh();

    getQueryClient({ staleTime: 1_000 });
    getQueryClient(); // no overrides

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns the singleton even without overrides", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getQueryClient } = await loadFresh();

    const first = getQueryClient();
    const second = getQueryClient();
    const third = getQueryClient({ staleTime: 50_000 }); // ignored

    expect(first).toBe(second);
    expect(first).toBe(third);
    warnSpy.mockRestore();
  });

  describe("retry (TanStack retryer semantics, quota 429s excluded)", () => {
    let quota: Error;
    const retryOf = async (retry: QueryClientOverrides["retry"]) => {
      const { makeQueryClient } = await loadFresh();
      // The module instance query-client imported after the reset (isArcApiError is instanceof).
      const { ArcApiError } = await import("../../src/client/client.js");
      quota = new ArcApiError("quota", {
        status: 429,
        statusText: "Too Many Requests",
        json: { code: "quota.exceeded", message: "quota", status: 429 },
        endpoint: "/api/v1/products",
        method: "GET",
      });
      return makeQueryClient({ retry }).getDefaultOptions().queries?.retry as (
        n: number,
        e: unknown,
      ) => boolean;
    };

    it("retry: true retries without limit", async () => {
      const retry = await retryOf(true);
      expect(retry(0, new Error("flaky"))).toBe(true);
      expect(retry(1, new Error("flaky"))).toBe(true);
      expect(retry(50, new Error("flaky"))).toBe(true);
      expect(retry(0, quota)).toBe(false);
    });

    it("retry: false never retries", async () => {
      const retry = await retryOf(false);
      expect(retry(0, new Error("flaky"))).toBe(false);
    });

    it("retry: a number is the retry count", async () => {
      const retry = await retryOf(2);
      expect(retry(0, new Error("flaky"))).toBe(true);
      expect(retry(1, new Error("flaky"))).toBe(true);
      expect(retry(2, new Error("flaky"))).toBe(false);
      expect(retry(0, quota)).toBe(false);
    });

    it("retry: a function decides, except for a quota 429", async () => {
      const decide = vi.fn((failureCount: number, error: unknown) => {
        return failureCount < 4 && error instanceof Error && error.message === "flaky";
      });
      const retry = await retryOf(decide);
      expect(retry(3, new Error("flaky"))).toBe(true);
      expect(retry(4, new Error("flaky"))).toBe(false);
      expect(retry(0, new Error("fatal"))).toBe(false);
      expect(decide).toHaveBeenCalledWith(3, expect.any(Error));
      decide.mockClear();
      expect(retry(0, quota)).toBe(false);
      expect(decide).not.toHaveBeenCalled();
    });

    it("a real query retries until it succeeds under retry: true", async () => {
      const { makeQueryClient } = await loadFresh();
      const client = makeQueryClient({ retry: true });
      let calls = 0;
      const data = await client.fetchQuery({
        queryKey: ["flaky"],
        retryDelay: 0,
        queryFn: () => {
          calls += 1;
          if (calls < 4) throw new Error("flaky");
          return "ok";
        },
      });
      expect(data).toBe("ok");
      expect(calls).toBe(4);
    });
  });

  it("dehydrate config includes pending queries", async () => {
    const { getQueryClient } = await loadFresh();
    const client = getQueryClient();
    const dehydrateOpts = client.getDefaultOptions().dehydrate;
    expect(dehydrateOpts?.shouldDehydrateQuery).toBeDefined();
  });
});
