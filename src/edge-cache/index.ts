/**
 * `@classytic/arc-next/edge-cache`: keep a Next host's PUBLIC pages at the CDN edge, and empty the
 * edge after an edit or a deploy. Provider-neutral; the Cloudflare adapter lives in
 * `@classytic/arc-next/edge-cache/cloudflare`.
 *
 * Three pieces:
 * 1. {@link edgePageHeaders}: `headers()` entries for `next.config` giving an EXPLICIT route list
 *    an edge lifetime. Nothing else is ever cached: a route is cached only when it is listed, and
 *    a listed route whose first segment is dynamic in any form (`/:creator`, `/:path*`, `/(.*)`,
 *    `/{:slug}`, `/u-:id`) is rewritten to exclude the app's reserved segments
 *    ({@link reservedSegments}), or the call throws, so `/dashboard` can never match it. A first
 *    segment that only names literal sections (`/:section(courses|practice)`) is static, and a
 *    route the exclusions would leave matching nothing throws instead of emitting a dead rule.
 * 2. {@link createEdgePurger}: coalesced purges after edits (a burst of saves is one purge),
 *    `after()`-friendly: it returns a promise and never throws.
 * 3. The provider's own purge for deploys (see the Cloudflare adapter's `purgeEdgeHost`).
 *
 * Only pages that are the same for every visitor belong here. An edge header OVERRIDES Next's
 * `no-store` on a dynamic page, which is exactly why the list is explicit. Server-only (next.config,
 * route handlers, server actions); not part of the React Native surface.
 */

import {
  afterLeadingSlash,
  escapeString,
  firstSegmentAlwaysRefused,
  hasStaticFirstSegment,
  parseSource,
  type SourceToken,
  sourceRegExp,
} from "./route-source.js";

// ── Cache-Control ────────────────────────────────────────────────────────────────────────────

/** How long the edge keeps a page (seconds). */
export interface EdgeCachePolicy {
  maxAge: number;
  /** Serve the stale copy while one request refreshes it. */
  staleWhileRevalidate?: number;
  /** Serve the stale copy when the origin errors. */
  staleIfError?: number;
}

/** The standard targeted header (RFC 9213), read by CDNs and stripped before the browser. */
export const CDN_CACHE_CONTROL = "CDN-Cache-Control";

/** `public, max-age=N[, stale-while-revalidate=N][, stale-if-error=N]`. */
export function edgeCacheControl(policy: EdgeCachePolicy): string {
  const int = (name: string, value: number) => {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`edgeCacheControl: ${name} must be a non-negative integer, got ${value}`);
    }
    return value;
  };
  const parts = ["public", `max-age=${int("maxAge", policy.maxAge)}`];
  if (policy.staleWhileRevalidate !== undefined) {
    parts.push(
      `stale-while-revalidate=${int("staleWhileRevalidate", policy.staleWhileRevalidate)}`,
    );
  }
  if (policy.staleIfError !== undefined) {
    parts.push(`stale-if-error=${int("staleIfError", policy.staleIfError)}`);
  }
  return parts.join(", ");
}

// ── Routes ───────────────────────────────────────────────────────────────────────────────────

/** One `next.config` `headers()` rule. */
export interface EdgeHeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

/**
 * Every static first URL segment of a Next `app/` directory (`dashboard`, `sign-in`, `courses`),
 * walking through route groups `(group)`. A dynamic first segment can never be one of these, so a
 * new top-level route is excluded from it automatically. Node only (reads the file system).
 */
export async function reservedSegments(appDir: string): Promise<string[]> {
  // Loaded on call (next.config runs in Node): the module itself stays importable anywhere.
  const fsModule: string = "node:fs";
  const fs = (await import(fsModule)) as {
    readdirSync(
      dir: string,
      opts: { withFileTypes: true },
    ): Array<{ name: string; isDirectory(): boolean }>;
  };
  const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}/${name}`;
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith("(") && name.endsWith(")")) walk(join(dir, name));
      else if (!name.startsWith("_") && !name.startsWith("[") && !name.startsWith("@")) {
        out.add(name);
      }
    }
  };
  walk(appDir);
  return [...out].sort();
}

export interface EdgePageHeadersOptions {
  /**
   * The public routes, as Next `source` patterns: `"/"`, `"/courses/:path*"`, `"/:creator"`,
   * `"/:creator/courses/:slug"`. Only these are cached.
   */
  routes: readonly string[];
  policy: EdgeCachePolicy;
  /** The header the provider reads. Default {@link CDN_CACHE_CONTROL}; Cloudflare's is exported by its adapter. */
  header?: string;
  /**
   * Reserved first segments ({@link reservedSegments}). Required when any route's first segment
   * is dynamic (a parameter, regex or group in any form): such a route is rewritten into one
   * pattern whose first segment can never be reserved, a file name (`favicon.ico`) or empty. A
   * route whose first segment cannot be located (a parameter with no `/` before it) throws, and
   * so does one left matching nothing. `/:section(courses|practice)` names its sections
   * explicitly, so it is static and needs no exclusion.
   */
  reserved?: readonly string[];
}

/**
 * A route whose first segment is dynamic, as one unnamed `source` pattern: `/(GUARD REST)`, where
 * GUARD refuses a first segment that is reserved, holds a `.` (a file) or is empty, and REST is
 * the route after its leading `/`. One shape covers every form (`?`, `*`, `+`, regex, groups,
 * text mixed with a parameter), including a skipped first part that shifts the next one first.
 */
function guardedSource(route: string, reserved: readonly string[]): string {
  const names = reserved.filter((name) => name !== "").map(escapeString);
  const reservedAlternative = names.length ? `(?:${names.join("|")})(?:/|$)|` : "";
  const rest = afterLeadingSlash(parseSource(route));
  const source = `/((?!${reservedAlternative}[^/]*\\.|/)${rest})`;
  // The rewrite must stay one valid `source`: Next parses it with the same grammar.
  const [only, extra] = parseSource(source);
  if (typeof only !== "object" || only.prefix !== "/" || extra !== undefined) {
    throw new TypeError("the rewritten source is not a single pattern");
  }
  return source;
}

/**
 * `next.config` `headers()` entries giving exactly `routes` an edge lifetime.
 *
 * @example
 * // next.config.ts
 * import { edgePageHeaders, reservedSegments } from "@classytic/arc-next/edge-cache";
 * import { CLOUDFLARE_CDN_CACHE_CONTROL } from "@classytic/arc-next/edge-cache/cloudflare";
 * async headers() {
 *   return edgePageHeaders({
 *     routes: ["/", "/courses/:path*", "/:creator", "/:creator/courses/:slug"],
 *     policy: { maxAge: 3600, staleWhileRevalidate: 86_400 },
 *     header: CLOUDFLARE_CDN_CACHE_CONTROL,
 *     reserved: await reservedSegments(path.join(process.cwd(), "app")),
 *   });
 * }
 */
export function edgePageHeaders(options: EdgePageHeadersOptions): EdgeHeaderRule[] {
  const header = options.header ?? CDN_CACHE_CONTROL;
  const value = edgeCacheControl(options.policy);
  return options.routes.map((route) => {
    if (!route.startsWith("/")) {
      throw new Error(`edgePageHeaders: route must start with "/", got ${JSON.stringify(route)}`);
    }
    let tokens: SourceToken[];
    try {
      tokens = parseSource(route);
    } catch (error) {
      throw new Error(`edgePageHeaders: cannot parse ${route}: ${(error as Error).message}`);
    }
    if (hasStaticFirstSegment(tokens)) return { source: route, headers: [{ key: header, value }] };
    if (!options.reserved) {
      throw new Error(
        `edgePageHeaders: ${route} starts with a dynamic segment; pass \`reserved\` ` +
          "(reservedSegments(appDir)) so it cannot match /dashboard, /sign-in and other app routes",
      );
    }
    const reserved = new Set(options.reserved.filter(Boolean).map((name) => name.toLowerCase()));
    const refused = (segment: string) =>
      reserved.has(segment.toLowerCase()) || segment.includes(".");
    if (firstSegmentAlwaysRefused(tokens, refused)) {
      throw new Error(
        `edgePageHeaders: ${route} matches nothing: every first segment it allows is reserved or ` +
          "a file name; list public sections as plain names, e.g. /:section(courses|practice)",
      );
    }
    let source: string;
    try {
      source = guardedSource(route, options.reserved);
    } catch (error) {
      throw new Error(
        `edgePageHeaders: cannot prove ${route} excludes the reserved segments ` +
          `(${(error as Error).message}); start it with a static segment or a / parameter`,
      );
    }
    return { source, headers: [{ key: header, value }] };
  });
}

/**
 * A matcher for Next `source` patterns, compiled the way Next compiles `headers()` sources
 * (path-to-regexp 6: `:name`, `:name(regex)`, `(regex)`, `{...}` groups, `?` `*` `+`;
 * case-insensitive, optional trailing slash). For a host's tests: assert which URLs the edge may
 * keep, e.g. that `/dashboard` and `/sign-in` never match. Throws on a source Next cannot parse.
 */
export function edgeRouteMatcher(sources: readonly string[]): (pathname: string) => boolean {
  const patterns = sources.map((source) => {
    try {
      return sourceRegExp(source);
    } catch (error) {
      throw new Error(`edgeRouteMatcher: cannot parse ${source}: ${(error as Error).message}`);
    }
  });
  return (pathname) => patterns.some((re) => re.test(pathname));
}

// ── Purging ──────────────────────────────────────────────────────────────────────────────────

/** What to empty at the edge. Hosts and tags merge across a coalescing window. */
export interface EdgePurgeTarget {
  hosts?: string[];
  tags?: string[];
  everything?: boolean;
}

/** A CDN that can purge. The Cloudflare adapter returns one. */
export interface EdgeProvider {
  name: string;
  /** The header this CDN reads for its own copy's lifetime (for {@link edgePageHeaders}). */
  header: string;
  purge(target: EdgePurgeTarget): Promise<void>;
}

export interface EdgePurgerOptions {
  /** `null` (no credentials in this environment): every purge resolves at once, the edge copy just expires. */
  provider: EdgeProvider | null;
  /** Edits inside this window share one purge. Default 5000 ms. */
  coalesceMs?: number;
  /** Purge failures never fail an edit; they are reported here (default `console.warn`). */
  onError?: (error: unknown, target: EdgePurgeTarget) => void;
}

export interface EdgePurger {
  /** Schedule a purge, merged with any other in the window. Resolves after it ran; never rejects. */
  purge(target: EdgePurgeTarget): Promise<void>;
  /** Run the pending purge now (tests, shutdown). */
  flush(): Promise<void>;
}

/**
 * Coalesced edge purging after edits. The first call schedules one purge `coalesceMs` later and
 * every call inside that window rides along (targets merge), so a lesson saved five times is one
 * purge. Server-module state by design: coalescing spans requests, and it holds no user data.
 *
 * @example
 * // lib/edge.ts (server)
 * export const edge = createEdgePurger({ provider: cloudflareEdgeFromEnv() });
 * // a server action, after revalidateTag(...)
 * after(() => edge.purge({ hosts: [new URL(SITE_URL).hostname] }));
 */
export function createEdgePurger(options: EdgePurgerOptions): EdgePurger {
  const coalesceMs = options.coalesceMs ?? 5000;
  const onError =
    options.onError ??
    ((error: unknown) => console.warn("[arc-next/edge-cache] purge failed", error));
  let pending: {
    target: Required<EdgePurgeTarget>;
    timer: ReturnType<typeof setTimeout>;
    promise: Promise<void>;
    run: () => void;
  } | null = null;

  const merge = (into: Required<EdgePurgeTarget>, target: EdgePurgeTarget) => {
    for (const host of target.hosts ?? []) if (!into.hosts.includes(host)) into.hosts.push(host);
    for (const tag of target.tags ?? []) if (!into.tags.includes(tag)) into.tags.push(tag);
    if (target.everything) into.everything = true;
  };

  return {
    purge(target) {
      const provider = options.provider;
      if (!provider) return Promise.resolve();
      if (!pending) {
        const merged: Required<EdgePurgeTarget> = { hosts: [], tags: [], everything: false };
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        const run = () => {
          if (pending?.promise !== promise) return;
          clearTimeout(pending.timer);
          pending = null;
          const final: EdgePurgeTarget = merged.everything
            ? { everything: true }
            : {
                ...(merged.hosts.length ? { hosts: merged.hosts } : {}),
                ...(merged.tags.length ? { tags: merged.tags } : {}),
              };
          provider
            .purge(final)
            .catch((error: unknown) => onError(error, final))
            .finally(resolve);
        };
        pending = { target: merged, timer: setTimeout(run, coalesceMs), promise, run };
      }
      merge(pending.target, target);
      return pending.promise;
    },
    flush() {
      if (!pending) return Promise.resolve();
      const { promise, run } = pending;
      run();
      return promise;
    },
  };
}
