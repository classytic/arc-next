/**
 * Same-origin reverse proxy for an auth service (e.g. Better Auth) mounted on the API, as a Next
 * route-handler factory. Serving `/api/auth/*` from the portal's own origin makes the cookies it
 * sets (a pending-2FA cookie, a CSRF cookie) first-party. A route handler rather than a
 * `next.config` rewrite because rewrites are fixed at build time and the API origin is a runtime
 * setting (see `./runtime`).
 *
 * ```ts
 * // app/api/auth/[...path]/route.ts
 * export const { DELETE, GET, PATCH, POST, PUT } = createAuthProxy({
 *   upstream: () => publicEnv.apiUrl,
 *   internalUpstream: () => process.env.API_INTERNAL_URL, // private-network address, optional
 * });
 * ```
 *
 * Headers pass through, including `origin` (an auth server's trusted-origin check) and
 * `x-forwarded-for` (set by the edge proxy; the API reads it for per-IP limits). Server-safe: no
 * `next` imports, only the Fetch API.
 */

export type Upstream = string | (() => string | undefined);

export interface AuthProxyOptions {
  /** Public API origin. A function is evaluated per request (runtime settings). */
  upstream: Upstream;
  /**
   * Private-network API origin (compose service name) so the portal does not loop out through the
   * public edge. Falls back to `upstream` when unset or empty.
   */
  internalUpstream?: Upstream;
  /** Transport (tests). Default: global `fetch`. */
  fetch?: typeof fetch;
  /** The 502 body when the upstream cannot be reached. */
  unavailable?: { code?: string; message?: string };
  /**
   * Extra request headers never forwarded, on top of the connection-level ones (lower-case names).
   */
  stripRequestHeaders?: readonly string[];
}

/** Connection-level request headers: never forwarded (fetch sets its own). */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "content-length",
];

/** `fetch` already decoded the body, so these no longer describe what goes back to the browser. */
export const DECODED_RESPONSE_HEADERS: readonly string[] = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
];

export const DEFAULT_UNAVAILABLE = {
  code: "auth.upstream_unavailable",
  message: "The sign-in service is unreachable.",
} as const;

export type AuthProxyHandler = (request: Request) => Promise<Response>;

export interface AuthProxyHandlers {
  DELETE: AuthProxyHandler;
  GET: AuthProxyHandler;
  PATCH: AuthProxyHandler;
  POST: AuthProxyHandler;
  PUT: AuthProxyHandler;
}

const resolve = (value: Upstream | undefined): string | undefined =>
  typeof value === "function" ? value() : value;

/** The origin requests are forwarded to: the internal one when set, else the public one, no trailing slash. */
export function resolveUpstream(options: AuthProxyOptions): string {
  const chosen = resolve(options.internalUpstream)?.trim() || resolve(options.upstream)?.trim();
  if (!chosen) throw new Error("createAuthProxy: no upstream origin configured");
  return chosen.replace(/\/+$/, "");
}

export function createAuthProxy(options: AuthProxyOptions): AuthProxyHandlers {
  const strip = new Set([...HOP_BY_HOP_HEADERS, ...(options.stripRequestHeaders ?? [])]);
  const unavailable = { ...DEFAULT_UNAVAILABLE, ...options.unavailable };

  async function forward(request: Request): Promise<Response> {
    const { pathname, search } = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const name of strip) headers.delete(name);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    let upstream: Response;
    try {
      upstream = await (options.fetch ?? fetch)(`${resolveUpstream(options)}${pathname}${search}`, {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
        // The browser follows redirects itself (an OAuth hop must reach it with its cookies).
        redirect: "manual",
        cache: "no-store",
      });
    } catch {
      return Response.json(unavailable, { status: 502 });
    }

    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      // `forEach` folds repeated headers; set-cookie is re-added one by one below.
      if (name !== "set-cookie" && !DECODED_RESPONSE_HEADERS.includes(name))
        out.append(name, value);
    });
    const cookies = upstream.headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) for (const cookie of cookies) out.append("set-cookie", cookie);
    else {
      const folded = upstream.headers.get("set-cookie");
      if (folded) out.append("set-cookie", folded);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  }

  return { DELETE: forward, GET: forward, PATCH: forward, POST: forward, PUT: forward };
}
