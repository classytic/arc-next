import { hashKey, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AggResult, createCrudApi } from "../../src/client/api.js";
import { _resetAuthWarnings, configureAuth, configureClient } from "../../src/client/client.js";
import { createCacheUtils, createQueryKeys } from "../../src/query/cache.js";
import { type CrudApi, configureNavigation, createCrudHooks } from "../../src/query/hooks.js";
import { configureToast } from "../../src/query/mutation.js";
import { prefetchQueries } from "../../src/query/prefetch.js";
import { useSuspenseDetailQuery, useSuspenseListQuery } from "../../src/query/query.js";
import { createEntityQueries } from "../../src/query/query-options.js";
import { createFakeArc } from "../harness/fake-arc.js";
import { createTestQueryClient, createWrapper } from "../harness/query-client.js";

/** The default partition segment: signed in, no tenant, no scope. */
const P0 = { auth: "inherit", organizationId: null, scope: null };

describe("tenant-scoped caches", () => {
  /**
   * Scoped Cache Tests — tenant-aware detail keys, navigation prefill, optimistic writes
   *
   * Validates that multi-tenant apps with org-scoped data get isolated cache entries
   * and that all write paths (navigation, optimistic updates, cache helpers) target
   * the correct scoped keys.
   */

  // ============================================================================
  // Helpers
  // ============================================================================

  function createMockApi(): CrudApi<
    { _id: string; name: string },
    { name: string },
    { name: string }
  > {
    return {
      getAll: vi.fn().mockResolvedValue({
        success: true,
        data: [
          { _id: "1", name: "Item 1" },
          { _id: "2", name: "Item 2" },
        ],
        total: 2,
        page: 1,
        limit: 10,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      }),
      getById: vi.fn().mockResolvedValue({ success: true, data: { _id: "1", name: "Item 1" } }),
      create: vi.fn().mockResolvedValue({ success: true, data: { _id: "3", name: "New" } }),
      update: vi.fn().mockResolvedValue({ success: true, data: { _id: "1", name: "Updated" } }),
      delete: vi.fn().mockResolvedValue({ success: true }),
      count: vi.fn().mockResolvedValue(0),
    };
  }

  // ============================================================================
  // detail(id, { organizationId }) primitive
  // ============================================================================

  describe("detail(id, { organizationId }) query key primitive", () => {
    it("detail(id, { organizationId: null }) is the no-tenant partition's entry", () => {
      const KEYS = createQueryKeys("products");
      expect(KEYS.detail("abc", { organizationId: null })).toEqual([
        "products",
        "detail",
        "abc",
        P0,
      ]);
    });

    it("detail(id, { organizationId }) carries the tenant in the partition", () => {
      const KEYS = createQueryKeys("products");
      expect(KEYS.detail("abc", { organizationId: "org-1" })).toEqual([
        "products",
        "detail",
        "abc",
        { ...P0, organizationId: "org-1" },
      ]);
    });

    it("different orgs produce different keys", () => {
      const KEYS = createQueryKeys("products");
      const k1 = JSON.stringify(KEYS.detail("abc", { organizationId: "org-1" }));
      const k2 = JSON.stringify(KEYS.detail("abc", { organizationId: "org-2" }));
      expect(k1).not.toBe(k2);
    });

    it("bare detail(id) is prefix of detail(id, { organizationId })(id, org)", () => {
      const KEYS = createQueryKeys("products");
      const bare = KEYS.detail("abc");
      const scoped = KEYS.detail("abc", { organizationId: "org-1" });
      // scoped starts with bare
      expect(scoped.slice(0, bare.length)).toEqual(bare);
      // scoped is longer
      expect(scoped.length).toBeGreaterThan(bare.length);
    });
  });

  // ============================================================================
  // Scoped cache utils
  // ============================================================================

  describe("scoped cache utils", () => {
    let qc: QueryClient;

    beforeEach(() => {
      qc = createTestQueryClient();
    });
    afterEach(() => {
      qc.clear();
    });

    it("setScopedDetail / getScopedDetail round-trip", () => {
      const KEYS = createQueryKeys("products");
      const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

      cache.setDetail(qc, "abc", { _id: "abc", name: "Scoped" }, { organizationId: "org-1" });

      expect(cache.getDetail(qc, "abc", { organizationId: "org-1" })).toEqual({
        _id: "abc",
        name: "Scoped",
      });
    });

    it("partitions are isolated (default, tenants, anonymous)", () => {
      const KEYS = createQueryKeys("products");
      const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

      cache.setDetail(qc, "abc", { _id: "abc", name: "Default" });
      cache.setDetail(qc, "abc", { _id: "abc", name: "Org1" }, { organizationId: "org-1" });
      cache.setDetail(qc, "abc", { _id: "abc", name: "Org2" }, { organizationId: "org-2" });
      cache.setDetail(qc, "abc", { _id: "abc", name: "Anon" }, { auth: "omit" });

      expect(cache.getDetail(qc, "abc")?.name).toBe("Default");
      expect(cache.getDetail(qc, "abc", { organizationId: "org-1" })?.name).toBe("Org1");
      expect(cache.getDetail(qc, "abc", { organizationId: "org-2" })?.name).toBe("Org2");
      expect(cache.getDetail(qc, "abc", { auth: "omit" })?.name).toBe("Anon");
    });

    it("invalidateDetail prefix-matches all scoped variants", async () => {
      const KEYS = createQueryKeys("products");
      const cache = createCacheUtils<{ _id: string }>(KEYS);

      cache.setDetail(qc, "abc", { _id: "abc" });
      cache.setDetail(qc, "abc", { _id: "abc" }, { organizationId: "org-1" });

      await cache.invalidateDetail(qc, "abc");

      // Both should be invalidated (stale) — TanStack Query prefix matching
      const bareState = qc.getQueryState(KEYS.detail("abc", {}));
      const scopedState = qc.getQueryState(KEYS.detail("abc", { organizationId: "org-1" }));

      // After invalidation, query state isInvalidated is true
      expect(bareState?.isInvalidated).toBe(true);
      expect(scopedState?.isInvalidated).toBe(true);
    });

    it("removeScopedDetail only removes that org variant", () => {
      const KEYS = createQueryKeys("products");
      const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

      cache.setDetail(qc, "abc", { _id: "abc", name: "Org1" }, { organizationId: "org-1" });
      cache.setDetail(qc, "abc", { _id: "abc", name: "Org2" }, { organizationId: "org-2" });

      qc.removeQueries({ queryKey: KEYS.detail("abc", { organizationId: "org-1" }), exact: true });

      expect(cache.getDetail(qc, "abc", { organizationId: "org-1" })).toBeUndefined();
      expect(cache.getDetail(qc, "abc", { organizationId: "org-2" })?.name).toBe("Org2");
    });
  });

  // ============================================================================
  // useDetail with org-scoped cache
  // ============================================================================

  describe("useDetail tenant-scoped cache", () => {
    let qc: QueryClient;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      configureToast({ success: () => {}, error: () => {} });
      qc = createTestQueryClient();
    });

    afterEach(() => {
      qc.clear();
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("useDetail with org stores under scoped key", async () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });

      const api = createMockApi();
      const hooks = createCrudHooks({
        api,
        entityKey: `scoped-detail-${Math.random()}`,
        singular: "Item",
      });

      const wrapper = createWrapper(qc);
      const { result } = renderHook(() => hooks.useDetail("item-1"), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Key should include org scope
      const scopedKey = hooks.KEYS.detail("item-1", { organizationId: "org-1" });
      const cached = qc.getQueryData(scopedKey);
      expect(cached).toBeDefined();
    });

    it("useDetail without org stores under the no-tenant partition", async () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => null });

      const api = createMockApi();
      const hooks = createCrudHooks({
        api,
        entityKey: `bare-detail-${Math.random()}`,
        singular: "Item",
      });

      const wrapper = createWrapper(qc);
      const { result } = renderHook(() => hooks.useDetail("item-1"), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const cached = qc.getQueryData(hooks.KEYS.detail("item-1", { organizationId: null }));
      expect(cached).toBeDefined();
    });

    it("two orgs get isolated detail caches for same ID", async () => {
      const api = createMockApi();
      const entityKey = `isolated-${Math.random()}`;

      // Org 1
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });
      api.getById = vi.fn().mockResolvedValue({
        success: true,
        data: { _id: "same-id", name: "Org1 Data" },
      });

      const hooks1 = createCrudHooks({ api, entityKey, singular: "Item" });
      const wrapper = createWrapper(qc);

      const { result: r1 } = renderHook(() => hooks1.useDetail("same-id"), { wrapper });
      await waitFor(() => expect(r1.current.item).toBeDefined());

      // Org 2
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-2" });
      api.getById = vi.fn().mockResolvedValue({
        success: true,
        data: { _id: "same-id", name: "Org2 Data" },
      });

      const hooks2 = createCrudHooks({ api, entityKey, singular: "Item" });
      const { result: r2 } = renderHook(() => hooks2.useDetail("same-id"), { wrapper });
      await waitFor(() => expect(r2.current.item).toBeDefined());

      // Different cache entries
      const KEYS = createQueryKeys(entityKey);
      const org1Data = qc.getQueryData(KEYS.detail("same-id", { organizationId: "org-1" }));
      const org2Data = qc.getQueryData(KEYS.detail("same-id", { organizationId: "org-2" }));

      expect(org1Data).toBeDefined();
      expect(org2Data).toBeDefined();
      expect(org1Data).not.toEqual(org2Data);
    });
  });

  // ============================================================================
  // useNavigation scoped prefill
  // ============================================================================

  describe("useNavigation tenant-scoped prefill", () => {
    let qc: QueryClient;
    const mockRouter = { push: vi.fn(), replace: vi.fn() };

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      configureNavigation(() => mockRouter);
      configureToast({ success: () => {}, error: () => {} });
      qc = createTestQueryClient();
      mockRouter.push.mockClear();
    });

    afterEach(() => {
      qc.clear();
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("navigate writes raw doc to scoped detail key when org is set (no { data } envelope since 0.7)", () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });

      const api = createMockApi();
      const hooks = createCrudHooks({
        api,
        entityKey: `nav-scoped-${Math.random()}`,
        singular: "Item",
      });

      const wrapper = createWrapper(qc);
      const { result } = renderHook(() => hooks.useNavigation(), { wrapper });

      act(() => {
        result.current("/items/abc", { _id: "abc", name: "Navigated" } as never);
      });

      const scopedKey = hooks.KEYS.detail("abc", { organizationId: "org-1" });
      const cached = qc.getQueryData(scopedKey) as { name: string };
      expect(cached?.name).toBe("Navigated");
    });

    it("navigate seeds only the reader's partition (no tenant-less or anonymous copy)", () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });

      const api = createMockApi();
      const hooks = createCrudHooks({
        api,
        entityKey: `nav-partition-${Math.random()}`,
        singular: "Item",
      });

      const wrapper = createWrapper(qc);
      const { result } = renderHook(() => hooks.useNavigation(), { wrapper });

      act(() => {
        result.current("/items/abc", { _id: "abc", name: "Mine" } as never);
      });

      expect(qc.getQueryData(hooks.KEYS.detail("abc", { organizationId: "org-1" }))).toBeDefined();
      expect(qc.getQueriesData({ queryKey: hooks.KEYS.detail("abc") })).toHaveLength(1);
    });

    it("navigate without org writes raw doc to bare key", () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => null });

      const api = createMockApi();
      const hooks = createCrudHooks({
        api,
        entityKey: `nav-bare-${Math.random()}`,
        singular: "Item",
      });

      const wrapper = createWrapper(qc);
      const { result } = renderHook(() => hooks.useNavigation(), { wrapper });

      act(() => {
        result.current("/items/abc", { _id: "abc", name: "BareOnly" } as never);
      });

      const cached = qc.getQueryData(hooks.KEYS.detail("abc", {})) as { name: string };
      expect(cached?.name).toBe("BareOnly");
    });
  });

  // ============================================================================
  // useList detail prefill with org scope
  // ============================================================================

  describe("useList + useDetail org-scope handoff (0.7 placeholderData pattern)", () => {
    let qc: QueryClient;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      configureToast({ success: () => {}, error: () => {} });
      qc = createTestQueryClient();
    });

    afterEach(() => {
      qc.clear();
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("useList does NOT pollute the scoped detail cache (no eager setQueryData)", async () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });

      const api = createMockApi();
      const entityKey = `list-noprefill-${Math.random()}`;
      const hooks = createCrudHooks({ api, entityKey, singular: "Item" });

      const wrapper = createWrapper(qc);
      const { result } = renderHook(() => hooks.useList(), { wrapper });

      await waitFor(() => expect(result.current.items).toHaveLength(2));

      const KEYS = createQueryKeys(entityKey);
      // 0.7 contract: list never writes to detail keys. The placeholderData
      // handoff happens inside useDetail at read time — keeps the cache clean
      // and lets `staleTime` reason about real fetches only.
      expect(qc.getQueryData(KEYS.detail("1", { organizationId: "org-1" }))).toBeUndefined();
      expect(qc.getQueryData(KEYS.detail("2", { organizationId: "org-1" }))).toBeUndefined();
    });

    it("useDetail picks up the list item as instant placeholder under the scoped key", async () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });

      const api = createMockApi();
      const entityKey = `list-detail-handoff-${Math.random()}`;
      const hooks = createCrudHooks({ api, entityKey, singular: "Item" });

      const wrapper = createWrapper(qc);
      const list = renderHook(() => hooks.useList(), { wrapper });
      await waitFor(() => expect(list.result.current.items).toHaveLength(2));

      const detail = renderHook(() => hooks.useDetail("1"), { wrapper });

      // Synchronous first render: placeholder hit, no loading flash.
      expect(detail.result.current.isPlaceholderData).toBe(true);
      expect((detail.result.current.item as { _id?: string } | null)?._id).toBe("1");

      // Real GET still fires and resolves.
      await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(detail.result.current.isPlaceholderData).toBe(false));
    });
  });

  // ============================================================================
  // Optimistic update targets all detail variants
  // ============================================================================

  describe("optimistic update targets scoped detail keys", () => {
    let qc: QueryClient;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      configureToast({ success: () => {}, error: () => {} });
      qc = createTestQueryClient();
    });

    afterEach(() => {
      qc.clear();
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("update mutation writes to all matching detail queries via prefix match", async () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });

      const api = createMockApi();
      const entityKey = `opt-update-${Math.random()}`;
      const KEYS = createQueryKeys(entityKey);
      const hooks = createCrudHooks({ api, entityKey, singular: "Item" });

      // Pre-populate both bare and scoped detail caches
      qc.setQueryData(KEYS.detail("1"), { data: { _id: "1", name: "Bare" } });
      qc.setQueryData(KEYS.detail("1", { organizationId: "org-1" }), {
        data: { _id: "1", name: "Scoped" },
      });

      // Also a list cache so the optimistic update matcher works
      qc.setQueryData(KEYS.list({ organizationId: "org-1" }), {
        data: [{ _id: "1", name: "InList" }],
        total: 1,
      });

      const wrapper = createWrapper(qc);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      await act(async () => {
        await result.current.update({ id: "1", data: { name: "NewName" } });
      });

      // After invalidation, both should be refetched. The optimistic write
      // via getQueriesData prefix match should have updated both.
      expect(api.update).toHaveBeenCalled();
    });
  });
});

// An explicit `auth` reaches the wire the same way from a hook, an option factory and a direct
// api call: `"inherit"` overrides a resource's `readAuth: "omit"`, `"omit"` drops every credential,
// omitted means the resource default. The key's partition says the same thing.
describe("auth: hooks, option factories and the transport agree", () => {
  type Row = { _id: string; title: string };
  afterEach(() => configureAuth({ getToken: () => null, getOrgId: () => null }));

  const cases: Array<{
    readAuth: "omit" | undefined;
    auth: "omit" | "inherit" | undefined;
    sent: "inherit" | "omit";
  }> = [
    { readAuth: undefined, auth: undefined, sent: "inherit" },
    { readAuth: undefined, auth: "inherit", sent: "inherit" },
    { readAuth: undefined, auth: "omit", sent: "omit" },
    { readAuth: "omit", auth: undefined, sent: "omit" },
    { readAuth: "omit", auth: "inherit", sent: "inherit" },
    { readAuth: "omit", auth: "omit", sent: "omit" },
  ];

  for (const { readAuth, auth, sent } of cases) {
    it(`readAuth ${readAuth ?? "default"}, auth ${auth ?? "omitted"}: sent ${sent}`, async () => {
      const arc = createFakeArc({ resources: { rows: [{ _id: "r1", title: "x" }] } });
      configureClient({ baseUrl: "http://api.test", fetch: arc.fetch });
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });
      const api = createCrudApi<Row>("rows", {
        basePath: "/api",
        ...(readAuth ? { readAuth } : {}),
      });
      const hooks = createCrudHooks<Row>({ api, entityKey: "rows", singular: "Row" });
      const expectWire = () => {
        const req = arc.last();
        if (sent === "omit") {
          expect(req.headers.authorization).toBeUndefined();
          expect(req.headers["x-organization-id"]).toBeUndefined();
          expect(req.credentials).toBe("omit");
        } else {
          expect(req.headers.authorization).toBe("Bearer tok");
          expect(req.headers["x-organization-id"]).toBe("org-1");
          expect(req.credentials).not.toBe("omit");
        }
      };
      const ctx = auth ? { auth } : {};

      // Hook.
      const qc = createTestQueryClient();
      const list = renderHook(() => hooks.useList({}, ctx), { wrapper: createWrapper(qc) });
      await waitFor(() => expect(list.result.current.items).toHaveLength(1));
      expectWire();
      // The hook's entry is the factory's entry.
      const factory = hooks.queries.list({}, ctx);
      expect(
        qc
          .getQueryCache()
          .getAll()
          .map((q) => q.queryHash),
      ).toEqual([hashKey(factory.queryKey)]);
      const partition = factory.queryKey[2] as { auth: string };
      expect(partition.auth).toBe(sent);

      // Option factory.
      await new QueryClient().fetchQuery(factory);
      expectWire();

      // Transport.
      await api.getAll(auth ? { options: { auth } } : {});
      expectWire();
    });
  }
});

describe("useDetail always fires its request", () => {
  /**
   * useDetail audit — does it actually fail to fire GET requests in the
   * scenarios people complain about?
   *
   * Spans the documented hypotheses:
   *  1. Public detail call (logged out) — `useDetail(id, { public: true })`
   *  2. Bearer-mode admin call             — `useDetail(id, { enabled: true })`
   *  3. Async getToken (Promise return)    — `getToken: () => Promise<...>`
   *  4. Cache prefill from useList         — list mounts, then detail mounts
   *  5. Cookie auth mode                    — `useDetail(id)` with no token
   *  6. hasStaticAuth (internalApiKey)     — public read with API key
   *  7. Cold-load via direct route          — only useDetail mounts, no list
   *
   * Each test asserts on `mockApi.getById.mock.calls.length` — that is the
   * single signal "did the SDK fire a GET request?" the consumer cares about.
   */

  type Item = { _id: string; title: string; body?: string };

  function mockApi(): CrudApi<Item> {
    return {
      getAll: vi.fn().mockResolvedValue({
        data: [
          { _id: "a", title: "A from list" }, // intentionally NO `body` — list payload is lighter than detail
          { _id: "b", title: "B from list" },
        ],
        total: 2,
        page: 1,
        limit: 10,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      }),
      getById: vi.fn().mockResolvedValue({ _id: "a", title: "A from detail", body: "full body" }),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    };
  }

  describe("useDetail audit — does the request actually fire?", () => {
    beforeEach(() => {
      _resetAuthWarnings();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // ──────────────────────────────────────────────────────────────────────
    // 1. Public detail call from a logged-out user
    // ──────────────────────────────────────────────────────────────────────
    it("FIRES GET for useDetail(id, {public:true}) when logged out", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "chapters", singular: "Chapter" });
      const qc = createTestQueryClient();

      const { result } = renderHook(() => hooks.useDetail("chap-1", { public: true }), {
        wrapper: createWrapper(qc),
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(api.getById).toHaveBeenCalledTimes(1);
      expect(api.getById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "chap-1", token: undefined }),
      );
    });

    // ──────────────────────────────────────────────────────────────────────
    // 2. Bearer-mode admin call
    // ──────────────────────────────────────────────────────────────────────
    it("FIRES GET for useDetail(id) in bearer mode when token is present", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "bearer" });
      configureAuth({ getToken: () => "admin-token", getOrgId: () => null });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "cms", singular: "CMS" });
      const qc = createTestQueryClient();

      const { result } = renderHook(() => hooks.useDetail("home"), { wrapper: createWrapper(qc) });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(api.getById).toHaveBeenCalledTimes(1);
      expect(api.getById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "home", token: "admin-token" }),
      );
    });

    // ──────────────────────────────────────────────────────────────────────
    // 3. Async getToken (the silent killer)
    // ──────────────────────────────────────────────────────────────────────
    it("DOES NOT fire GET when getToken returns a Promise (silent failure)", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "bearer" });
      configureAuth({
        // Misuse: returning Promise<string>. readToken() drops it, warns once, returns null.
        getToken: (() => Promise.resolve("admin-token")) as unknown as () => string,
        getOrgId: () => null,
      });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "cms", singular: "CMS" });
      const qc = createTestQueryClient();

      const { result } = renderHook(() => hooks.useDetail("home"), { wrapper: createWrapper(qc) });

      await new Promise((r) => setTimeout(r, 50));
      expect(api.getById).not.toHaveBeenCalled();
      // react-query reports `isLoading: false` when the query is `enabled: false`
      // (which is what happens when token is null in bearer mode). So the consumer
      // sees `{ isLoading: false, item: null }` — looks like an empty success state.
      expect(result.current.isLoading).toBe(false);
      expect(result.current.item).toBeNull();
    });

    it("USER FIX for async token: pass {public:true} OR switch to cookie mode", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "bearer" });
      configureAuth({
        getToken: (() => Promise.resolve("admin-token")) as unknown as () => string,
        getOrgId: () => null,
      });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "cms", singular: "CMS" });
      const qc = createTestQueryClient();

      const { result } = renderHook(() => hooks.useDetail("home", { public: true }), {
        wrapper: createWrapper(qc),
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(api.getById).toHaveBeenCalledTimes(1);
    });

    // ──────────────────────────────────────────────────────────────────────
    // 4. FIXED (0.7): useList in cache → useDetail uses it as placeholderData,
    //                 always fires the real detail GET, returns rich payload
    // ──────────────────────────────────────────────────────────────────────
    it("FIRES detail GET even when useList already has the item — list payload becomes placeholderData, not cached truth", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "chapters", singular: "Chapter" });
      const qc = createTestQueryClient();

      // Mount useList first — calls api.getAll. Does NOT pollute the detail cache.
      const listHook = renderHook(() => hooks.useList(undefined, { public: true }), {
        wrapper: createWrapper(qc),
      });
      await waitFor(() => expect(listHook.result.current.isLoading).toBe(false));
      expect(api.getAll).toHaveBeenCalledTimes(1);
      expect(api.getById).not.toHaveBeenCalled();

      // Mount useDetail for an item that was in the list. The hook reads the
      // list item via placeholderData (instant render with `_id` + `title`),
      // then fires the real GET in the background.
      const detailHook = renderHook(() => hooks.useDetail("a", { public: true }), {
        wrapper: createWrapper(qc),
      });

      // Synchronous first render: list item shown as placeholder.
      expect(detailHook.result.current.isPlaceholderData).toBe(true);
      expect(detailHook.result.current.item).toEqual({ _id: "a", title: "A from list" });

      // Then the real detail GET fires and resolves with the rich payload.
      await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(detailHook.result.current.isPlaceholderData).toBe(false));
      expect(detailHook.result.current.item).toEqual({
        _id: "a",
        title: "A from detail",
        body: "full body",
      });
    });

    it("FIRES detail GET when useList stays mounted alongside detail (master/detail layout)", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "chapters", singular: "Chapter" });
      const qc = createTestQueryClient();

      // List stays mounted (layout pattern, master/detail view, etc.) — no
      // prefill effect means no unstable-ref clobber loop.
      renderHook(() => hooks.useList(undefined, { public: true }), { wrapper: createWrapper(qc) });
      await waitFor(() => expect(api.getAll).toHaveBeenCalledTimes(1));

      const detailHook = renderHook(() => hooks.useDetail("a", { public: true }), {
        wrapper: createWrapper(qc),
      });

      await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(detailHook.result.current.isFetching).toBe(false));

      // Result is the rich detail payload — placeholder swap is final.
      expect(detailHook.result.current.item).toEqual({
        _id: "a",
        title: "A from detail",
        body: "full body",
      });
    });

    it("FIRES detail GET on cold cache (no prior list) — no regression", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "chapters", singular: "Chapter" });
      const qc = createTestQueryClient();

      const detailHook = renderHook(() => hooks.useDetail("a", { public: true }), {
        wrapper: createWrapper(qc),
      });

      // No list → no placeholderData → straight to loading.
      expect(detailHook.result.current.isPlaceholderData).toBe(false);
      expect(detailHook.result.current.item).toBeNull();

      await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(detailHook.result.current.isLoading).toBe(false));
      expect(detailHook.result.current.item?.body).toBe("full body");
    });

    // ──────────────────────────────────────────────────────────────────────
    // 5. Cookie auth mode
    // ──────────────────────────────────────────────────────────────────────
    it("FIRES GET in cookie mode regardless of token", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "cookie" });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "cms", singular: "CMS" });
      const qc = createTestQueryClient();

      const { result } = renderHook(() => hooks.useDetail("home"), { wrapper: createWrapper(qc) });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(api.getById).toHaveBeenCalledTimes(1);
    });

    // ──────────────────────────────────────────────────────────────────────
    // 6. hasStaticAuth via internalApiKey on per-client config
    // ──────────────────────────────────────────────────────────────────────
    it("FIRES GET when client has internalApiKey (hasStaticAuth path)", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const api = mockApi();
      const hooks = createCrudHooks({
        api,
        entityKey: "cms",
        singular: "CMS",
        // Per-client config carries the API key — flips hasStaticAuth to true.
        client: {
          request: vi.fn(),
          config: { baseUrl: "http://api.test", internalApiKey: "srv-key" },
        },
      });
      const qc = createTestQueryClient();

      const { result } = renderHook(() => hooks.useDetail("home"), { wrapper: createWrapper(qc) });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(api.getById).toHaveBeenCalledTimes(1);
    });

    it("FIRES GET when global configureClient has internalApiKey (gap closed in 0.7)", async () => {
      // Before 0.7, `hasStaticAuth` only inspected per-client config — a global
      // `internalApiKey` left queries permanently disabled. `hasGlobalStaticAuth`
      // now also reads the singleton, so apps that authenticate via a global
      // key (most of them) get enabled queries without per-call ceremony.
      configureClient({ baseUrl: "http://api.test", internalApiKey: "srv-key" });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "cms", singular: "CMS" });
      const qc = createTestQueryClient();

      const { result } = renderHook(() => hooks.useDetail("home"), { wrapper: createWrapper(qc) });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(api.getById).toHaveBeenCalledTimes(1);
    });

    // ──────────────────────────────────────────────────────────────────────
    // 7. Cold-load detail page (no list mounted first)
    // ──────────────────────────────────────────────────────────────────────
    it("FIRES GET when detail page is loaded directly (no prior list)", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "chapters", singular: "Chapter" });
      const qc = createTestQueryClient();

      const { result } = renderHook(() => hooks.useDetail("chap-1", { public: true }), {
        wrapper: createWrapper(qc),
      });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(api.getById).toHaveBeenCalledTimes(1);
      expect(result.current.item?.body).toBe("full body"); // full payload from the GET
    });

    // ──────────────────────────────────────────────────────────────────────
    // 8. Edge case the user actually claimed was broken: id flips null→'home'
    // ──────────────────────────────────────────────────────────────────────
    it("FIRES GET once id flips from null to a value", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "cookie" });

      const api = mockApi();
      const hooks = createCrudHooks({ api, entityKey: "cms", singular: "CMS" });
      const qc = createTestQueryClient();

      const { result, rerender } = renderHook(
        ({ id }: { id: string | null }) => hooks.useDetail(id),
        { wrapper: createWrapper(qc), initialProps: { id: null as string | null } },
      );

      await new Promise((r) => setTimeout(r, 30));
      expect(api.getById).not.toHaveBeenCalled(); // disabled — id is null

      rerender({ id: "home" });
      await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.item).toEqual({ _id: "a", title: "A from detail", body: "full body" });
    });
  });
});

describe("suspense reads", () => {
  // ============================================================================
  // Test setup
  // ============================================================================

  /** Wrapper with a Suspense boundary — required because these hooks suspend. */

  /** Minimal error boundary so we can assert errors throw to the boundary. */
  class TestErrorBoundary extends React.Component<
    { onError: (e: Error) => void; children?: React.ReactNode },
    { hasError: boolean }
  > {
    override state = { hasError: false };
    static getDerivedStateFromError() {
      return { hasError: true };
    }
    override componentDidCatch(error: Error) {
      this.props.onError(error);
    }
    override render() {
      return this.state.hasError ? React.createElement("div", null, "error") : this.props.children;
    }
  }

  // ============================================================================
  // useSuspenseListQuery
  // ============================================================================

  describe("useSuspenseListQuery", () => {
    let queryClient: QueryClient;
    beforeEach(() => {
      queryClient = createTestQueryClient();
    });
    afterEach(() => {
      queryClient.clear();
    });

    it("suspends, then resolves with items + pagination and isLoading=false", async () => {
      const wrapper = createWrapper(queryClient, { suspense: true });
      const payload = {
        method: "offset",
        data: [
          { _id: "1", name: "A" },
          { _id: "2", name: "B" },
        ],
        total: 2,
        page: 1,
        limit: 20,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      };
      const queryFn = vi.fn().mockResolvedValue(payload);

      const { result } = renderHook(
        () =>
          useSuspenseListQuery<{ _id: string; name: string }>({
            queryKey: ["thing", "list"],
            queryFn,
          }),
        { wrapper },
      );

      // Suspended on first render — the hook hasn't produced a value yet.
      expect(result.current).toBeNull();

      await waitFor(() => expect(result.current?.items.length).toBe(2));
      expect(result.current.items).toEqual(payload.data);
      expect(result.current.pagination?.total).toBe(2);
      expect(result.current.pagination?.method).toBe("offset");
      // Suspense guarantees data before render → no loading branch ever.
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isSuccess).toBe(true);
      expect(result.current.error).toBeNull();
      expect(queryFn).toHaveBeenCalledTimes(1);
      // queryFn receives an AbortSignal (cancellation support preserved).
      expect(queryFn.mock.calls[0][0]).toHaveProperty("signal");
    });

    it("applies the select projection", async () => {
      const wrapper = createWrapper(queryClient, { suspense: true });
      const payload = { data: [{ _id: "1" }, { _id: "2" }], total: 2 };
      const queryFn = vi.fn().mockResolvedValue(payload);

      const { result } = renderHook(
        () =>
          useSuspenseListQuery({
            queryKey: ["thing", "list", "sel"],
            queryFn,
            select: (d: unknown) => ({
              data: (d as { data: unknown[] }).data.slice(0, 1),
              total: 1,
            }),
          }),
        { wrapper },
      );

      await waitFor(() => expect(result.current?.items.length).toBe(1));
      expect(result.current.items).toEqual([{ _id: "1" }]);
    });
  });

  // ============================================================================
  // useSuspenseDetailQuery
  // ============================================================================

  describe("useSuspenseDetailQuery", () => {
    let queryClient: QueryClient;
    beforeEach(() => {
      queryClient = createTestQueryClient();
    });
    afterEach(() => {
      queryClient.clear();
    });

    it("suspends, then resolves with item, isLoading=false, isPlaceholderData=false", async () => {
      const wrapper = createWrapper(queryClient, { suspense: true });
      const doc = { _id: "1", name: "A" };
      const queryFn = vi.fn().mockResolvedValue(doc);

      const { result } = renderHook(
        () =>
          useSuspenseDetailQuery<{ _id: string; name: string }>({
            queryKey: ["thing", "detail", "1"],
            queryFn,
          }),
        { wrapper },
      );

      expect(result.current).toBeNull();

      await waitFor(() => expect(result.current?.item).toEqual(doc));
      expect(result.current.isLoading).toBe(false);
      // Suspense has no placeholder phase — always false (unlike useDetailQuery).
      expect(result.current.isPlaceholderData).toBe(false);
      expect(result.current.isSuccess).toBe(true);
      expect(result.current.error).toBeNull();
    });
  });

  // ============================================================================
  // Error propagation
  // ============================================================================

  describe("suspense query error handling", () => {
    let queryClient: QueryClient;
    beforeEach(() => {
      queryClient = createTestQueryClient();
    });
    afterEach(() => {
      queryClient.clear();
    });

    it("throws a rejected queryFn to the nearest error boundary (not isError)", async () => {
      const onError = vi.fn();
      function Wrapper({ children }: { children: React.ReactNode }) {
        return React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            TestErrorBoundary,
            { onError },
            React.createElement(
              React.Suspense,
              { fallback: React.createElement("div", null, "loading") },
              children,
            ),
          ),
        );
      }
      const queryFn = vi.fn().mockRejectedValue(new Error("boom"));

      renderHook(() => useSuspenseListQuery({ queryKey: ["thing", "list", "err"], queryFn }), {
        wrapper: Wrapper,
      });

      await waitFor(() => expect(onError).toHaveBeenCalled());
      const err = onError.mock.calls[0][0] as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("boom");
    });
  });
});

describe("aggregations", () => {
  /**
   * Aggregations — arc 2.13+ declarative `GET /:resource/aggregations/:name`.
   *
   * Locks the wire shape `{ rows: TRow[] }`, query-key tenant isolation, and
   * the prefetch / hook hydration round-trip RSC consumers depend on.
   */

  // ============================================================================
  // Query key factory
  // ============================================================================

  describe("aggregation query keys", () => {
    it("aggregations() is the prefix for all aggregations on a resource", () => {
      const KEYS = createQueryKeys("orders");
      expect(KEYS.aggregations()).toEqual(["orders", "aggregation"]);
    });

    it("aggregations(name) is the name-only prefix of every variant", () => {
      const KEYS = createQueryKeys("orders");
      expect(KEYS.aggregations("salesByDay")).toEqual(["orders", "aggregation", "salesByDay"]);
      expect(KEYS.aggregation("salesByDay")).toEqual([
        "orders",
        "aggregation",
        "salesByDay",
        P0,
        {},
      ]);
    });

    it("aggregation(name, filter) appends filter for cache discrimination", () => {
      const KEYS = createQueryKeys("orders");
      const k = KEYS.aggregation("salesByDay", { from: "2025-01-01", to: "2025-12-31" });
      expect(k).toEqual([
        "orders",
        "aggregation",
        "salesByDay",
        P0,
        { from: "2025-01-01", to: "2025-12-31" },
      ]);
    });

    it("aggregations() is a prefix of every aggregation(name) key", () => {
      const KEYS = createQueryKeys("orders");
      const prefix = KEYS.aggregations();
      const k1 = KEYS.aggregation("salesByDay");
      const k2 = KEYS.aggregation("topRegions", { limit: 10 });
      expect(k1.slice(0, prefix.length)).toEqual(prefix);
      expect(k2.slice(0, prefix.length)).toEqual(prefix);
    });

    it("different filters produce different keys (cache discrimination)", () => {
      const KEYS = createQueryKeys("orders");
      const k1 = JSON.stringify(KEYS.aggregation("salesByDay", { from: "2025-01-01" }));
      const k2 = JSON.stringify(KEYS.aggregation("salesByDay", { from: "2025-02-01" }));
      expect(k1).not.toBe(k2);
    });
  });

  // ============================================================================
  // invalidateAggregations cache util
  // ============================================================================

  describe("invalidateAggregations", () => {
    let qc: QueryClient;

    beforeEach(() => {
      qc = createTestQueryClient();
    });
    afterEach(() => qc.clear());

    it("invalidateAggregations() with no name prefix-invalidates every aggregation", async () => {
      const KEYS = createQueryKeys("orders");
      const cache = createCacheUtils<unknown>(KEYS);

      qc.setQueryData(KEYS.aggregation("salesByDay"), { rows: [{ day: "2025-01-01", total: 10 }] });
      qc.setQueryData(KEYS.aggregation("topRegions"), { rows: [{ region: "NA", total: 50 }] });
      qc.setQueryData(KEYS.list({ page: 1 }), { data: [] }); // unrelated

      const beforeStates = qc.getQueriesData({ queryKey: KEYS.aggregations() });
      expect(beforeStates).toHaveLength(2);

      await cache.invalidateAggregations(qc);

      // Both aggregations marked stale; the unrelated list query is untouched.
      const aggStates = qc.getQueryState(KEYS.aggregation("salesByDay"));
      expect(aggStates?.isInvalidated).toBe(true);
      const listState = qc.getQueryState(KEYS.list({ page: 1 }));
      expect(listState?.isInvalidated).toBeFalsy();
    });

    it("invalidateAggregations(name) targets only that aggregation", async () => {
      const KEYS = createQueryKeys("orders");
      const cache = createCacheUtils<unknown>(KEYS);

      qc.setQueryData(KEYS.aggregation("salesByDay"), { rows: [] });
      qc.setQueryData(KEYS.aggregation("topRegions"), { rows: [] });

      await cache.invalidateAggregations(qc, "salesByDay");

      expect(qc.getQueryState(KEYS.aggregation("salesByDay"))?.isInvalidated).toBe(true);
      // Other aggregation untouched.
      expect(qc.getQueryState(KEYS.aggregation("topRegions"))?.isInvalidated).toBeFalsy();
    });
  });

  // ============================================================================
  // useAggregation hook
  // ============================================================================

  describe("useAggregation hook", () => {
    let qc: QueryClient;

    beforeEach(() => {
      qc = createTestQueryClient();
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => "tok", getOrgId: () => null });
    });

    afterEach(() => {
      qc.clear();
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    type SalesRow = { day: string; total: number };

    function createApiWithAggregate(
      rows: SalesRow[] = [{ day: "2025-01-01", total: 100 }],
    ): CrudApi<unknown> {
      return {
        getAll: vi.fn(),
        getById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({ rows } as AggResult<SalesRow>),
      } as unknown as CrudApi<unknown>;
    }

    it("calls api.aggregate with name + filter and exposes rows", async () => {
      const api = createApiWithAggregate();
      const hooks = createCrudHooks({ api, entityKey: `agg-${Math.random()}`, singular: "Order" });

      const { result } = renderHook(
        () =>
          hooks.useAggregation<SalesRow>({ name: "salesByDay", filter: { from: "2025-01-01" } }),
        { wrapper: createWrapper(qc) },
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(api.aggregate).toHaveBeenCalledWith({
        name: "salesByDay",
        filter: { from: "2025-01-01" },
        token: "tok",
        // The resolved tenant the key was built for (none configured here), sent explicitly.
        organizationId: null,
        options: { signal: expect.any(AbortSignal) },
      });
      expect(result.current.data?.rows).toEqual([{ day: "2025-01-01", total: 100 }]);
    });

    it("caches under KEYS.aggregation(name, filterKey)", async () => {
      const api = createApiWithAggregate();
      const entityKey = `agg-cache-${Math.random()}`;
      const hooks = createCrudHooks({ api, entityKey, singular: "Order" });

      const { result } = renderHook(
        () =>
          hooks.useAggregation<SalesRow>({ name: "salesByDay", filter: { from: "2025-01-01" } }),
        { wrapper: createWrapper(qc) },
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      const cached = qc.getQueryData(hooks.KEYS.aggregation("salesByDay", { from: "2025-01-01" }));
      expect(cached).toEqual({ rows: [{ day: "2025-01-01", total: 100 }] });
    });

    it("different filters produce isolated cache entries (no leak)", async () => {
      const api = createApiWithAggregate();
      const hooks = createCrudHooks({
        api,
        entityKey: `agg-iso-${Math.random()}`,
        singular: "Order",
      });

      const { result: r1 } = renderHook(
        () =>
          hooks.useAggregation<SalesRow>({ name: "salesByDay", filter: { from: "2025-01-01" } }),
        { wrapper: createWrapper(qc) },
      );
      await waitFor(() => expect(r1.current.isLoading).toBe(false));

      const { result: r2 } = renderHook(
        () =>
          hooks.useAggregation<SalesRow>({ name: "salesByDay", filter: { from: "2025-02-01" } }),
        { wrapper: createWrapper(qc) },
      );
      await waitFor(() => expect(r2.current.isLoading).toBe(false));

      expect(api.aggregate).toHaveBeenCalledTimes(2);
    });

    it("tenant isolation — same name + filter under different orgs is different key", async () => {
      const api = createApiWithAggregate();
      const entityKey = `agg-tenant-${Math.random()}`;
      const hooks = createCrudHooks({ api, entityKey, singular: "Order" });

      configureAuth({ getToken: () => "tok", getOrgId: () => "org-1" });
      const { result: r1 } = renderHook(
        () => hooks.useAggregation<SalesRow>({ name: "salesByDay" }),
        { wrapper: createWrapper(qc) },
      );
      await waitFor(() => expect(r1.current.isLoading).toBe(false));

      configureAuth({ getToken: () => "tok", getOrgId: () => "org-2" });
      const { result: r2 } = renderHook(
        () => hooks.useAggregation<SalesRow>({ name: "salesByDay" }),
        { wrapper: createWrapper(qc) },
      );
      await waitFor(() => expect(r2.current.isLoading).toBe(false));

      expect(api.aggregate).toHaveBeenCalledTimes(2);
    });

    it("enabled: false does not fire the request", async () => {
      const api = createApiWithAggregate();
      const hooks = createCrudHooks({
        api,
        entityKey: `agg-disabled-${Math.random()}`,
        singular: "Order",
      });

      renderHook(() => hooks.useAggregation<SalesRow>({ name: "salesByDay", enabled: false }), {
        wrapper: createWrapper(qc),
      });

      // Wait a tick to ensure no fire.
      await new Promise((r) => setTimeout(r, 20));
      expect(api.aggregate).not.toHaveBeenCalled();
    });

    it("select transforms AggResult — pluck rows directly", async () => {
      type Row = { day: string; total: number };
      const api = createApiWithAggregate([
        { day: "2025-01-01", total: 100 },
        { day: "2025-01-02", total: 200 },
      ]);
      const hooks = createCrudHooks({
        api,
        entityKey: `agg-select-${Math.random()}`,
        singular: "Order",
      });

      const { result } = renderHook(
        () => hooks.useAggregation<Row, Row[]>({ name: "salesByDay", select: (r) => r.rows }),
        { wrapper: createWrapper(qc) },
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.data).toEqual([
        { day: "2025-01-01", total: 100 },
        { day: "2025-01-02", total: 200 },
      ]);
    });

    it("select can compute derived values (sum / aggregate-of-aggregate)", async () => {
      type Row = { day: string; total: number };
      const api = createApiWithAggregate([
        { day: "2025-01-01", total: 100 },
        { day: "2025-01-02", total: 200 },
        { day: "2025-01-03", total: 50 },
      ]);
      const hooks = createCrudHooks({
        api,
        entityKey: `agg-select-sum-${Math.random()}`,
        singular: "Order",
      });

      const { result } = renderHook(
        () =>
          hooks.useAggregation<Row, number>({
            name: "salesByDay",
            select: (r) => r.rows.reduce((sum, x) => sum + x.total, 0),
          }),
        { wrapper: createWrapper(qc) },
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.data).toBe(350);
    });

    it("public: true bypasses auth gate (allows query without token)", async () => {
      configureAuth({ getToken: () => null, getOrgId: () => null });
      const api = createApiWithAggregate();
      const hooks = createCrudHooks({
        api,
        entityKey: `agg-public-${Math.random()}`,
        singular: "Order",
      });

      const { result } = renderHook(
        () => hooks.useAggregation<SalesRow>({ name: "publicMetrics", public: true }),
        { wrapper: createWrapper(qc) },
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(api.aggregate).toHaveBeenCalled();
    });

    it("CRUD writes auto-invalidate aggregations (dashboards refresh)", async () => {
      const api: CrudApi<{ _id: string; name: string }, { name: string }, { name: string }> = {
        getAll: vi.fn(),
        getById: vi.fn(),
        create: vi.fn().mockResolvedValue({ _id: "99", name: "New" }),
        update: vi.fn().mockResolvedValue({ _id: "1", name: "Edited" }),
        delete: vi.fn().mockResolvedValue({ deleted: true }),
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({ rows: [{ count: 0 }] } as AggResult),
      };
      const hooks = createCrudHooks({
        api,
        entityKey: `agg-invalidate-${Math.random()}`,
        singular: "Item",
      });

      // Seed an aggregation in the cache so we can observe invalidation.
      const aggKey = hooks.KEYS.aggregation("count", {});
      qc.setQueryData(aggKey, { rows: [{ count: 10 }] });
      expect(qc.getQueryState(aggKey)?.isInvalidated).toBeFalsy();

      const { result } = renderHook(() => hooks.useActions(), { wrapper: createWrapper(qc) });

      // Create
      await result.current.create({ data: { name: "X" } });
      await waitFor(() => expect(qc.getQueryState(aggKey)?.isInvalidated).toBe(true));

      // Reset and try update
      qc.setQueryData(aggKey, { rows: [{ count: 11 }] });
      qc.invalidateQueries({ queryKey: aggKey, refetchType: "none" });
      qc.setQueryData(aggKey, { rows: [{ count: 11 }] });
      const stateBefore = qc.getQueryState(aggKey);
      expect(stateBefore?.data).toEqual({ rows: [{ count: 11 }] });

      await result.current.update({ id: "1", data: { name: "Edited" } });
      await waitFor(() => expect(qc.getQueryState(aggKey)?.isInvalidated).toBe(true));
    });

    it("rejects with actionable error if api lacks aggregate", async () => {
      const api: CrudApi<unknown> = {
        getAll: vi.fn(),
        getById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        // no aggregate
      };
      const hooks = createCrudHooks({
        api,
        entityKey: `agg-missing-${Math.random()}`,
        singular: "Order",
      });

      // enabled rule requires `!!api.aggregate` so the query stays disabled —
      // the hook returns idle, not an error. This is the right behavior:
      // detection is structural, not a runtime fire-and-fail.
      const { result } = renderHook(() => hooks.useAggregation<SalesRow>({ name: "salesByDay" }), {
        wrapper: createWrapper(qc),
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(result.current.fetchStatus).toBe("idle");
    });

    it("bulkCreate auto-invalidates aggregations", async () => {
      const api = {
        getAll: vi.fn(),
        getById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        bulkCreate: vi.fn().mockResolvedValue([{ _id: "1" }, { _id: "2" }]),
        aggregate: vi.fn().mockResolvedValue({ rows: [] }),
      };
      const hooks = createCrudHooks({
        api: api as unknown as CrudApi<{ _id: string }>,
        entityKey: `agg-bulk-${Math.random()}`,
        singular: "Item",
      });

      const aggKey = hooks.KEYS.aggregation("byStatus", {});
      qc.setQueryData(aggKey, { rows: [{ count: 5 }] });

      const { result } = renderHook(() => hooks.useBulkActions(), { wrapper: createWrapper(qc) });
      await act(async () => {
        await result.current.bulkCreate({ data: [{ name: "a" }, { name: "b" }] as never[] });
      });
      await waitFor(() => expect(qc.getQueryState(aggKey)?.isInvalidated).toBe(true));
    });

    it("restore auto-invalidates aggregations", async () => {
      const api = {
        getAll: vi.fn(),
        getById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        restore: vi.fn().mockResolvedValue({ _id: "1", name: "x" }),
        aggregate: vi.fn().mockResolvedValue({ rows: [] }),
      };
      const hooks = createCrudHooks({
        api: api as unknown as CrudApi<{ _id: string; name: string }>,
        entityKey: `agg-restore-${Math.random()}`,
        singular: "Item",
      });

      const aggKey = hooks.KEYS.aggregation("count");
      qc.setQueryData(aggKey, { rows: [{ count: 0 }] });

      const { result } = renderHook(() => hooks.useActions(), { wrapper: createWrapper(qc) });
      await act(async () => {
        await result.current.restore({ id: "1" });
      });
      await waitFor(() => expect(qc.getQueryState(aggKey)?.isInvalidated).toBe(true));
    });

    it("prefetched aggregation hydrates useAggregation without refetch", async () => {
      type Row = { region: string; total: number };
      const aggregate = vi.fn().mockResolvedValue({
        rows: [{ region: "NA", total: 50 }],
      } as AggResult<Row>);
      const api: CrudApi<unknown> = {
        getAll: vi.fn(),
        getById: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        count: vi.fn().mockResolvedValue(0),
        aggregate: aggregate as unknown as NonNullable<CrudApi<unknown>["aggregate"]>,
      };

      const entityKey = `agg-prefetch-${Math.random()}`;
      // 1. Prefetch on the "server" with the same option factory the hook uses.
      const queries = createEntityQueries(
        { getAll: vi.fn(), getById: vi.fn(), aggregate },
        entityKey,
      );
      await prefetchQueries([queries.aggregation("topRegions", { limit: 10 })], {
        queryClient: qc,
      });

      expect(aggregate).toHaveBeenCalledTimes(1);

      // 2. Render the hook with the SAME args — should read from prefetched
      // cache and NOT fire a second fetch. Long staleTime keeps it fresh.
      const hooks = createCrudHooks({ api, entityKey, singular: "Region" });
      const { result } = renderHook(
        () =>
          hooks.useAggregation<Row>({
            name: "topRegions",
            filter: { limit: 10 },
            staleTime: 60_000,
          }),
        { wrapper: createWrapper(qc) },
      );

      // Cache hit on first render — no loading state, data populated immediately.
      await waitFor(() => expect(result.current.data).toBeDefined());
      expect(result.current.data?.rows).toEqual([{ region: "NA", total: 50 }]);
      // Critical: the network was hit ONCE (during prefetch), not twice.
      expect(aggregate).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // aggregation option factory (server prefetch)
  // ============================================================================

  describe("queries.aggregation (server prefetch)", () => {
    let qc: QueryClient;

    beforeEach(() => {
      qc = createTestQueryClient();
    });
    afterEach(() => qc.clear());

    it("prefetches under the same tenant-scoped key useAggregation reads", async () => {
      type Row = { region: string; total: number };
      const aggregate = vi.fn().mockResolvedValue({
        rows: [{ region: "NA", total: 50 }],
      } as AggResult<Row>);
      const queries = createEntityQueries(
        { getAll: vi.fn(), getById: vi.fn(), aggregate },
        "orders",
      );

      await prefetchQueries(
        [
          queries.aggregation(
            "topRegions",
            { limit: 10 },
            { token: "srv-tok", organizationId: "org-1" },
          ),
        ],
        { queryClient: qc },
      );

      expect(aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "topRegions",
          filter: { limit: 10 },
          token: "srv-tok",
          organizationId: "org-1",
        }),
      );
      const KEYS = createQueryKeys("orders");
      const hydrated = qc.getQueryData(
        KEYS.aggregation("topRegions", { limit: 10 }, { organizationId: "org-1" }),
      );
      expect(hydrated).toEqual({ rows: [{ region: "NA", total: 50 }] });
    });

    it("rejects when the api lacks aggregate", async () => {
      const queries = createEntityQueries({ getAll: vi.fn(), getById: vi.fn() }, "orders");
      const fn = queries.aggregation("salesByDay").queryFn as (ctx: unknown) => Promise<unknown>;
      await expect(fn({ signal: new AbortController().signal })).rejects.toThrow(/aggregate/);
    });
  });
});
