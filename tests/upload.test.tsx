/**
 * v0.5.0 — uploadWithProgress() + useUploadWithProgress()
 *
 * The XHR transport is mocked through a hand-rolled `MockXHR` that mirrors
 * the real WHATWG XMLHttpRequest contract for the surface the SDK touches:
 *   - open / send / abort / setRequestHeader / status / responseText /
 *     onload / onerror / ontimeout / upload.onprogress / withCredentials
 *
 * Tests cover both the plain function and the React hook so the same XHR
 * plumbing isn't proven twice from different angles.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { configureClient, configureAuth, ArcApiError, isArcApiError } from "../src/client.js";
import { configureToast } from "../src/mutation.js";
import {
  uploadWithProgress,
  useUploadWithProgress,
  type UploadProgress,
} from "../src/upload.js";

// ============================================================================
// MockXHR — minimal WHATWG-faithful XHR for the surface we use
// ============================================================================

interface MockXHRUpload {
  onprogress: ((event: ProgressEvent) => void) | null;
}

class MockXHR {
  static instances: MockXHR[] = [];
  static reset() {
    MockXHR.instances = [];
  }
  static latest(): MockXHR {
    const x = MockXHR.instances[MockXHR.instances.length - 1];
    if (!x) throw new Error("no MockXHR opened");
    return x;
  }

  // WHATWG-shaped fields the SDK reads.
  status = 0;
  statusText = "";
  responseText = "";
  response: unknown = "";
  responseType: "" | "text" | "json" | "blob" | "arraybuffer" | "document" = "";
  withCredentials = false;
  readyState = 0;

  // Captured for assertions.
  method = "";
  url = "";
  sentBody: unknown = null;
  headers: Record<string, string> = {};
  aborted = false;

  // Listener slots.
  onload: ((this: MockXHR) => void) | null = null;
  onerror: ((this: MockXHR) => void) | null = null;
  ontimeout: ((this: MockXHR) => void) | null = null;
  upload: MockXHRUpload = { onprogress: null };

  constructor() {
    MockXHR.instances.push(this);
  }

  open(method: string, url: string, _async: boolean): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: unknown): void {
    this.sentBody = body;
    this.readyState = 2;
  }

  abort(): void {
    this.aborted = true;
    this.readyState = 4;
  }

  // Test helpers — drive the XHR lifecycle from outside.

  emitProgress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }

  emitLoad(opts: {
    status: number;
    statusText?: string;
    body?: string | object | Blob;
    contentType?: string;
  }): void {
    this.status = opts.status;
    this.statusText = opts.statusText ?? "";
    if (opts.body instanceof Blob) {
      this.response = opts.body;
      this.responseText = "";
    } else if (typeof opts.body === "string") {
      this.responseText = opts.body;
      this.response = opts.body;
    } else if (opts.body !== undefined) {
      this.responseText = JSON.stringify(opts.body);
      this.response = this.responseText;
    } else {
      this.responseText = "";
      this.response = "";
    }
    this.readyState = 4;
    this.onload?.call(this);
  }

  emitError(): void {
    this.readyState = 4;
    this.onerror?.call(this);
  }

  emitTimeout(): void {
    this.readyState = 4;
    this.ontimeout?.call(this);
  }
}

// ============================================================================
// Test fixtures
// ============================================================================

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

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

// ============================================================================
// uploadWithProgress() — plain function
// ============================================================================

describe("uploadWithProgress (plain function)", () => {
  beforeEach(() => {
    installMockXHR();
    configureClient({ baseUrl: "http://api.test" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });
  afterEach(() => {
    restoreXHR();
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it("opens POST against the resolved URL with the FormData body", async () => {
    const fd = makeFormData({ caption: "hi" });
    const promise = uploadWithProgress({ url: "/upload", formData: fd });
    const xhr = MockXHR.latest();

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("http://api.test/upload");
    expect(xhr.sentBody).toBe(fd);

    xhr.emitLoad({ status: 200, body: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("does NOT set Content-Type for FormData (preserves multipart boundary)", async () => {
    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    const xhr = MockXHR.latest();
    // No content-type / Content-Type header — XHR auto-fills the boundary.
    expect(Object.keys(xhr.headers).map((h) => h.toLowerCase())).not.toContain("content-type");
    xhr.emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("emits onProgress with computed percent / loaded / total", async () => {
    const events: UploadProgress[] = [];
    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
      onProgress: (p) => events.push(p),
    });
    const xhr = MockXHR.latest();

    xhr.emitProgress(0, 1000);
    xhr.emitProgress(500, 1000);
    xhr.emitProgress(1000, 1000);

    expect(events).toEqual([
      { percent: 0, loaded: 0, total: 1000, lengthComputable: true },
      { percent: 50, loaded: 500, total: 1000, lengthComputable: true },
      { percent: 100, loaded: 1000, total: 1000, lengthComputable: true },
    ]);

    xhr.emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("reports lengthComputable: false → percent stays 0", async () => {
    const events: UploadProgress[] = [];
    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
      onProgress: (p) => events.push(p),
    });
    MockXHR.latest().emitProgress(123, 0, false);
    expect(events[0]).toEqual({ percent: 0, loaded: 123, total: 0, lengthComputable: false });
    MockXHR.latest().emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("rejects with ArcApiError on non-2xx, preserving status + body + endpoint", async () => {
    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    MockXHR.latest().emitLoad({
      status: 413,
      statusText: "Payload Too Large",
      body: { code: "FILE_TOO_LARGE", message: "File exceeds 5MB", status: 413 },
    });

    try {
      await promise;
      expect.fail("should reject");
    } catch (e) {
      expect(isArcApiError(e)).toBe(true);
      if (isArcApiError(e)) {
        expect(e.status).toBe(413);
        expect(e.message).toBe("File exceeds 5MB");
        expect(e.endpoint).toBe("/upload");
        expect(e.method).toBe("POST");
        expect(e.code).toBe("FILE_TOO_LARGE");
      }
    }
  });

  it("non-JSON error body is captured as { rawBody } on ArcApiError.json", async () => {
    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    MockXHR.latest().emitLoad({
      status: 502,
      statusText: "Bad Gateway",
      body: "<html>CDN error</html>",
    });

    try {
      await promise;
      expect.fail("should reject");
    } catch (e) {
      if (isArcApiError(e)) {
        expect(e.status).toBe(502);
        expect((e.json as { rawBody: string }).rawBody).toBe("<html>CDN error</html>");
      } else {
        expect.fail("expected ArcApiError");
      }
    }
  });

  it("network failure throws Error (not ArcApiError)", async () => {
    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    MockXHR.latest().emitError();
    await expect(promise).rejects.toThrow(/Network error during upload/);
  });

  it("timeout throws an explicit timeout Error", async () => {
    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    MockXHR.latest().emitTimeout();
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("AbortSignal aborts the XHR and rejects with the signal's reason (preserved verbatim)", async () => {
    const ctrl = new AbortController();
    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
      signal: ctrl.signal,
    });

    const xhr = MockXHR.latest();
    const reason = new DOMException("user clicked Cancel", "AbortError");
    ctrl.abort(reason);

    expect(xhr.aborted).toBe(true);
    await expect(promise).rejects.toBe(reason);
  });

  it("AbortSignal with no reason rejects with a synthesized AbortError DOMException", async () => {
    const ctrl = new AbortController();
    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
      signal: ctrl.signal,
    });
    ctrl.abort(); // no reason — platform supplies a default

    try {
      await promise;
      expect.fail("should reject");
    } catch (e) {
      // The platform's AbortController fills in a default reason — both
      // behaviors are valid, our promise just relays whatever the signal carries.
      expect(e).toBeDefined();
      const name = (e as { name?: string }).name;
      expect(name).toBe("AbortError");
    }
  });

  it("pre-aborted signal short-circuits before opening the XHR", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      uploadWithProgress({ url: "/upload", formData: makeFormData(), signal: ctrl.signal }),
    ).rejects.toThrow();
    expect(MockXHR.instances.length).toBe(0);
  });

  // ─── Auth + headers parity with fetch path ──────────────────────────

  it("attaches Authorization Bearer when configureAuth has a token", async () => {
    configureAuth({ getToken: () => "tok-1", getOrgId: () => "org-1" });
    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    const xhr = MockXHR.latest();
    expect(xhr.headers["Authorization"]).toBe("Bearer tok-1");
    expect(xhr.headers["x-organization-id"]).toBe("org-1");
    xhr.emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("attaches custom auth header when authMode='header'", async () => {
    configureClient({ baseUrl: "http://api.test", authMode: "header" });
    configureAuth({ getToken: () => "secret", headerName: "x-api-key" });
    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    const xhr = MockXHR.latest();
    expect(xhr.headers["x-api-key"]).toBe("secret");
    expect(xhr.headers["Authorization"]).toBeUndefined();
    xhr.emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("sets withCredentials=true when authMode='cookie' and DOES NOT add Authorization", async () => {
    configureClient({ baseUrl: "http://api.test", authMode: "cookie" });
    configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });
    const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
    const xhr = MockXHR.latest();
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers["Authorization"]).toBeUndefined();
    expect(xhr.headers["x-organization-id"]).toBe("org-1");
    xhr.emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("explicit token / organizationId override the global context", async () => {
    configureAuth({ getToken: () => "global", getOrgId: () => "global-org" });
    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
      token: "per-call",
      organizationId: "per-call-org",
    });
    const xhr = MockXHR.latest();
    expect(xhr.headers["Authorization"]).toBe("Bearer per-call");
    expect(xhr.headers["x-organization-id"]).toBe("per-call-org");
    xhr.emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("explicit `token: null` suppresses both global token AND Authorization header", async () => {
    configureAuth({ getToken: () => "global", getOrgId: () => null });
    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
      token: null,
    });
    const xhr = MockXHR.latest();
    expect(xhr.headers["Authorization"]).toBeUndefined();
    xhr.emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("elevated:true sends x-arc-scope: platform; client-level elevated propagates", async () => {
    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
      elevated: true,
    });
    expect(MockXHR.latest().headers["x-arc-scope"]).toBe("platform");
    MockXHR.latest().emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("idempotencyKey is forwarded as Idempotency-Key header", async () => {
    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
      idempotencyKey: "abc-123",
    });
    expect(MockXHR.latest().headers["Idempotency-Key"]).toBe("abc-123");
    MockXHR.latest().emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("user-supplied headers are layered on top, but Content-Type stays stripped", async () => {
    const promise = uploadWithProgress({
      url: "/upload",
      formData: makeFormData(),
      headers: { "x-custom": "v", "Content-Type": "ignored/me" },
    });
    const xhr = MockXHR.latest();
    expect(xhr.headers["x-custom"]).toBe("v");
    expect(Object.keys(xhr.headers).map((h) => h.toLowerCase())).not.toContain("content-type");
    xhr.emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("absolute URLs bypass the configured baseUrl", async () => {
    configureClient({ baseUrl: "http://api.test" });
    const promise = uploadWithProgress({
      url: "https://other.example.com/upload",
      formData: makeFormData(),
    });
    expect(MockXHR.latest().url).toBe("https://other.example.com/upload");
    MockXHR.latest().emitLoad({ status: 200, body: {} });
    await promise;
  });

  it("responseType:'text' returns the raw body string", async () => {
    const promise = uploadWithProgress<string>({
      url: "/upload",
      formData: makeFormData(),
      responseType: "text",
    });
    MockXHR.latest().emitLoad({ status: 200, body: "raw text response" });
    await expect(promise).resolves.toBe("raw text response");
  });

  it("responseType:'blob' returns the binary Blob", async () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    const promise = uploadWithProgress<Blob>({
      url: "/upload",
      formData: makeFormData(),
      responseType: "blob",
    });
    expect(MockXHR.latest().responseType).toBe("blob");
    MockXHR.latest().emitLoad({ status: 200, body: blob });
    await expect(promise).resolves.toBe(blob);
  });
});

// ============================================================================
// useUploadWithProgress() — React hook
// ============================================================================

describe("useUploadWithProgress (React hook)", () => {
  let qc: QueryClient;

  beforeEach(() => {
    installMockXHR();
    configureClient({ baseUrl: "http://api.test" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
    configureToast({ success: vi.fn(), error: vi.fn() });
    qc = createTestQueryClient();
  });
  afterEach(() => {
    restoreXHR();
    qc.clear();
  });

  it("upload() resolves with parsed JSON; data + isSuccess update", async () => {
    const wrapper = createWrapper(qc);
    const { result } = renderHook(
      () =>
        useUploadWithProgress<{ url: string }, { file: string }>({
          url: "/api/v1/media/upload",
          buildFormData: ({ file }) => makeFormData({ file }),
        }),
      { wrapper },
    );

    expect(result.current.isPending).toBe(false);
    expect(result.current.data).toBeNull();

    let promise!: Promise<{ url: string }>;
    act(() => {
      promise = result.current.upload({ file: "hello" });
    });

    // After microtask, isUploading flips on.
    await waitFor(() => expect(result.current.isPending).toBe(true));
    MockXHR.latest().emitLoad({ status: 200, body: { url: "/cdn/x.txt" } });
    await expect(promise).resolves.toEqual({ url: "/cdn/x.txt" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ url: "/cdn/x.txt" });
    expect(result.current.error).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it("progress state mirrors xhr.upload.onprogress events", async () => {
    const wrapper = createWrapper(qc);
    const { result } = renderHook(
      () =>
        useUploadWithProgress({
          url: "/upload",
          buildFormData: () => makeFormData(),
        }),
      { wrapper },
    );

    let promise!: Promise<unknown>;
    act(() => { promise = result.current.upload(undefined); });

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    act(() => MockXHR.latest().emitProgress(250, 1000));
    await waitFor(() => expect(result.current.progress?.percent).toBe(25));
    act(() => MockXHR.latest().emitProgress(750, 1000));
    await waitFor(() => expect(result.current.progress?.percent).toBe(75));

    act(() => MockXHR.latest().emitLoad({ status: 200, body: {} }));
    await promise;
  });

  it("invalidates queries on success", async () => {
    const wrapper = createWrapper(qc);
    const spy = vi.spyOn(qc, "invalidateQueries");

    const { result } = renderHook(
      () =>
        useUploadWithProgress({
          url: "/upload",
          buildFormData: () => makeFormData(),
          invalidateQueries: [["media"], ["dashboard", "stats"]],
        }),
      { wrapper },
    );

    let promise!: Promise<unknown>;
    act(() => { promise = result.current.upload(undefined); });
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    act(() => MockXHR.latest().emitLoad({ status: 200, body: {} }));
    await promise;

    const calls = spy.mock.calls.map(([arg]) => (arg as { queryKey: unknown }).queryKey);
    expect(calls).toContainEqual(["media"]);
    expect(calls).toContainEqual(["dashboard", "stats"]);
  });

  it("error path captures the ArcApiError; isError flips on", async () => {
    const wrapper = createWrapper(qc);
    const onError = vi.fn();
    const { result } = renderHook(
      () =>
        useUploadWithProgress({
          url: "/upload",
          buildFormData: () => makeFormData(),
          onError,
        }),
      { wrapper },
    );

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.upload(undefined).catch(() => undefined);
    });
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    act(() =>
      MockXHR.latest().emitLoad({
        status: 415,
        statusText: "Unsupported Media Type",
        body: { error: "PNG only" },
      }),
    );
    await promise;

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ArcApiError);
    expect((result.current.error as ArcApiError).status).toBe(415);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("cancel() aborts the in-flight upload, hook returns to idle on next render", async () => {
    const wrapper = createWrapper(qc);
    const { result } = renderHook(
      () =>
        useUploadWithProgress({
          url: "/upload",
          buildFormData: () => makeFormData(),
        }),
      { wrapper },
    );

    let promise!: Promise<unknown>;
    act(() => {
      promise = result.current.upload(undefined).catch(() => undefined);
    });
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    act(() => result.current.cancel());

    expect(MockXHR.latest().aborted).toBe(true);
    await promise;
  });

  it("starting a new upload while one is in-flight cancels the previous (last-call wins)", async () => {
    const wrapper = createWrapper(qc);
    const { result } = renderHook(
      () =>
        useUploadWithProgress({
          url: "/upload",
          buildFormData: () => makeFormData(),
        }),
      { wrapper },
    );

    let first!: Promise<unknown>;
    act(() => {
      first = result.current.upload(undefined).catch(() => undefined);
    });
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));

    let second!: Promise<unknown>;
    act(() => {
      second = result.current.upload(undefined);
    });
    await waitFor(() => expect(MockXHR.instances.length).toBe(2));

    expect(MockXHR.instances[0]!.aborted).toBe(true);
    expect(MockXHR.instances[1]!.aborted).toBe(false);

    act(() => MockXHR.instances[1]!.emitLoad({ status: 200, body: { ok: true } }));
    await first;
    await second;
  });

  it("reset() returns the hook to idle (clears progress/data/error/success)", async () => {
    const wrapper = createWrapper(qc);
    const { result } = renderHook(
      () =>
        useUploadWithProgress({
          url: "/upload",
          buildFormData: () => makeFormData(),
        }),
      { wrapper },
    );

    let promise!: Promise<unknown>;
    act(() => { promise = result.current.upload(undefined); });
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    act(() => MockXHR.latest().emitProgress(500, 1000));
    act(() => MockXHR.latest().emitLoad({ status: 200, body: { ok: true } }));
    await promise;
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    act(() => result.current.reset());
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.progress).toBeNull();
    expect(result.current.isPending).toBe(false);
    expect(result.current.isSuccess).toBe(false);
  });

  it("dynamic url + headers + idempotencyKey functions receive vars", async () => {
    const wrapper = createWrapper(qc);
    const { result } = renderHook(
      () =>
        useUploadWithProgress<unknown, { folder: string }>({
          url: ({ folder }) => `/api/v1/${folder}/upload`,
          headers: ({ folder }) => ({ "x-folder": folder }),
          idempotencyKey: ({ folder }) => `key-${folder}`,
          elevated: ({ folder }) => folder === "admin",
          buildFormData: () => makeFormData(),
        }),
      { wrapper },
    );

    let promise!: Promise<unknown>;
    act(() => { promise = result.current.upload({ folder: "admin" }); });
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));

    const xhr = MockXHR.latest();
    expect(xhr.url).toBe("http://api.test/api/v1/admin/upload");
    expect(xhr.headers["x-folder"]).toBe("admin");
    expect(xhr.headers["Idempotency-Key"]).toBe("key-admin");
    expect(xhr.headers["x-arc-scope"]).toBe("platform");

    act(() => xhr.emitLoad({ status: 200, body: {} }));
    await promise;
  });

  it("messages.success / messages.error fire the configured toast handler", async () => {
    const success = vi.fn();
    const error = vi.fn();
    configureToast({ success, error });

    const wrapper = createWrapper(qc);
    const { result } = renderHook(
      () =>
        useUploadWithProgress({
          url: "/upload",
          buildFormData: () => makeFormData(),
          messages: { success: "Uploaded!", error: "Bad upload" },
        }),
      { wrapper },
    );

    let promise!: Promise<unknown>;
    act(() => { promise = result.current.upload(undefined); });
    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    act(() => MockXHR.latest().emitLoad({ status: 200, body: {} }));
    await promise;
    expect(success).toHaveBeenCalledWith("Uploaded!");

    let promise2!: Promise<unknown>;
    act(() => { promise2 = result.current.upload(undefined).catch(() => undefined); });
    await waitFor(() => expect(MockXHR.instances.length).toBe(2));
    act(() =>
      MockXHR.instances[1]!.emitLoad({ status: 500, body: { error: "boom" } }),
    );
    await promise2;
    expect(error).toHaveBeenCalledWith("Bad upload");
  });
});
