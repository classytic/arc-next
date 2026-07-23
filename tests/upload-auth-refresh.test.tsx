/**
 * `uploadWithProgress` auth-recovery — 0.7 wired the XHR upload path into
 * the shared `onAuthError` cycle. Verifies:
 *
 *  - 401 on upload → `onAuthError` fires → upload re-issued with new token
 *  - Concurrent uploads → ONE refresh (shared dedup with fetch + ws + sse)
 *  - 401 + handler returns 'skip' → original ArcApiError surfaces
 *  - maxAuthRetries cap honored
 *  - 200 → handler not called
 *
 * Uses the same MockXHR pattern as upload.test.tsx so the XHR plumbing
 * isn't re-mocked from scratch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetAuthRecovery,
  _resetAuthWarnings,
  configureAuth,
  configureClient,
  createAuthRefreshHandler,
  isArcApiError,
} from "../src/client.js";
import { uploadWithProgress } from "../src/upload.js";

// ── MockXHR — copy of upload.test.tsx's mock, kept local so test files
// stay independent. Mirrors the surface uploadWithProgress touches.
interface MockXHRUpload {
  onprogress: ((this: MockXHRUpload, ev: ProgressEvent) => unknown) | null;
}
class MockXHR {
  static instances: MockXHR[] = [];
  static reset(): void {
    MockXHR.instances = [];
  }
  static all(): MockXHR[] {
    return MockXHR.instances;
  }
  static latest(): MockXHR {
    const x = MockXHR.instances[MockXHR.instances.length - 1];
    if (!x) throw new Error("no MockXHR opened");
    return x;
  }

  method = "";
  url = "";
  withCredentials = false;
  responseType: "" | "blob" | "text" = "";
  readyState = 0;
  status = 0;
  statusText = "";
  responseText = "";
  readonly responseHeaders = new Map<string, string>();
  readonly requestHeaders = new Map<string, string>();
  onload: ((this: MockXHR) => void) | null = null;
  onerror: ((this: MockXHR) => void) | null = null;
  ontimeout: ((this: MockXHR) => void) | null = null;
  upload: MockXHRUpload = { onprogress: null };

  constructor() {
    MockXHR.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader(name: string, value: string): void {
    this.requestHeaders.set(name, value);
  }
  send(_body: unknown): void {
    this.readyState = 2;
  }
  abort(): void {
    /* no-op for these tests */
  }

  emitLoad(opts: { status: number; body?: unknown; statusText?: string }): void {
    this.readyState = 4;
    this.status = opts.status;
    this.statusText = opts.statusText ?? "";
    this.responseText = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? {});
    this.onload?.call(this);
  }
}

const originalXHR = (globalThis as Record<string, unknown>).XMLHttpRequest;
function installMockXHR(): void {
  MockXHR.reset();
  (globalThis as Record<string, unknown>).XMLHttpRequest = MockXHR;
}
function restoreXHR(): void {
  if (originalXHR) {
    (globalThis as Record<string, unknown>).XMLHttpRequest = originalXHR;
  } else {
    delete (globalThis as Record<string, unknown>).XMLHttpRequest;
  }
}

function makeFormData(fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  installMockXHR();
  configureClient({ baseUrl: "http://api.test" });
  configureAuth({ getToken: () => null, getOrgId: () => null });
  _resetAuthRecovery();
  _resetAuthWarnings();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  restoreXHR();
  vi.restoreAllMocks();
});

describe("uploadWithProgress — auth recovery via onAuthError", () => {
  it("200 → handler not called (fast path)", async () => {
    const onAuthError = vi.fn();
    configureAuth({ getToken: () => "tok", onAuthError });

    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData({ file: "data" }),
    });
    // Wait a tick for the XHR to be set up.
    await Promise.resolve();
    MockXHR.latest().emitLoad({ status: 200, body: { ok: true } });

    await expect(promise).resolves.toEqual({ ok: true });
    expect(onAuthError).not.toHaveBeenCalled();
    expect(MockXHR.all()).toHaveLength(1);
  });

  it("401 → handler refreshes → upload re-issued with new token, second response delivered", async () => {
    let cached = "stale-token";
    configureAuth({
      getToken: () => cached,
      onAuthError: createAuthRefreshHandler({
        refresh: async () => {
          cached = "fresh-token";
          return "fresh-token";
        },
      }),
    });

    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData({ file: "data" }),
    });

    // First XHR — 401.
    await Promise.resolve();
    expect(MockXHR.all()).toHaveLength(1);
    expect(MockXHR.all()[0]!.requestHeaders.get("Authorization")).toBe("Bearer stale-token");
    MockXHR.latest().emitLoad({ status: 401, body: { error: "expired" } });

    // The refresh cycle is async; wait for the second XHR to spin up.
    await vi.waitFor(() => expect(MockXHR.all()).toHaveLength(2));
    expect(MockXHR.all()[1]!.requestHeaders.get("Authorization")).toBe("Bearer fresh-token");
    MockXHR.all()[1]!.emitLoad({ status: 200, body: { uploaded: true } });

    await expect(promise).resolves.toEqual({ uploaded: true });
  });

  it("401 + handler returns 'skip' → original ArcApiError surfaces, NO retry", async () => {
    configureAuth({
      getToken: () => "tok",
      onAuthError: async () => "skip",
    });

    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData({ file: "data" }),
    });
    await Promise.resolve();
    MockXHR.latest().emitLoad({ status: 401, body: { error: "expired" } });

    await expect(promise).rejects.toSatisfy((err) => isArcApiError(err) && err.status === 401);
    // Only the original attempt — no retry.
    expect(MockXHR.all()).toHaveLength(1);
  });

  it("maxAuthRetries:1 (default) — second 401 surfaces, no infinite loop", async () => {
    const onAuthError = vi.fn(async ({ setToken }: { setToken: (t: string | null) => void }) => {
      setToken("next");
      return "retry" as const;
    });
    configureAuth({ getToken: () => "tok", onAuthError });

    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
    });

    await Promise.resolve();
    MockXHR.latest().emitLoad({ status: 401, body: {} });
    await vi.waitFor(() => expect(MockXHR.all()).toHaveLength(2));
    MockXHR.all()[1]!.emitLoad({ status: 401, body: {} });

    await expect(promise).rejects.toSatisfy((err) => isArcApiError(err) && err.status === 401);
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(MockXHR.all()).toHaveLength(2);
  });

  it("CRITICAL — 3 concurrent uploads, all 401, collapse to ONE refresh", async () => {
    let cached = "stale";
    const refreshSpy = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      cached = "fresh";
      return "fresh";
    });
    configureAuth({
      getToken: () => cached,
      onAuthError: createAuthRefreshHandler({ refresh: refreshSpy }),
    });

    // Kick off 3 uploads in parallel.
    const uploads = [
      uploadWithProgress({ url: "/upload/a", formData: makeFormData({ x: "a" }) }),
      uploadWithProgress({ url: "/upload/b", formData: makeFormData({ x: "b" }) }),
      uploadWithProgress({ url: "/upload/c", formData: makeFormData({ x: "c" }) }),
    ];

    // All three open immediately.
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(MockXHR.all()).toHaveLength(3));
    // All three get 401.
    for (const xhr of MockXHR.all()) {
      xhr.emitLoad({ status: 401, body: {} });
    }

    // All three retry (now 6 XHRs total).
    await vi.waitFor(() => expect(MockXHR.all()).toHaveLength(6));
    for (let i = 3; i < 6; i++) {
      MockXHR.all()[i]!.emitLoad({ status: 200, body: { uploaded: true } });
    }

    const results = await Promise.all(uploads);
    expect(results).toHaveLength(3);
    // Single refresh shared across all three concurrent 401s.
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // All retries carry the same fresh token.
    for (let i = 3; i < 6; i++) {
      expect(MockXHR.all()[i]!.requestHeaders.get("Authorization")).toBe("Bearer fresh");
    }
  });

  it("non-auth 4xx (e.g. 422) → handler NOT called, error surfaces as-is", async () => {
    const onAuthError = vi.fn();
    configureAuth({ getToken: () => "tok", onAuthError });

    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    await Promise.resolve();
    MockXHR.latest().emitLoad({ status: 422, body: { error: "too big" } });

    await expect(promise).rejects.toSatisfy((err) => isArcApiError(err) && err.status === 422);
    expect(onAuthError).not.toHaveBeenCalled();
    expect(MockXHR.all()).toHaveLength(1);
  });

  it("403 + retryOn403:false (default) → handler NOT called", async () => {
    const onAuthError = vi.fn();
    configureAuth({ getToken: () => "tok", onAuthError });

    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    await Promise.resolve();
    MockXHR.latest().emitLoad({ status: 403, body: { error: "denied" } });

    await expect(promise).rejects.toSatisfy((err) => isArcApiError(err) && err.status === 403);
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it("403 + retryOn403:true → handler runs, retry succeeds", async () => {
    configureAuth({
      getToken: () => "tok",
      retryOn403: true,
      onAuthError: async ({ setToken }) => {
        setToken("fresh");
        return "retry";
      },
    });

    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    await Promise.resolve();
    MockXHR.latest().emitLoad({ status: 403, body: {} });
    await vi.waitFor(() => expect(MockXHR.all()).toHaveLength(2));
    MockXHR.all()[1]!.emitLoad({ status: 200, body: { ok: true } });

    await expect(promise).resolves.toEqual({ ok: true });
  });
});
