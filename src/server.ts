/**
 * `@classytic/arc-next/server` — call arc from a Server Component, Route
 * Handler or Server Action on behalf of the user whose request is being served.
 *
 * The server's `fetch` carries none of the browser's cookies, so the incoming
 * request's identity has to be forwarded explicitly — and only that: hop-by-hop
 * headers (`host`, `connection`, `content-length`, …) describe the OTHER
 * connection and break the proxied one. A client built here is per-request, so
 * one user's cookie can never reach another user's call (the reason global
 * `configureClient({ defaultHeaders })` warns on the server).
 *
 * Framework-agnostic: pass anything with `get(name)` — Next's `await headers()`,
 * a Fetch `Request.headers`, a React Router loader's `request.headers`.
 *
 * @example
 * // app/orders/page.tsx (Server Component)
 * import { headers } from 'next/headers';
 * import { createRequestClient } from '@classytic/arc-next/server';
 *
 * const arc = createRequestClient({ baseUrl: process.env.API_URL!, headers: await headers() });
 * const orders = await createCrudApi<Order>('orders', { client: arc }).getAll();
 *
 * // or keep the module-level api and forward per call (prefetch):
 * await ordersPrefetcher.prefetchList(queryClient, {}, {
 *   headers: forwardRequestHeaders(await headers()),
 * });
 */

import { type ArcClient, type ArcClientConfig, createClient } from "./client.js";

/** Anything that reads a header by name — `Headers`, Next's `ReadonlyHeaders`. */
export interface HeaderSource {
  get(name: string): string | null | undefined;
}

/**
 * Forwarded by default: who the user is (`cookie`, `authorization`), which
 * tenant (`x-organization-id`), their locale, and the trace the hop belongs to.
 * `x-forwarded-for` is NOT here: arc would read the Next server as a proxy, which
 * is only correct when arc's `trustProxy` names that server — add it deliberately.
 */
export const FORWARDED_REQUEST_HEADERS = [
  "cookie",
  "authorization",
  "x-organization-id",
  "accept-language",
  "x-request-id",
  "traceparent",
  "tracestate",
] as const;

/** Copy the named headers that are present and non-empty (lowercase keys). */
export function forwardRequestHeaders(
  incoming: HeaderSource,
  names: readonly string[] = FORWARDED_REQUEST_HEADERS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = incoming.get(name);
    if (value) out[name.toLowerCase()] = value;
  }
  return out;
}

export interface RequestClientConfig
  extends Omit<ArcClientConfig, "toast" | "navigation" | "getToken" | "getOrgId"> {
  /** The incoming request's headers. */
  headers: HeaderSource;
  /** Header names to forward (default {@link FORWARDED_REQUEST_HEADERS}). */
  forward?: readonly string[];
}

/**
 * A client for ONE incoming request: its forwarded headers ride on every call,
 * and `defaultHeaders` (e.g. an internal API key) are added on top. Build it
 * per request — never cache it across requests.
 */
export function createRequestClient(config: RequestClientConfig): ArcClient {
  const { headers, forward, defaultHeaders, ...rest } = config;
  return createClient({
    ...rest,
    defaultHeaders: { ...forwardRequestHeaders(headers, forward), ...defaultHeaders },
  });
}
