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

import {
  ARC_ERROR_CODES,
  ARC_REASON_CODES,
  type ArcReasonCode,
  type ArcErrorCode as ArcWireCode,
  DUPLICATE_KEY_DETAIL_CODE,
  ERROR_CODES,
  type ErrorCode,
  type ErrorContract,
  type ErrorDetail,
} from "@classytic/repo-core/errors";
import { deleteHeader, headerValue, mergeHeaders, setHeader } from "./headers.js";

/**
 * Codes arc-next itself puts on a synthesized `ArcApiError` when a realtime
 * channel is refused before any arc response exists. Client-side only.
 */
export const CLIENT_ERROR_CODES = {
  SSE_UNAUTHORIZED: "arc.sse.unauthorized",
  WEBSOCKET_UNAUTHORIZED: "arc.websocket.unauthorized",
} as const;

/**
 * Every code a client may see on `error.code`. The server vocabulary is NOT
 * copied here — it is spread from `@classytic/repo-core/errors`, the contract
 * both arc and this SDK depend on (arc's test suite fails on an uncatalogued
 * code), so a code arc adds reaches the client with a repo-core bump.
 */
export const KNOWN_ARC_ERROR_CODES = [
  ...Object.values(ERROR_CODES),
  ...Object.values(ARC_ERROR_CODES),
  ...Object.values(ARC_REASON_CODES),
  DUPLICATE_KEY_DETAIL_CODE,
  ...Object.values(CLIENT_ERROR_CODES),
] as const;

/**
 * Known codes, kept open with `(string & {})` so a domain package's own codes
 * (`'order.cart.locked'`) and custom `errorMappers` codes still satisfy it.
 */
export type ArcErrorCode =
  | ErrorCode
  | ArcWireCode
  | ArcReasonCode
  | typeof DUPLICATE_KEY_DETAIL_CODE
  | (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES]
  | (string & {});

export interface ArcApiErrorOptions {
  status: number;
  statusText: string;
  json: unknown;
  endpoint: string;
  method: HttpMethod;
  /** Parsed `Retry-After` response header in ms (429/503 pacing), if present. */
  retryAfterMs?: number | null;
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
  /**
   * Server-directed retry pacing from the `Retry-After` response header
   * (seconds or HTTP-date form, normalized to ms). Populated on 429/503;
   * the SDK's retry loop honors it INSTEAD of computed backoff so clients
   * come back exactly when the server says capacity returns.
   */
  readonly retryAfterMs: number | null;

  constructor(message: string, options: ArcApiErrorOptions) {
    super(message);
    this.name = "ArcApiError";
    this.status = options.status;
    this.statusText = options.statusText;
    this.json = options.json;
    this.endpoint = options.endpoint;
    this.method = options.method;
    this.retryAfterMs = options.retryAfterMs ?? null;
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
    return j && typeof j.code === "string" ? (j.code as ArcErrorCode) : null;
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
    return Array.isArray(j?.details) ? (j.details as ErrorDetail[]) : null;
  }

  /**
   * Field-level validation errors as a `{ field: message }` map, read from repo-core's
   * `ErrorContract.details: ErrorDetail[]` (`{ path, code, message }`), the only shape arc emits.
   * The first message per path wins. `null` when the error carries no field details.
   */
  get fieldErrors(): Record<string, string> | null {
    const details = this.details;
    if (!details || details.length === 0) return null;
    const map: Record<string, string> = {};
    for (const d of details) {
      if (!d || typeof d !== "object") continue;
      const key = typeof d.path === "string" ? d.path : "";
      const msg = typeof d.message === "string" ? d.message : "Invalid value";
      if (key && !(key in map)) map[key] = msg;
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
  if (typeof error !== "object") return false;
  const e = error as { name?: unknown; code?: unknown };
  if (e.name === "AbortError") return true;
  if (e.code === "ERR_ABORTED") return true;
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

// ============================================================================
// Quota / plan-limit 429s (arc 2.22)
// ============================================================================

/** `details` payload of arc's `quota.exceeded` 429 (`requireQuota`). */
export interface QuotaDetails {
  /** The metered counter, e.g. `ai.tokens`, `export.runs`. */
  kind: string;
  used: number;
  limit: number;
  /** Billing period key, `YYYY-MM`. */
  period: string;
  /** ISO timestamp of the next period start — render "resets {date}". */
  resetsAt: string;
}

/**
 * Type guard for arc's quota denial (429 `quota.exceeded` from
 * `requireQuota`). Render a meter, not a generic failure:
 *
 * @example
 * if (isQuotaExceeded(err)) {
 *   const q = getQuotaDetails(err);
 *   toast(`${q.used.toLocaleString()} of ${q.limit.toLocaleString()} ${q.kind} used — resets ${new Date(q.resetsAt).toLocaleDateString()}`);
 * }
 *
 * NEVER auto-retry these — a monthly quota doesn't reset between retries
 * (the shared query client already refuses; see query-client.ts).
 */
export function isQuotaExceeded(error: unknown): error is ArcApiError {
  return isArcApiError(error) && error.status === 429 && error.code === "quota.exceeded";
}

/** Structured quota details from a `quota.exceeded` error (null when absent/malformed). */
export function getQuotaDetails(error: unknown): QuotaDetails | null {
  if (!isQuotaExceeded(error)) return null;
  // Quota details is an OBJECT — the `.details` getter is validation-shaped
  // (ErrorDetail[]) and returns null here; read the raw wire envelope.
  const j = error.json as { details?: Partial<QuotaDetails> } | null;
  const d = j?.details;
  if (!d || typeof d.kind !== "string" || typeof d.limit !== "number") return null;
  return d as QuotaDetails;
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
  return isArcErrorCode(error, ARC_REASON_CODES.ORG_CONTEXT_REQUIRED);
}

/** The tier/mode a `arc.tier_required` error asked for, plus the active one. */
export interface TierRequirement {
  /** Minimum tier/mode the feature needs (e.g. `"enterprise"`). */
  requiredMode: string;
  /** The deployment's current tier/mode (e.g. `"standard"`). */
  currentMode?: string;
}

/**
 * TIER/CAPABILITY gate predicate. True when the backend refused because the
 * deployment's tier (FLOW_MODE / feature tier) is below what the route needs —
 * a `arc.tier_required` error (arc-inventory's mode gate → arc's
 * `createDomainError`). This is the DISCRIMINABLE counterpart to a bare
 * `arc.forbidden` (a role/permission denial): switch on THIS to render an
 * "upgrade required / requires Enterprise" surface, and on `arc.forbidden` for
 * "access denied". The required tier is available via {@link getTierRequirement}.
 *
 * @example
 * if (isTierRequiredError(error)) {
 *   const { requiredMode } = getTierRequirement(error)!;
 *   showUpgradePanel(requiredMode);           // "requires Enterprise"
 * } else if (isArcErrorCode(error, "arc.forbidden")) {
 *   showAccessDenied();                        // role/branch problem
 * }
 */
export function isTierRequiredError(error: unknown): error is ArcApiError {
  return isArcErrorCode(error, ARC_ERROR_CODES.TIER_REQUIRED);
}

/**
 * Extract the tier requirement from a `arc.tier_required` error's structured
 * machine-readable context (`{ requiredMode, currentMode }`). Returns `null` for
 * any other error, so the FE never has to hardcode a route→tier map or
 * string-match a message.
 *
 * Reads `meta` (the canonical ErrorContract Record — where both arc gate paths
 * put it: the global error handler serializes `ArcError.meta`, and the
 * permission-slot applier emits the same `meta`). Falls back to `details` for
 * resilience against any backend still emitting the pre-2026-07 shape.
 */
export function getTierRequirement(error: unknown): TierRequirement | null {
  if (!isTierRequiredError(error)) return null;
  type TierBag = { requiredMode?: unknown; currentMode?: unknown };
  const j = (error.json ?? {}) as { meta?: TierBag; details?: TierBag };
  const bag = j.meta ?? j.details ?? {};
  const requiredMode = bag.requiredMode;
  if (typeof requiredMode !== "string") return null;
  return {
    requiredMode,
    ...(typeof bag.currentMode === "string" ? { currentMode: bag.currentMode } : {}),
  };
}

/**
 * Specific predicate for validation failures (Fastify AJV + Mongoose
 * ValidationError). When true, `error.fieldErrors` is populated with the
 * `{ field: message }` map. Matches arc's `arc.validation_error` and the
 * canonical `validation_error` from repo-core.
 */
export function isValidationError(error: unknown): error is ArcApiError {
  if (!isArcApiError(error)) return false;
  return error.code === ARC_ERROR_CODES.VALIDATION_ERROR || error.code === ERROR_CODES.VALIDATION;
}

/**
 * The write was based on a stale read: the record changed since it was loaded
 * (`412 arc.precondition_failed` — optimistic concurrency, see `versionField`).
 * The hooks already refetched it; tell the user, and offer "save anyway" as
 * `update({ id, data, version: null })`.
 */
export function isPreconditionFailed(error: unknown): error is ArcApiError {
  if (!isArcApiError(error)) return false;
  return (
    error.code === ARC_ERROR_CODES.PRECONDITION_FAILED ||
    error.code === ERROR_CODES.PRECONDITION_FAILED
  );
}

/**
 * Specific predicate for unique-constraint violations. Arc's errorHandler
 * classifies these uniformly across MongoDB E11000, Postgres 23505,
 * Prisma P2002 → `arc.conflict` (with `details[].code === 'duplicate_key'`).
 */
export function isDuplicateKeyError(error: unknown): error is ArcApiError {
  if (!isArcApiError(error)) return false;
  if (
    error.code === ARC_ERROR_CODES.CONFLICT ||
    error.code === DUPLICATE_KEY_DETAIL_CODE ||
    error.code === ERROR_CODES.CONFLICT
  ) {
    // arc.conflict can also represent non-duplicate conflicts (lease, version) —
    // narrow further by checking details[].code === 'duplicate_key' when present.
    if (error.code === ARC_ERROR_CODES.CONFLICT) {
      return error.details?.some((d) => d.code === DUPLICATE_KEY_DETAIL_CODE) ?? false;
    }
    return true;
  }
  return false;
}

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Application-Layer Encryption (ALE) config — the client half of
 * `@classytic/arc/encryption`. Lets the SDK decrypt JWE response bodies and
 * (optionally) encrypt JSON request bodies, transparently to callers and to
 * the repo-core wire contracts (decryption happens BEFORE error / pagination
 * parsing, so the parsed shape is identical to an unencrypted response).
 *
 * `decrypt` / `encrypt` are host-supplied so the core SDK pulls no crypto
 * dependency. Use `createJoseEncryption()` from `@classytic/arc-next/encryption`
 * for a ready-made JWE implementation, or wire your own (KMS proxy, WebCrypto).
 */
export interface ClientEncryptionConfig {
  /**
   * Decrypt an encrypted response body (JWE compact string) → plaintext JSON
   * string. Required — this is what makes encrypted responses readable.
   */
  decrypt: (payload: string) => string | Promise<string>;
  /**
   * Encrypt a serialized JSON request body string → JWE compact string.
   * Required only when `encryptRequests` is true.
   */
  encrypt?: (json: string) => string | Promise<string>;
  /**
   * Encrypt outbound JSON request bodies. Default `false` — responses are
   * still decrypted regardless (the common case: server encrypts responses,
   * client posts plaintext over TLS).
   */
  encryptRequests?: boolean;
  /** Response media type signalling an encrypted body. Default `'application/jose'`. */
  responseContentType?: string;
  /** Content-Type set on encrypted outbound requests. Default `'application/jose'`. */
  requestContentType?: string;
}

export interface ClientConfig {
  baseUrl: string;
  /**
   * Route prefix every API is mounted under, when it is not `/api/v1`.
   *
   * `BaseApi` defaults each instance to `/api/v1` and takes a per-instance
   * `basePath` override. That covers an app's OWN api classes and nothing else:
   * a package that constructs its own API internally — erp-shell's permission
   * `platformApi`, an SDK preset — has no seam to be told, so on a host mounted
   * anywhere but `/api/v1` it silently requests a URL that does not exist and
   * the feature reads as "no data" rather than as a misconfiguration.
   *
   * Setting it here makes the mount point a property of the DEPLOYMENT, stated
   * once, which is what it actually is. A per-instance `basePath` still wins,
   * so nothing that already passes one changes.
   *
   * @example configureClient({ baseUrl, basePath: '/api' }) // host mounts at /api
   */
  basePath?: string;
  internalApiKey?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Auth mode for the API client.
   * - 'bearer' (default): Requires a token for authenticated requests. Queries are disabled until a token is provided.
   * - 'cookie': Auth is handled via HTTP-only cookies (e.g. Better Auth). Queries are always enabled — no token needed.
   */
  authMode?: "bearer" | "cookie" | "header";
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
   * Default request cache mode applied to every request that expresses no
   * caching intent of its own (no per-call `cache`, `revalidate`, or `next`) —
   * the client-level analog of `BaseApiConfig.cache`, same precedence rule.
   * Unset = the runtime's fetch default.
   */
  cache?: RequestCache;
  /**
   * The transport every request goes through. Unset = the runtime's `fetch`.
   * Supply a `(Request-like) => Response` handler to serve the API in-process
   * (an offline device store, a test double): envelope parsing, `ArcApiError`,
   * auth, retry and interceptors all still run, so a local answer and a server
   * answer reach callers identically. Uploads (XHR), SSE and WebSockets do not use it.
   */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /**
   * The `EventSource` implementation SSE uses (`subscribeToEvents`,
   * `useEventStream`). Unset = `globalThis.EventSource`.
   *
   * Inject one where the runtime has none (React Native) or where credentials
   * should travel as headers — e.g. `react-native-sse`. The contract is
   * {@link EventSourceConstructor}: `new (url, { withCredentials, headers? })`,
   * events delivered through `addEventListener` (`open`, `message`, `error` and
   * named frames), and `close()`.
   */
  eventSource?: EventSourceConstructor;
  /**
   * Where SSE credentials travel.
   *
   * - `'query'` (default): `?token=…&organizationId=…` in the stream URL. The
   *   WHATWG `EventSource` cannot send headers, so in a browser this is the only
   *   option for bearer auth (cookie auth sends no token at all).
   * - `'header'`: the same headers a fetch carries ({@link arcAuthHeaders}),
   *   passed as the `headers` init of the injected {@link ClientConfig.eventSource}.
   *   The URL then carries no credentials, so the token never reaches access
   *   logs, proxies or crash reports. With no `eventSource` injected, the SDK
   *   loads its built-in fetch-based `FetchEventSource`
   *   (`@classytic/arc-next/sse-fetch`, lazily — native-EventSource apps never
   *   ship it) wherever `fetch` can stream (browsers, Node). On React Native,
   *   whose `fetch` cannot stream, inject `react-native-sse`; without it the
   *   SDK refuses to connect rather than silently falling back to the URL.
   *
   * WebSocket URLs are unaffected.
   */
  streamAuth?: "query" | "header";
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
   * Per-attempt request timeout in ms. When set (> 0), every fetch attempt is
   * aborted after this long and fails with a retryable `TimeoutError` —
   * WITHOUT it, a hung connection pends forever unless the caller wires an
   * `AbortSignal` themselves. Composed with the caller's signal (whichever
   * fires first wins); each retry attempt gets a fresh timeout window.
   * Default: disabled (0) — deliberate, to avoid killing legitimately slow
   * report/export endpoints; set it explicitly (10–30s is typical).
   * Per-request override: `ApiRequestOptions.timeoutMs` (0 disables).
   */
  timeoutMs?: number;
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
  /**
   * Application-Layer Encryption. When set, the SDK decrypts `application/jose`
   * response bodies (and, with `encryptRequests`, encrypts JSON request bodies)
   * — the client counterpart to `@classytic/arc/encryption` on the backend.
   * Transparent to repo-core wire contracts. See {@link ClientEncryptionConfig}.
   */
  encryption?: ClientEncryptionConfig;
}

/** Init accepted by an {@link EventSourceConstructor}. `headers` is honoured only by implementations that support it. */
export interface EventSourceInitLike {
  withCredentials?: boolean;
  headers?: Record<string, string>;
  /**
   * Called for every chunk the stream receives after `open`, heartbeat comments included, so a
   * caller can tell a quiet line from a dead one. Honoured by `FetchEventSource`
   * (`@classytic/arc-next/sse-fetch`); the native `EventSource` ignores it (it never exposes
   * comments). An init callback rather than an event, so it cannot clash with a server event name.
   */
  onActivity?: () => void;
}

/** The fields the SDK reads from an SSE event (`MessageEvent` and react-native-sse events both fit). */
export interface EventSourceEventLike {
  type?: string;
  data?: string | null;
  lastEventId?: string | null;
  /**
   * `error` events only, and only from implementations that know it (the
   * built-in `FetchEventSource` from `@classytic/arc-next/sse-fetch`): the
   * stream response's HTTP status, `0` when no response arrived. When present
   * the SDK classifies the failure from it (401/403 → `onAuthError`, 429 →
   * `Retry-After`) instead of sending a probe request.
   */
  status?: number;
  /** `error` events only: the response headers, when a response arrived. */
  headers?: { get(name: string): string | null };
}

/**
 * The part of an `EventSource` the SDK uses. Satisfied by the WHATWG
 * `EventSource` and by `react-native-sse`. Built-in `open` / `message` /
 * `error` events are consumed through `addEventListener`, never `on*`
 * properties, because header-capable implementations only offer the former.
 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: EventSourceEventLike) => void): void;
  close(): void;
}

export type EventSourceConstructor = new (
  url: string,
  init?: EventSourceInitLike,
) => EventSourceLike;

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
  backoff?: "exponential" | "linear" | ((attempt: number) => number);
  /**
   * Whitelist of statuses to retry on, OR a predicate. Defaults to a function
   * that returns true for: any non-`ArcApiError` (network failure / fetch
   * TypeError) AND `ArcApiError.status >= 500 && < 600`. Never retries on
   * AbortError or 4xx.
   */
  retryOn?: number[] | ((error: unknown) => boolean);
  /**
   * Backoff jitter. `'full'` randomizes each delay uniformly in
   * `[0, computed]` (AWS full-jitter) so a fleet of clients recovering from
   * the same outage doesn't retry in lockstep and re-stampede the backend.
   * Default `'none'` keeps the historical deterministic delays.
   */
  jitter?: "none" | "full";
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
 * The `ClientConfig` keys that can carry PER-REQUEST state, and so are the only
 * ones worth warning about on the server.
 *
 * Everything else in `ClientConfig` is a constant of the deployment — `baseUrl`,
 * `basePath`, `authMode`, `timeoutMs` and friends are read out of the environment
 * and are identical for every request, so a module-level singleton holding them
 * has nothing to leak. These three do not have that property: the two
 * interceptors are closures, which is exactly where a caller reaches for the
 * request they happen to be serving, and `defaultHeaders` is where a token gets
 * pinned by hand.
 *
 * The warning used to fire on ANY server-side call, which made it noise in the
 * one case a Next.js app genuinely has to configure on the server: an SSR
 * fetcher needs `baseUrl` to build an absolute URL, and there is no other seam
 * that supplies it. An app doing the leak-safe thing correctly got told it was
 * wrong on every cold start, so the warning trained people to ignore it — and a
 * warning nobody reads does not catch the real mistake either.
 */
const REQUEST_VARYING_CONFIG_KEYS = [
  "beforeRequest",
  "afterResponse",
  "defaultHeaders",
] as const satisfies readonly (keyof ClientConfig)[];

/**
 * Configure the API client. Call once at app init before any API requests.
 *
 * **SSR safety:** This sets module-level state. In Next.js, call this from
 * client-side code (e.g. a `"use client"` provider or `useEffect`).
 *
 * Configuring only the deployment's CONSTANTS on the server is supported and
 * silent — an SSR fetcher needs `baseUrl`/`basePath` to build an absolute URL,
 * and those are the same for every request. What must not cross to the server is
 * anything derived from the request being served: {@link ClientConfig.beforeRequest},
 * {@link ClientConfig.afterResponse} and {@link ClientConfig.defaultHeaders} are
 * warned about because they are where that happens. Per-request AUTH belongs to
 * {@link configureAuth}, which stays client-only in full.
 *
 * @example
 * // Bearer token auth (default)
 * configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL! });
 *
 * // Cookie-based auth (e.g. Better Auth)
 * configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL!, authMode: 'cookie' });
 *
 * // Server module graph — constants only, no warning
 * if (typeof window === "undefined") {
 *   configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL!, basePath: "/api" });
 * }
 */
export function configureClient(config: ClientConfig): void {
  if (typeof window === "undefined") {
    const risky = REQUEST_VARYING_CONFIG_KEYS.filter((key) => config[key] !== undefined);
    if (risky.length > 0) {
      console.warn(
        `[arc-next] configureClient() called on the server with ${risky.join(", ")}. ` +
          "These can capture per-request state into a module-level singleton that " +
          "persists across requests, so one request's values can serve another's. " +
          "Set them from client-side code (e.g. a 'use client' provider); " +
          "deployment constants such as baseUrl/basePath are safe to set here.",
      );
    }
  }
  clientConfig = config;
}

/**
 * Get the configured auth mode. Returns 'bearer' if not configured.
 */
export function getAuthMode(): "bearer" | "cookie" | "header" {
  return clientConfig?.authMode ?? "bearer";
}

/** Get the configured base URL. Returns empty string if not configured. */
export function getBaseUrl(): string {
  return clientConfig?.baseUrl ?? "";
}

/**
 * The deployment's route prefix, or `null` when it has not declared one.
 *
 * `null` rather than the `/api/v1` default on purpose: the default belongs to
 * `BaseApi`, which is the one place that should own it. Returning it here would
 * put the same literal in two files, and the next person to change one would
 * have no way to know about the other.
 */
export function getBasePath(): string | null {
  return clientConfig?.basePath ?? null;
}

/** @internal — SSE transport settings for sse.ts ({@link ClientConfig.eventSource} / `streamAuth`). */
export function _getStreamConfig(): {
  eventSource: EventSourceConstructor | undefined;
  streamAuth: "query" | "header";
} {
  return {
    eventSource: clientConfig?.eventSource,
    streamAuth: clientConfig?.streamAuth ?? "query",
  };
}

/** Whether auto-idempotency is enabled on the global client. */
export function isAutoIdempotency(): boolean {
  return clientConfig?.autoIdempotency ?? false;
}

/**
 * RFC 4122 v4 UUID. Internal — the one place the SDK mints ids.
 *
 * `crypto.randomUUID` is missing on React Native (Hermes) and on non-secure
 * browser origins, while `crypto.getRandomValues` is present there (natively or
 * via `react-native-get-random-values`). A runtime with neither has no
 * cryptographic randomness, and an idempotency key built from `Math.random`
 * could collide, so that case throws rather than degrade silently.
 */
export function _uuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  if (typeof c?.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = ((b[6] as number) & 0x0f) | 0x40; // version 4
    b[8] = ((b[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  throw new Error(
    "[arc-next] No cryptographic random source: globalThis.crypto.getRandomValues is unavailable. " +
      "On React Native install and import 'react-native-get-random-values' before arc-next.",
  );
}

/**
 * Whether the globally-configured client carries enough auth to satisfy a
 * protected endpoint without a per-request token. True when any of
 * `internalApiKey`, `defaultHeaders`, or `authMode: 'cookie'` is configured.
 *
 * Read by `createCrudHooks` to decide whether queries should be enabled when
 * `getToken()` returns null — without this, an app that authenticates via a
 * global `internalApiKey` or static headers would see every query stuck in
 * a permanently-disabled state, looking like a clean empty success.
 */
export function hasGlobalStaticAuth(): boolean {
  if (!clientConfig) return false;
  if (clientConfig.authMode === "cookie") return true;
  if (clientConfig.internalApiKey) return true;
  if (clientConfig.defaultHeaders && Object.keys(clientConfig.defaultHeaders).length > 0)
    return true;
  return false;
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
   * (timer, event listener, lazy 401 retry via {@link onAuthError}) and have
   * `getToken` return the *cached* value. Returning a Promise will be detected and
   * logged as an Error in dev — and the underlying token will be silently treated
   * as `null`, causing 401s.
   */
  getToken?: () => string | null;
  getOrgId?: () => string | null;
  /** Custom auth header name. Used when authMode is 'header'. Default: 'x-api-key' */
  headerName?: string;
  /**
   * Lazy 401-recovery hook. Invoked once per request when the backend returns
   * 401 (or 403, if {@link retryOn403} is true) AND a handler is configured.
   *
   * - Return `'retry'` to re-issue the request once with a fresh token.
   * - Return `'skip'` to surface the original error to the caller (e.g. after
   *   a refresh attempt that found no valid session — let the consumer route
   *   to sign-in).
   * - Throw to short-circuit; the thrown error propagates to the caller.
   *
   * **Concurrent dedup.** When N requests hit 401 at the same time, the handler
   * fires ONCE — every concurrent caller awaits the same refresh promise and
   * retries with the token it produced. Avoids stampeding the refresh endpoint.
   *
   * **Token propagation.** Inside the handler, call `ctx.setToken(newToken)` to
   * inject the refreshed token for the retry. If you've already updated your
   * global auth state out-of-band (e.g. updated a signal or the auth library's
   * cache), you can omit `setToken` — arc-next re-reads via `getToken()` on
   * the retry attempt.
   *
   * @see {@link createAuthRefreshHandler} for the canonical wiring with any
   * `refresh()` function (Better Auth, NextAuth, custom OAuth flows).
   */
  onAuthError?: AuthErrorHandler;
  /**
   * Treat 403 as auth-recoverable too. Default: `false` (only 401 triggers
   * the handler). Enable for backends that emit 403 on expired sessions
   * instead of 401.
   */
  retryOn403?: boolean;
  /**
   * Opt-in hook for 403s that mean the session's STATE changed rather than
   * "you may not do this": a second factor became required after a deploy,
   * a password must be rotated, the org membership was swapped. Without it a
   * tab left open shows that 403 as a plain error until reload.
   *
   * Only 403s whose parsed error passes `match` reach `handler` (same
   * contract as {@link onAuthError}: `'retry'` after the user completes the
   * step, `'skip'` to surface the 403, e.g. after routing to a verify page).
   * Concurrent matches share one handler call. A matched 403 goes here even
   * when {@link retryOn403} is on; unmatched 403s keep the existing path.
   * Retries are capped by {@link maxAuthRetries}, counted apart from 401s,
   * so a refresh followed by a step-up on the same request both run.
   * Applies to the JSON client (queries, mutations, actions, routes), not to
   * uploads or streams.
   *
   * @example
   * ```ts
   * configureAuth({
   *   getToken,
   *   onSessionChange: {
   *     match: (e) => e.code === "auth.second_factor_required",
   *     handler: async () => (await openStepUpDialog()) ? "retry" : "skip",
   *   },
   * });
   * ```
   */
  onSessionChange?: SessionChangeHook;
  /**
   * Cap on auth-recovery retries per individual request. Default: `1`.
   * Bumping above 1 risks pathological loops if the refresh itself
   * triggers 401s — only do it if you have hard guarantees on `getToken()`.
   */
  maxAuthRetries?: number;
}

/** {@link AuthConfig.onSessionChange}: which 403s mean the session changed, and what to do. */
export interface SessionChangeHook {
  /** True when this 403 means the session changed. Usually a check on `error.code`. Keep it pure. */
  match: (error: ArcApiError) => boolean;
  /** Runs once per burst of matched 403s. `ctx.error.status` is 403. */
  handler: AuthErrorHandler;
}

/**
 * Context passed to {@link AuthConfig.onAuthError} when a request 401s.
 *
 * Inspect `error` to decide whether to refresh. Call `setToken(t)` to inject
 * the refreshed token for the retry — arc-next prefers this value over
 * re-reading `getToken()`, so it works even when your auth library hasn't
 * yet propagated the new session.
 */
export interface AuthErrorContext {
  /** The 401/403 thrown by the failing request. Carries `status`, `code`, `json`. */
  error: ArcApiError;
  /** The request that failed — useful for path-based heuristics. */
  request: { method: HttpMethod; endpoint: string };
  /**
   * 1-indexed auth-recovery attempt. First 401 in a request lifecycle is 1.
   * Reaches {@link AuthConfig.maxAuthRetries} → handler is NOT called again
   * and the 401 surfaces.
   */
  attempt: number;
  /**
   * Inject the refreshed token for the retry. Pass `null` to retry
   * unauthenticated. Optional — omit if `getToken()` already returns the
   * fresh value.
   */
  setToken: (token: string | null) => void;
}

/** {@link AuthConfig.onAuthError} signature. */
export type AuthErrorHandler = (ctx: AuthErrorContext) => Promise<"retry" | "skip">;

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
        "Call only in client-side code (e.g., a 'use client' provider).",
    );
  }
  authConfig = config;
  hasWarnedAsyncToken = false;
}

function readToken(getToken: AuthConfig["getToken"]): string | null {
  if (!getToken) return null;
  const result = getToken();
  if (result && typeof (result as { then?: unknown }).then === "function") {
    if (!hasWarnedAsyncToken) {
      hasWarnedAsyncToken = true;
      // Console.error (not warn) because the failure is silent in the UI:
      // queries report `isLoading: false, item: null` — indistinguishable
      // from a clean empty state. Dev tools must surface this loudly so the
      // mistake isn't shipped to production. The accompanying Error gives the
      // stack trace pointing at the caller's `configureAuth` site.
      console.error(
        new Error(
          "[arc-next] configureAuth({ getToken }) returned a Promise. " +
            "Tokens MUST resolve synchronously — async returns are dropped and " +
            "every authenticated query will be silently disabled (no GET fires, " +
            "isLoading:false, item:null). Fix: cache the token outside getToken " +
            "(localStorage, memory, signal, useState) and have getToken() return " +
            "the cached value. See README → 'Authentication'.",
        ),
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
// 401 → refresh → retry interceptor
// ============================================================================

/**
 * Outcome of a single auth-recovery cycle. `overrideToken` is the value the
 * handler injected via `setToken`; `undefined` means the handler didn't call
 * `setToken` and we should re-read via `getToken()`. `null` is meaningful —
 * "retry without a token" (rare but valid for public endpoints).
 */
interface AuthRecoveryResult {
  decision: "retry" | "skip";
  overrideToken: string | null | undefined;
}

/**
 * Shared in-flight recovery per handler: concurrent 401s collapse onto one
 * `onAuthError` call, matched 403s onto one `onSessionChange` call. Cleared
 * in `.finally` so the NEXT failure (after settlement) starts a fresh cycle.
 */
const pendingAuthRecovery = new Map<AuthErrorHandler, Promise<AuthRecoveryResult>>();

/** @internal — exposed for tests; clears the dedup so they don't bleed. */
export function _resetAuthRecovery(): void {
  pendingAuthRecovery.clear();
}

/**
 * @internal
 * Cross-transport access to the configured auth-recovery handler.
 * Upload (XHR) and WebSocket / SSE plumbing share the same dedup as the
 * fetch path — they read the handler here and call {@link _runAuthRecovery}
 * when they detect a transport-specific auth failure (XHR 401, WS close
 * code 1008/4401, SSE pre-flight probe 401).
 */
export function _getAuthErrorHandler(): {
  handler: AuthErrorHandler | undefined;
  retryOn403: boolean;
  maxAuthRetries: number;
} {
  return {
    handler: authConfig?.onAuthError,
    retryOn403: authConfig?.retryOn403 ?? false,
    maxAuthRetries: Math.max(0, authConfig?.maxAuthRetries ?? 1),
  };
}

/**
 * @internal
 * Drive the shared recovery cycle from a non-fetch transport. Same dedup
 * as the fetch path — concurrent callers (XHR upload + WebSocket reconnect
 * + SSE probe firing at once) collapse to one refresh.
 */
export function _runAuthRecovery(
  handler: AuthErrorHandler,
  ctx: Omit<AuthErrorContext, "setToken">,
): Promise<AuthRecoveryResult> {
  return runAuthRecovery(handler, ctx);
}

/**
 * @internal
 * Resolve the next-attempt token. Mirrors the priority in `executeRequest`'s
 * auth loop — `setToken` override beats re-reading `getToken()`. Exported so
 * transports outside the fetch path apply the same precedence.
 */
export function _resolveRefreshedToken(overrideToken: string | null | undefined): string | null {
  if (overrideToken !== undefined) return overrideToken;
  return readToken(authConfig?.getToken);
}

/**
 * @internal
 * True for any error a transport should run through `onAuthError`. Matches
 * the fetch path's predicate so XHR / WS / SSE failures classify the same
 * way (401, or 403 when `retryOn403`).
 */
export function _isAuthRecoverable(error: unknown, retryOn403: boolean): boolean {
  return isAuthRecoverable(error, retryOn403);
}

/** True for status codes that should trigger {@link AuthConfig.onAuthError}. */
function isAuthRecoverable(error: unknown, retryOn403: boolean): boolean {
  if (!isArcApiError(error)) return false;
  if (error.status === 401) return true;
  if (retryOn403 && error.status === 403) return true;
  return false;
}

/**
 * Run the recovery handler with concurrent-request dedup. Every concurrent
 * 401 awaits the same promise and gets the same decision + override token.
 * Cleared on settlement so a later (post-settlement) 401 starts a new cycle.
 */
function runAuthRecovery(
  handler: AuthErrorHandler,
  ctx: Omit<AuthErrorContext, "setToken">,
): Promise<AuthRecoveryResult> {
  const pending = pendingAuthRecovery.get(handler);
  if (pending) return pending;

  const promise = (async (): Promise<AuthRecoveryResult> => {
    let overrideToken: string | null | undefined;
    const setToken = (token: string | null): void => {
      overrideToken = token;
    };
    const decision = await handler({ ...ctx, setToken });
    return { decision, overrideToken };
  })();

  const shared = promise.finally(() => {
    // Clear AFTER settlement so concurrent awaiters all see the same value,
    // while a later 401 (e.g. after a successful refresh expires again) starts
    // a fresh recovery cycle instead of replaying a stale decision.
    pendingAuthRecovery.delete(handler);
  });
  pendingAuthRecovery.set(handler, shared);
  return shared;
}

/**
 * Build an {@link AuthErrorHandler} from any `refresh()` function that
 * returns the new token (or `null` if the session is truly expired).
 *
 * Catches refresh errors and surfaces them as `'skip'` by default so the
 * original 401 reaches the consumer instead of a misleading "refresh failed"
 * trace — consumers expect to handle "session expired" once, not twice. Pass
 * `onRefreshError: 'throw'` to opt in to propagation.
 *
 * @example Better Auth (or any session-based lib)
 * ```ts
 * import { configureAuth, createAuthRefreshHandler } from '@classytic/arc-next/client';
 * import { authClient } from '@/lib/auth-client';
 *
 * configureAuth({
 *   getToken: () => authClient.getSession().data?.session.token ?? null,
 *   onAuthError: createAuthRefreshHandler({
 *     refresh: async () => {
 *       const { data } = await authClient.getSession({ disableCookieCache: true });
 *       return data?.session.token ?? null;
 *     },
 *   }),
 * });
 * ```
 *
 * @example Custom OAuth refresh
 * ```ts
 * configureAuth({
 *   getToken: () => tokenStore.getAccessToken(),
 *   onAuthError: createAuthRefreshHandler({
 *     refresh: () => oauthClient.refresh(tokenStore.getRefreshToken()),
 *   }),
 * });
 * ```
 */
export function createAuthRefreshHandler(opts: {
  refresh: () => Promise<string | null>;
  /**
   * Behavior when the `refresh()` call itself throws. Default: `'skip'`
   * (the original 401 surfaces; consumers handle "session expired" once).
   */
  onRefreshError?: "skip" | "throw";
}): AuthErrorHandler {
  return async ({ setToken }) => {
    try {
      const token = await opts.refresh();
      if (token == null) return "skip";
      setToken(token);
      return "retry";
    } catch (err) {
      if (opts.onRefreshError === "throw") throw err;
      return "skip";
    }
  };
}

// ============================================================================
// Shared URL builder for SSE / WebSocket / any auth-stamped GET stream
// ============================================================================

/** Protocol family the URL should target. `http` keeps `getBaseUrl()` as-is; `ws` rewrites `http(s)://` → `ws(s)://`. */
export type StreamUrlProtocol = "http" | "ws";

/**
 * Build an auth-aware URL using the global client + auth singletons.
 *
 * Single source of truth for {@link import('../realtime/sse.js').buildSseUrl} (HTTP) and
 * {@link import('../realtime/ws.js').buildWsUrl} (WebSocket). Both delegate here so the
 * auth-injection rule (org always, token only when `authMode !== 'cookie'`)
 * stays in one place and can't drift. With `streamAuth: 'header'` an `http`
 * URL carries neither (they travel as headers instead).
 *
 * @param path Path appended to the base URL (leading slash recommended).
 * @param params Caller-supplied params; merged with auth params. Caller wins on key collision.
 * @param protocol `'http'` (default) or `'ws'` — controls the protocol rewrite.
 */
export function buildStreamUrl(
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
  protocol: StreamUrlProtocol = "http",
): string {
  const auth = getAuthContext();
  const qs = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }

  // `streamAuth: 'header'` moves SSE credentials to headers (see ClientConfig),
  // so the URL must not repeat them.
  const headerAuth = protocol === "http" && clientConfig?.streamAuth === "header";
  if (!headerAuth && auth.organizationId && !qs.has("organizationId")) {
    qs.set("organizationId", auth.organizationId);
  }
  if (!headerAuth && auth.token && getAuthMode() !== "cookie" && !qs.has("token")) {
    qs.set("token", auth.token);
  }

  const origin =
    protocol === "ws" ? getBaseUrl().replace(/^http(s?):\/\//, "ws$1://") : getBaseUrl();
  const suffix = qs.toString();
  return `${origin}${path}${suffix ? `?${suffix}` : ""}`;
}

// ============================================================================
// Types
// ============================================================================

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

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

/**
 * Next.js App Router `fetch` cache directives, forwarded verbatim as `fetch(url, { next })`:
 * the one way to put an arc read in Next's data cache. Inert off-Next.
 *
 * @see https://nextjs.org/docs/app/api-reference/functions/fetch
 */
export interface NextFetchOptions {
  /**
   * Seconds before the cached response is considered stale and revalidated.
   * `false` caches indefinitely (Next's `force-cache` semantics); `0` opts
   * out of caching. Omit to inherit the route's default.
   */
  revalidate?: number | false;
  /** Cache tags for on-demand `revalidateTag(tag)` invalidation. */
  tags?: string[];
}

export interface ApiRequestOptions {
  body?: unknown;
  /**
   * Bearer token for this request. THREE-STATE contract:
   * - **omitted / `undefined`** → inherit the global `configureAuth()` context
   *   (auto-injected by `handleApiRequest`, per-client instances, and hooks)
   * - **explicit `null`** → deliberately unauthenticated (public endpoint)
   * - **string** → use exactly this token (wins over the global context)
   */
  token?: string | null;
  /**
   * Tenant/org id sent as `x-organization-id`. Same three-state contract as
   * `token`: `undefined` = inherit `configureAuth().getOrgId`, `null` = send
   * no org header (platform-scope calls), string = exactly this org.
   */
  organizationId?: string | null;
  headerOptions?: Record<string, string>;
  /** Next App Router fetch cache config (`{ revalidate, tags }`), passed to `fetch(url, { next })`. */
  next?: NextFetchOptions;
  cache?: RequestCache;
  signal?: AbortSignal;
  /** Per-request timeout in ms — overrides `ClientConfig.timeoutMs`. `0` disables for this request. */
  timeoutMs?: number;
  /** Explicit idempotency key for this request. Sent as `Idempotency-Key` header. */
  idempotencyKey?: string;
  /**
   * How to read a 2xx body. Omitted: by `Content-Type` (JSON parsed; `text/*`, PDF, images and
   * other binaries as `{ data, response }`). `'text'` answers the body string, `'blob'` the
   * `Blob`, `'json'` the parsed body (`undefined` when empty), whatever the content type.
   * An encrypted response is decrypted first, as before. Errors are unaffected.
   */
  responseType?: "json" | "text" | "blob";
  /**
   * Send `x-arc-scope: platform` for this request only — overrides `ClientConfig.elevated`.
   * Pass `false` to suppress when client-level elevation is on.
   */
  elevated?: boolean;
  /**
   * `"omit"` sends this request ANONYMOUSLY, whoever is signed in: no `Authorization`, no
   * `x-organization-id`, no API-key / internal-key / cookie header, `credentials: "omit"`, and no
   * auth-refresh retry. arc's http-cache serves any credentialed request `private, no-store`, so
   * this is what lets a signed-in user's public read (a catalogue) be shared at the CDN.
   * Use it only for endpoints that answer the same for everyone. Default: `"inherit"`.
   */
  auth?: RequestAuth;
}

/** Whether a request carries the caller's identity (`"inherit"`, default) or none (`"omit"`). */
export type RequestAuth = "inherit" | "omit";

/** Header names that identify a caller; an `auth: "omit"` request never sends them. */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "x-internal-api-key",
  "x-organization-id",
]);

const ORG_HEADER = "x-organization-id";

/** The header a token travels in for this client (`authMode: "header"` names its own). */
function credentialHeader(config: ClientConfig | null, headerName?: string): string {
  return config?.authMode === "header" ? (headerName ?? "x-api-key") : "authorization";
}

/** A header already names it: the configured `getToken` / `getOrgId` default is not injected. */
function named(options: ApiRequestOptions, config: ClientConfig | null, header: string): boolean {
  return (
    headerValue(options.headerOptions, header) !== undefined ||
    headerValue(config?.defaultHeaders, header) !== undefined
  );
}

function stripCredentialHeaders(
  headers: Record<string, string>,
  extra?: string,
): Record<string, string> {
  const extraName = extra?.toLowerCase();
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (CREDENTIAL_HEADERS.has(lower) || lower === extraName) continue;
    out[name] = value;
  }
  return out;
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
  request: <T = unknown>(
    method: HttpMethod,
    endpoint: string,
    options?: ApiRequestOptions,
  ) => Promise<T>;
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
  const clientAuth =
    getToken || getOrgId || headerName ? { getToken, getOrgId, headerName } : undefined;

  return {
    request: <T = unknown>(method: HttpMethod, endpoint: string, options?: ApiRequestOptions) => {
      // Auto-inject per-client auth if no explicit token/orgId in options
      if (clientAuth && options?.auth !== "omit") {
        const resolved = { ...options };
        const authName = credentialHeader(clientCfg, clientAuth.headerName);
        if (
          resolved.token === undefined &&
          clientAuth.getToken &&
          !named(resolved, clientCfg, authName)
        ) {
          resolved.token = readToken(clientAuth.getToken);
        }
        if (
          resolved.organizationId === undefined &&
          clientAuth.getOrgId &&
          !named(resolved, clientCfg, ORG_HEADER)
        ) {
          resolved.organizationId = clientAuth.getOrgId();
        }
        // For header auth mode: inject token as custom header directly
        if (clientCfg.authMode === "header" && resolved.token) {
          resolved.headerOptions = mergeHeaders(resolved.headerOptions, {
            [authName]: resolved.token,
          });
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
  // **All config is resolved lazily.** Previous revisions snapshotted
  // `getBaseUrl()` / `getAuthMode()` / etc. at construction time and froze
  // the result into `clientCfg`. That bit hard in real apps: `createAuthAwareClient()`
  // typically runs at module-load (top of an `api.ts` module), but
  // `configureClient({ baseUrl })` runs LATER inside a `'use client'` provider's
  // `useState` initializer. The frozen baseUrl was `''` → every request hit
  // a relative URL → 404 cascade against the Next.js dev server / Vercel
  // function origin instead of the API.
  //
  // Now: per-call `request` reads the latest global config every time. Token
  // rotation, baseUrl set-after-load, authMode flipped via reconfigure — all
  // pick up automatically. The only fields that snapshot are the overrides
  // explicitly passed in (those are an opt-in, "I want a different transport"
  // signal that we honor literally).
  const { toast, navigation, getToken, getOrgId, headerName, ...overrideCfg } = overrides;

  const authGetToken = getToken ?? ((): string | null => readToken(authConfig?.getToken));
  const authGetOrgId = getOrgId ?? ((): string | null => authConfig?.getOrgId?.() ?? null);
  const authHeaderName = headerName ?? authConfig?.headerName;
  const clientAuth = { getToken: authGetToken, getOrgId: authGetOrgId, headerName: authHeaderName };

  // The WHOLE global config, then the explicit overrides — never a field list, which silently
  // dropped every field it forgot (`fetch`, `cache`, `timeoutMs`, `encryption`).
  const setOverrides = Object.fromEntries(
    Object.entries(overrideCfg).filter(([, value]) => value !== undefined),
  ) as Partial<ClientConfig>;
  const resolveClientCfg = (): ClientConfig => ({
    ...clientConfig,
    ...setOverrides,
    baseUrl: overrideCfg.baseUrl ?? getBaseUrl(),
    authMode: overrideCfg.authMode ?? getAuthMode(),
    autoIdempotency: overrideCfg.autoIdempotency ?? isAutoIdempotency(),
  });

  return {
    request: <T = unknown>(method: HttpMethod, endpoint: string, options?: ApiRequestOptions) => {
      const cfg = resolveClientCfg();
      if (options?.auth === "omit") return executeRequest<T>(cfg, method, endpoint, options);
      const resolved: ApiRequestOptions = { ...options };
      const authName = credentialHeader(cfg, authHeaderName);
      if (resolved.token === undefined && !named(resolved, cfg, authName)) {
        resolved.token = readToken(authGetToken);
      }
      if (resolved.organizationId === undefined && !named(resolved, cfg, ORG_HEADER)) {
        resolved.organizationId = authGetOrgId();
      }
      if (cfg.authMode === "header" && resolved.token) {
        resolved.headerOptions = mergeHeaders(resolved.headerOptions, {
          [authName]: resolved.token,
        });
        resolved.token = undefined;
      }
      return executeRequest<T>(cfg, method, endpoint, resolved);
    },
    // `config` is the snapshot frozen at construction — kept for the
    // `hasGlobalStaticAuth` / `internalApiKey` heuristic in `createCrudHooks`.
    // Reads of `config.baseUrl` here will be `''` if the global wasn't set yet,
    // but no part of the request path actually reads that — `resolveClientCfg`
    // does at request time.
    config: resolveClientCfg(),
    toast,
    navigation,
    auth: clientAuth,
  };
}

/**
 * Request-scoped server client config — static credentials for exactly one
 * request, no module singletons.
 */
export interface ServerClientConfig
  extends Omit<ArcClientConfig, "getToken" | "getOrgId" | "toast" | "navigation"> {
  /** Bearer token for this request. `null`/omitted = unauthenticated. */
  token?: string | null;
  /** Tenant/org for this request, sent as `x-organization-id`. */
  organizationId?: string | null;
}

/**
 * Create a **request-scoped** client for server environments (Next.js App
 * Router route handlers / Server Components, or any SSR runtime).
 *
 * Unlike `configureClient`/`configureAuth` — which set module-level state
 * that leaks across concurrent server requests — this returns an isolated
 * client whose credentials live only in the returned instance. Construct one
 * per request, read cookies/headers in YOUR framework code, and pass the
 * values in. The SDK stays framework-free: no `next` dependency, no
 * `next/headers` import, no hidden cookie access.
 *
 * @example Next.js App Router (Server Component or route handler)
 * ```ts
 * import { cookies, headers } from 'next/headers';   // host code, not SDK code
 * import { createServerClient } from '@classytic/arc-next/client';
 * import { createCrudApi } from '@classytic/arc-next/api';
 *
 * export async function loadOrders() {
 *   const jar = await cookies();
 *   const client = createServerClient({
 *     baseUrl: process.env.API_URL!,
 *     token: jar.get('session')?.value ?? null,
 *     organizationId: (await headers()).get('x-organization-id'),
 *   });
 *   const orders = createCrudApi<Order>('orders', { client });
 *   // Next fetch-cache passthrough works per call:
 *   return orders.getAll({ options: { next: { revalidate: 60, tags: ['orders'] } } });
 * }
 * ```
 */
export function createServerClient(config: ServerClientConfig): ArcClient {
  const { token = null, organizationId = null, ...rest } = config;
  return createClient({
    ...rest,
    getToken: () => token,
    getOrgId: () => organizationId,
  });
}

/** Who a request is sent as (`organizationId`: the `x-organization-id` it carries, or `null`). */
export interface RequestIdentity {
  auth: RequestAuth;
  organizationId: string | null;
}

/**
 * The identity a request through `client` (omitted: the global transport) is sent with, in the
 * transport's precedence, so a cache key can name it BEFORE the request: `auth: "omit"` (no org),
 * else the `organizationId` option (`null` = none), else an `x-organization-id` header (call, then
 * client defaults), else the configured `getOrgId`.
 */
export function resolveRequestIdentity(
  client: ArcClient | undefined,
  options: Pick<ApiRequestOptions, "auth" | "organizationId" | "headerOptions"> = {},
): RequestIdentity {
  if (options.auth === "omit") return { auth: "omit", organizationId: null };
  if (options.organizationId !== undefined) {
    return { auth: "inherit", organizationId: options.organizationId || null };
  }
  const config = client ? client.config : clientConfig;
  const header =
    headerValue(options.headerOptions, ORG_HEADER) ??
    headerValue(config?.defaultHeaders, ORG_HEADER);
  if (header !== undefined) return { auth: "inherit", organizationId: header || null };
  const configured = client ? client.auth?.getOrgId?.() : authConfig?.getOrgId?.();
  return { auth: "inherit", organizationId: configured || null };
}

/**
 * Get auth context for a specific client instance, falling back to global.
 */
export function getClientAuthContext(client?: ArcClient): {
  token: string | null;
  organizationId: string | null;
} {
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
function computeBackoff(retry: RetryConfig, attempt: number, error?: unknown): number {
  // Server-directed pacing wins: a 429/503 carrying `Retry-After` states
  // exactly when capacity returns — retrying sooner is wasted load, and the
  // header already staggers clients, so no jitter is applied on top.
  if (
    isArcApiError(error) &&
    error.retryAfterMs != null &&
    (error.status === 429 || error.status === 503)
  ) {
    return error.retryAfterMs;
  }
  const strategy = retry.backoff ?? "exponential";
  const base =
    typeof strategy === "function"
      ? Math.max(0, strategy(attempt))
      : strategy === "linear"
        ? 300 * (attempt + 1)
        : // exponential: 300, 600, 1200, ... capped at 10s
          Math.min(300 * 2 ** attempt, 10_000);
  return retry.jitter === "full" ? Math.random() * base : base;
}

/**
 * Inner request loop — handles 5xx + network-failure backoff per
 * {@link ClientConfig.retry}. Knows nothing about 401 recovery; that's the
 * outer {@link executeRequest} wrapper. Split so the two retry families don't
 * tangle: the backoff loop has its own attempt counter and predicate, the
 * auth loop has its own cap and dedup.
 */
async function executeWithBackoff<T = unknown>(
  config: ClientConfig,
  method: HttpMethod,
  endpoint: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const totalAttempts = Math.max(1, config.retry?.attempts ?? 1);
  const shouldRetry = (() => {
    const r = config.retry?.retryOn;
    if (typeof r === "function") return r;
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
      const delay = computeBackoff(config.retry ?? {}, attempt, error);
      if (delay > 0) await sleepAbortable(delay, options.signal);
    }
  }
  throw lastError;
}

/**
 * Top-level request entry. Wraps the 5xx-backoff loop with the 401-recovery
 * loop so the two retry families compose cleanly:
 *
 *   401 (auth) ─→ onAuthError ─→ retry with fresh token ─→ may 5xx ─→ backoff
 *
 * `maxAuthRetries` (default 1) caps the auth loop independently of the
 * backoff loop's `attempts`. AbortSignal propagates through both loops.
 *
 * The auth loop only fires when {@link AuthConfig.onAuthError} is configured —
 * apps that haven't wired a refresh handler see the original behavior (401
 * surfaces immediately, no extra round-trip).
 */
async function executeRequest<T = unknown>(
  config: ClientConfig,
  method: HttpMethod,
  endpoint: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  // Auto-idempotency is an EXECUTOR concern: the key is generated once per
  // logical request, here at the top, so every backoff retry AND every
  // auth-recovery retry of the same call reuses the same `Idempotency-Key`.
  // (Generating inside the attempt would mint a fresh key per retry and
  // defeat the dedup.) Caller-supplied keys always win; GET/DELETE are
  // naturally idempotent and excluded.
  if (
    config.autoIdempotency &&
    options.idempotencyKey === undefined &&
    (method === "POST" || method === "PUT" || method === "PATCH")
  ) {
    options = { ...options, idempotencyKey: _uuid() };
  }

  // Client-level default cache mode — applied ONLY when the call expresses no
  // caching intent of its own (mirrors BaseApi.withCacheDefault precedence: a
  // per-call `cache` or `next` always wins, so ISR opt-ins are
  // never clobbered by the default).
  if (config.cache !== undefined && options.cache === undefined && options.next === undefined) {
    options = { ...options, cache: config.cache };
  }

  const handler = authConfig?.onAuthError;
  const session = authConfig?.onSessionChange;
  // Fast path — most apps haven't wired either hook; skip the wrapper entirely. An anonymous
  // request never refreshes a session: a retry would carry the very token it chose to omit.
  if ((!handler && !session) || options.auth === "omit") {
    return executeWithBackoff<T>(config, method, endpoint, options);
  }

  const retryOn403 = authConfig?.retryOn403 ?? false;
  const maxAuthRetries = Math.max(0, authConfig?.maxAuthRetries ?? 1);
  // Separate budgets: a 401 refresh, then a 403 step-up on the retry, both get to run.
  let authTries = 0;
  let sessionTries = 0;

  let currentOptions = options;
  for (;;) {
    try {
      return await executeWithBackoff<T>(config, method, endpoint, currentOptions);
    } catch (error) {
      // A 403 the session hook matches goes there (more specific than retryOn403).
      const isSession =
        !!session && isArcApiError(error) && error.status === 403 && session.match(error);
      const recover = isSession
        ? session.handler
        : isAuthRecoverable(error, retryOn403)
          ? handler
          : undefined;
      const attempt = isSession ? ++sessionTries : ++authTries;
      // Not recoverable, out of retries, or abandoned by the caller → bubble as-is.
      if (!recover || attempt > maxAuthRetries || currentOptions.signal?.aborted) throw error;

      const { decision, overrideToken } = await runAuthRecovery(recover, {
        error: error as ArcApiError,
        request: { method, endpoint },
        attempt,
      });

      if (decision !== "retry") throw error;

      // Token resolution priority: setToken override > re-read getToken > current.
      // `undefined` means handler didn't touch setToken; `null` is a valid choice
      // (retry unauthenticated). The distinction matters for public endpoints.
      const nextToken =
        overrideToken !== undefined ? overrideToken : readToken(authConfig?.getToken);
      currentOptions = { ...currentOptions, token: nextToken };
    }
  }
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) to ms; null when absent/invalid. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Sleep that resolves early if the signal aborts. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Compose the caller's AbortSignal with a per-attempt timeout. Returns the
 * effective signal plus a `timedOut()` probe so the catch path can tell a
 * timeout abort (retryable failure) apart from a deliberate caller abort
 * (silent cancellation).
 */
function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; timedOut: () => boolean; cleanup: () => void } {
  if (!(timeoutMs > 0)) {
    return { signal, timedOut: () => false, cleanup: () => {} };
  }
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    },
  };
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
    headerOptions,
    next,
    cache,
    signal: callerSignal,
    idempotencyKey,
    elevated,
  } = options;
  const anonymous = options.auth === "omit";
  const token = anonymous ? null : options.token;
  const organizationId = anonymous ? null : options.organizationId;

  const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 0;
  const timeout = withTimeoutSignal(callerSignal, timeoutMs);
  const signal = timeout.signal;

  const startTime = Date.now();

  try {
    // Case-insensitive layers, later wins: client defaults < per-call headers < explicit options
    // (README "Request headers"). `resolveRequestIdentity` mirrors this order.
    let headers = mergeHeaders(config.defaultHeaders);

    if (config.internalApiKey && !anonymous) {
      setHeader(headers, "x-internal-api-key", config.internalApiKey);
    }

    if (config.apiVersion) {
      setHeader(headers, "Accept-Version", config.apiVersion);
    }

    // Detect bodies that carry their own Content-Type (FormData computes a
    // multipart boundary; Blob/File carry `.type`; URLSearchParams is form-
    // urlencoded; ArrayBuffer / typed arrays are raw bytes). Setting
    // `Content-Type: application/json` for those would either strip the
    // multipart boundary or misdeclare the payload. Plain objects + arrays
    // are the only shapes we JSON-stringify ourselves, so they're the only
    // ones that need the JSON content-type.
    if (body !== undefined && body !== null && !isNonJsonBody(body)) {
      setHeader(headers, "Content-Type", "application/json");
    }

    headers = mergeHeaders(headers, headerOptions);

    // `null` is "deliberately none": it also clears a header-supplied tenant.
    if (organizationId) setHeader(headers, "x-organization-id", organizationId);
    else if (organizationId === null) deleteHeader(headers, "x-organization-id");

    if (token) {
      if (config.authMode === "header") {
        setHeader(headers, authConfig?.headerName ?? "x-api-key", token);
      } else if (config.authMode !== "cookie") {
        // Cookie mode carries auth via Set-Cookie / `credentials: 'include'`.
        // Adding `Authorization: Bearer …` on top is redundant at best and
        // can trip servers that strictly validate one auth mechanism
        // per request (e.g. Better Auth's session validator). Matches the
        // upload-path + `arcAuthHeaders` convention so all three transports
        // agree on the cookie-mode contract.
        setHeader(headers, "Authorization", `Bearer ${token}`);
      }
    }

    if (idempotencyKey) {
      setHeader(headers, "Idempotency-Key", idempotencyKey);
    }

    // Per-request `elevated` overrides client-level config (false suppresses, true forces).
    const elevatedActive = elevated ?? config.elevated ?? false;
    if (elevatedActive) {
      setHeader(headers, "x-arc-scope", "platform");
    }

    // Derive credentials: anonymous > explicit config > authMode-based default
    const credentials: RequestCredentials = anonymous
      ? "omit"
      : (config.credentials ?? (config.authMode === "cookie" ? "include" : "same-origin"));

    let serializedBody: BodyInit | undefined;
    if (body !== undefined && body !== null) {
      serializedBody = isNonJsonBody(body) ? (body as BodyInit) : JSON.stringify(body);
    }

    // Application-Layer Encryption — encrypt outbound JSON bodies. Only the
    // JSON path we serialized ourselves (a string) is encrypted; FormData /
    // Blob / raw bytes pass through untouched. The Content-Type flips to the
    // JWE media type so the backend's content-type parser decrypts it.
    const encryption = config.encryption;
    if (encryption?.encryptRequests && encryption.encrypt && typeof serializedBody === "string") {
      serializedBody = await encryption.encrypt(serializedBody);
      setHeader(headers, "Content-Type", encryption.requestContentType ?? "application/jose");
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

    // Last, so neither default headers, instance headers nor an interceptor can re-identify an
    // anonymous request (that would make arc's http-cache answer it `private, no-store`).
    if (anonymous) headers = stripCredentialHeaders(headers, authConfig?.headerName);

    const fetchOptions: RequestInit & { next?: NextFetchOptions } = {
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
    // Next's data cache: `next` goes to fetch as given (inert off-Next).
    if (next && (next.revalidate !== undefined || next.tags)) {
      fetchOptions.next = next;
    }

    // Fail loud on the silent 404 cascade: if baseUrl is empty AND the
    // endpoint is relative, fetch resolves against the current origin and
    // hits the Next.js dev server / Vercel function / whatever else owns
    // the page's origin instead of the API. That's almost never what the
    // caller intended — and the resulting 404s look like backend bugs.
    // The most common cause is calling `configureClient({ baseUrl })`
    // AFTER an SDK module already constructed its `ArcClient` at top-level
    // import time. Throwing here costs us nothing on healthy apps and
    // saves hours of "why is the API returning HTML" debugging on broken ones.
    const isAbsolute = /^https?:\/\//i.test(endpoint);
    if (!isAbsolute && !config.baseUrl) {
      // SSR-aware guidance: `configureClient` is a no-op on the server (it warns
      // and returns), so pointing a Server Component author at it is a dead end.
      // Direct them to a request-scoped / server-config client instead.
      const serverHint =
        `On the server, configureClient() is a no-op — configure a request-scoped ` +
        `client instead: createServerClient({ baseUrl }), or your SDK's server config ` +
        `(e.g. a server env baseUrl / runWithSDKConfig) so SSR reads resolve.`;
      const clientHint =
        `Call configureClient({ baseUrl: '...' }) at app boot (Providers) BEFORE the ` +
        `first request — e.g. in a useState() initializer, before the children render.`;
      throw new Error(
        `[arc-next] handleApiRequest(${method} ${endpoint}): baseUrl is empty. ` +
          (typeof window === "undefined" ? serverHint : clientHint),
      );
    }
    const url = `${config.baseUrl}${endpoint}`;
    const response = await (config.fetch
      ? config.fetch(url, fetchOptions)
      : fetch(url, fetchOptions));

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
        const j = json as {
          error?: unknown;
          message?: unknown;
          meta?: { message?: unknown };
        } | null;
        errorMessage =
          (typeof j?.error === "string" && j.error) ||
          // Arc wraps hook-thrown errors as `{ message: 'Hook execution failed',
          // meta: { message: <the real, author-written message> } }`. Surface the
          // real message so the user sees "Your organization is pending approval…"
          // instead of the generic wrapper text. (No-op when `meta.message` absent.)
          (typeof j?.meta?.message === "string" && j.meta.message) ||
          (typeof j?.message === "string" && j.message) ||
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
        retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
      });
    }

    const contentType = response.headers.get("Content-Type");

    let data: unknown;

    // Application-Layer Encryption — decrypt a JWE response body BEFORE any
    // content-type / repo-core parsing, so the decrypted JSON flows through
    // the normal path and the wire contract (pagination, error shapes) is
    // identical to an unencrypted response.
    const decryptCt = encryption
      ? (encryption.responseContentType ?? "application/jose")
      : undefined;
    if (encryption && decryptCt && contentType?.includes(decryptCt)) {
      const cipher = await response.text();
      const plaintext = cipher.length > 0 ? await encryption.decrypt(cipher) : "";
      data = plaintext.length > 0 ? JSON.parse(plaintext) : undefined;
    } else if (options.responseType === "text") {
      data = await response.text();
    } else if (options.responseType === "blob") {
      data = await response.blob();
    } else if (options.responseType === "json") {
      const text = await response.text();
      data = text.length > 0 ? JSON.parse(text) : undefined;
    } else if (contentType?.includes("application/json")) {
      data = await response.json();
    } else if (contentType?.includes("application/pdf") || contentType?.includes("image/")) {
      const blobData = await response.blob();
      data = { data: blobData, response };
    } else if (contentType?.includes("text/csv")) {
      const csvData = await response.blob();
      data = { data: csvData, response };
    } else if (contentType?.includes("text/")) {
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
              `blob error: ${blobError instanceof Error ? blobError.message : String(blobError)}`,
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
    // Timeout aborts surface as a RETRYABLE TimeoutError, distinct from a
    // deliberate caller abort (which stays an AbortError and is never
    // retried / toasted).
    if (timeout.timedOut() && isAbortError(error)) {
      throw Object.assign(
        new Error(`[arc-next] Request timed out after ${timeoutMs}ms: ${method} ${endpoint}`),
        { name: "TimeoutError" },
      );
    }
    // Preserve original error type (ArcApiError, AbortError, TypeError, etc.)
    if (error instanceof Error) throw error;
    throw new Error("An error occurred while fetching data.");
  } finally {
    timeout.cleanup();
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
      "arc-next: Client not configured. Call configureClient({ baseUrl }) before making API requests.",
    );
  }
  // Auto-inject global auth context (configureAuth) when the caller didn't
  // pass an explicit token/orgId — the SAME contract the per-client path
  // (createClient) and the query hooks already follow. Without this, direct
  // BaseApi calls (invokeRoute / aggregate / getAll outside hooks) fired
  // unauthenticated and burned a 401 → onAuthError refresh → retry cycle on
  // every call. `undefined` = inherit; explicit `null` = deliberately public.
  if (authConfig && options.auth !== "omit") {
    const resolved = { ...options };
    const authName = credentialHeader(clientConfig, authConfig.headerName);
    if (resolved.token === undefined && !named(resolved, clientConfig, authName)) {
      resolved.token = readToken(authConfig.getToken);
    }
    if (resolved.organizationId === undefined && !named(resolved, clientConfig, ORG_HEADER)) {
      resolved.organizationId = authConfig.getOrgId?.() ?? null;
    }
    return executeRequest<T>(clientConfig, method, endpoint, resolved);
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
    if (value === undefined || value === "") return;

    if (key === "populateOptions" && Array.isArray(value)) {
      (value as Array<{ path: string; select?: string; match?: Record<string, unknown> }>).forEach(
        (opt) => {
          if (opt.select) {
            const selectFields = opt.select.replace(/\s+/g, ",");
            searchParams.append(`populate[${opt.path}][select]`, selectFields);
          }
          // Bracket form, field equality only — the one shape every server parser reads. A JSON
          // string here was silently ignored, so the populate matched every document.
          for (const [field, fv] of Object.entries(opt.match ?? {})) {
            searchParams.append(`populate[${opt.path}][match][${field}]`, encodeScalar(fv));
          }
          if (!opt.select && !opt.match) {
            const existing = searchParams.get("populate");
            if (existing) {
              searchParams.set("populate", `${existing},${opt.path}`);
            } else {
              searchParams.append("populate", opt.path);
            }
          }
        },
      );
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > 1) {
        searchParams.append(`${key}[in]`, value.map(encodeScalar).join(","));
      } else if (value.length === 1) {
        searchParams.append(key, encodeScalar(value[0]));
      }
    } else if (value === null || value instanceof Date) {
      searchParams.append(key, encodeScalar(value));
    } else if (typeof value === "object") {
      // Nested operator object — `{ field: { gte: 18, lt: 65 } }` → `field[gte]=18&field[lt]=65`.
      // Matches `@classytic/repo-core/query-parser` bracket grammar so the
      // server-side `parseUrl()` reverses to the same Filter IR.
      // Array operator values flatten via comma-join (`{ in: [1,2,3] }` → `field[in]=1,2,3`),
      // matching mongokit/sqlitekit URL conventions.
      for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
        if (opValue === undefined || opValue === "") continue;
        const bracketKey = `${key}[${op}]`;
        if (Array.isArray(opValue)) {
          if (opValue.length > 0)
            searchParams.append(bracketKey, opValue.map(encodeScalar).join(","));
        } else {
          searchParams.append(bracketKey, encodeScalar(opValue));
        }
      }
    } else {
      searchParams.append(key, String(value));
    }
  });

  return searchParams.toString();
}

/** A Date goes out as ISO-8601, the form the server parsers coerce; `String(date)` is locale text they refuse. */
function encodeScalar(value: unknown): string {
  if (value === null) return "null";
  return value instanceof Date ? value.toISOString() : String(value);
}

// ============================================================================
// arcFetch — one-line authenticated fetch for non-hook contexts
// ============================================================================

/**
 * Body shapes that carry their own Content-Type and must NOT be re-serialized
 * by arc-next:
 *
 *  - `FormData` — multipart with a runtime-computed boundary.
 *  - `Blob` / `File` — carries `.type`.
 *  - `URLSearchParams` — `application/x-www-form-urlencoded`.
 *  - `ArrayBuffer` / typed arrays — raw bytes; caller controls Content-Type.
 *  - `ReadableStream` — caller controls Content-Type.
 *  - `string` — caller controls Content-Type (could be plain text, XML, etc.).
 *
 * Plain objects and arrays fall through and get `JSON.stringify`d with
 * `Content-Type: application/json`.
 */
function isNonJsonBody(body: unknown): boolean {
  if (body == null) return false;
  if (typeof body === "string") return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return true;
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return true;
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body as ArrayBufferView))
    return true;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return true;
  return false;
}

/**
 * Returns the auth headers arc-next would inject on a fetch right now —
 * `Authorization` (or the configured custom `headerName` for `authMode:
 * 'header'`), `x-organization-id`, and `x-internal-api-key`. Use for the
 * rare case where you need full `Response` control via plain `fetch` but
 * still want arc-next's auth wiring.
 *
 * @example
 * const res = await fetch(url, {
 *   headers: { ...arcAuthHeaders(), 'X-Custom': '1' },
 *   credentials: getAuthMode() === 'cookie' ? 'include' : 'same-origin',
 * });
 */
export function arcAuthHeaders(): Record<string, string> {
  const { token, organizationId } = getAuthContext();
  const authMode = getAuthMode();
  const headers: Record<string, string> = {};

  if (token) {
    if (authMode === "header") {
      headers[authConfig?.headerName ?? "x-api-key"] = token;
    } else if (authMode !== "cookie") {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  if (organizationId) headers["x-organization-id"] = organizationId;
  if (clientConfig?.internalApiKey) headers["x-internal-api-key"] = clientConfig.internalApiKey;
  return headers;
}

/**
 * Headers that arc-next owns and a caller must not override via
 * {@link ArcFetchOptions.headers}. Passing one of these in `options.headers`
 * is silently dropped — see the `arcFetch` JSDoc for the rationale.
 *
 * Lower-cased on lookup so case-insensitive HTTP header semantics are
 * honored (`Authorization` vs `authorization` both protected).
 */
const ARC_FETCH_PROTECTED_HEADERS = new Set<string>([
  "authorization",
  "x-organization-id",
  "x-internal-api-key",
  // Custom auth-header-mode header name is protected dynamically below
  // (depends on authConfig.headerName).
]);

export interface ArcFetchOptions extends Omit<RequestInit, "body" | "headers"> {
  /**
   * Request body. Plain objects and arrays are auto-`JSON.stringify`d and
   * sent with `Content-Type: application/json`. Binary bodies (`FormData`,
   * `Blob`, `ArrayBuffer`, `URLSearchParams`, `ReadableStream`) and strings
   * pass through unchanged — the caller owns `Content-Type` for those.
   */
  body?: Record<string, unknown> | unknown[] | BodyInit | null;
  /**
   * Extra headers merged on top of arc-next's auto-injected ones. Auth-
   * related headers (`Authorization`, `x-organization-id`,
   * `x-internal-api-key`, and the configured custom-auth header name) are
   * **protected** — passing them here is silently dropped, so a caller can't
   * accidentally strip the bearer token by spreading their own header map.
   */
  headers?: Record<string, string>;
  /** AbortSignal — same semantics as `fetch`. */
  signal?: AbortSignal;
  /** Per-call elevated-scope override (`x-arc-scope: platform`). */
  elevated?: boolean;
  /** Per-call `Idempotency-Key` header. */
  idempotencyKey?: string;
  /** Next App Router fetch cache config (`{ revalidate, tags }`). */
  next?: NextFetchOptions;
  /** `cache` pass-through (browser fetch + Next.js). */
  cache?: RequestCache;
  /**
   * Per-call client. Defaults to a lazily-created `createAuthAwareClient()`
   * that bridges global `configureClient` + `configureAuth`. Pass a
   * dedicated `createClient(...)` for multi-backend apps.
   */
  client?: ArcClient;
}

let defaultArcFetchClient: ArcClient | null = null;
function getDefaultArcFetchClient(): ArcClient {
  // Lazy — `configureClient` and `configureAuth` might not have run when this
  // module loads (especially in Next.js where the SDK is imported during SSR
  // before the client provider mounts). Resolve on first use so the singleton
  // captures the latest global state.
  if (!defaultArcFetchClient) {
    defaultArcFetchClient = createAuthAwareClient();
  }
  return defaultArcFetchClient;
}

/** @internal — tests reset the default client between cases. */
export function _resetArcFetchClient(): void {
  defaultArcFetchClient = null;
}

/**
 * Strip protected auth headers from a caller-supplied map. Case-insensitive
 * (HTTP header names are case-insensitive). The custom-auth `headerName`
 * (when `authMode: 'header'` is configured) is computed at call time so
 * apps that reconfigure auth modes don't lose protection on the renamed
 * header.
 */
function sanitizeUserHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const customHeader = authConfig?.headerName?.toLowerCase();
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (ARC_FETCH_PROTECTED_HEADERS.has(lower)) continue;
    if (customHeader && lower === customHeader) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Authenticated, tenant-scoped fetch to an arc endpoint — one line for the
 * non-hook contexts where `useQuery` / `useMutation` aren't available
 * (event handlers, service workers, server actions, custom MDX submits,
 * background polls).
 *
 * Auto-injects on every call:
 *  - `Authorization: Bearer <token>` (from `configureAuth().getToken`), or
 *    the custom header for `authMode: 'header'`
 *  - `x-organization-id` (from `configureAuth().getOrgId`)
 *  - `Content-Type: application/json` (only for plain object/array bodies)
 *  - `x-internal-api-key`, `Accept-Version`, `Idempotency-Key`,
 *    `x-arc-scope` when configured
 *
 * Composes with everything else `configureClient` + `configureAuth` do:
 *  - `retry` (5xx backoff)
 *  - `onAuthError` (401 → refresh → retry, with concurrent dedup)
 *  - `beforeRequest` / `afterResponse` interceptors
 *  - `cookie` / `bearer` / `header` auth modes
 *
 * Response handling:
 *  - 2xx → parsed body (JSON for `application/json`, Blob for binary,
 *    text for `text/*`).
 *  - non-2xx → throws `ArcApiError` with parsed body, status, endpoint,
 *    method. Use `isArcApiError(err)` + `err.code` to discriminate.
 *
 * For full `Response` control (rare), use plain `fetch` with
 * {@link arcAuthHeaders} instead.
 *
 * @example
 * import { arc } from '@classytic/arc-next/client';
 *
 * // Before — 15 lines of header dance + error parse + JSON
 * // After:
 * const result = await arc.post<{ ok: true }>('/api/statements', statements);
 */
export function arcFetch<T = unknown>(path: string, options: ArcFetchOptions = {}): Promise<T> {
  const {
    method = "GET",
    body,
    headers,
    signal,
    elevated,
    idempotencyKey,
    next,
    cache,
    client,
  } = options;

  const transport = client ?? getDefaultArcFetchClient();

  const apiOptions: ApiRequestOptions = {
    body,
    headerOptions: sanitizeUserHeaders(headers),
    ...(signal ? { signal } : {}),
    ...(elevated !== undefined ? { elevated } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(next ? { next } : {}),
    ...(cache ? { cache } : {}),
  };

  return transport.request<T>(method as HttpMethod, path, apiOptions);
}

/**
 * Method-specific shorthands for the 90% case. Each mirrors `arcFetch` with
 * the HTTP verb pre-filled; mutating verbs accept `body` as the second arg
 * so the call reads as a sentence:
 *
 *   `arc.post('/path', payload)` instead of
 *   `arcFetch('/path', { method: 'POST', body: payload })`.
 *
 * Identical composition with `onAuthError`, retry, and interceptors.
 */
export const arc = {
  get: <T = unknown>(path: string, opts: ArcFetchOptions = {}) =>
    arcFetch<T>(path, { ...opts, method: "GET" }),
  post: <T = unknown>(path: string, body?: ArcFetchOptions["body"], opts: ArcFetchOptions = {}) =>
    arcFetch<T>(path, { ...opts, method: "POST", body }),
  put: <T = unknown>(path: string, body?: ArcFetchOptions["body"], opts: ArcFetchOptions = {}) =>
    arcFetch<T>(path, { ...opts, method: "PUT", body }),
  patch: <T = unknown>(path: string, body?: ArcFetchOptions["body"], opts: ArcFetchOptions = {}) =>
    arcFetch<T>(path, { ...opts, method: "PATCH", body }),
  delete: <T = unknown>(path: string, opts: ArcFetchOptions = {}) =>
    arcFetch<T>(path, { ...opts, method: "DELETE" }),
};
