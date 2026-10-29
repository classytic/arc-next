/**
 * Transport configuration: the one config shape for both the global singleton (`initSDK`) and
 * isolated clients (`createIsolatedClient`). Server-safe (no "use client").
 *
 * The raw transport (`ResolvedTransport`) is what the helpers that bypass arc-next's JSON client
 * need: streamed downloads (`./download`) and presigned uploads.
 */

import {
  type ArcClient,
  type AuthErrorHandler,
  type ClientConfig,
  createClient,
  type ToastHandler,
  type UseRouterHook,
} from "../client.js";
import type { MessageResolver } from "./messages.js";

/** arc-next's own default mount point; pass `basePath` when the API is mounted elsewhere (`/api`). */
export const DEFAULT_API_BASE_PATH = "/api/v1";

export interface SdkConfig {
  /** API origin, e.g. `https://api.example.com`. */
  baseUrl: string;
  /** Mount point of the arc API. Default {@link DEFAULT_API_BASE_PATH}. */
  basePath?: string;
  /** Synchronous bearer token read (arc-next contract). Async refresh belongs in your auth client. */
  getToken: () => string | null;
  /** Fired once per 401 burst: refresh or sign out, then `'retry'` or `'skip'`. Global client only. */
  onAuthError?: AuthErrorHandler;
  /** Mutation toasts (sonner). Message keys are resolved to text through `messages` before they reach it. */
  toast?: ToastHandler;
  /** Router hook for the navigation helpers arc-next hooks use (Next `useRouter`). */
  navigation?: UseRouterHook;
  /**
   * Localised toast text, called at display time with the message context (CRUD or action, outcome,
   * server `code` and `details`). Return `undefined` to keep the English default. Re-run `initSDK`
   * or `configureMessages` when the locale changes, or read the locale inside the resolver.
   */
  messages?: MessageResolver;
  /** First segment of the message keys the resolver sees. Default `sdk`. */
  messageKeyPrefix?: string;
  /** Transport override (tests, React Native, in-process). */
  fetch?: ClientConfig["fetch"];
  /** SSE transport (React Native). Unset = `globalThis.EventSource`. */
  eventSource?: ClientConfig["eventSource"];
  /** Where SSE credentials travel. See arc-next `ClientConfig.streamAuth`. */
  streamAuth?: ClientConfig["streamAuth"];
  /** Per-attempt timeout in ms. Default 20s: a hung request must not freeze a command screen. */
  timeoutMs?: number;
  /**
   * Send a collection route as its bare registered path (`/api/things?x=1`, not `/api/things/?x=1`).
   * arc-next joins `<resource>` + `/` for a route call with path `/`; a server that registers
   * `/api/things` then answers 404 (or redirects). Default true.
   */
  bareCollectionPaths?: boolean;
  /** Record refused JSON responses so toast resolvers see the server `code` / `details`. Default true. */
  captureErrors?: boolean;
}

/** What the download and upload helpers need to talk to the API without going through arc-next. */
export interface ResolvedTransport {
  baseUrl: string;
  basePath: string;
  getToken: () => string | null;
  /** The runtime (or injected) fetch, untouched: presigned storage PUTs, downloads, streams. */
  fetch: typeof fetch;
  /** `fetch` for API calls through arc-next: collection routes go out as their bare registered path. */
  apiFetch: typeof fetch;
}

/** What the download helper needs (it uses the raw fetch, never the API wrapper). */
export type RawTransport = Pick<ResolvedTransport, "baseUrl" | "basePath" | "getToken" | "fetch">;

/**
 * The server registers a collection route as `/api/things`. arc-next joins `<resource>` + `/` for a
 * route call with path `/`, which would send `/api/things/?x=1`; strip that slash before the query
 * so the request names the route as registered (and the OpenAPI document lists it).
 */
export function bareCollectionPath(url: string): string {
  return url.replace(/^([^?#]*[^/?#:])\/+(?=[?#]|$)/, "$1");
}

export function withBareCollectionPaths(inner: typeof fetch): typeof fetch {
  return (input, init) =>
    inner(typeof input === "string" ? bareCollectionPath(input) : input, init);
}

export function resolveTransport(config: SdkConfig): ResolvedTransport {
  const raw = (config.fetch as typeof fetch | undefined) ?? ((input, init) => fetch(input, init));
  return {
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    basePath: config.basePath ?? DEFAULT_API_BASE_PATH,
    getToken: config.getToken,
    fetch: raw,
    apiFetch: config.bareCollectionPaths === false ? raw : withBareCollectionPaths(raw),
  };
}

/**
 * The `ClientConfig` both `initSDK` (global) and `createIsolatedClient` derive from a transport:
 * bearer auth, no cookies, automatic idempotency keys, a per-attempt timeout.
 */
export function clientConfigFor(
  config: SdkConfig,
  transport: ResolvedTransport,
  fetchImpl: typeof fetch = transport.apiFetch,
): ClientConfig {
  return {
    baseUrl: transport.baseUrl,
    basePath: transport.basePath,
    authMode: "bearer",
    credentials: "omit",
    autoIdempotency: true,
    timeoutMs: config.timeoutMs ?? 20_000,
    fetch: fetchImpl,
    ...(config.eventSource ? { eventSource: config.eventSource } : {}),
    ...(config.streamAuth ? { streamAuth: config.streamAuth } : {}),
  };
}

/**
 * ISOLATED: a fresh `ArcClient` and resolved transport, no global state (not the arc-next transport,
 * not the toast, not the message resolver). For SSR requests, tests and background jobs. Bind a
 * resource to it with `resource.bind(client, transport.basePath)` (`./resource`).
 */
export function createIsolatedClient(config: SdkConfig): {
  client: ArcClient;
  transport: ResolvedTransport;
} {
  const transport = resolveTransport(config);
  const client = createClient({ ...clientConfigFor(config, transport), getToken: config.getToken });
  return { client, transport };
}

let globalTransport: ResolvedTransport | undefined;

export function setGlobalTransport(transport: ResolvedTransport): void {
  globalTransport = transport;
}

export function requireGlobalTransport(): ResolvedTransport {
  if (!globalTransport) {
    throw new Error("SDK is not configured: call initSDK() at app boot first.");
  }
  return globalTransport;
}
