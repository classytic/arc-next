/**
 * Query enablement: one rule for the generated hooks and for queries written with TanStack's
 * `useQuery` directly. Server-safe (no "use client"); its own subpath so the transport (`./client`)
 * does not carry it.
 */

import type { ArcClient } from "./client.js";
import { getAuthMode, getClientAuthContext, hasGlobalStaticAuth } from "./client.js";

/** What decides whether an auth-gated read may run. */
export interface QueryAuthOptions {
  /** The endpoint is public (`allowPublic`): no token needed. */
  public?: boolean;
  /** The caller's own gate (a missing id, a closed panel); combined with the auth rule. */
  enabled?: boolean;
  /**
   * The endpoint answers for the SIGNED-IN USER ("my enrollments", `/mine`, "do I have access"):
   * it needs that user's credentials even when static auth is configured, because an
   * `internalApiKey` or default headers identify the app, not a person. Without a token such a
   * query would only 401. Cookie auth carries the user, so it runs whenever the caller allows.
   */
  user?: boolean;
}

/**
 * The enablement rule, as a pure function of its inputs: cookie auth, a public endpoint or static
 * auth (`defaultHeaders`, `internalApiKey`, a per-client `auth`) runs whenever the caller allows;
 * bearer / header auth needs a token. `createCrudHooks` uses exactly this; so does
 * {@link queryAuthEnabled} for hand-written queries.
 */
export function authGate(
  token: string | null,
  options: QueryAuthOptions,
  authMode: "bearer" | "cookie" | "header",
  hasStaticAuth: boolean,
): boolean {
  if (options.user && authMode !== "cookie") return (options.enabled ?? true) && !!token;
  if (authMode === "cookie" || options.public || hasStaticAuth) return options.enabled ?? true;
  return options.enabled !== undefined ? options.enabled && !!token : !!token;
}

/**
 * `enabled` for a query written with TanStack's `useQuery` directly, so it obeys the same auth rule
 * as the generated hooks. Without it a per-user query ("my enrollments", "do I have access") fires
 * for a signed-out visitor, gets a 401, and sets off the auth refresh: wasted round trips on every
 * page view.
 *
 * ```ts
 * useQuery({ queryKey, queryFn, enabled: queryAuthEnabled({ enabled: !!courseId }) });
 * ```
 *
 * Read at render, like the generated hooks: signing in re-renders and enables the query.
 */
export function queryAuthEnabled(options: QueryAuthOptions = {}, client?: ArcClient): boolean {
  const hasStaticAuth =
    !!(client?.config?.defaultHeaders || client?.config?.internalApiKey || client?.auth) ||
    hasGlobalStaticAuth();
  return authGate(
    getClientAuthContext(client).token,
    options,
    client?.config?.authMode ?? getAuthMode(),
    hasStaticAuth,
  );
}
