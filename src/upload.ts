"use client";

/**
 * XHR-based upload with real progress events.
 *
 * `fetch()` has no upload-progress API across browsers — Chrome 105+ supports
 * `ReadableStream` request bodies, but Safari and Firefox don't ship the stream
 * fetch+request body combination consumers need. This module solves that with
 * `XMLHttpRequest`, which gives universal `xhr.upload.onprogress` support.
 *
 * Two surfaces:
 *   1. `uploadWithProgress()` — plain Promise-returning function. Works in any
 *      JS context (React, Node-with-XHR-shim, tests).
 *   2. `useUploadWithProgress()` — TanStack-Query-flavored React hook. Tracks
 *      progress as React state alongside the standard mutation lifecycle
 *      (loading, error, data, reset, cancel) and integrates with the SDK's
 *      toast handler + query invalidation.
 *
 * Both reuse arc-next's auth pipeline (`getClientAuthContext`), the shared
 * `ArcApiError` envelope (top-level `code` + `details.code` slots), and the
 * same `Authorization` / `x-organization-id` / `x-arc-scope` /
 * `Idempotency-Key` header conventions as the fetch path. SDK behavior (auth,
 * errors, elevated requests, ArcApiError messages) stays consistent across
 * both upload variants.
 *
 * ─── Divergence from the fetch path ──────────────────────────────────────
 *
 * Two `ClientConfig` surfaces deliberately do NOT propagate to uploads:
 *
 * 1. **`retry`** — uploads do not auto-retry. Re-uploading a multi-MB body
 *    after a transient 5xx is rarely what consumers want (re-encoding cost,
 *    duplicate-write risk on non-idempotent endpoints, bandwidth burn). If
 *    you need at-most-once semantics, set `idempotencyKey` and let the
 *    backend dedupe; if you need at-least-once, wrap the call site with
 *    your own retry policy where you control file streaming.
 *
 * 2. **`beforeRequest` / `afterResponse`** — interceptors are tied to
 *    `executeRequest` (the fetch path) and DO NOT fire on XHR uploads.
 *    Trace headers, correlation IDs, and latency loggers configured via
 *    `configureClient({ beforeRequest, afterResponse })` will be missing
 *    on upload requests. To attach trace/correlation headers per-upload,
 *    pass them through the `headers` option on `uploadWithProgress` (or
 *    the `headers` factory on `useUploadWithProgress`):
 *
 *        const traceId = crypto.randomUUID();
 *        await uploadWithProgress({
 *          url, formData,
 *          headers: { 'x-correlation-id': traceId },
 *        });
 *        log.info({ traceId, uploadKind: 'media' });
 *
 *    This is documented behavior, not a bug — bridging XHR's progress events
 *    into the fetch interceptor pipeline would either require duplicating
 *    every interceptor for both transports or giving up the upload-progress
 *    contract. Future versions may expose dedicated `beforeUpload` /
 *    `afterUpload` hooks if a strong use case emerges.
 */

import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import {
  _getAuthErrorHandler,
  _isAuthRecoverable,
  _resolveRefreshedToken,
  _runAuthRecovery,
  ArcApiError,
  type ArcClient,
  getAuthMode,
  getBaseUrl,
  getClientAuthContext,
  type HttpMethod,
  type ToastHandler,
} from "./client.js";
import { getToastHandler, type MutationMessages } from "./mutation.js";

// ============================================================================
// Public types
// ============================================================================

/**
 * Upload-progress snapshot. Emitted on every native `xhr.upload.progress`
 * event. `lengthComputable` reflects whether the browser knows the total —
 * always true for `FormData` bodies in modern browsers, but consumers MUST
 * check it before treating `percent` as meaningful (some embedded WebView
 * environments still emit non-computable progress).
 */
export interface UploadProgress {
  /** 0..100, integer-rounded. Equal to `(loaded / total) * 100` when computable, 0 otherwise. */
  percent: number;
  /** Bytes successfully uploaded so far. */
  loaded: number;
  /** Total bytes the request body announces. 0 when `lengthComputable` is false. */
  total: number;
  /** Whether the runtime knows the total. False ⇒ `percent` is 0 and not meaningful. */
  lengthComputable: boolean;
}

export interface UploadWithProgressOptions {
  /**
   * Target endpoint. Absolute (`https://api.example.com/...`) or relative
   * (`/api/v1/media/upload`). Relative paths are prefixed with the configured
   * `baseUrl` from `configureClient()` (or `client.config.baseUrl`).
   */
  url: string;
  /**
   * Request body. Pass `FormData` directly — XHR auto-sets the
   * `multipart/form-data` Content-Type with the right boundary. We never set
   * Content-Type ourselves on FormData uploads; doing so strips the boundary.
   */
  formData: FormData;
  /** HTTP method. Default: `'POST'`. */
  method?: HttpMethod;
  /** Per-event progress callback. Called on every `xhr.upload.progress`. */
  onProgress?: (progress: UploadProgress) => void;
  /**
   * Abort signal. When the signal fires (or is already aborted), the XHR is
   * aborted immediately and the returned promise rejects with the signal's
   * `reason` (or `DOMException('AbortError')` if no reason was set).
   */
  signal?: AbortSignal;
  /**
   * Per-client auth context override. When provided, auth headers
   * (`Authorization`, `x-organization-id`, `x-arc-scope`) and `withCredentials`
   * are derived from this client's config. Falls back to the global
   * `configureClient()` / `configureAuth()` singletons when absent.
   */
  client?: ArcClient;
  /** Explicit token, overrides `client?.auth?.getToken()` and global. */
  token?: string | null;
  /** Explicit organization id, overrides `client?.auth?.getOrgId()` and global. */
  organizationId?: string | null;
  /**
   * Extra headers merged on top of the auth-derived headers. Use for
   * per-request needs (`Accept-Version`, `x-foo`, etc.). Setting
   * `Content-Type` here is allowed but discouraged — XHR computes the
   * multipart boundary automatically.
   */
  headers?: Record<string, string>;
  /** Send `x-arc-scope: platform` for arc's elevated-scope upgrade. */
  elevated?: boolean;
  /** Sent as `Idempotency-Key` header. Match the fetch path's contract. */
  idempotencyKey?: string;
  /**
   * Treat the response as a binary blob instead of attempting JSON parse.
   * Use when the upload returns a transformed file (e.g. the server resizes
   * an image and returns the resized binary). Default: false (parse JSON).
   */
  responseType?: "json" | "text" | "blob";
  /**
   * Upload timeout in ms, assigned to `xhr.timeout` — the whole request
   * (upload + server processing + response) must finish within this window
   * or the promise rejects with a `TimeoutError`. Default: disabled (0) —
   * large files on slow links legitimately take minutes; size it to your
   * payload ceiling when you enable it. (`ClientConfig.timeoutMs` does NOT
   * apply to uploads — the fetch pipeline and XHR transport stay isolated.)
   */
  timeoutMs?: number;
}

// ============================================================================
// Plain function — the source of truth (works in tests, Node-with-shim, etc.)
// ============================================================================

/**
 * Upload a `FormData` payload via XHR with native progress events.
 *
 * Returns a Promise that resolves with the parsed response body
 * (`responseType: 'json'` by default — pass `'text'` or `'blob'` to opt out).
 * Rejects with {@link ArcApiError} on non-2xx, with abort errors when the
 * provided signal fires, or `Error` on transport failure (network down, CORS).
 *
 * Reuses {@link getClientAuthContext} so the global `configureAuth()` token /
 * orgId — and per-client overrides via `client?.auth` — flow through. Sets
 * `withCredentials = true` automatically for `authMode: 'cookie'`.
 *
 * @example
 * const result = await uploadWithProgress<{ url: string }>({
 *   url: '/api/v1/media/upload',
 *   formData,
 *   onProgress: ({ percent }) => setUiProgress(percent),
 * });
 */
export async function uploadWithProgress<TResult = unknown>(
  options: UploadWithProgressOptions,
): Promise<TResult> {
  const { handler, retryOn403, maxAuthRetries } = _getAuthErrorHandler();
  // Fast path — no recovery handler wired, single attempt as before.
  if (!handler) return uploadAttempt<TResult>(options);

  // Auth-retry loop — same shape as `executeRequest`'s outer loop, just
  // wrapping the XHR transport instead of fetch. Token override from the
  // shared dedup'd recovery flows back via `options.token` for the retry.
  let currentOptions = options;
  for (let attempt = 0; attempt <= maxAuthRetries; attempt++) {
    try {
      return await uploadAttempt<TResult>(currentOptions);
    } catch (error) {
      if (attempt >= maxAuthRetries || !_isAuthRecoverable(error, retryOn403)) throw error;
      if (currentOptions.signal?.aborted) throw error;

      const { decision, overrideToken } = await _runAuthRecovery(handler, {
        error: error as ArcApiError,
        request: {
          method: (currentOptions.method ?? "POST") as HttpMethod,
          endpoint: currentOptions.url,
        },
        attempt: attempt + 1,
      });
      if (decision !== "retry") throw error;

      currentOptions = { ...currentOptions, token: _resolveRefreshedToken(overrideToken) };
    }
  }
  throw new Error("arc-next: upload auth retry loop terminated without resolution");
}

/**
 * Single XHR attempt. Identical to the pre-0.7 body of `uploadWithProgress`
 * — extracted so the auth-retry loop above can re-run it with a refreshed
 * token without duplicating the XHR setup. All auth-recovery semantics live
 * in the outer loop; this function just performs one upload.
 */
function uploadAttempt<TResult = unknown>(options: UploadWithProgressOptions): Promise<TResult> {
  const {
    url,
    formData,
    method = "POST",
    onProgress,
    signal,
    client,
    headers: extraHeaders,
    elevated,
    idempotencyKey,
    responseType = "json",
    timeoutMs = 0,
  } = options;

  return new Promise<TResult>((resolve, reject) => {
    // ── Pre-abort guard ───────────────────────────────────────────────
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const xhr = new XMLHttpRequest();
    const fullUrl = resolveUrl(url, client);

    xhr.open(method, fullUrl, true);

    // Without assigning `xhr.timeout`, the `ontimeout` handler below can
    // never fire (XHR's default is 0 = no timeout) — a hung upload pends
    // forever. 0 keeps it disabled; see UploadWithProgressOptions.timeoutMs.
    if (timeoutMs > 0) xhr.timeout = timeoutMs;

    // ── Response parsing ───────────────────────────────────────────────
    // We parse manually so non-JSON error bodies (HTML CDN pages, plain text)
    // get captured into ArcApiError.json.rawBody — matching the fetch path's
    // contract exactly. Setting xhr.responseType = '' (text) keeps everything
    // string-friendly until we parse below.
    xhr.responseType = responseType === "blob" ? "blob" : "";

    // ── Auth + standard headers ────────────────────────────────────────
    // IMPORTANT: do NOT set Content-Type for FormData. XHR computes the
    // multipart boundary automatically; setting it strips the boundary
    // and the request fails server-side with "no multipart boundary".
    const authMode = client?.config?.authMode ?? getAuthMode();
    if (authMode === "cookie") {
      xhr.withCredentials = true;
    }

    const authCtx = getClientAuthContext(client);
    const token = options.token !== undefined ? options.token : authCtx.token;
    const orgId =
      options.organizationId !== undefined ? options.organizationId : authCtx.organizationId;

    const builtHeaders: Record<string, string> = {};

    if (token) {
      if (authMode === "header") {
        const headerName = client?.auth?.headerName ?? "x-api-key";
        builtHeaders[headerName] = token;
      } else if (authMode !== "cookie") {
        builtHeaders.Authorization = `Bearer ${token}`;
      }
    }
    if (orgId) builtHeaders["x-organization-id"] = orgId;
    if (elevated ?? client?.config?.elevated) builtHeaders["x-arc-scope"] = "platform";
    if (idempotencyKey) builtHeaders["Idempotency-Key"] = idempotencyKey;
    if (client?.config?.apiVersion) builtHeaders["Accept-Version"] = client.config.apiVersion;
    if (client?.config?.internalApiKey)
      builtHeaders["x-internal-api-key"] = client.config.internalApiKey;

    Object.assign(builtHeaders, client?.config?.defaultHeaders ?? {});
    Object.assign(builtHeaders, extraHeaders ?? {});

    for (const [name, value] of Object.entries(builtHeaders)) {
      // Skip Content-Type for FormData — see comment above.
      if (name.toLowerCase() === "content-type") continue;
      xhr.setRequestHeader(name, value);
    }

    // ── Progress wiring ────────────────────────────────────────────────
    if (onProgress) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        const lengthComputable = event.lengthComputable;
        const total = lengthComputable ? event.total : 0;
        const loaded = event.loaded;
        const percent =
          lengthComputable && total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        onProgress({ percent, loaded, total, lengthComputable });
      };
    }

    // ── Abort wiring ───────────────────────────────────────────────────
    let abortListener: (() => void) | null = null;
    if (signal) {
      abortListener = () => {
        try {
          xhr.abort();
        } catch {
          /* ignore double-abort */
        }
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    // ── Completion handlers ────────────────────────────────────────────
    xhr.onload = () => {
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
      const status = xhr.status;
      const statusText = xhr.statusText || statusTextFromCode(status);
      // 0 status with response body indicates a CORS / network failure that
      // surfaces through onload (some browsers). Treat as network error.
      if (status === 0) {
        reject(new Error(`Network error during upload to ${fullUrl}`));
        return;
      }

      const body = parseResponseBody(xhr, responseType);

      if (status >= 200 && status < 300) {
        resolve(body as TResult);
        return;
      }

      // Mirror the fetch path: prefer json.message (canonical ErrorContract),
      // fall back to json.error (legacy backends), then statusText.
      // ArcApiError.json carries the raw envelope so `code` / `details` /
      // `fieldErrors` getters parse it on demand.
      const message = extractErrorMessage(body, statusText);
      reject(
        new ArcApiError(message, {
          status,
          statusText,
          json: body,
          endpoint: url,
          method,
        }),
      );
    };

    xhr.onerror = () => {
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
      reject(new Error(`Network error during upload to ${fullUrl}`));
    };

    xhr.ontimeout = () => {
      if (abortListener && signal) signal.removeEventListener("abort", abortListener);
      reject(
        Object.assign(new Error(`Upload timed out after ${timeoutMs}ms: ${fullUrl}`), {
          name: "TimeoutError",
        }),
      );
    };

    // ── Fire ───────────────────────────────────────────────────────────
    xhr.send(formData);
  });
}

// ============================================================================
// React hook — TanStack Query flavored, delegates to plain function
// ============================================================================

export interface UseUploadWithProgressOptions<TResult, TVars> {
  /** Endpoint URL or a function that derives it from `vars`. Relative or absolute. */
  url: string | ((vars: TVars) => string);
  /** HTTP method. Default: `'POST'`. */
  method?: HttpMethod;
  /** Build the FormData payload from the call's variables. */
  buildFormData: (vars: TVars) => FormData;
  /** Query keys to invalidate after a successful upload. */
  invalidateQueries?: QueryKey[];
  /** Toast messages. Same shape as `useMutationWithTransition`. */
  messages?: MutationMessages;
  /** Override the global toast handler for this hook only. */
  toastHandler?: ToastHandler;
  /** Per-client auth pipeline (multi-backend apps). */
  client?: ArcClient;
  /**
   * Extra request headers per call. Function form receives the call's vars
   * so you can compute headers from the upload (e.g. an idempotency key
   * derived from the file hash).
   */
  headers?: Record<string, string> | ((vars: TVars) => Record<string, string>);
  /** Send `x-arc-scope: platform`. Per-call dynamic via function form. */
  elevated?: boolean | ((vars: TVars) => boolean);
  /** Per-call idempotency key. Function form gets the vars. */
  idempotencyKey?: string | ((vars: TVars) => string);
  /** `'json'` (default), `'text'`, or `'blob'`. */
  responseType?: "json" | "text" | "blob";
  // Lifecycle callbacks — symmetric with `useMutationWithTransition`.
  onSuccess?: (data: TResult, vars: TVars) => void;
  onError?: (error: Error, vars: TVars) => void;
  onSettled?: (data: TResult | undefined, error: Error | null, vars: TVars) => void;
  /** Per-event progress callback (in addition to the React state mirror). */
  onProgress?: (progress: UploadProgress, vars: TVars) => void;
}

export interface UseUploadWithProgressResult<TResult, TVars> {
  /**
   * Trigger an upload. Returns a Promise that resolves with the parsed
   * response body or rejects with `ArcApiError` / abort error.
   */
  upload: (vars: TVars) => Promise<TResult>;
  /** Latest progress snapshot. Null when no upload is active. */
  progress: UploadProgress | null;
  /** True from `upload()` start until resolve/reject/cancel. */
  isUploading: boolean;
  /** Alias for `isUploading` — matches TanStack mutation naming. */
  isPending: boolean;
  /** Last-resolved data (kept across calls until `reset()` or next upload). */
  data: TResult | null;
  /** Last error (cleared on the next upload or `reset()`). */
  error: Error | null;
  /** Whether the last upload succeeded. */
  isSuccess: boolean;
  /** Whether the last upload errored. */
  isError: boolean;
  /** Abort the in-flight upload. No-op when none is active. */
  cancel: () => void;
  /** Clear progress / data / error so the hook reads as "idle" again. */
  reset: () => void;
}

/**
 * React hook that wraps {@link uploadWithProgress} with TanStack-Query-style
 * mutation ergonomics. Progress lives in React state — every progress tick
 * re-renders the consumer so binding `progress.percent` to a `<ProgressBar>`
 * "just works" with no extra plumbing.
 *
 * @example
 * const { upload, progress, isUploading, cancel, error } = useUploadWithProgress<
 *   { url: string }[],
 *   { files: File[]; folder?: string }
 * >({
 *   url: '/api/v1/media/upload-multiple',
 *   buildFormData: ({ files, folder }) => {
 *     const fd = new FormData();
 *     if (folder) fd.append('folder', folder);
 *     files.forEach((f) => fd.append('files[]', f));
 *     return fd;
 *   },
 *   invalidateQueries: [mediaKeys.lists()],
 *   messages: { success: 'Uploaded', error: 'Upload failed' },
 * });
 *
 * <ProgressBar value={progress?.percent ?? 0} />
 * <button onClick={() => upload({ files })}>Upload</button>
 * {isUploading && <button onClick={cancel}>Cancel</button>}
 */
export function useUploadWithProgress<TResult = unknown, TVars = unknown>(
  options: UseUploadWithProgressOptions<TResult, TVars>,
): UseUploadWithProgressResult<TResult, TVars> {
  const queryClient = useQueryClient();

  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [data, setData] = useState<TResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  // Live ref bag so callback churn doesn't break in-flight uploads. Mirrors
  // the pattern useEventStream / useWebSocket use — option fields can change
  // mid-upload without aborting the request.
  const optsRef = useRef(options);
  optsRef.current = options;

  // AbortController for the active upload. Stable handle so cancel() works
  // even if the consumer re-renders between upload() and cancel().
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setProgress(null);
    setIsUploading(false);
    setData(null);
    setError(null);
    setIsSuccess(false);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const upload = useCallback(
    async (vars: TVars): Promise<TResult> => {
      const opts = optsRef.current;
      const url = typeof opts.url === "function" ? opts.url(vars) : opts.url;
      const formData = opts.buildFormData(vars);
      const headers = typeof opts.headers === "function" ? opts.headers(vars) : opts.headers;
      const elevated = typeof opts.elevated === "function" ? opts.elevated(vars) : opts.elevated;
      const idempotencyKey =
        typeof opts.idempotencyKey === "function" ? opts.idempotencyKey(vars) : opts.idempotencyKey;

      // Cancel any in-flight upload before starting a new one. Mirrors
      // useMutation's overlap policy — last-call wins.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Fresh state for this attempt.
      setError(null);
      setIsSuccess(false);
      setIsUploading(true);
      setProgress({ percent: 0, loaded: 0, total: 0, lengthComputable: false });

      try {
        const result = await uploadWithProgress<TResult>({
          url,
          formData,
          method: opts.method,
          client: opts.client,
          headers,
          elevated,
          idempotencyKey,
          responseType: opts.responseType,
          signal: controller.signal,
          onProgress: (p) => {
            setProgress(p);
            opts.onProgress?.(p, vars);
          },
        });

        // Only commit success if this controller is still the active one.
        // Late-arriving responses from a superseded upload don't clobber state.
        if (abortRef.current === controller) {
          setData(result);
          setIsSuccess(true);
          setIsUploading(false);
        }

        // Invalidations + toasts happen unconditionally on success — the
        // mutation completed, the user wants the UI to reflect it.
        if (opts.invalidateQueries?.length) {
          for (const key of opts.invalidateQueries) {
            queryClient.invalidateQueries({ queryKey: key });
          }
        }
        const successMsg = opts.messages?.success;
        if (successMsg) {
          const text = typeof successMsg === "function" ? successMsg(result, vars) : successMsg;
          (opts.toastHandler ?? getToastHandler()).success(text);
        }
        opts.onSuccess?.(result, vars);
        opts.onSettled?.(result, null, vars);

        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));

        if (abortRef.current === controller) {
          setError(e);
          setIsSuccess(false);
          setIsUploading(false);
        }

        const errorMsg = opts.messages?.error;
        if (errorMsg) {
          const text = typeof errorMsg === "function" ? errorMsg(e, vars) : errorMsg;
          (opts.toastHandler ?? getToastHandler()).error(text);
        }
        opts.onError?.(e, vars);
        opts.onSettled?.(undefined, e, vars);

        throw e;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    // queryClient is stable; everything else reads through optsRef so the
    // returned `upload` identity stays the same across renders.
    [queryClient],
  );

  return {
    upload,
    progress,
    isUploading,
    isPending: isUploading,
    data,
    error,
    isSuccess,
    isError: error !== null,
    cancel,
    reset,
  };
}

// ============================================================================
// Internals
// ============================================================================

/**
 * Resolve a possibly-relative URL against the configured base. Mirrors
 * `executeRequest` so the SDK presents a consistent URL contract regardless
 * of transport.
 */
function resolveUrl(url: string, client?: ArcClient): string {
  if (/^https?:\/\//i.test(url)) return url; // already absolute
  const base = client?.config?.baseUrl ?? getBaseUrl();
  if (!base) return url;
  // Avoid double slashes when both base ends with / and url starts with /
  if (base.endsWith("/") && url.startsWith("/")) return base + url.slice(1);
  if (!base.endsWith("/") && !url.startsWith("/")) return `${base}/${url}`;
  return base + url;
}

/**
 * Parse XHR response body. Returns the raw value the caller asked for —
 * `'json'` parses (and falls back to text on parse failure); `'text'` returns
 * the string as-is; `'blob'` returns the binary directly.
 */
function parseResponseBody(xhr: XMLHttpRequest, kind: "json" | "text" | "blob"): unknown {
  if (kind === "blob") return xhr.response;
  const raw = xhr.responseText;
  if (kind === "text") return raw;
  // JSON path — try parse, fall back to a `{ rawBody }` wrapper on failure
  // so error responses (HTML, plain text) still ride on `ArcApiError.json`.
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { rawBody: raw };
  }
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const obj = body as { error?: unknown; message?: unknown };
    if (typeof obj.error === "string" && obj.error) return obj.error;
    if (typeof obj.message === "string" && obj.message) return obj.message;
  }
  return fallback;
}

function abortReason(signal: AbortSignal): unknown {
  // `signal.reason` was added in 2022 — present in every browser arc-next
  // targets, but fall back to a synthesized DOMException for very old
  // environments. Match the platform's AbortError convention exactly.
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

function statusTextFromCode(code: number): string {
  if (code >= 500) return "Internal Server Error";
  if (code >= 400) return "Request Error";
  return "OK";
}
