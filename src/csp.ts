/**
 * Content Security Policy for a Next.js app, built per request, plus `createProxy`, the helper for
 * Next's `proxy.ts` (formerly `middleware.ts`) that mints the nonce and sets the header.
 *
 * Scripts: only the framework's own, carrying this request's nonce (`'strict-dynamic'` lets them
 * load their chunks); no inline handlers, no `eval` outside development. Trusted Types (production):
 * DOM script sinks only accept values from the named policies; {@link TRUSTED_TYPES_DEFAULT_POLICY}
 * (a nonce'd inline script in `<head>`) admits same-origin and `blob:` script URLs and refuses HTML
 * and script strings. Network and frame origins are supplied by the host: nothing is hard-coded.
 *
 * Server-safe (no "use client") and free of `next` imports: `createProxy` takes the host's
 * `NextResponse` as an argument, so the package needs no `next` peer dependency.
 */

/** Request header the nonce travels on to the root layout (`headers().get("x-nonce")`). */
export const NONCE_HEADER = "x-nonce";

export const CSP_HEADER = "content-security-policy";

/** Trusted Types policy names the app itself (and its framework) may create. */
export const TRUSTED_TYPES_POLICIES = ["nextjs", "nextjs#bundler", "default"] as const;

export interface CspInput {
  nonce: string;
  /** The API origin (REST, media, the realtime stream). */
  apiOrigin: string;
  /** Object-storage origin direct uploads and media are served from. Optional. */
  storageOrigin?: string;
  /** Base-map hosts (styles, tiles, glyphs, sprites): img + connect. */
  mapOrigins?: readonly string[];
  /** Hosts external content may be framed from (video embeds): frame-src only. */
  embedOrigins?: readonly string[];
  /**
   * Extra origins per directive, merged after the built-in ones, e.g.
   * `{ "connect-src": ["https://analytics.example.com"], "font-src": ["https://fonts.gstatic.com"] }`.
   * A directive the builder does not emit (e.g. `child-src`) is appended as `<name> <origins>`.
   */
  extra?: Readonly<Record<string, readonly string[]>>;
  /** `next dev`: React needs `eval` for error overlays and HMR uses `ws:`; Trusted Types stay off. */
  dev: boolean;
  /** Enforce Trusted Types. Default: on in production, off in development. */
  trustedTypes?: boolean;
  /** Policy names allowed when Trusted Types are enforced. Default {@link TRUSTED_TYPES_POLICIES}. */
  trustedTypesPolicies?: readonly string[];
  /** Add `upgrade-insecure-requests`. Default: production with an `https://` API origin. */
  upgradeInsecureRequests?: boolean;
}

/** The origin (`scheme://host[:port]`) of a URL; `null` for a relative, empty or unparsable one. `{token}` templates are tolerated. */
export function originOf(url: string | undefined | null): string | null {
  if (!url || url.startsWith("/")) return null;
  try {
    return new URL(url.replace(/\{[^}]+\}/g, "x")).origin;
  } catch {
    return null;
  }
}

/** The distinct origins of a list of URLs (unparsable and relative ones dropped). */
export function originsOf(urls: ReadonlyArray<string | undefined | null>): string[] {
  return [...new Set(urls.map(originOf).filter((origin): origin is string => origin !== null))];
}

/**
 * `https://<host>` origins for bare host names that match `pattern` (a regex the host owns, e.g.
 * exact tenant hosts only). Hosts that already carry a scheme, wildcards and lookalikes fail a
 * sensible pattern and are dropped; with no pattern only plain `a.b` host names are accepted.
 */
export function hostOrigins(
  hosts: readonly string[],
  pattern: RegExp = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
): string[] {
  return [...new Set(hosts.filter((host) => pattern.test(host)).map((host) => `https://${host}`))];
}

const list = (...items: ReadonlyArray<string | undefined>): string =>
  [...new Set(items.filter((item): item is string => Boolean(item)))].join(" ");

export function contentSecurityPolicy(input: CspInput): string {
  const {
    nonce,
    apiOrigin,
    storageOrigin,
    mapOrigins = [],
    embedOrigins = [],
    extra = {},
    dev,
  } = input;
  const trustedTypes = input.trustedTypes ?? !dev;
  const upgrade = input.upgradeInsecureRequests ?? (!dev && apiOrigin.startsWith("https://"));
  const more = (name: string): string[] => [...(extra[name] ?? [])];

  const directives: Array<[string, string]> = [
    ["default-src", "'self'"],
    [
      "script-src",
      list(
        "'self'",
        `'nonce-${nonce}'`,
        "'strict-dynamic'",
        dev ? "'unsafe-eval'" : "",
        ...more("script-src"),
      ),
    ],
    ["style-src", list("'self'", "'unsafe-inline'", ...more("style-src"))],
    [
      "img-src",
      list("'self'", "data:", "blob:", storageOrigin, apiOrigin, ...mapOrigins, ...more("img-src")),
    ],
    ["font-src", list("'self'", "data:", ...more("font-src"))],
    [
      "connect-src",
      list(
        "'self'",
        apiOrigin,
        storageOrigin,
        ...mapOrigins,
        dev ? "ws:" : "",
        ...more("connect-src"),
      ),
    ],
    ["worker-src", list("'self'", "blob:", ...more("worker-src"))],
    ["frame-src", list("'self'", storageOrigin, apiOrigin, ...embedOrigins, ...more("frame-src"))],
    ["media-src", list("'self'", "blob:", storageOrigin, apiOrigin, ...more("media-src"))],
    ["manifest-src", list("'self'", ...more("manifest-src"))],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", list("'self'", ...more("form-action"))],
    ["frame-ancestors", "'none'"],
  ];
  const emitted = new Set(directives.map(([name]) => name));
  for (const [name, origins] of Object.entries(extra)) {
    if (!emitted.has(name) && origins.length > 0) directives.push([name, list(...origins)]);
  }
  if (trustedTypes) {
    directives.push(
      ["require-trusted-types-for", "'script'"],
      ["trusted-types", (input.trustedTypesPolicies ?? TRUSTED_TYPES_POLICIES).join(" ")],
    );
  }
  if (upgrade) directives.push(["upgrade-insecure-requests", ""]);
  return directives.map(([name, value]) => (value ? `${name} ${value}` : name)).join("; ");
}

/**
 * The Trusted Types `default` policy, run first in `<head>` (nonce'd inline script). Script URLs:
 * this origin or `blob:` only. HTML and script strings: refused (no library here needs them).
 */
export const TRUSTED_TYPES_DEFAULT_POLICY = `(function(){var t=window.trustedTypes;if(!t||!t.createPolicy||t.defaultPolicy)return;t.createPolicy("default",{createScriptURL:function(u){var x=new URL(u,location.href);if(x.protocol==="blob:"||x.origin===location.origin)return u;throw new TypeError("Trusted Types: script URL refused")},createHTML:function(){throw new TypeError("Trusted Types: HTML string refused")},createScript:function(){throw new TypeError("Trusted Types: script string refused")}})})();`;

/** A fresh, unguessable per-request nonce (base64 of a UUID). */
export function createNonce(): string {
  return btoa(crypto.randomUUID());
}

/** The slice of Next's `NextResponse` that `createProxy` uses (pass the real one). */
export interface ProxyResponseFactory<
  TResponse extends { headers: Headers } = { headers: Headers },
> {
  next(init: { request: { headers: Headers } }): TResponse;
}

/** The slice of `NextRequest` that `createProxy` reads. */
export interface ProxyRequest {
  headers: Headers;
}

export interface CreateProxyOptions<
  TRequest extends ProxyRequest = ProxyRequest,
  TResponse extends { headers: Headers } = { headers: Headers },
> {
  /** Next's `NextResponse` (`import { NextResponse } from "next/server"`). */
  NextResponse: ProxyResponseFactory<TResponse>;
  /**
   * The policy for this request. Called per request with its nonce so a runtime-configured origin
   * (see `./runtime`) is read at request time, not at build time.
   */
  policy: (context: { nonce: string; dev: boolean; request: TRequest }) => string;
  /** `next dev`. Default: `process.env.NODE_ENV === "development"`. */
  dev?: boolean;
  /** Nonce source (tests). Default {@link createNonce}. */
  nonce?: () => string;
}

/**
 * Next's `proxy` function: a fresh nonce per request, the CSP on the forwarded request (Next reads
 * the nonce from it and stamps its own scripts), `x-nonce` for the root layout, and the CSP on the
 * response.
 *
 * ```ts
 * // proxy.ts
 * export const proxy = createProxy({
 *   NextResponse,
 *   policy: ({ nonce, dev }) => contentSecurityPolicy({ nonce, dev, apiOrigin: publicEnv.apiUrl }),
 * });
 * export const config = { matcher: [...] }; // a static literal: Next reads it at build time
 * ```
 */
export function createProxy<
  TRequest extends ProxyRequest = ProxyRequest,
  TResponse extends { headers: Headers } = { headers: Headers },
>(options: CreateProxyOptions<TRequest, TResponse>): (request: TRequest) => TResponse {
  const { NextResponse, policy } = options;
  return (request) => {
    const nonce = (options.nonce ?? createNonce)();
    const dev =
      options.dev ??
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.NODE_ENV === "development";
    const csp = policy({ nonce, dev, request });
    const headers = new Headers(request.headers);
    headers.set(NONCE_HEADER, nonce);
    headers.set(CSP_HEADER, csp);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set(CSP_HEADER, csp);
    return response;
  };
}
