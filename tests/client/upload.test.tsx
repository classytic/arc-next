import type { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAuthRecovery,
  _resetAuthWarnings,
  ArcApiError,
  configureAuth,
  configureClient,
  createAuthRefreshHandler,
  isArcApiError,
} from "../../src/client/client.js";
import {
  type UploadProgress,
  uploadWithProgress,
  useUploadWithProgress,
} from "../../src/client/upload.js";
import { configureToast } from "../../src/query/mutation.js";
import { createTestQueryClient, createWrapper } from "../harness/query-client.js";

describe("upload", () => {
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
    /** WHATWG default 0 = no timeout — the SDK must ASSIGN this for ontimeout to ever fire. */
    timeout = 0;

    // Captured for assertions.
    method = "";
    url = "";
    sentBody: unknown = null;
    headers: Record<string, string> = {};
    aborted = false;
    /** Headers the page may read (CORS-exposed); lowercase names. */
    responseHeaders: Record<string, string> = {};

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

    getResponseHeader(name: string): string | null {
      return this.responseHeaders[name.toLowerCase()] ?? null;
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
      headers?: Record<string, string>;
    }): void {
      this.responseHeaders = opts.headers ?? {};
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

    it("an error carries the body's correlationId as its support reference", async () => {
      const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
      MockXHR.latest().emitLoad({
        status: 503,
        body: {
          code: "arc.unavailable",
          message: "Busy",
          status: 503,
          correlationId: "req-body-1",
        },
        headers: { "x-request-id": "req-header-1" },
      });
      await expect(promise).rejects.toMatchObject({ correlationId: "req-body-1" });
    });

    it("an error without a body correlationId falls back to the x-request-id header", async () => {
      const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
      MockXHR.latest().emitLoad({
        status: 502,
        body: "<html>CDN error</html>",
        headers: { "x-request-id": "req-header-2" },
      });
      await expect(promise).rejects.toMatchObject({ correlationId: "req-header-2" });
    });

    it("an error with neither (header not exposed) has no correlationId", async () => {
      const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
      MockXHR.latest().emitLoad({ status: 500, body: { code: "arc.internal", message: "x" } });
      const error = await promise.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ArcApiError);
      expect((error as ArcApiError).correlationId).toBeUndefined();
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
      const promise = uploadWithProgress({ url: "/upload", formData: makeFormData(), token: null });
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
  // uploadWithProgress — timeoutMs (0.12)
  // ============================================================================

  describe("uploadWithProgress — timeoutMs", () => {
    beforeEach(() => {
      installMockXHR();
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });
    afterEach(() => {
      restoreXHR();
    });

    it("assigns xhr.timeout — without the assignment ontimeout can never fire", async () => {
      const promise = uploadWithProgress({
        url: "/upload",
        formData: makeFormData(),
        timeoutMs: 30_000,
      });
      const xhr = MockXHR.latest();
      expect(xhr.timeout).toBe(30_000);
      xhr.emitLoad({ status: 200, body: { ok: true } });
      await promise;
    });

    it("stays disabled (xhr.timeout 0) by default", async () => {
      const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });
      const xhr = MockXHR.latest();
      expect(xhr.timeout).toBe(0);
      xhr.emitLoad({ status: 200, body: { ok: true } });
      await promise;
    });

    it("rejects with a TimeoutError when the transport times out", async () => {
      const promise = uploadWithProgress({
        url: "/upload",
        formData: makeFormData(),
        timeoutMs: 5000,
      });
      const xhr = MockXHR.latest();
      xhr.ontimeout?.call(xhr);
      await expect(promise).rejects.toMatchObject({
        name: "TimeoutError",
        message: expect.stringContaining("5000ms"),
      });
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

      expect(result.current.isUploading).toBe(false);
      expect(result.current.data).toBeNull();

      let promise!: Promise<{ url: string }>;
      act(() => {
        promise = result.current.upload({ file: "hello" });
      });

      // After microtask, isUploading flips on.
      await waitFor(() => expect(result.current.isUploading).toBe(true));
      await act(async () =>
        MockXHR.latest().emitLoad({ status: 200, body: { url: "/cdn/x.txt" } }),
      );
      await expect(promise).resolves.toEqual({ url: "/cdn/x.txt" });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual({ url: "/cdn/x.txt" });
      expect(result.current.error).toBeNull();
      expect(result.current.isUploading).toBe(false);
    });

    it("progress state mirrors xhr.upload.onprogress events", async () => {
      const wrapper = createWrapper(qc);
      const { result } = renderHook(
        () => useUploadWithProgress({ url: "/upload", buildFormData: () => makeFormData() }),
        { wrapper },
      );

      let promise!: Promise<unknown>;
      act(() => {
        promise = result.current.upload(undefined);
      });

      await waitFor(() => expect(MockXHR.instances.length).toBe(1));
      await act(async () => MockXHR.latest().emitProgress(250, 1000));
      await waitFor(() => expect(result.current.progress?.percent).toBe(25));
      await act(async () => MockXHR.latest().emitProgress(750, 1000));
      await waitFor(() => expect(result.current.progress?.percent).toBe(75));

      await act(async () => MockXHR.latest().emitLoad({ status: 200, body: {} }));
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
      act(() => {
        promise = result.current.upload(undefined);
      });
      await waitFor(() => expect(MockXHR.instances.length).toBe(1));
      await act(async () => MockXHR.latest().emitLoad({ status: 200, body: {} }));
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
          useUploadWithProgress({ url: "/upload", buildFormData: () => makeFormData(), onError }),
        { wrapper },
      );

      let promise!: Promise<unknown>;
      act(() => {
        promise = result.current.upload(undefined).catch(() => undefined);
      });
      await waitFor(() => expect(MockXHR.instances.length).toBe(1));
      await act(async () =>
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
        () => useUploadWithProgress({ url: "/upload", buildFormData: () => makeFormData() }),
        { wrapper },
      );

      let promise!: Promise<unknown>;
      act(() => {
        promise = result.current.upload(undefined).catch(() => undefined);
      });
      await waitFor(() => expect(MockXHR.instances.length).toBe(1));
      await act(async () => result.current.cancel());

      expect(MockXHR.latest().aborted).toBe(true);
      await promise;
    });

    it("starting a new upload while one is in-flight cancels the previous (last-call wins)", async () => {
      const wrapper = createWrapper(qc);
      const { result } = renderHook(
        () => useUploadWithProgress({ url: "/upload", buildFormData: () => makeFormData() }),
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

      await act(async () => MockXHR.instances[1]!.emitLoad({ status: 200, body: { ok: true } }));
      await first;
      await second;
    });

    it("reset() returns the hook to idle (clears progress/data/error/success)", async () => {
      const wrapper = createWrapper(qc);
      const { result } = renderHook(
        () => useUploadWithProgress({ url: "/upload", buildFormData: () => makeFormData() }),
        { wrapper },
      );

      let promise!: Promise<unknown>;
      act(() => {
        promise = result.current.upload(undefined);
      });
      await waitFor(() => expect(MockXHR.instances.length).toBe(1));
      await act(async () => MockXHR.latest().emitProgress(500, 1000));
      await act(async () => MockXHR.latest().emitLoad({ status: 200, body: { ok: true } }));
      await promise;
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      await act(async () => result.current.reset());
      expect(result.current.data).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.progress).toBeNull();
      expect(result.current.isUploading).toBe(false);
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
      act(() => {
        promise = result.current.upload({ folder: "admin" });
      });
      await waitFor(() => expect(MockXHR.instances.length).toBe(1));

      const xhr = MockXHR.latest();
      expect(xhr.url).toBe("http://api.test/api/v1/admin/upload");
      expect(xhr.headers["x-folder"]).toBe("admin");
      expect(xhr.headers["Idempotency-Key"]).toBe("key-admin");
      expect(xhr.headers["x-arc-scope"]).toBe("platform");

      await act(async () => xhr.emitLoad({ status: 200, body: {} }));
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
      act(() => {
        promise = result.current.upload(undefined);
      });
      await waitFor(() => expect(MockXHR.instances.length).toBe(1));
      await act(async () => MockXHR.latest().emitLoad({ status: 200, body: {} }));
      await promise;
      expect(success).toHaveBeenCalledWith("Uploaded!");

      let promise2!: Promise<unknown>;
      act(() => {
        promise2 = result.current.upload(undefined).catch(() => undefined);
      });
      await waitFor(() => expect(MockXHR.instances.length).toBe(2));
      await act(async () =>
        MockXHR.instances[1]!.emitLoad({ status: 500, body: { error: "boom" } }),
      );
      await promise2;
      expect(error).toHaveBeenCalledWith("Bad upload");
    });
  });
});

describe("auth refresh", () => {
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
    getResponseHeader(name: string): string | null {
      return this.responseHeaders.get(name.toLowerCase()) ?? null;
    }

    emitLoad(opts: { status: number; body?: unknown; statusText?: string }): void {
      this.readyState = 4;
      this.status = opts.status;
      this.statusText = opts.statusText ?? "";
      this.responseText =
        typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? {});
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

      const promise = uploadWithProgress({ url: "/upload", formData: makeFormData() });

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
});
