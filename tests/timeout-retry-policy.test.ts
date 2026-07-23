/**
 * 0.12: request timeout policy + retry jitter + Retry-After pacing.
 *
 *   - `timeoutMs` (client-level, per-request override) aborts a hung fetch
 *     and surfaces a RETRYABLE `TimeoutError` — distinct from a deliberate
 *     caller abort, which stays an `AbortError` and is never retried.
 *   - `retry.jitter: 'full'` randomizes delays (anti-stampede).
 *   - 429/503 `Retry-After` (seconds or HTTP-date) is parsed onto
 *     `ArcApiError.retryAfterMs` and wins over computed backoff.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArcApiError } from "../src/client.js";
import { configureAuth, configureClient, handleApiRequest, isAbortError } from "../src/client.js";

function okJson(body: unknown = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch that never settles but honors abort like the real one. */
function hangingFetch() {
  return vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
          { once: true },
        );
      }),
  );
}

beforeEach(() => {
  configureClient({ baseUrl: "https://api.test" });
  configureAuth({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("timeoutMs", () => {
  it("aborts a hung request and rejects with TimeoutError (not a silent AbortError)", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    configureClient({ baseUrl: "https://api.test", timeoutMs: 30 });

    const err = await handleApiRequest("GET", "/slow").catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect((err as Error).message).toContain("30ms");
    // Timeouts are failures, not cancellations — they must NOT be swallowed
    // by abort-filtering in consumers.
    expect(isAbortError(err)).toBe(false);
  });

  it("per-request timeoutMs: 0 disables the client-level default", async () => {
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(okJson()), 60)),
    );
    vi.stubGlobal("fetch", fetchMock);
    configureClient({ baseUrl: "https://api.test", timeoutMs: 20 });

    await expect(handleApiRequest("GET", "/slow", { timeoutMs: 0 })).resolves.toEqual({ ok: true });
  });

  it("a deliberate caller abort stays an AbortError even with a timeout configured", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    configureClient({ baseUrl: "https://api.test", timeoutMs: 5_000 });

    const controller = new AbortController();
    const pending = handleApiRequest("GET", "/slow", { signal: controller.signal });
    controller.abort();

    const err = await pending.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect((err as Error).name).not.toBe("TimeoutError");
  });

  it("timeouts are retryable — a hung first attempt is retried within its own fresh window", async () => {
    let call = 0;
    const hang = hangingFetch();
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) return hang(url, init);
      return Promise.resolve(okJson());
    });
    vi.stubGlobal("fetch", fetchMock);
    configureClient({
      baseUrl: "https://api.test",
      timeoutMs: 25,
      retry: { attempts: 2, backoff: () => 0 },
    });

    await expect(handleApiRequest("GET", "/flaky")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Retry-After pacing", () => {
  it("parses delta-seconds Retry-After onto ArcApiError.retryAfterMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response('{"error":"slow down"}', {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "7" },
          }),
        ),
      ),
    );

    const err = (await handleApiRequest("GET", "/limited").catch((e: unknown) => e)) as ArcApiError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(7000);
  });

  it("server pacing WINS over computed backoff on 503 (retry completes immediately with Retry-After: 0)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":"maintenance"}', {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(okJson());
    vi.stubGlobal("fetch", fetchMock);
    configureClient({
      baseUrl: "https://api.test",
      // Computed backoff would sleep 10 minutes — if the test finishes, the
      // header's 0ms won.
      retry: { attempts: 2, backoff: () => 600_000 },
    });

    await expect(handleApiRequest("GET", "/maint")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 5_000);
});

describe("retry jitter", () => {
  it("jitter: 'full' draws each delay from [0, computed]", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0); // → 0ms delay
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
      retry: { attempts: 2, backoff: () => 600_000, jitter: "full" },
    });

    await expect(handleApiRequest("GET", "/flaky")).resolves.toEqual({ ok: true });
    expect(random).toHaveBeenCalled();
  }, 5_000);

  it("default stays deterministic (no Math.random consulted)", async () => {
    const random = vi.spyOn(Math, "random");
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
      retry: { attempts: 2, backoff: () => 0 },
    });

    await expect(handleApiRequest("GET", "/flaky")).resolves.toEqual({ ok: true });
    expect(random).not.toHaveBeenCalled();
  });
});
