/**
 * Query-key PARITY contract: hooks, option factories and Server Component prefetch build keys from
 * ONE factory (`createQueryKeys`), so the same logical read is the same cache entry everywhere.
 * A drift fails silently in production (the prefetch that never hydrates), so it is pinned here:
 * the documented key shapes, and keys read back from caches that rendered hooks populated.
 *
 * Every key carries the full identity partition `{ auth, organizationId, scope }` (`null` for none,
 * a fixed shape so a prefix filter on it is exact); an `organizationId` in params is a filter.
 */

import { hashKey, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import { configureAuth, createClient } from "../../src/client/client.js";
import { createQueryKeys } from "../../src/query/cache.js";
import { createCrudHooks } from "../../src/query/hooks.js";
import {
  createEntityQueries,
  type EntityApi,
  type QueryFnContext,
} from "../../src/query/query-options.js";
import { createFakeArc } from "../harness/fake-arc.js";

const KEYS = createQueryKeys("products");

const stubApi: EntityApi = {
  getAll: async () => ({ method: "offset", data: [], page: 1, hasNext: false }),
  getById: async () => ({ _id: "p1" }),
  count: async () => 3,
  getBySlug: async () => ({ _id: "p1" }),
  getDeleted: async () => ({ data: [] }),
  getTree: async () => [],
  getChildren: async () => ({ data: [] }),
  aggregate: async () => ({ rows: [] }),
};
const Q = createEntityQueries(stubApi, "products");

const CASES: Array<{ label: string; org: string | null; rest: Record<string, unknown> }> = [
  { label: "org-less (public storefront)", org: null, rest: {} },
  { label: "org-less with params", org: null, rest: { limit: 20, status: "active" } },
  { label: "tenant-scoped", org: "org_1", rest: {} },
  { label: "tenant-scoped with params", org: "org_1", rest: { limit: 20 } },
];

/** The partition segment every key carries in full. */
const P = (
  over: Partial<{ auth: string; organizationId: string | null; scope: string | null }>,
) => ({
  auth: "inherit",
  organizationId: null,
  scope: null,
  ...over,
});

describe("key shapes (the documented contract)", () => {
  it("list / infinite / count / presets carry the partition, then params", () => {
    expect(Q.list({ limit: 5 }).queryKey).toEqual(["products", "list", P({}), { limit: 5 }]);
    expect(Q.list({ limit: 5 }, { organizationId: "o" }).queryKey).toEqual([
      "products",
      "list",
      P({ organizationId: "o" }),
      { limit: 5 },
    ]);
    expect(Q.list({ limit: 5 }, { organizationId: null }).queryKey).toEqual([
      "products",
      "list",
      P({}),
      { limit: 5 },
    ]);
    expect(Q.infiniteList({}).queryKey).toEqual(["products", "list", P({}), {}, "infinite"]);
    expect(Q.count({ status: "a" }).queryKey).toEqual([
      "products",
      "count",
      P({}),
      { status: "a" },
    ]);
    expect(Q.tree({}).queryKey).toEqual(["products", "tree", P({}), {}]);
    expect(Q.deleted({}).queryKey).toEqual(["products", "deleted", P({}), {}]);
    expect(Q.children("c1").queryKey).toEqual(["products", "children", "c1", P({}), {}]);
  });

  it("detail: partition, then params; detail(id) alone prefixes every variant", () => {
    expect(Q.detail("p1").queryKey).toEqual(["products", "detail", "p1", P({})]);
    expect(Q.detail("p1", { organizationId: "o" }).queryKey).toEqual([
      "products",
      "detail",
      "p1",
      P({ organizationId: "o" }),
    ]);
    expect(Q.detail("p1", { params: { select: "name" } }).queryKey).toEqual([
      "products",
      "detail",
      "p1",
      P({}),
      { select: "name" },
    ]);
    expect(KEYS.detail("p1")).toEqual(["products", "detail", "p1"]);
  });

  it("aggregation keys are partitioned; aggregations(name) prefixes every variant", () => {
    expect(Q.aggregation("sales", { from: "x" }, { organizationId: "o" }).queryKey).toEqual([
      "products",
      "aggregation",
      "sales",
      P({ organizationId: "o" }),
      { from: "x" },
    ]);
    expect(KEYS.aggregations("sales")).toEqual(["products", "aggregation", "sales"]);
  });

  it("an anonymous read (auth: omit) is its own entry and drops the org", () => {
    const anon = Q.list({ limit: 5 }, { organizationId: "o", auth: "omit" }).queryKey;
    expect(anon).toEqual(["products", "list", P({ auth: "omit" }), { limit: 5 }]);
    expect(hashKey(anon)).not.toBe(hashKey(Q.list({ limit: 5 }).queryKey));
    expect(Q.detail("p1", { auth: "omit" }).queryKey).toEqual([
      "products",
      "detail",
      "p1",
      P({ auth: "omit" }),
    ]);
  });

  it("a resource with readAuth: omit keys every read as anonymous (server and client agree)", () => {
    const R = createEntityQueries({ ...stubApi, config: { readAuth: "omit" } } as never, "catalog");
    expect(R.anonymousReads).toBe(true);
    expect(R.list({ limit: 5 }, { organizationId: "o", token: "t" }).queryKey).toEqual([
      "catalog",
      "list",
      P({ auth: "omit" }),
      { limit: 5 },
    ]);
  });

  it("an organizationId param is a filter and the ctx org is the tenant: they never alias", () => {
    expect(
      Q.list({ organizationId: "org_A", limit: 5 }, { organizationId: "org_B" }).queryKey,
    ).toEqual([
      "products",
      "list",
      P({ organizationId: "org_B" }),
      { organizationId: "org_A", limit: 5 },
    ]);
    expect(hashKey(Q.list({ organizationId: "org_A" }).queryKey)).not.toBe(
      hashKey(Q.list({}, { organizationId: "org_A" }).queryKey),
    );
  });

  it("all CRUD writes share one mutation key", () => {
    expect(Q.create().mutationKey).toEqual(["products", "write"]);
    expect(Q.update().mutationKey).toEqual(["products", "write"]);
    expect(Q.remove().mutationKey).toEqual(["products", "write"]);
    expect(Q.update().meta).toEqual({ arc: { entity: "products", op: "update" } });
  });
});

// Every input that changes the response is in the key (eslint-plugin-query exhaustive-deps):
// the identity a read is sent as is resolved BEFORE the key is built, from the same source the
// transport uses, so two request contexts never share one cache entry.
describe("identity partition: resolved before the key is built", () => {
  afterEach(() => configureAuth({ getToken: () => null, getOrgId: () => null }));

  const tenantApi = (getOrgId: () => string | null) => {
    const arc = createFakeArc({ resources: { products: [{ _id: "p1", title: "x" }] } });
    const client = createClient({ baseUrl: "http://api.test", fetch: arc.fetch, getOrgId });
    return { arc, api: createCrudApi<{ _id: string }>("products", { client, basePath: "/api" }) };
  };

  it("an omitted organizationId resolves through the api's client into the key", () => {
    const { api } = tenantApi(() => "tenant-A");
    const F = createEntityQueries(api, "products");
    const inherited = F.detail("p1").queryKey;
    const none = F.detail("p1", { organizationId: null }).queryKey;
    expect(hashKey(inherited)).not.toBe(hashKey(none));
    expect(hashKey(inherited)).toBe(
      hashKey(F.detail("p1", { organizationId: "tenant-A" }).queryKey),
    );
  });

  it("an x-organization-id forwarded in ctx.headers is the tenant of the key", () => {
    const F = createEntityQueries(stubApi, "products");
    const forwarded = F.list({}, { headers: { "X-Organization-Id": "tenant-A" } }).queryKey;
    expect(hashKey(forwarded)).not.toBe(hashKey(F.list({}).queryKey));
    expect(hashKey(forwarded)).toBe(hashKey(F.list({}, { organizationId: "tenant-A" }).queryKey));
  });

  it("the configured org (configureAuth) enters the key of an api on the global transport", () => {
    configureAuth({ getToken: () => "t", getOrgId: () => "tenant-A" });
    const F = createEntityQueries(stubApi, "products");
    expect(hashKey(F.list({}).queryKey)).toBe(
      hashKey(F.list({}, { organizationId: "tenant-A" }).queryKey),
    );
  });

  it("the queryFn sends the org the key was built for, not one re-resolved later", async () => {
    let org: string | null = "tenant-A";
    const { arc, api } = tenantApi(() => org);
    const F = createEntityQueries(api, "products");
    const o = F.detail("p1");
    org = "tenant-B";
    await (o.queryFn as (ctx: unknown) => Promise<unknown>)({
      signal: new AbortController().signal,
    });
    expect(arc.last().headers["x-organization-id"]).toBe("tenant-A");
  });

  it("two clients (tenants) prefetching into one QueryClient never share an entry", async () => {
    const a = tenantApi(() => "tenant-A");
    const b = tenantApi(() => "tenant-B");
    a.arc.tables.get("products")![0]!.title = "A's";
    b.arc.tables.get("products")![0]!.title = "B's";
    const FA = createEntityQueries(a.api, "products");
    const FB = createEntityQueries(b.api, "products");
    const qc = new QueryClient();
    await qc.prefetchQuery(FA.detail("p1"));
    await qc.prefetchQuery(FB.detail("p1"));
    await qc.prefetchQuery(FA.list({}));
    await qc.prefetchQuery(FB.list({}));
    expect(qc.getQueryCache().getAll()).toHaveLength(4);
    expect(qc.getQueryData(FA.detail("p1").queryKey)).toEqual(
      expect.objectContaining({ title: "A's" }),
    );
    expect(qc.getQueryData(FB.detail("p1").queryKey)).toEqual(
      expect.objectContaining({ title: "B's" }),
    );
  });

  it("scope separates every key kind, single-record keys included", () => {
    const F = createEntityQueries(stubApi, "products");
    const kinds: Array<(ctx: QueryFnContext) => readonly unknown[]> = [
      (ctx) => F.list({}, ctx).queryKey,
      (ctx) => F.infiniteList({}, ctx).queryKey,
      (ctx) => F.detail("p1", ctx).queryKey,
      (ctx) => F.bySlug("s1", ctx).queryKey,
      (ctx) => F.count({}, ctx).queryKey,
      (ctx) => F.deleted({}, ctx).queryKey,
      (ctx) => F.tree({}, ctx).queryKey,
      (ctx) => F.children("c1", {}, ctx).queryKey,
      (ctx) => F.aggregation("sales", {}, ctx).queryKey,
      (ctx) => F.route("/stats", ctx).queryKey,
    ];
    for (const key of kinds) {
      expect(hashKey(key({ scope: "A" }))).not.toBe(hashKey(key({ scope: "B" })));
      expect(hashKey(key({ scope: "A" }))).not.toBe(hashKey(key({})));
    }
  });
});

describe("tenant context vs filter params (they never alias)", () => {
  type Call = {
    params?: Record<string, unknown>;
    token?: string | null;
    organizationId?: string | null;
    options?: object;
  };
  const recording = () => {
    const getAll = vi.fn(async (_opts: Call) => ({ method: "offset", data: [] }));
    return { getAll, F: createEntityQueries({ ...stubApi, getAll }, "products") };
  };
  const run = (o: { queryFn?: unknown }) =>
    (o.queryFn as (ctx: unknown) => Promise<unknown>)({ signal: new AbortController().signal });

  it("signed in: the filter stays in params, the tenant is forwarded separately", async () => {
    const { getAll, F } = recording();
    await run(F.list({ organizationId: "org_filter", limit: 5 }, { organizationId: "org_tenant" }));
    const call = getAll.mock.calls[0]![0];
    expect(call.params).toEqual({ organizationId: "org_filter", limit: 5 });
    expect(call.organizationId).toBe("org_tenant");
  });

  it("anonymous (auth: omit): the filter is still sent; no tenant is", async () => {
    const { getAll, F } = recording();
    const o = F.list({ organizationId: "org_filter" }, { organizationId: "o", auth: "omit" });
    expect(o.queryKey).toEqual([
      "products",
      "list",
      P({ auth: "omit" }),
      { organizationId: "org_filter" },
    ]);
    await run(o);
    const call = getAll.mock.calls[0]![0];
    expect(call.params).toEqual({ organizationId: "org_filter" });
    expect(call.organizationId).toBeUndefined();
    expect(call.options).toEqual(expect.objectContaining({ auth: "omit" }));
  });

  it("readAuth: omit resource: the filter is still sent", async () => {
    const getAll = vi.fn(async (_opts: Call) => ({ method: "offset", data: [] }));
    const R = createEntityQueries(
      { ...stubApi, getAll, config: { readAuth: "omit" } } as never,
      "c",
    );
    await run(R.list({ organizationId: "org_filter" }, { organizationId: "o" }));
    expect(getAll.mock.calls[0]![0].params).toEqual({ organizationId: "org_filter" });
    expect(getAll.mock.calls[0]![0].organizationId).toBeUndefined();
  });

  it("ctx org: omitted sends the resolved default (the key's), null sends 'none'", async () => {
    const { getAll, F } = recording();
    configureAuth({ getToken: () => "t", getOrgId: () => "org_default" });
    try {
      await run(F.list({}));
      await run(F.list({}, { organizationId: null, token: null }));
    } finally {
      configureAuth({ getToken: () => null, getOrgId: () => null });
    }
    expect(getAll.mock.calls[0]![0].organizationId).toBe("org_default");
    expect(getAll.mock.calls[0]![0].token).toBeUndefined();
    expect(getAll.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ organizationId: null, token: null }),
    );
  });
});

describe("custom routes: route() / routeMutation()", () => {
  type RouteCall = {
    method?: string;
    path: string;
    params?: Record<string, unknown>;
    data?: unknown;
    token?: string | null;
    organizationId?: string | null;
    options?: { signal?: AbortSignal; auth?: string };
  };
  const make = () => {
    const invokeRoute = vi.fn(async (_opts: RouteCall) => ({ ok: true }));
    return { invokeRoute, F: createEntityQueries({ ...stubApi, invokeRoute }, "iam") };
  };

  it("route(): key under routes(), GET through invokeRoute with the abort signal", async () => {
    const { invokeRoute, F } = make();
    const o = F.route<{ ok: boolean }>("me", { params: { expand: "roles" }, organizationId: null });
    expect(o.queryKey).toEqual(["iam", "route", "/me", P({}), { expand: "roles" }]);
    expect(KEYS.routes()).toEqual(["products", "route"]);
    const signal = new AbortController().signal;
    await (o.queryFn as (ctx: unknown) => Promise<unknown>)({ signal });
    expect(invokeRoute).toHaveBeenCalledWith({
      method: "GET",
      path: "me",
      params: { expand: "roles" },
      token: undefined,
      organizationId: null,
      options: { signal },
    });
  });

  it("route(): tenant in the partition, staleTime override, anonymous variant", () => {
    const { F } = make();
    expect(F.route("/stats", { organizationId: "o", staleTime: 60_000 })).toEqual(
      expect.objectContaining({
        queryKey: ["iam", "route", "/stats", P({ organizationId: "o" }), {}],
        staleTime: 60_000,
      }),
    );
    expect(F.route("/stats", { auth: "omit", organizationId: "o" }).queryKey).toEqual([
      "iam",
      "route",
      "/stats",
      P({ auth: "omit" }),
      {},
    ]);
  });

  it("routeMutation(): fills :segments, sends body/params, shares one key per template", async () => {
    const { invokeRoute, F } = make();
    const m = F.routeMutation<{ ok: boolean }, { note: string }>("/:id/approve");
    expect(m.mutationKey).toEqual(["iam", "route", "/:id/approve", "POST"]);
    const fn = m.mutationFn as (v: unknown) => Promise<unknown>;
    await fn({ pathParams: { id: "o 1" }, data: { note: "x" }, organizationId: null });
    expect(invokeRoute).toHaveBeenCalledWith({
      method: "POST",
      path: "/o%201/approve",
      data: { note: "x" },
      token: undefined,
      organizationId: null,
    });
    expect(() => fn({})).toThrow(/pathParams\.id/);
  });

  it("routeMutation(): invalidates runs the scoped change rule or exact keys on success", async () => {
    const { F } = make();
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const change = F.routeMutation<{ _id: string }>("/:id/approve", {
      method: "PATCH",
      invalidates: (doc) => ({ op: "update", id: doc._id }),
    });
    await (change.onSuccess as (...a: unknown[]) => Promise<void>)({ _id: "p1" }, {}, undefined, {
      client,
    });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual(
      expect.arrayContaining([
        ["iam", "list"],
        ["iam", "detail", "p1"],
      ]),
    );
    spy.mockClear();
    const keyed = F.routeMutation("/recompute", { invalidates: () => [F.keys.routes()] });
    await (keyed.onSuccess as (...a: unknown[]) => Promise<void>)({}, {}, undefined, { client });
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([["iam", "route"]]);
    expect(F.routeMutation("/x").onSuccess).toBeUndefined();
  });
});

describe("infinite list page semantics", () => {
  it("offset hasNext -> page+1, keyset -> cursor", () => {
    const opts = Q.infiniteList();
    expect(opts.initialPageParam).toBe(1);
    const next = opts.getNextPageParam as (page: unknown) => unknown;
    expect(next({ method: "offset", hasNext: true, page: 2 })).toBe(3);
    expect(next({ method: "offset", hasNext: false, page: 9 })).toBeUndefined();
    expect(next({ method: "keyset", hasMore: true, next: "cur_9" })).toBe("cur_9");
    expect(next({ method: "keyset", hasMore: false, next: null })).toBeUndefined();
  });

  it("sends the page param as arc parses it (cursor -> after, page -> page)", async () => {
    const getAll = vi.fn(async () => ({ data: [] }));
    const F = createEntityQueries({ ...stubApi, getAll }, "products");
    const opts = F.infiniteList({ limit: 5 });
    const run = (pageParam: unknown) =>
      (opts.queryFn as (ctx: unknown) => Promise<unknown>)({
        pageParam,
        signal: new AbortController().signal,
      });
    await run("cur_9");
    expect(getAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { limit: 5, after: "cur_9" } }),
    );
    await run(2);
    expect(getAll).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { limit: 5, page: 2 } }),
    );
    expect(F.infiniteList({ after: "cur_1" }).initialPageParam).toBe("cur_1");
  });
});

// Real hooks: keys read back from the cache a rendered hook populated, so a hook that stopped
// using the factory fails here.
describe("rendered hook ↔ factory key parity", () => {
  afterEach(() => configureAuth({ getToken: () => null, getOrgId: () => null }));

  const render = <R>(org: string | null, use: (h: ReturnType<typeof makeHooks>) => R) => {
    configureAuth({ getToken: () => "t", getOrgId: () => org });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hooks = makeHooks();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(React.Suspense, { fallback: null }, children),
      );
    renderHook(() => use(hooks), { wrapper });
    return qc;
  };
  const makeHooks = () =>
    createCrudHooks<{ _id: string }>({
      api: stubApi as never,
      entityKey: "products",
      singular: "Product",
    });
  const onlyHash = async (qc: QueryClient) => {
    await waitFor(() => expect(qc.getQueryCache().getAll()).toHaveLength(1));
    return qc.getQueryCache().getAll()[0]!.queryHash;
  };

  for (const { label, org, rest } of [
    ...CASES,
    { label: "explicit organizationId: null", org: null, rest: { organizationId: null, limit: 5 } },
  ]) {
    it(`useList / useSuspenseList / useInfiniteList / useCount — ${label}`, async () => {
      const ctx = { organizationId: org };
      expect(await onlyHash(render(org, (h) => h.useList(rest)))).toBe(
        hashKey(Q.list(rest, ctx).queryKey),
      );
      expect(await onlyHash(render(org, (h) => h.useSuspenseList(rest)))).toBe(
        hashKey(Q.list(rest, ctx).queryKey),
      );
      expect(await onlyHash(render(org, (h) => h.useInfiniteList(rest)))).toBe(
        hashKey(Q.infiniteList(rest, ctx).queryKey),
      );
      expect(await onlyHash(render(org, (h) => h.useCount(rest)))).toBe(
        hashKey(Q.count(rest, ctx).queryKey),
      );
    });
  }

  it("useDetail (tenant + params) and an anonymous useList", async () => {
    expect(
      await onlyHash(render("org_1", (h) => h.useDetail("p1", { params: { select: "name" } }))),
    ).toBe(
      hashKey(Q.detail("p1", { organizationId: "org_1", params: { select: "name" } }).queryKey),
    );
    expect(await onlyHash(render("org_1", (h) => h.useList({ limit: 5 }, { auth: "omit" })))).toBe(
      hashKey(Q.list({ limit: 5 }, { auth: "omit" }).queryKey),
    );
  });

  it("hooks.queries is the same factory the hooks use", () => {
    const hooks = makeHooks();
    expect(hooks.queries.list({ a: 1 }).queryKey).toEqual(Q.list({ a: 1 }).queryKey);
    expect(hooks.KEYS).toBe(hooks.queries.keys);
  });
});
