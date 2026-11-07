/**
 * `./edge-cache`: an explicit public route list gets an edge lifetime and NOTHING else can match
 * it (dynamic first segments exclude every reserved app segment); purges after edits coalesce.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARE_CDN_CACHE_CONTROL,
  cloudflareEdge,
  cloudflareEdgeFromEnv,
  purgeEdgeHost,
} from "../../src/edge-cache/cloudflare.js";
import {
  CDN_CACHE_CONTROL,
  createEdgePurger,
  type EdgeProvider,
  edgeCacheControl,
  edgePageHeaders,
  edgeRouteMatcher,
  reservedSegments,
} from "../../src/edge-cache/index.js";

const appDir = mkdtempSync(path.join(tmpdir(), "edge-app-"));
for (const dir of [
  "(auth)/sign-in",
  "(dashboard)/dashboard/courses",
  "(site)/courses",
  "(site)/[creatorSlug]/courses/[courseSlug]",
  "api/health",
  "_components",
  "@modal",
]) {
  mkdirSync(path.join(appDir, dir), { recursive: true });
}
afterAll(() => rmSync(appDir, { recursive: true, force: true }));

describe("edgeCacheControl", () => {
  it("builds the directive and rejects nonsense", () => {
    expect(edgeCacheControl({ maxAge: 3600, staleWhileRevalidate: 86_400 })).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(() => edgeCacheControl({ maxAge: -1 })).toThrow(/maxAge/);
  });
});

describe("reservedSegments", () => {
  it("walks route groups; skips private, dynamic and parallel-route folders", async () => {
    expect(await reservedSegments(appDir)).toEqual(["api", "courses", "dashboard", "sign-in"]);
  });
});

describe("edgePageHeaders", () => {
  const policy = { maxAge: 3600, staleWhileRevalidate: 86_400 };

  it("refuses a dynamic first segment without the reserved list (fail closed)", () => {
    expect(() => edgePageHeaders({ routes: ["/:creator"], policy })).toThrow(/reserved/);
  });

  it("caches only the listed routes and never a reserved or file-like path", async () => {
    const reserved = await reservedSegments(appDir);
    const rules = edgePageHeaders({
      routes: ["/", "/courses/:path*", "/:creator", "/:creator/courses/:slug"],
      policy,
      header: CLOUDFLARE_CDN_CACHE_CONTROL,
      reserved,
    });
    expect(rules.every((r) => r.headers[0]!.key === "Cloudflare-CDN-Cache-Control")).toBe(true);
    const cached = edgeRouteMatcher(rules.map((r) => r.source));

    for (const p of ["/", "/courses", "/courses/math/algebra", "/jane", "/jane/courses/algebra"]) {
      expect(cached(p), p).toBe(true);
    }
    for (const p of [
      "/dashboard",
      "/dashboard/courses",
      "/sign-in",
      "/api/health",
      "/favicon.ico",
      "/jane/settings",
      "/jane/courses/algebra/edit",
    ]) {
      expect(cached(p), p).toBe(false);
    }
    // A creator slug that merely STARTS with a reserved word is still a creator.
    expect(cached("/dashboarding")).toBe(true);
  });

  it("defaults to the standard CDN-Cache-Control header", () => {
    const [rule] = edgePageHeaders({ routes: ["/"], policy: { maxAge: 60 } });
    expect(rule!.headers).toEqual([{ key: CDN_CACHE_CONTROL, value: "public, max-age=60" }]);
  });

  // Every Next (path-to-regexp v6) form a first segment can take. Each is dynamic, so it needs
  // `reserved`; with it the emitted source must keep the public path and lose every app path.
  const reservedList = ["api", "courses", "dashboard", "sign-in", "u-admin"];
  const appPaths = [
    "/dashboard",
    "/Dashboard",
    "/dashboard/",
    "/dashboard/courses",
    "/sign-in",
    "/api/x",
    "/favicon.ico",
    "//dashboard",
  ];
  const leadingForms: Array<{ route: string; publicPaths: string[]; alsoBlocked?: string[] }> = [
    { route: "/:creator", publicPaths: ["/jane"] },
    { route: "/:creator?", publicPaths: ["/jane"] },
    { route: "/:creator*", publicPaths: ["/jane", "/jane/notes"] },
    { route: "/:creator+", publicPaths: ["/jane", "/jane/notes"] },
    { route: "/:path*", publicPaths: ["/jane/notes/a"] },
    { route: "/:creator(.*)", publicPaths: ["/jane", "/jane/notes"] },
    { route: "/:creator([a-z-]+)", publicPaths: ["/jane", "/sign-up"] },
    { route: "/(.*)", publicPaths: ["/jane", "/jane/notes"] },
    { route: "/{:creator}", publicPaths: ["/jane"] },
    { route: "/{:creator}?", publicPaths: ["/jane"] },
    { route: "/u-:id", publicPaths: ["/u-jane"], alsoBlocked: ["/u-admin", "/u-admin/x"] },
    { route: "/:creator/courses/:slug", publicPaths: ["/jane/courses/algebra"] },
    {
      route: "/:creator?/courses",
      publicPaths: ["/jane/courses"],
      // Skipping the optional first segment would put `courses` (reserved) first.
      alsoBlocked: ["/courses"],
    },
  ];

  it.each(leadingForms)("refuses a leading $route without reserved", ({ route }) => {
    expect(() => edgePageHeaders({ routes: [route], policy })).toThrow(/reserved/);
  });

  it.each(leadingForms)(
    "excludes reserved segments from a leading $route",
    ({ route, publicPaths, alsoBlocked = [] }) => {
      const rules = edgePageHeaders({ routes: [route], policy, reserved: reservedList });
      const cached = edgeRouteMatcher(rules.map((r) => r.source));
      for (const p of publicPaths) expect(cached(p), `${route} keeps ${p}`).toBe(true);
      for (const p of [...appPaths, ...alsoBlocked]) {
        expect(cached(p), `${route} must not match ${p}`).toBe(false);
      }
    },
  );

  it.each(["/*", "/{:creator}*", "/{:creator}+", "/:creator(", "/:", "/(?:x)", "/(a(b))"])(
    "throws on %s, which Next cannot parse",
    (route) => {
      expect(() => edgePageHeaders({ routes: [route], policy, reserved: reservedList })).toThrow(
        /edgePageHeaders/,
      );
    },
  );

  it("leaves routes with a static first segment unchanged", () => {
    const routes = ["/", "/courses/:path*", "/blog/:slug?", "/about", "/c/{:x}?"];
    const rules = edgePageHeaders({ routes, policy });
    expect(rules.map((r) => r.source)).toEqual(routes);
  });

  // A first-segment parameter that only names literal sections is static: those sections are
  // explicit choices (and usually reserved app folders), so no reserved exclusion applies.
  const sectionsReserved = ["courses", "dashboard", "practice", "questions", "sign-in"];
  const literalSections: Array<{ route: string; publicPaths: string[] }> = [
    {
      route: "/:section(courses|practice|questions)",
      publicPaths: ["/courses", "/practice", "/questions", "/Practice/"],
    },
    {
      route: "/:section(courses|practice|questions)/:path*",
      publicPaths: ["/courses", "/practice/ssc/physics", "/questions/a"],
    },
    { route: "/(courses|practice)+", publicPaths: ["/courses", "/courses/practice"] },
  ];

  it.each(literalSections)(
    "treats the literal sections of $route as static",
    ({ route, publicPaths }) => {
      for (const reserved of [undefined, sectionsReserved]) {
        const rules = edgePageHeaders({ routes: [route], policy, reserved });
        expect(rules.map((r) => r.source)).toEqual([route]);
        const cached = edgeRouteMatcher(rules.map((r) => r.source));
        for (const p of publicPaths) expect(cached(p), `${route} keeps ${p}`).toBe(true);
        for (const p of ["/dashboard", "/sign-in", "/api/x", "/jane", "/coursesx", "/"]) {
          expect(cached(p), `${route} must not match ${p}`).toBe(false);
        }
      }
    },
  );

  it.each([
    "/:section(courses|practice|q-[0-9]+)",
    "/:section(courses|(?:practice))",
    "/:section(courses|practice)?",
    "/:section(courses|practice)-:id",
  ])("still requires reserved for %s, which is not provably literal", (route) => {
    expect(() => edgePageHeaders({ routes: [route], policy })).toThrow(/reserved/);
  });

  it("excludes reserved sections from a mixed alternation, keeping its regex piece", () => {
    const rules = edgePageHeaders({
      routes: ["/:section(courses|practice|q-[0-9]+)"],
      policy,
      reserved: sectionsReserved,
    });
    const cached = edgeRouteMatcher(rules.map((r) => r.source));
    expect(cached("/q-12")).toBe(true);
    for (const p of ["/courses", "/practice", "/dashboard"]) expect(cached(p), p).toBe(false);
    // Two groups side by side are one segment (`dashboardx`), not a reserved name: still emitted.
    const [joined] = edgePageHeaders({
      routes: ["/:s((?:dashboard)(?:x))"],
      policy,
      reserved: sectionsReserved,
    });
    expect(edgeRouteMatcher([joined!.source])("/dashboardx")).toBe(true);
  });

  it.each([
    "/:section((?:dashboard)|(?:sign-in))",
    "/:section(dashboard|(?:Sign-In))/:path*",
    "/:file((?:favicon\\.ico))",
  ])("throws when reserved exclusions leave %s matching nothing", (route) => {
    expect(() => edgePageHeaders({ routes: [route], policy, reserved: sectionsReserved })).toThrow(
      /matches nothing/,
    );
  });
});

describe("edgeRouteMatcher", () => {
  it("matches like Next headers(): case-insensitive, optional trailing slash", () => {
    const cached = edgeRouteMatcher(["/courses/:path*", "/about"]);
    for (const p of ["/courses", "/courses/", "/Courses/a/b", "/about", "/ABOUT/"]) {
      expect(cached(p), p).toBe(true);
    }
    for (const p of ["/coursesx", "/about/x", "/", "/abou"]) expect(cached(p), p).toBe(false);
  });

  it("understands unnamed groups, {} groups and modifiers", () => {
    const cached = edgeRouteMatcher(["/files/(.*)", "/blog{/:slug}?", "/v{-:n}+"]);
    for (const p of ["/files/a/b.pdf", "/blog", "/blog/hello", "/v-1-2"]) {
      expect(cached(p), p).toBe(true);
    }
    for (const p of ["/blog/a/b", "/v", "/v1"]) expect(cached(p), p).toBe(false);
  });

  it("throws on a source Next cannot parse", () => {
    expect(() => edgeRouteMatcher(["/:creator("])).toThrow(/edgeRouteMatcher/);
  });
});

describe("createEdgePurger", () => {
  const provider = (purge = vi.fn(async () => {})): EdgeProvider & { purge: typeof purge } => ({
    name: "fake",
    header: "X",
    purge,
  });

  it("coalesces a burst into one purge with merged targets", async () => {
    vi.useFakeTimers();
    const p = provider();
    const purger = createEdgePurger({ provider: p, coalesceMs: 5000 });
    const a = purger.purge({ hosts: ["example.com"] });
    const b = purger.purge({ hosts: ["example.com"], tags: ["courses"] });
    const c = purger.purge({ tags: ["courses:c1"] });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(p.purge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await a;
    expect(p.purge).toHaveBeenCalledTimes(1);
    expect(p.purge).toHaveBeenCalledWith({
      hosts: ["example.com"],
      tags: ["courses", "courses:c1"],
    });
    // A later edit starts a new window.
    void purger.purge({ everything: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(p.purge).toHaveBeenLastCalledWith({ everything: true });
    vi.useRealTimers();
  });

  it("never rejects: a failing provider is reported, the edit is not failed", async () => {
    const onError = vi.fn();
    const purger = createEdgePurger({
      provider: provider(
        vi.fn(async () => {
          throw new Error("403");
        }),
      ),
      coalesceMs: 0,
      onError,
    });
    await expect(purger.purge({ hosts: ["x"] })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a provider (no credentials in this environment)", async () => {
    await expect(
      createEdgePurger({ provider: null }).purge({ hosts: ["x"] }),
    ).resolves.toBeUndefined();
  });

  it("flush runs the pending purge at once", async () => {
    const p = provider();
    const purger = createEdgePurger({ provider: p, coalesceMs: 60_000 });
    void purger.purge({ hosts: ["x"] });
    await purger.flush();
    expect(p.purge).toHaveBeenCalledTimes(1);
  });
});

describe("Cloudflare adapter", () => {
  const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });

  it("posts hosts / tags (chunked by 30) / everything to the zone purge endpoint", async () => {
    const fetchMock = vi.fn(async () => ok());
    const cf = cloudflareEdge({ zoneId: "z1", apiToken: "t", fetch: fetchMock as never });
    const tags = Array.from({ length: 31 }, (_, i) => `t${i}`);
    await cf.purge({ hosts: ["example.com"], tags });
    await cf.purge({ everything: true });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe("https://api.cloudflare.com/client/v4/zones/z1/purge_cache");
    expect((calls[0]![1].headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ hosts: ["example.com"] });
    expect(JSON.parse(calls[1]![1].body as string).tags).toHaveLength(30);
    expect(JSON.parse(calls[2]![1].body as string).tags).toEqual(["t30"]);
    expect(JSON.parse(calls[3]![1].body as string)).toEqual({ purge_everything: true });
  });

  it("from env: null without credentials; deploy purge reports instead of throwing", async () => {
    expect(cloudflareEdgeFromEnv({})).toBeNull();
    expect(
      cloudflareEdgeFromEnv({ CLOUDFLARE_ZONE_ID: "z", CLOUDFLARE_PURGE_TOKEN: "t" }),
    ).not.toBeNull();
    const missing = await purgeEdgeHost({ host: "example.com", env: {} });
    expect(missing.ok).toBe(false);
    const refused = await purgeEdgeHost({
      host: "example.com",
      zoneId: "z",
      apiToken: "secret-token",
      fetch: (async () =>
        new Response(JSON.stringify({ errors: [{ message: "bad token" }] }), {
          status: 403,
        })) as never,
    });
    expect(refused).toEqual({
      ok: false,
      message: "example.com: Cloudflare refused the purge (HTTP 403: bad token)",
    });
    expect(refused.message).not.toContain("secret-token");
  });
});
