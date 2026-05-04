// ============================================================================
// Shared Types (used by client, mutation, and hooks)
// ============================================================================

export interface ToastHandler {
  success: (message: string) => void;
  error: (message: string) => void;
}

export type UseRouterHook = () => {
  push: (href: string, options?: { scroll?: boolean }) => void;
  replace: (href: string, options?: { scroll?: boolean }) => void;
};

// ============================================================================
// ArcApiError — unified on `@classytic/repo-core` ErrorContract
// ============================================================================

import type { ErrorContract, ErrorDetail } from '@classytic/repo-core/errors';

/**
 * Canonical error codes arc and repo-core emit on `json.code`. Single
 * top-level slot — arc 2.13's `createError` lifts business codes from
 * `details` to top-level so `repo-core`'s `toErrorContract` round-trips
 * them on the wire. There is no separate `detailsCode` slot; everything
 * lives at `error.code`.
 *
 * Three families compose this list:
 *  1. **repo-core canonical** (`validation_error`, `not_found`, ...) — RFC 7807
 *     / Stripe-shaped lowercase + snake_case. Cross-package universals.
 *  2. **arc hierarchical** (`arc.forbidden`, `arc.validation_error`,
 *     `arc.org.access_denied`, ...) — what arc's `errorHandlerPlugin`
 *     emits for HTTP-status throws + arc-classified errors.
 *  3. **arc business** (`ORG_CONTEXT_REQUIRED`, `ALL_FIELDS_STRIPPED`,
 *     `OWNERSHIP_DENIED`, ...) — emitted by mixins / org guards via
 *     `createError(status, msg, { code })`. The UPPER_SNAKE form is
 *     intentional: these are reason codes, not HTTP-status codes.
 *
 * `(string & {})` keeps the type open so domain packages and custom
 * `errorMappers` codes still satisfy it.
 */
export const KNOWN_ARC_ERROR_CODES = [
  // repo-core canonical (lowercase, RFC 7807)
  'validation_error',
  'not_found',
  'conflict',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'idempotency_conflict',
  'precondition_failed',
  'internal_error',
  'service_unavailable',
  'timeout',
  // arc hierarchical (lowercase, dot-separated)
  'arc.bad_request',
  'arc.unauthorized',
  'arc.forbidden',
  'arc.not_found',
  'arc.conflict',
  'arc.unprocessable_entity',
  'arc.rate_limited',
  'arc.internal_error',
  'arc.bad_gateway',
  'arc.service_unavailable',
  'arc.gateway_timeout',
  'arc.validation_error',
  'arc.invalid_id',
  'arc.org.selection_required',
  'arc.org.access_denied',
  // arc business (UPPER_SNAKE) — emitted by mixins + org guards
  'ORG_CONTEXT_REQUIRED',
  'ORG_ROLE_REQUIRED',
  'OWNERSHIP_DENIED',
  'MIXED_UPDATE_SHAPE',
  'ALL_FIELDS_STRIPPED',
  'BEFORE_RESTORE_HOOK_ERROR',
  'duplicate_key',
] as const;

/**
 * Canonical arc error code union. `(string & {})` keeps the type open so
 * domain packages can extend hierarchically (`'order.cart.locked'`,
 * `'payment.gateway.timeout'`) and still satisfy the type.
 */
export type ArcErrorCode = (typeof KNOWN_ARC_ERROR_CODES)[number] | (string & {});

export interface ArcApiErrorOptions {
  status: number;
  statusText: string;
  json: unknown;
  endpoint: string;
  method: HttpMethod;
}

/**
 * Rich API error with status code, response payload, and request metadata.
 * Extends Error so existing `catch (e) { if (e instanceof Error) }` still works.
 *
 * @example
 * try {
 *   await handleApiRequest('POST', '/users', { body: data });
 * } catch (error) {
 *   if (isArcApiError(error)) {
 *     console.log(error.status);       // 422
 *     console.log(error.fieldErrors);   // { email: 'already taken' }
 *   }
 * }
 */
export class ArcApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly json: unknown;
  readonly endpoint: string;
  readonly method: HttpMethod;

  constructor(message: string, options: ArcApiErrorOptions) {
    super(message);
    this.name = 'ArcApiError';
    this.status = options.status;
    this.statusText = options.statusText;
    this.json = options.json;
    this.endpoint = options.endpoint;
    this.method = options.method;
  }

  /**
   * Canonical error code from arc's wire envelope (`json.code`).
   *
   * Arc 2.13 + `repo-core` 0.4 emit one canonical {@link ErrorContract}
   * shape — `{ code, message, status, details? }` — with the business
   * code at top-level. Hosts switch on `error.code` directly:
   *
   * @example
   * if (error.code === 'ORG_CONTEXT_REQUIRED') promptOrgSelector();
   * if (error.code === 'arc.not_found') router.replace('/404');
   * if (error.code === 'duplicate_key') showRetryAsAdmin();
   */
  get code(): ArcErrorCode | null {
    const j = this.json as { code?: unknown } | null;
    return j && typeof j.code === 'string' ? (j.code as ArcErrorCode) : null;
  }

  /**
   * Canonical structured details — populated for validation failures
   * (one entry per offending field) and duplicate-key conflicts (one entry
   * per offending field). Shape matches `repo-core`'s {@link ErrorDetail}:
   * `{ path?, code, message, meta? }`. Returns `null` for non-arc backends
   * or responses without details.
   */
  get details(): readonly ErrorDetail[] | null {
    const j = this.json as { details?: unknown } | null;
    return Array.isArray(j?.details) ? (j!.details as ErrorDetail[]) : null;
  }

  /**
   * Extract field-level validation errors as `{ field: message }` map.
   *
   * Reads the canonical `ErrorContract.details: ErrorDetail[]` shape first
   * (what arc 2.13 + repo-core emit), then falls back to legacy shapes for
   * non-arc backends:
   *  1. `details: [{ path, code, message }]` — canonical (arc / repo-core).
   *  2. `errors: { email: 'invalid' }` — record form (legacy app handlers).
   *  3. `details: { errors: [{ field|instancePath, message }] }` — pre-2.13 AJV.
   *  4. `errors: [...]` at the top level — third-party frameworks.
   */
  get fieldErrors(): Record<string, string> | null {
    const j = this.json as
      | {
          errors?: Record<string, string> | unknown[];
          details?: ErrorDetail[] | { errors?: unknown[] } | unknown[];
        }
      | null;
    if (!j) return null;

    // Shape 1 (canonical): `details: ErrorDetail[]` with `{ path, code, message }`.
    if (Array.isArray(j.details) && j.details.length > 0) {
      const map: Record<string, string> = {};
      for (const d of j.details as ErrorDetail[]) {
        if (!d || typeof d !== 'object') continue;
        const key = typeof d.path === 'string' ? d.path : '';
        const msg = typeof d.message === 'string' ? d.message : 'Invalid value';
        if (key && !(key in map)) map[key] = msg;
      }
      if (Object.keys(map).length > 0) return map;
    }

    // Shape 2 (legacy record form): `errors: { field: 'message' }`.
    if (j.errors && !Array.isArray(j.errors) && typeof j.errors === 'object') {
      return j.errors as Record<string, string>;
    }

    // Shape 3/4 (pre-2.13 / third-party): `errors: [...]` or `details.errors: [...]`.
    const detailsObj = j.details as { errors?: unknown[] } | undefined;
    const errorList = Array.isArray(j.errors)
      ? j.errors
      : Array.isArray(detailsObj?.errors)
        ? detailsObj!.errors
        : null;
    if (!errorList) return null;

    const map: Record<string, string> = {};
    for (const item of errorList) {
      if (!item || typeof item !== 'object') continue;
      const e = item as {
        field?: unknown;
        instancePath?: unknown;
        path?: unknown;
        message?: unknown;
        params?: { missingProperty?: unknown };
      };
      const key =
        (typeof e.field === 'string' && e.field) ||
        (typeof e.instancePath === 'string' && e.instancePath.replace(/^\//, '')) ||
        (typeof e.path === 'string' && e.path) ||
        (typeof e.params?.missingProperty === 'string' && e.params.missingProperty) ||
        '';
      if (!key) continue;
      const msg = typeof e.message === 'string' ? e.message : 'Invalid value';
      if (!(key in map)) map[key] = msg;
    }
    return Object.keys(map).length > 0 ? map : null;
  }
}

/**
 * Type guard for ArcApiError.
 */
export function isArcApiError(error: unknown): error is ArcApiError {
  return error instanceof ArcApiError;
}

/**
 * Detects request cancellation (AbortSignal triggered) regardless of runtime.
 *
 * Filtering out abort errors from real failures is a common need — without it,
 * unmounting a React component mid-fetch produces noisy logs and bogus error
 * toasts that look like API failures. Use this predicate to skip the catch
 * branch when the request was deliberately cancelled.
 *
 * Handles the three AbortError shapes you'll see in the wild:
 * 1. Browser `DOMException { name: 'AbortError' }`
 * 2. Node 18+ / undici `Error { name: 'AbortError' }` (no DOMException)
 * 3. Some polyfills / older runtimes where the error has `code: 'ERR_ABORTED'`
 *
 * @example
 * try {
 *   await api.getAll({ options: { signal } });
 * } catch (err) {
 *   if (isAbortError(err)) return; // user navigated away — silence
 *   showToast('Failed to load: ' + err.message);
 * }
 */
export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error !== 'object') return false;
  const e = error as { name?: unknown; code?: unknown };
  if (e.name === 'AbortError') return true;
  if (e.code === 'ERR_ABORTED') return true;
  return false;
}

/**
 * Generic check: is this an `ArcApiError` carrying a specific `code`?
 * Single-slot — arc 2.13 + repo-core 0.4 emit one canonical `code` at
 * top-level. Pass either the canonical lowercase form (`'arc.not_found'`,
 * `'validation_error'`) or arc's UPPER_SNAKE business form
 * (`'ORG_CONTEXT_REQUIRED'`).
 *
 * @example
 * if (isArcErrorCode(error, 'duplicate_key')) showRetryUI();
 * if (isArcErrorCode(error, 'ORG_CONTEXT_REQUIRED')) promptOrgSelector();
 */
export function isArcErrorCode(error: unknown, code: ArcErrorCode): error is ArcApiError {
  return isArcApiError(error) && error.code === code;
}

/**
 * Specific predicate for arc's bulk-preset + orgGuard safety code.
 *
 * Arc's bulk endpoints (`POST/PATCH/DELETE /:resource/bulk`) reject any call
 * where `request.scope.organizationId` is missing — the wire signal is
 * `403 { code: 'ORG_CONTEXT_REQUIRED', message, status: 403 }`. Hosts hitting
 * this need to call `configureAuth({ getOrgId })` before retrying.
 *
 * @example
 * try { await api.bulkCreate({ data: [...] }); }
 * catch (e) {
 *   if (isOrgContextRequiredError(e)) {
 *     console.warn('Bulk requires org context. Configure: configureAuth({ getOrgId })');
 *   } else throw e;
 * }
 */
export function isOrgContextRequiredError(error: unknown): error is ArcApiError {
  return isArcErrorCode(error, 'ORG_CONTEXT_REQUIRED');
}

/**
 * Specific predicate for validation failures (Fastify AJV + Mongoose
 * ValidationError). When true, `error.fieldErrors` is populated with the
 * `{ field: message }` map. Matches arc's `arc.validation_error` and the
 * canonical `validation_error` from repo-core.
 */
export function isValidationError(error: unknown): error is ArcApiError {
  if (!isArcApiError(error)) return false;
  return error.code === 'arc.validation_error' || error.code === 'validation_error';
}

/**
 * Specific predicate for unique-constraint violations. Arc's errorHandler
 * classifies these uniformly across MongoDB E11000, Postgres 23505,
 * Prisma P2002 → `arc.conflict` (with `details[].code === 'duplicate_key'`).
 */
export function isDuplicateKeyError(error: unknown): error is ArcApiError {
  if (!isArcApiError(error)) return false;
  if (error.code === 'arc.conflict' || error.code === 'duplicate_key' || error.code === 'conflict') {
    // arc.conflict can also represent non-duplicate conflicts (lease, version) —
    // narrow further by checking details[].code === 'duplicate_key' when present.
    if (error.code === 'arc.conflict') {
      return error.details?.some((d) => d.code === 'duplicate_key') ?? false;
    }
    return true;
  }
  return false;
}

// ============================================================================
// Client Configuration
// ============================================================================

export interface ClientConfig {
  baseUrl: string;
  internalApiKey?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Auth mode for the API client.
   * - 'bearer' (default): Requires a token for authenticated requests. Queries are disabled until a token is provided.
   * - 'cookie': Auth is handled via HTTP-only cookies (e.g. Better Auth). Queries are always enabled — no token needed.
   */
  authMode?: 'bearer' | 'cookie' | 'header';
  /**
   * Fetch credentials policy.
   * - 'include': Always send cookies cross-origin (required for cookie-based auth).
   * - 'same-origin': Only send cookies to same-origin requests (browser default).
   * - 'omit': Never send cookies.
   *
   * When not set, derived from `authMode`:
   * - `authMode: 'cookie'` → `'include'`
   * - `authMode: 'bearer'` (default) → `'same-origin'`
   */
  credentials?: RequestCredentials;
  /**
   * API version sent as `Accept-Version` header.
   * Use when the Arc backend has versioning enabled.
   * @example '2' // sends Accept-Version: 2
   */
  apiVersion?: string;
  /**
   * Auto-generate `Idempotency-Key` header for POST/PUT/PATCH requests.
   * Prevents duplicate mutations on network retries.
   * Default: false — opt-in per-request via `idempotencyKey` option.
   */
  autoIdempotency?: boolean;
  /**
   * Send `x-arc-scope: platform` on every request. Triggers arc's elevated-scope
   * upgrade (member → elevated) when the caller has the appropriate permission.
   * Use sparingly — typically only for internal admin tooling.
   * Per-request override: set `elevated: true | false` on `RequestOptions`.
   */
  elevated?: boolean;
  /**
   * Network-failure + 5xx retry policy. Off by default — TanStack Query already
   * retries query reads (3× by default), but the SDK's mutation flow and any
   * direct `handleApiRequest` call get nothing without this.
   *
   * @example
   * configureClient({
   *   baseUrl,
   *   retry: { attempts: 3, backoff: 'exponential' },
   * });
   */
  retry?: RetryConfig;
  /**
   * Mutate the outgoing request before fetch. Runs once per attempt (so a retry
   * re-runs the interceptor — useful for refreshed tokens or rotated trace IDs).
   * Return the (possibly modified) context. Async is supported.
   *
   * @example
   * configureClient({
   *   baseUrl,
   *   beforeRequest: (req) => ({
   *     ...req,
   *     headers: { ...req.headers, 'x-correlation-id': crypto.randomUUID() },
   *   }),
   * });
   */
  beforeRequest?: BeforeRequestInterceptor;
  /**
   * Inspect or transform the parsed response body. Receives the same shape the
   * SDK is about to return; returning a new `body` replaces it. Errors are not
   * forwarded here — they throw `ArcApiError` before this runs. Async is supported.
   *
   * @example
   * configureClient({
   *   baseUrl,
   *   afterResponse: (res) => {
   *     console.log(`[arc] ${res.method} ${res.endpoint} ${res.status} ${res.durationMs}ms`);
   *     return res; // unchanged
   *   },
   * });
   */
  afterResponse?: AfterResponseInterceptor;
}

// ============================================================================
// Retry + Interceptor types
// ============================================================================

export interface RetryConfig {
  /** Total attempts including the first. `attempts: 3` means 1 try + 2 retries. Default: 0 (off). */
  attempts?: number;
  /**
   * Backoff strategy.
   * - `'exponential'` (default): `min(300 * 2^n, 10_000)` ms
   * - `'linear'`: `300 * (n + 1)` ms
   * - `(attempt) => number`: custom delay in ms; receives the 0-indexed retry attempt
   */
  backoff?: 'exponential' | 'linear' | ((attempt: number) => number);
  /**
   * Whitelist of statuses to retry on, OR a predicate. Defaults to a function
   * that returns true for: any non-`ArcApiError` (network failure / fetch
   * TypeError) AND `ArcApiError.status >= 500 && < 600`. Never retries on
   * AbortError or 4xx.
   */
  retryOn?: number[] | ((error: unknown) => boolean);
}

/** Context handed to {@link ClientConfig.beforeRequest}. Mutate + return to override. */
export interface BeforeRequestContext {
  method: HttpMethod;
  endpoint: string;
  /** Headers about to be sent. Mutating this is the recommended way to inject auth/trace headers. */
  headers: Record<string, string>;
  /** Body as the SDK is about to send it (already JSON-stringified, FormData, or undefined). */
  body: BodyInit | undefined;
  /** AbortSignal forwarded to fetch, if any. */
  signal?: AbortSignal;
  /** 0 on first attempt, 1+ on retries — useful for trace stamping. */
  attempt: number;
}

export type BeforeRequestInterceptor = (
  ctx: BeforeRequestContext,
) => BeforeRequestContext | Promise<BeforeRequestContext>;

/** Context handed to {@link ClientConfig.afterResponse}. */
export interface AfterResponseContext<T = unknown> {
  method: HttpMethod;
  endpoint: string;
  status: number;
  /** Parsed response body — JSON object, blob wrapper, or text wrapper depending on Content-Type. */
  body: T;
  /** Total elapsed milliseconds from `beforeRequest` invocation to response parse complete. */
  durationMs: number;
  /** Original Response — clone before reading body if you need raw access. */
  response: Response;
}

export type AfterResponseInterceptor = <T = unknown>(
  ctx: AfterResponseContext<T>,
) => AfterResponseContext<T> | Promise<AfterResponseContext<T>>;

let clientConfig: ClientConfig | null = null;

/**
 * Configure the API client. Call once at app init before any API requests.
 *
 * **SSR safety:** This sets module-level state. In Next.js, call this only in
 * client-side code (e.g. a `"use client"` provider or `useEffect`).
 * Calling on the server risks leaking state between requests.
 *
 * @example
 * // Bearer token auth (default)
 * configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL! });
 *
 * // Cookie-based auth (e.g. Better Auth)
 * configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL!, authMode: 'cookie' });
 */
export function configureClient(config: ClientConfig): void {
  if (typeof window === "undefined") {
    console.warn(
      "[arc-next] configureClient() called on the server. " +
      "This sets module-level state that persists across requests. " +
      "Call only in client-side code (e.g., a 'use client' provider)."
    );
  }
  clientConfig = config;
}

/**
 * Get the configured auth mode. Returns 'bearer' if not configured.
 */
export function getAuthMode(): 'bearer' | 'cookie' | 'header' {
  return clientConfig?.authMode ?? 'bearer';
}

/** Get the configured base URL. Returns empty string if not configured. */
export function getBaseUrl(): string {
  return clientConfig?.baseUrl ?? '';
}

/** Whether auto-idempotency is enabled on the global client. */
export function isAutoIdempotency(): boolean {
  return clientConfig?.autoIdempotency ?? false;
}

// ============================================================================
// Auth Configuration
// ============================================================================

export interface AuthConfig {
  /**
   * Returns the current bearer/API token, or `null` if not authenticated.
   *
   * **MUST resolve synchronously.** The signature is `() => string | null`, never
   * `Promise<string | null>`. If your auth library exposes an async session getter
   * (Better Auth, NextAuth, Clerk, OAuth flows), refresh the token out-of-band
   * (timer, event listener, lazy 401 retry) and have `getToken` return the *cached*
   * value. Returning a Promise will be detected and warned about in dev — but the
   * underlying token will be silently treated as `null`, causing 401s.
   */
  getToken?: () => string | null;
  getOrgId?: () => string | null;
  /** Custom auth header name. Used when authMode is 'header'. Default: 'x-api-key' */
  headerName?: string;
}

let authConfig: AuthConfig | null = null;
let hasWarnedAsyncToken = false;

/**
 * Configure auth context for automatic token/orgId injection.
 * When configured, hooks auto-inject these values so you don't need to pass them manually.
 *
 * **SSR safety:** This sets module-level state. Call only in client-side code.
 *
 * **Token resolution is synchronous.** `getToken` must return `string | null`
 * synchronously — never a Promise. See {@link AuthConfig.getToken} for guidance
 * on bridging async auth libraries via cached values.
 *
 * @example
 * // Cookie auth (no token needed)
 * configureAuth({ getOrgId: () => currentOrg.id });
 *
 * // Bearer auth — token is cached synchronously by the auth library
 * configureAuth({
 *   getToken: () => session?.accessToken ?? null,
 *   getOrgId: () => currentOrg?.id ?? null,
 * });
 */
export function configureAuth(config: AuthConfig): void {
  if (typeof window === "undefined") {
    console.warn(
      "[arc-next] configureAuth() called on the server. " +
      "This sets module-level state that persists across requests. " +
      "Call only in client-side code (e.g., a 'use client' provider)."
    );
  }
  authConfig = config;
  hasWarnedAsyncToken = false;
}

function readToken(getToken: AuthConfig['getToken']): string | null {
  if (!getToken) return null;
  const result = getToken();
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    if (!hasWarnedAsyncToken) {
      hasWarnedAsyncToken = true;
      console.warn(
        "[arc-next] configureAuth({ getToken }) returned a Promise. " +
        "Tokens MUST resolve synchronously — async returns are dropped and " +
        "requests will be unauthenticated. Cache your token (localStorage, " +
        "memory, signal) and have getToken() return the cached value."
      );
    }
    return null;
  }
  return result ?? null;
}

/**
 * Get the current auth context. Returns nulls when not configured.
 */
export function getAuthContext(): { token: string | null; organizationId: string | null } {
  return {
    token: readToken(authConfig?.getToken),
    organizationId: authConfig?.getOrgId?.() ?? null,
  };
}

/** @internal — exposed for tests; resets the dev-warn dedup flag. */
export function _resetAuthWarnings(): void {
  hasWarnedAsyncToken = false;
}

// ============================================================================
// Shared URL builder for SSE / WebSocket / any auth-stamped GET stream
// ============================================================================

/** Protocol family the URL should target. `http` keeps `getBaseUrl()` as-is; `ws` rewrites `http(s)://` → `ws(s)://`. */
export type StreamUrlProtocol = 'http' | 'ws';

/**
 * Build an auth-aware URL using the global client + auth singletons.
 *
 * Single source of truth for {@link import('./sse.js').buildSseUrl} (HTTP) and
 * {@link import('./ws.js').buildWsUrl} (WebSocket). Both delegate here so the
 * auth-injection rule (org always, token only when `authMode !== 'cookie'`)
 * stays in one place and can't drift.
 *
 * @param path Path appended to the base URL (leading slash recommended).
 * @param params Caller-supplied params; merged with auth params. Caller wins on key collision.
 * @param protocol `'http'` (default) or `'ws'` — controls the protocol rewrite.
 */
export function buildStreamUrl(
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
  protocol: StreamUrlProtocol = 'http',
): string {
  const auth = getAuthContext();
  const qs = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }

  if (auth.organizationId && !qs.has('organizationId')) {
    qs.set('organizationId', auth.organizationId);
  }
  if (auth.token && getAuthMode() !== 'cookie' && !qs.has('token')) {
    qs.set('token', auth.token);
  }

  const origin =
    protocol === 'ws'
      ? getBaseUrl().replace(/^http(s?):\/\//, 'ws$1://')
      : getBaseUrl();
  const suffix = qs.toString();
  return `${origin}${path}${suffix ? `?${suffix}` : ''}`;
}

// ============================================================================
// Types
// ============================================================================

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Returned by `handleApiRequest` for PDF, image, and CSV responses. */
export interface BlobResponse {
  data: Blob;
  response: Response;
}

/** Returned by `handleApiRequest` for text/plain and text/html responses. */
export interface TextResponse {
  data: string;
  response: Response;
}

export interface ApiRequestOptions {
  body?: unknown;
  token?: string | null;
  organizationId?: string | null;
  revalidate?: number;
  headerOptions?: Record<string, string>;
  tags?: string[];
  cache?: RequestCache;
  signal?: AbortSignal;
  /** Explicit idempotency key for this request. Sent as `Idempotency-Key` header. */
  idempotencyKey?: string;
  /**
   * Send `x-arc-scope: platform` for this request only — overrides `ClientConfig.elevated`.
   * Pass `false` to suppress when client-level elevation is on.
   */
  elevated?: boolean;
}

// ============================================================================
// Multi-Client Support
// ============================================================================

export interface ArcClientConfig extends ClientConfig {
  toast?: ToastHandler;
  navigation?: UseRouterHook;
  /** Per-client token provider. Overrides global configureAuth().getToken. */
  getToken?: () => string | null;
  /** Per-client org ID provider. Overrides global configureAuth().getOrgId. */
  getOrgId?: () => string | null;
  /** Per-client custom auth header name. Used when authMode is 'header'. */
  headerName?: string;
}

export interface ArcClient {
  request: <T = unknown>(method: HttpMethod, endpoint: string, options?: ApiRequestOptions) => Promise<T>;
  config: ClientConfig;
  toast?: ToastHandler;
  navigation?: UseRouterHook;
  /** Per-client auth context. Falls back to global configureAuth() when not set. */
  auth?: { getToken?: () => string | null; getOrgId?: () => string | null; headerName?: string };
}

/**
 * Create an isolated API client for a specific backend.
 * Use this when your app needs to talk to multiple APIs with different auth.
 *
 * @example
 * // Bearer auth for main API
 * const mainClient = createClient({
 *   baseUrl: 'https://api.example.com',
 *   getToken: () => session.accessToken,
 * });
 *
 * // API key auth for analytics
 * const analyticsClient = createClient({
 *   baseUrl: 'https://analytics.example.com',
 *   authMode: 'header',
 *   getToken: () => env.ANALYTICS_KEY,
 *   headerName: 'x-api-key',
 * });
 */
export function createClient(config: ArcClientConfig): ArcClient {
  const { toast, navigation, getToken, getOrgId, headerName, ...clientCfg } = config;
  const clientAuth = (getToken || getOrgId || headerName)
    ? { getToken, getOrgId, headerName }
    : undefined;

  return {
    request: <T = unknown>(method: HttpMethod, endpoint: string, options?: ApiRequestOptions) => {
      // Auto-inject per-client auth if no explicit token/orgId in options
      if (clientAuth) {
        const resolved = { ...options };
        if (resolved.token === undefined && clientAuth.getToken) {
          resolved.token = readToken(clientAuth.getToken);
        }
        if (resolved.organizationId === undefined && clientAuth.getOrgId) {
          resolved.organizationId = clientAuth.getOrgId();
        }
        // For header auth mode: inject token as custom header directly
        if (clientCfg.authMode === 'header' && resolved.token) {
          const name = clientAuth.headerName ?? 'x-api-key';
          resolved.headerOptions = { [name]: resolved.token, ...(resolved.headerOptions ?? {}) };
          resolved.token = undefined; // prevent double-injection via Bearer
        }
        return executeRequest<T>(clientCfg, method, endpoint, resolved);
      }
      return executeRequest<T>(clientCfg, method, endpoint, options);
    },
    config: clientCfg,
    toast,
    navigation,
    auth: clientAuth,
  };
}

/**
 * Create an `ArcClient` wired to the global `configureClient` + `configureAuth` setup.
 *
 * Removes the boilerplate every consumer SDK writes by hand (auth-injection adapter
 * + `BaseApi` constructor with `client: { request: handleApiRequest, config: ... }`).
 * The returned client reads `getToken` / `getOrgId` lazily on each request, so token
 * rotation in the global auth layer takes effect immediately.
 *
 * Equivalent to `createClient(...)` with `getToken`/`getOrgId` pulled from
 * `getAuthContext()`. Pass `overrides` to customize specific fields without
 * rebuilding the whole transport.
 *
 * @example
 * // App init (somewhere in a "use client" provider)
 * configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL! });
 * configureAuth({
 *   getToken: () => session?.accessToken ?? null,
 *   getOrgId: () => currentOrg?.id ?? null,
 * });
 *
 * // SDK module
 * import { createAuthAwareClient } from '@classytic/arc-next/client';
 * import { createCrudApi } from '@classytic/arc-next/api';
 *
 * const client = createAuthAwareClient();
 * export const productsApi = createCrudApi('products', { client });
 *
 * // With per-call overrides
 * const analyticsClient = createAuthAwareClient({
 *   baseUrl: 'https://analytics.example.com',
 *   authMode: 'header',
 *   headerName: 'x-api-key',
 * });
 */
export function createAuthAwareClient(overrides: Partial<ArcClientConfig> = {}): ArcClient {
  return createClient({
    baseUrl: overrides.baseUrl ?? getBaseUrl(),
    authMode: overrides.authMode ?? getAuthMode(),
    autoIdempotency: overrides.autoIdempotency ?? isAutoIdempotency(),
    elevated: overrides.elevated ?? clientConfig?.elevated,
    ...overrides,
    getToken: overrides.getToken ?? (() => readToken(authConfig?.getToken)),
    getOrgId: overrides.getOrgId ?? (() => authConfig?.getOrgId?.() ?? null),
    headerName: overrides.headerName ?? authConfig?.headerName,
  });
}

/**
 * Get auth context for a specific client instance, falling back to global.
 */
export function getClientAuthContext(client?: ArcClient): { token: string | null; organizationId: string | null } {
  if (client?.auth) {
    return {
      token: readToken(client.auth.getToken) ?? readToken(authConfig?.getToken),
      organizationId: client.auth.getOrgId?.() ?? authConfig?.getOrgId?.() ?? null,
    };
  }
  return getAuthContext();
}

// ============================================================================
// Core Request Logic
// ============================================================================

/** Default retry predicate: retry on network failures and 5xx, never on Abort or 4xx. */
function defaultShouldRetry(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (isArcApiError(error)) {
    return error.status >= 500 && error.status < 600;
  }
  // Anything else (TypeError from fetch, DNS failure, connection reset) — retry.
  return error instanceof Error;
}

/** Compute the delay in ms before the Nth retry. */
function computeBackoff(retry: RetryConfig, attempt: number): number {
  const strategy = retry.backoff ?? 'exponential';
  if (typeof strategy === 'function') return Math.max(0, strategy(attempt));
  if (strategy === 'linear') return 300 * (attempt + 1);
  // exponential: 300, 600, 1200, ... capped at 10s
  return Math.min(300 * Math.pow(2, attempt), 10_000);
}

async function executeRequest<T = unknown>(
  config: ClientConfig,
  method: HttpMethod,
  endpoint: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const totalAttempts = Math.max(1, config.retry?.attempts ?? 1);
  const shouldRetry = (() => {
    const r = config.retry?.retryOn;
    if (typeof r === 'function') return r;
    if (Array.isArray(r)) return (e: unknown) => isArcApiError(e) && r.includes(e.status);
    return defaultShouldRetry;
  })();

  let lastError: unknown;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      return await executeAttempt<T>(config, method, endpoint, options, attempt);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === totalAttempts - 1;
      if (isLastAttempt || !shouldRetry(error)) throw error;
      // Honor abort across the backoff sleep — don't keep retrying after cancellation.
      const delay = computeBackoff(config.retry ?? {}, attempt);
      if (delay > 0) await sleepAbortable(delay, options.signal);
    }
  }
  throw lastError;
}

/** Sleep that resolves early if the signal aborts. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A single fetch attempt — used by executeRequest's retry loop. */
async function executeAttempt<T = unknown>(
  config: ClientConfig,
  method: HttpMethod,
  endpoint: string,
  options: ApiRequestOptions,
  attempt: number,
): Promise<T> {
  const {
    body,
    token,
    organizationId,
    revalidate,
    headerOptions,
    tags,
    cache,
    signal,
    idempotencyKey,
    elevated,
  } = options;

  const startTime = Date.now();

  try {
    let headers: Record<string, string> = {
      ...(organizationId ? { 'x-organization-id': organizationId } : {}),
      ...(config.defaultHeaders ?? {}),
    };

    if (config.internalApiKey) {
      headers['x-internal-api-key'] = config.internalApiKey;
    }

    if (token) {
      if (config.authMode === 'header') {
        const headerName = authConfig?.headerName ?? 'x-api-key';
        headers[headerName] = token;
      } else {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    if (config.apiVersion) {
      headers['Accept-Version'] = config.apiVersion;
    }

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    // Per-request `elevated` overrides client-level config (false suppresses, true forces).
    const elevatedActive = elevated ?? config.elevated ?? false;
    if (elevatedActive) {
      headers['x-arc-scope'] = 'platform';
    }

    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    if (headerOptions) {
      headers = { ...headers, ...headerOptions };
    }

    // Derive credentials: explicit config > authMode-based default
    const credentials = config.credentials
      ?? (config.authMode === 'cookie' ? 'include' : 'same-origin');

    let serializedBody: BodyInit | undefined = undefined;
    if (body !== undefined && body !== null) {
      serializedBody = body instanceof FormData ? body : JSON.stringify(body);
    }

    // beforeRequest interceptor: mutate headers/body before fetch. Runs per
    // attempt so retries pick up rotated tokens/trace IDs.
    if (config.beforeRequest) {
      const ctx = await config.beforeRequest({
        method,
        endpoint,
        headers,
        body: serializedBody,
        signal,
        attempt,
      });
      headers = ctx.headers;
      serializedBody = ctx.body;
    }

    const fetchOptions: RequestInit & { next?: { revalidate?: number; tags?: string[] } } = {
      method,
      headers,
      credentials,
      ...(signal ? { signal } : {}),
    };

    if (serializedBody !== undefined) {
      fetchOptions.body = serializedBody;
    }

    if (cache) {
      fetchOptions.cache = cache;
    }
    if (revalidate !== undefined) {
      fetchOptions.next = { ...fetchOptions.next, revalidate };
    }
    if (tags) {
      fetchOptions.next = { ...fetchOptions.next, tags };
    }

    const response = await fetch(`${config.baseUrl}${endpoint}`, fetchOptions);

    if (!response.ok) {
      let json: unknown = null;
      let errorMessage = response.statusText;

      try {
        // Clone so we can fallback to text() if json() fails
        json = await response.clone().json();
        // Arc's errorHandlerPlugin emits `{ error: <human msg> }` for errors
        // routed through it AND `{ error }` for controller-emitted IControllerResponse
        // failures. Some hosts / non-arc backends use `{ message }` instead.
        // Read both, preferring `error` (arc native), falling back to `message`.
        const j = json as { error?: unknown; message?: unknown } | null;
        errorMessage =
          (typeof j?.error === 'string' && j.error) ||
          (typeof j?.message === 'string' && j.message) ||
          response.statusText;
      } catch {
        // Non-JSON error (HTML from CDN, plain text, empty body) — capture as text
        try {
          const text = await response.text();
          if (text) {
            json = { rawBody: text };
            errorMessage = text.slice(0, 200) || response.statusText;
          }
        } catch {
          // Both json and text failed — use statusText
        }
      }

      throw new ArcApiError(errorMessage, {
        status: response.status,
        statusText: response.statusText,
        json,
        endpoint,
        method,
      });
    }

    const contentType = response.headers.get('Content-Type');

    let data: unknown;

    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else if (contentType?.includes('application/pdf') || contentType?.includes('image/')) {
      const blobData = await response.blob();
      data = { data: blobData, response };
    } else if (contentType?.includes('text/csv')) {
      const csvData = await response.blob();
      data = { data: csvData, response };
    } else if (contentType?.includes('text/')) {
      const text = await response.text();
      data = { data: text, response };
    } else {
      try {
        const blob = await response.clone().blob();
        data = { data: blob, response };
      } catch (blobError) {
        try {
          const text = await response.text();
          data = { data: text, response };
        } catch {
          throw new Error(
            `Failed to parse response body from ${method} ${endpoint}: ` +
            `blob error: ${blobError instanceof Error ? blobError.message : String(blobError)}`
          );
        }
      }
    }

    // afterResponse interceptor: log latency, transform body, etc. Runs only
    // on successful (2xx) responses; errors throw ArcApiError above.
    if (config.afterResponse) {
      const ctx = await config.afterResponse({
        method,
        endpoint,
        status: response.status,
        body: data as T,
        durationMs: Date.now() - startTime,
        response,
      });
      data = ctx.body;
    }

    return data as T;
  } catch (error) {
    // Preserve original error type (ArcApiError, AbortError, TypeError, etc.)
    if (error instanceof Error) throw error;
    throw new Error('An error occurred while fetching data.');
  }
}

// ============================================================================
// API Request Handler (Global — uses configureClient singleton)
// ============================================================================

/**
 * Universal API request handler.
 * Handles JSON, binary (PDF, images), CSV, and text responses.
 *
 * @example
 * const user = await handleApiRequest<User>('GET', '/users/me');
 * const response = await handleApiRequest<PaginatedResult<Product>>('GET', '/products?page=1');
 */
export async function handleApiRequest<T = unknown>(
  method: HttpMethod,
  endpoint: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  if (!clientConfig) {
    throw new Error(
      'arc-next: Client not configured. Call configureClient({ baseUrl }) before making API requests.'
    );
  }
  return executeRequest<T>(clientConfig, method, endpoint, options);
}

// ============================================================================
// Query String Utilities
// ============================================================================

/**
 * Creates query string from parameters.
 * Supports: arrays as field[in]=value1,value2, populateOptions with field selection.
 *
 * @example
 * createQueryString({ page: 1, limit: 10, status: 'active' })
 * // => 'page=1&limit=10&status=active'
 *
 * createQueryString({ roles: ['admin', 'user'] })
 * // => 'roles[in]=admin,user'
 *
 * createQueryString({
 *   populateOptions: [{ path: 'employeeId', select: 'name email' }]
 * })
 * // => 'populate[employeeId][select]=name,email'
 */
export function createQueryString<T extends Record<string, unknown>>(params: T = {} as T): string {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') return;

    if (key === 'populateOptions' && Array.isArray(value)) {
      (value as Array<{ path: string; select?: string; match?: Record<string, unknown> }>).forEach(
        (opt) => {
          if (opt.select) {
            const selectFields = opt.select.replace(/\s+/g, ',');
            searchParams.append(`populate[${opt.path}][select]`, selectFields);
          }
          if (opt.match) {
            searchParams.append(`populate[${opt.path}][match]`, JSON.stringify(opt.match));
          }
          if (!opt.select && !opt.match) {
            const existing = searchParams.get('populate');
            if (existing) {
              searchParams.set('populate', `${existing},${opt.path}`);
            } else {
              searchParams.append('populate', opt.path);
            }
          }
        }
      );
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > 1) {
        searchParams.append(`${key}[in]`, value.join(','));
      } else if (value.length === 1) {
        searchParams.append(key, String(value[0]));
      }
    } else if (value === null) {
      searchParams.append(key, 'null');
    } else if (typeof value === 'object') {
      // Nested operator object — `{ field: { gte: 18, lt: 65 } }` → `field[gte]=18&field[lt]=65`.
      // Matches `@classytic/repo-core/query-parser` bracket grammar so the
      // server-side `parseUrl()` reverses to the same Filter IR.
      // Array operator values flatten via comma-join (`{ in: [1,2,3] }` → `field[in]=1,2,3`),
      // matching mongokit/sqlitekit URL conventions.
      for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
        if (opValue === undefined || opValue === '') continue;
        const bracketKey = `${key}[${op}]`;
        if (Array.isArray(opValue)) {
          if (opValue.length > 0) searchParams.append(bracketKey, opValue.join(','));
        } else if (opValue === null) {
          searchParams.append(bracketKey, 'null');
        } else {
          searchParams.append(bracketKey, String(opValue));
        }
      }
    } else {
      searchParams.append(key, String(value));
    }
  });

  return searchParams.toString();
}
