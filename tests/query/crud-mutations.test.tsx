import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  useMutation,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import {
  ArcApiError,
  configureAuth,
  configureClient,
  isPreconditionFailed,
} from "../../src/client/client.js";
import { type CrudApi, createCrudHooks } from "../../src/query/hooks.js";
import { configureToast } from "../../src/query/mutation.js";
import { createTestQueryClient, createWrapper } from "../harness/query-client.js";

describe("optimistic guarantees", () => {
  /**
   * 0.12 optimistic/bulk hardening — the guarantees, each pinned:
   *
   *   1. create inserts ONE placeholder (lists only — aggregation caches
   *      untouched), then reconciles it to the server doc in place and seeds
   *      the detail cache.
   *   2. update merges the RAW doc into detail caches (no `{ data }` envelope)
   *      and rolls back exactly on failure.
   *   3. sequential writes to the SAME record are ordered (call order =
   *      request order); different records stay parallel.
   *   4. bulk partial success: `modifiedCount: 0` / `deletedCount: 0` skip
   *      invalidation; bulkCreate seeds detail caches from returned docs.
   */

  type Doc = { _id: string; name: string };

  const silentToast = { success: vi.fn(), error: vi.fn() };

  type MockApi = CrudApi<Doc, Partial<Doc>, Partial<Doc>> & {
    bulkCreate?: ReturnType<typeof vi.fn>;
    bulkUpdate?: ReturnType<typeof vi.fn>;
    bulkDelete?: ReturnType<typeof vi.fn>;
  };

  function createMockApi(overrides: Partial<Record<string, unknown>> = {}): MockApi {
    return {
      getAll: vi.fn().mockResolvedValue({ data: [], total: 0 }),
      getById: vi.fn().mockResolvedValue({ _id: "1", name: "Item 1" }),
      create: vi.fn().mockResolvedValue({ _id: "server-1", name: "Created" }),
      update: vi.fn().mockResolvedValue({ _id: "1", name: "Updated" }),
      delete: vi.fn().mockResolvedValue({ message: "Deleted", id: "1" }),
      count: vi.fn().mockResolvedValue(0),
      ...overrides,
    } as MockApi;
  }

  function makeHooks(api: MockApi) {
    return createCrudHooks<Doc>({ api, entityKey: `e2e-${crypto.randomUUID()}`, singular: "Doc" });
  }

  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    configureToast(silentToast);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  // ============================================================================
  // 1. create — placeholder, reconciliation, aggregation isolation
  // ============================================================================

  describe("create — temp-ID reconciliation", () => {
    it("replaces the optimistic placeholder with the server doc and seeds the detail cache", async () => {
      let resolveCreate: (doc: Doc) => void = () => {};
      const api = createMockApi({
        create: vi.fn(
          () =>
            new Promise<Doc>((resolve) => {
              resolveCreate = resolve;
            }),
        ),
      });
      const hooks = makeHooks(api);
      const listKey = hooks.KEYS.list({});
      queryClient.setQueryData(listKey, { data: [{ _id: "1", name: "Existing" }], total: 1 });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      let done: Promise<Doc>;
      act(() => {
        done = result.current.create({ data: { name: "Draft" } });
      });

      // Optimistic phase: placeholder is in the list, marked, temp id.
      await waitFor(() => {
        const list = queryClient.getQueryData(listKey) as { data: Array<Record<string, unknown>> };
        expect(list.data).toHaveLength(2);
        expect(list.data[0]!._optimistic).toBe(true);
        expect(String(list.data[0]!._id)).toMatch(/^temp-/);
      });

      const server = { _id: "server-1", name: "Draft" };
      await act(async () => {
        resolveCreate(server);
        await done!;
      });

      // Reconciled: placeholder swapped in place for the server doc (no
      // flicker), total unchanged by the swap, detail cache seeded.
      const list = queryClient.getQueryData(listKey) as { data: Doc[]; total: number };
      expect(list.data[0]).toEqual(server);
      expect(list.data.some((d) => String(d._id).startsWith("temp-"))).toBe(false);
      expect(queryClient.getQueryData(hooks.KEYS.detail("server-1", {}))).toEqual(server);
    });

    it("leaves aggregation caches untouched during the optimistic phase", async () => {
      const api = createMockApi();
      const hooks = makeHooks(api);
      const aggKey = hooks.KEYS.aggregation("salesByDay");
      const aggValue = { rows: [{ day: "mon", total: 5 }] };
      queryClient.setQueryData(aggKey, aggValue);

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      await act(async () => {
        await result.current.create({ data: { name: "X" } });
      });

      // The aggregation entry was never optimistically mutated — `rows` must
      // NOT contain an injected item. (It may have been invalidated — that's
      // the correct refetch path — but the cached VALUE is unchanged.)
      expect(queryClient.getQueryData(aggKey)).toEqual(aggValue);
    });
  });

  // ============================================================================
  // 2. update — raw-doc detail merge + exact rollback
  // ============================================================================

  describe("update — detail cache contract", () => {
    it("optimistically merges the RAW doc into detail caches (no { data } envelope)", async () => {
      let resolveUpdate: (doc: Doc) => void = () => {};
      const api = createMockApi({
        update: vi.fn(
          () =>
            new Promise<Doc>((resolve) => {
              resolveUpdate = resolve;
            }),
        ),
      });
      const hooks = makeHooks(api);
      queryClient.setQueryData(hooks.KEYS.detail("1", {}), {
        _id: "1",
        name: "Old",
        extra: "kept",
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      let done: Promise<Doc>;
      act(() => {
        done = result.current.update({ id: "1", data: { name: "New" } });
      });

      await waitFor(() => {
        // Raw merge — updated field applied at TOP level, sibling fields kept,
        // and no nested `data` envelope introduced.
        expect(queryClient.getQueryData(hooks.KEYS.detail("1", {}))).toEqual({
          _id: "1",
          name: "New",
          extra: "kept",
        });
      });

      await act(async () => {
        resolveUpdate({ _id: "1", name: "New" });
        await done!;
      });
    });

    it("rolls back detail AND list caches exactly on failure", async () => {
      const api = createMockApi({ update: vi.fn().mockRejectedValue(new Error("boom")) });
      const hooks = makeHooks(api);
      const listKey = hooks.KEYS.list({});
      const detailBefore = { _id: "1", name: "Old" };
      const listBefore = { data: [{ _id: "1", name: "Old" }], total: 1 };
      queryClient.setQueryData(hooks.KEYS.detail("1", {}), detailBefore);
      queryClient.setQueryData(listKey, listBefore);

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      await act(async () => {
        await expect(result.current.update({ id: "1", data: { name: "New" } })).rejects.toThrow(
          "boom",
        );
      });

      expect(queryClient.getQueryData(hooks.KEYS.detail("1", {}))).toEqual(detailBefore);
      expect(queryClient.getQueryData(listKey)).toEqual(listBefore);
    });

    it("does not touch detail caches of OTHER records", async () => {
      const api = createMockApi();
      const hooks = makeHooks(api);
      const other = { _id: "2", name: "Other" };
      queryClient.setQueryData(hooks.KEYS.detail("2", {}), other);

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      await act(async () => {
        await result.current.update({ id: "1", data: { name: "New" } });
      });

      expect(queryClient.getQueryData(hooks.KEYS.detail("2", {}))).toEqual(other);
    });
  });

  // ============================================================================
  // 2b. optimistic writes and reconciliation stay inside the writer's partition
  // ============================================================================

  describe("partition: a write touches only caches read as the same identity", () => {
    afterEach(() => configureAuth({ getToken: () => null, getOrgId: () => null }));

    const seed = (hooks: ReturnType<typeof makeHooks>) => {
      const keys = {
        own: hooks.queries.list({}, { organizationId: "org-A" }).queryKey,
        anonymous: hooks.queries.list({}, { auth: "omit" }).queryKey,
        otherTenant: hooks.queries.list({}, { organizationId: "org-B" }).queryKey,
        ownDetail: hooks.queries.detail("1", { organizationId: "org-A" }).queryKey,
        anonymousDetail: hooks.queries.detail("1", { auth: "omit" }).queryKey,
      };
      for (const key of [keys.own, keys.anonymous, keys.otherTenant] as QueryKey[]) {
        queryClient.setQueryData(key, { data: [{ _id: "1", name: "Public" }], total: 1 });
      }
      queryClient.setQueryData(keys.ownDetail, { _id: "1", name: "Public" });
      queryClient.setQueryData(keys.anonymousDetail, { _id: "1", name: "Public" });
      return keys;
    };
    const nameIn = (key: readonly unknown[]) => {
      const value = queryClient.getQueryData(key) as { data?: Doc[]; name?: string } | undefined;
      return value?.data ? value.data.map((d) => d.name) : value?.name;
    };

    it("update: optimistic merge and reconcile reach only the writer's tenant", async () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-A" });
      let resolveUpdate: (doc: Doc) => void = () => {};
      const api = createMockApi({
        update: vi.fn(() => new Promise<Doc>((resolve) => (resolveUpdate = resolve))),
      });
      const hooks = makeHooks(api);
      const keys = seed(hooks);
      const { result } = renderHook(() => hooks.useActions(), {
        wrapper: createWrapper(queryClient),
      });

      let done: Promise<Doc>;
      act(() => {
        done = result.current.update({ id: "1", data: { name: "Private draft" } });
      });
      await waitFor(() => expect(nameIn(keys.own)).toEqual(["Private draft"]));
      expect(nameIn(keys.ownDetail)).toBe("Private draft");
      expect(nameIn(keys.anonymous)).toEqual(["Public"]);
      expect(nameIn(keys.otherTenant)).toEqual(["Public"]);
      expect(nameIn(keys.anonymousDetail)).toBe("Public");

      await act(async () => {
        resolveUpdate({ _id: "1", name: "Private" });
        await done!;
      });
      expect(nameIn(keys.own)).toEqual(["Private"]);
      expect(nameIn(keys.anonymous)).toEqual(["Public"]);
      expect(nameIn(keys.otherTenant)).toEqual(["Public"]);
      expect(nameIn(keys.anonymousDetail)).toBe("Public");
    });

    it("create: the placeholder and its reconciliation land only in the writer's lists", async () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-A" });
      const api = createMockApi({ create: vi.fn().mockResolvedValue({ _id: "9", name: "Mine" }) });
      const hooks = makeHooks(api);
      const keys = seed(hooks);
      const { result } = renderHook(() => hooks.useActions(), {
        wrapper: createWrapper(queryClient),
      });
      await act(async () => {
        await result.current.create({ data: { name: "Mine" } });
      });
      expect(nameIn(keys.own)).toEqual(["Mine", "Public"]);
      expect(nameIn(keys.anonymous)).toEqual(["Public"]);
      expect(nameIn(keys.otherTenant)).toEqual(["Public"]);
      expect(queryClient.getQueryData(hooks.queries.detail("9", { auth: "omit" }).queryKey)).toBe(
        undefined,
      );
      expect(
        queryClient.getQueryData(hooks.queries.detail("9", { organizationId: "org-A" }).queryKey),
      ).toEqual({ _id: "9", name: "Mine" });
    });

    it("delete: the optimistic removal reaches only the writer's lists", async () => {
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-A" });
      const api = createMockApi({ delete: vi.fn(() => new Promise(() => {})) });
      const hooks = makeHooks(api);
      const keys = seed(hooks);
      const { result } = renderHook(() => hooks.useActions(), {
        wrapper: createWrapper(queryClient),
      });
      act(() => {
        void result.current.remove({ id: "1" });
      });
      await waitFor(() => expect(nameIn(keys.own)).toEqual([]));
      expect(nameIn(keys.anonymous)).toEqual(["Public"]);
      expect(nameIn(keys.otherTenant)).toEqual(["Public"]);
    });
  });

  // ============================================================================
  // 3. per-record write ordering
  // ============================================================================

  // The identity a queued write is sent as is the one current when it was SUBMITTED, and the
  // per-record queue is per tenant: a tenant switch never re-targets or blocks a queued write.
  describe("write queue: identity captured at submit, one queue per tenant", () => {
    afterEach(() => configureAuth({ getToken: () => null, getOrgId: () => null }));

    const gatedUpdate = () => {
      const calls: Array<{ name: string; organizationId?: string | null; token?: string | null }> =
        [];
      const gates = new Map<string, () => void>();
      const update = vi.fn(
        async (args: {
          data: { name: string };
          organizationId?: string | null;
          token?: string | null;
        }) => {
          calls.push({
            name: args.data.name,
            organizationId: args.organizationId,
            token: args.token,
          });
          await new Promise<void>((release) => gates.set(args.data.name, release));
          return { _id: "1", name: args.data.name };
        },
      );
      return { update, calls, release: (name: string) => gates.get(name)?.() };
    };

    it("queued updates keep the tenant and token they were submitted with, in order", async () => {
      let org = "tenant-A";
      let token = "token-A";
      configureAuth({ getToken: () => token, getOrgId: () => org });
      const { update, calls, release } = gatedUpdate();
      const hooks = makeHooks(createMockApi({ update }));
      const { result } = renderHook(() => hooks.useActions(), {
        wrapper: createWrapper(queryClient),
      });

      let first: Promise<Doc>;
      let second: Promise<Doc>;
      act(() => {
        first = result.current.update({ id: "1", data: { name: "A1" } });
        second = result.current.update({ id: "1", data: { name: "A2" } });
      });
      await waitFor(() => expect(calls).toHaveLength(1));
      // The user switches tenant (and session) while A1 is in flight and A2 is queued.
      org = "tenant-B";
      token = "token-B";
      await act(async () => {
        release("A1");
        await first!;
      });
      await waitFor(() => expect(calls).toHaveLength(2));
      await act(async () => {
        release("A2");
        await second!;
      });

      expect(calls).toEqual([
        { name: "A1", organizationId: "tenant-A", token: "token-A" },
        { name: "A2", organizationId: "tenant-A", token: "token-A" },
      ]);
    });

    it("a write in another tenant never waits behind (or inherits from) this tenant's queue", async () => {
      let org = "tenant-A";
      configureAuth({ getToken: () => "tok", getOrgId: () => org });
      const { update, calls, release } = gatedUpdate();
      const hooks = makeHooks(createMockApi({ update }));
      const { result } = renderHook(() => hooks.useActions(), {
        wrapper: createWrapper(queryClient),
      });

      let a: Promise<Doc>;
      act(() => {
        a = result.current.update({ id: "1", data: { name: "A1" } });
      });
      await waitFor(() => expect(calls).toHaveLength(1));

      org = "tenant-B";
      let b: Promise<Doc>;
      act(() => {
        b = result.current.update({ id: "1", data: { name: "B1" } });
      });
      // B1 goes out while A1 is still pending: separate per-tenant queues.
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]).toEqual(expect.objectContaining({ name: "B1", organizationId: "tenant-B" }));

      await act(async () => {
        release("A1");
        release("B1");
        await Promise.all([a!, b!]);
      });
      expect(calls[0]).toEqual(expect.objectContaining({ name: "A1", organizationId: "tenant-A" }));
    });
  });

  describe("write ordering", () => {
    it("serializes sequential updates to the SAME record", async () => {
      const order: string[] = [];
      let releaseFirst: () => void = () => {};
      const firstGate = new Promise<void>((r) => {
        releaseFirst = r;
      });
      const api = createMockApi({
        update: vi.fn(async ({ data }: { data: { name: string } }) => {
          order.push(`start-${data.name}`);
          if (data.name === "A") await firstGate;
          order.push(`end-${data.name}`);
          return { _id: "1", name: data.name };
        }),
      });
      const hooks = makeHooks(api);
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      let a: Promise<Doc>;
      let b: Promise<Doc>;
      act(() => {
        a = result.current.update({ id: "1", data: { name: "A" } });
        b = result.current.update({ id: "1", data: { name: "B" } });
      });

      // B must NOT start while A is in flight.
      await waitFor(() => expect(order).toContain("start-A"));
      expect(order).not.toContain("start-B");

      await act(async () => {
        releaseFirst();
        await Promise.all([a!, b!]);
      });

      expect(order).toEqual(["start-A", "end-A", "start-B", "end-B"]);
    });

    it("keeps writes to DIFFERENT records parallel", async () => {
      const inFlight = new Set<string>();
      let sawOverlap = false;
      const api = createMockApi({
        update: vi.fn(async ({ id }: { id: string }) => {
          inFlight.add(id);
          if (inFlight.size > 1) sawOverlap = true;
          await new Promise((r) => setTimeout(r, 10));
          inFlight.delete(id);
          return { _id: id, name: "x" };
        }),
      });
      const hooks = makeHooks(api);
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      await act(async () => {
        await Promise.all([
          result.current.update({ id: "1", data: { name: "x" } }),
          result.current.update({ id: "2", data: { name: "x" } }),
        ]);
      });

      expect(sawOverlap).toBe(true);
    });

    it("a failed write does not block the next write to the same record", async () => {
      const api = createMockApi({
        update: vi
          .fn()
          .mockRejectedValueOnce(new Error("boom"))
          .mockResolvedValueOnce({ _id: "1", name: "B" }),
      });
      const hooks = makeHooks(api);
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      await act(async () => {
        const a = result.current.update({ id: "1", data: { name: "A" } }).catch(() => "failed");
        const b = result.current.update({ id: "1", data: { name: "B" } });
        expect(await a).toBe("failed");
        expect(await b).toEqual({ _id: "1", name: "B" });
      });
    });
  });

  // ============================================================================
  // 4. bulk partial success
  // ============================================================================

  describe("bulk partial success", () => {
    it("bulkUpdate with modifiedCount 0 skips invalidation entirely", async () => {
      const api = createMockApi({
        bulkUpdate: vi.fn().mockResolvedValue({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
        }),
      });
      const hooks = makeHooks(api);
      const spy = vi.spyOn(queryClient, "invalidateQueries");

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useBulkActions(), { wrapper });

      await act(async () => {
        await result.current.bulkUpdate({ filter: { name: "none" }, data: { name: "x" } });
      });

      expect(spy).not.toHaveBeenCalled();
    });

    it("bulkUpdate with modifiedCount > 0 invalidates as before", async () => {
      const api = createMockApi({
        bulkUpdate: vi.fn().mockResolvedValue({
          acknowledged: true,
          matchedCount: 3,
          modifiedCount: 3,
        }),
      });
      const hooks = makeHooks(api);
      const spy = vi.spyOn(queryClient, "invalidateQueries");

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useBulkActions(), { wrapper });

      await act(async () => {
        await result.current.bulkUpdate({ filter: {}, data: { name: "x" } });
      });

      expect(spy).toHaveBeenCalledWith({ queryKey: hooks.KEYS.lists() });
    });

    it("bulkRemove with deletedCount 0 skips invalidation", async () => {
      const api = createMockApi({
        bulkDelete: vi.fn().mockResolvedValue({ acknowledged: true, deletedCount: 0 }),
      });
      const hooks = makeHooks(api);
      const spy = vi.spyOn(queryClient, "invalidateQueries");

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useBulkActions(), { wrapper });

      await act(async () => {
        await result.current.bulkRemove({ filter: { name: "none" } });
      });

      expect(spy).not.toHaveBeenCalled();
    });

    it("bulkCreate seeds detail caches from the returned documents", async () => {
      const created = [
        { _id: "b1", name: "Bulk 1" },
        { _id: "b2", name: "Bulk 2" },
      ];
      const api = createMockApi({
        bulkCreate: vi.fn().mockResolvedValue({ data: created, count: 2 }),
      });
      const hooks = makeHooks(api);

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useBulkActions(), { wrapper });

      await act(async () => {
        await result.current.bulkCreate({ data: [{ name: "Bulk 1" }, { name: "Bulk 2" }] });
      });

      expect(queryClient.getQueryData(hooks.KEYS.detail("b1", {}))).toEqual(created[0]);
      expect(queryClient.getQueryData(hooks.KEYS.detail("b2", {}))).toEqual(created[1]);
    });
  });
});

describe("optimistic concurrency (If-Match)", () => {
  /**
   * Optimistic concurrency — `versionField` → `If-Match`, against arc's contract:
   * GET/PATCH answer `ETag: "<version>"`, an update carrying a stale `If-Match`
   * is refused `412 arc.precondition_failed`, and no `If-Match` means no
   * client precondition.
   *
   * The version must be the one the EDIT was based on, not whatever the cache
   * holds at submit time — a background refetch would otherwise let a stale
   * form silently overwrite the change it missed. Hence the resolution order:
   * explicit `version` → `data[versionField]` → cached document.
   */

  type Doc = { _id: string; name: string; __v: number };

  describe("BaseApi — If-Match", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ _id: "1", name: "x", __v: 4 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    afterEach(() => fetchMock.mockRestore());

    const headersOf = () =>
      (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;

    it('sends If-Match: "<version>" — the ETag form arc compares', async () => {
      const api = createCrudApi<Doc>("items", { basePath: "/api", headers: { "x-keep": "yes" } });
      await api.update({ id: "1", data: { name: "x" }, version: 3 });
      expect(headersOf()["If-Match"]).toBe('"3"');
      expect(headersOf()["x-keep"]).toBe("yes");
    });

    it("sends no precondition without a version (or with null)", async () => {
      const api = createCrudApi<Doc>("items", { basePath: "/api" });
      await api.update({ id: "1", data: { name: "x" }, version: null });
      expect(headersOf()["If-Match"]).toBeUndefined();
    });

    it("versionOf reads the configured field, numbers only", () => {
      const api = createCrudApi<Doc>("items", { versionField: "__v" });
      expect(api.versionOf({ __v: 7 })).toBe(7);
      expect(api.versionOf({ __v: "7" })).toBeUndefined();
      expect(createCrudApi("items").versionOf({ __v: 7 })).toBeUndefined();
    });
  });

  describe("useActions().update — which version is sent", () => {
    let queryClient: QueryClient;
    beforeEach(() => {
      queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity },
          mutations: { retry: false },
        },
      });
      configureToast({ success: vi.fn(), error: vi.fn() });
    });
    afterEach(() => queryClient.clear());

    function setup(
      update = vi.fn(async ({ id }: { id: string }) => ({ _id: id, name: "n", __v: 9 })),
    ) {
      const api = {
        getAll: vi.fn(),
        getById: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
        count: vi.fn(),
        update,
        versionOf: (doc: unknown) => {
          const v = (doc as { __v?: unknown } | null | undefined)?.__v;
          return typeof v === "number" ? v : undefined;
        },
      } as unknown as CrudApi<Doc>;
      const hooks = createCrudHooks<Doc>({
        api,
        entityKey: `cc-${crypto.randomUUID()}`,
        singular: "Doc",
      });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });
      return { hooks, update, actions: () => result.current };
    }

    const sentVersion = (update: ReturnType<typeof vi.fn>, call = 0) =>
      (update.mock.calls[call]![0] as { version?: number }).version;

    it("an explicit version wins over the cache", async () => {
      const { hooks, update, actions } = setup();
      queryClient.setQueryData(hooks.KEYS.detail("1", {}), { _id: "1", name: "a", __v: 5 });
      await act(() => actions().update({ id: "1", data: { name: "b" }, version: 3 }));
      expect(sentVersion(update)).toBe(3);
    });

    it("data[versionField] is the snapshot the form edited — preferred over a refetched cache", async () => {
      const { hooks, update, actions } = setup();
      // The cache was refetched to v5 while the user edited a form loaded at v3.
      queryClient.setQueryData(hooks.KEYS.detail("1", {}), { _id: "1", name: "theirs", __v: 5 });
      await act(() =>
        actions().update({ id: "1", data: { name: "mine", __v: 3 } as Partial<Doc> }),
      );
      expect(sentVersion(update)).toBe(3); // → 412, not a silent overwrite
    });

    it("falls back to the cached detail, then to a list row", async () => {
      const { hooks, update, actions } = setup();
      queryClient.setQueryData(hooks.KEYS.detail("1", {}), { _id: "1", name: "a", __v: 5 });
      await act(() => actions().update({ id: "1", data: { name: "b" } }));
      expect(sentVersion(update)).toBe(5);

      queryClient.setQueryData(hooks.KEYS.list({}), { data: [{ _id: "2", name: "r", __v: 11 }] });
      await act(() => actions().update({ id: "2", data: { name: "b" } }));
      expect(sentVersion(update, 1)).toBe(11);
    });

    it("version: null sends no precondition — the 'save anyway' path", async () => {
      const { hooks, update, actions } = setup();
      queryClient.setQueryData(hooks.KEYS.detail("1", {}), { _id: "1", name: "a", __v: 5 });
      await act(() => actions().update({ id: "1", data: { name: "b" }, version: null }));
      expect(sentVersion(update)).toBeUndefined();
    });

    it("a second queued update to the same record uses the version the first one returned", async () => {
      let v = 5;
      const update = vi.fn(async ({ id }: { id: string }) => ({ _id: id, name: "n", __v: ++v }));
      const { hooks, actions } = setup(update);
      queryClient.setQueryData(hooks.KEYS.detail("1", {}), { _id: "1", name: "a", __v: 5 });
      await act(async () => {
        await Promise.all([
          actions().update({ id: "1", data: { name: "b" } }),
          actions().update({ id: "1", data: { name: "c" } }),
        ]);
      });
      expect(sentVersion(update, 0)).toBe(5);
      expect(sentVersion(update, 1)).toBe(6); // not 5 — that would 412 against our own write
    });

    it("a 412 surfaces as isPreconditionFailed and rolls the optimistic edit back", async () => {
      const stale = new ArcApiError("changed", {
        status: 412,
        statusText: "Precondition Failed",
        json: { code: "arc.precondition_failed", message: "changed", status: 412 },
        endpoint: "/api/v1/items/1",
        method: "PATCH",
      });
      const { hooks, actions } = setup(vi.fn().mockRejectedValue(stale));
      const before = { _id: "1", name: "theirs", __v: 5 };
      queryClient.setQueryData(hooks.KEYS.detail("1", {}), before);

      let caught: unknown;
      await act(async () => {
        await actions()
          .update({ id: "1", data: { name: "mine" }, version: 3 })
          .catch((e: unknown) => {
            caught = e;
          });
      });
      expect(isPreconditionFailed(caught)).toBe(true);
      expect(queryClient.getQueryData(hooks.KEYS.detail("1", {}))).toEqual(before);
    });
  });
});

describe("useAction error toasts", () => {
  /** A refused action verb toasts its error — the caller's headline, plus the server's reason on a 4xx. */
  type Item = { _id: string; name: string };

  async function toastFor(rejection: Error): Promise<string> {
    configureClient({ baseUrl: "http://api.test" });
    const toast = { success: vi.fn(), error: vi.fn() };
    configureToast(toast);
    const api: CrudApi<Item, { name: string }, { name: string }> = {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      dispatchAction: vi.fn().mockRejectedValue(rejection),
    };
    const hooks = createCrudHooks<Item, { name: string }, { name: string }>({
      api,
      entityKey: "items",
      singular: "Item",
    });
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(
      () =>
        hooks.useAction({ action: "end", messages: { success: "Ended", error: "Failed to end" } }),
      { wrapper },
    );
    await act(async () => {
      await result.current.mutateAsync({ id: "1", data: {} }).catch(() => undefined);
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    return String(toast.error.mock.calls[0]?.[0]);
  }

  const apiError = (status: number, message: string) =>
    new ArcApiError(message, {
      status,
      statusText: "",
      json: { message },
      endpoint: "/items/1/action",
      method: "POST",
    });

  describe("useAction error toast", () => {
    it("a 4xx refusal shows the headline AND the server's reason", async () => {
      expect(await toastFor(apiError(422, "A relationship ends after it starts."))).toBe(
        "Failed to end: A relationship ends after it starts.",
      );
    });

    it("a 5xx keeps the headline alone — its message is not the operator's to act on", async () => {
      expect(await toastFor(apiError(500, "TypeError: cannot read x of undefined"))).toBe(
        "Failed to end",
      );
    });

    it("a non-API error still reaches the configured error toast", async () => {
      expect(await toastFor(new Error("network down"))).toBe("Failed to end");
    });
  });
});

describe("usePendingWrites", () => {
  /**
   * `usePendingWrites`: optimistic UI from TanStack's mutation cache (`useMutationState` over the
   * resource's shared write key), readable from ANY component, not just the one that wrote.
   */

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  afterEach(() => configureAuth({ getToken: () => null, getOrgId: () => null }));

  describe("usePendingWrites", () => {
    it("reports a create in flight with its variables, then clears", async () => {
      configureAuth({ getToken: () => "t", getOrgId: () => null });
      const gate = deferred<unknown>();
      const hooks = createCrudHooks<{ _id: string; title: string }, { title: string }>({
        api: {
          getAll: async () => ({ method: "offset", data: [] }),
          getById: async () => ({}),
          create: () => gate.promise,
          update: async () => ({}),
          delete: async () => ({}),
          count: async () => 0,
        } as never,
        entityKey: "notes",
        singular: "Note",
      });
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: qc }, children);

      // Writer and reader are different hook instances (different components in an app).
      const writer = renderHook(() => hooks.useActions(), { wrapper });
      const reader = renderHook(() => hooks.usePendingWrites(), { wrapper });
      expect(reader.result.current).toEqual([]);

      let done!: Promise<unknown>;
      act(() => {
        done = writer.result.current.create({ data: { title: "Draft" } });
      });
      await waitFor(() => expect(reader.result.current).toHaveLength(1));
      expect(reader.result.current[0]).toMatchObject({
        op: "create",
        variables: { data: { title: "Draft" } },
      });

      await act(async () => {
        gate.resolve({ _id: "n1", title: "Draft" });
        await done;
      });
      await waitFor(() => expect(reader.result.current).toEqual([]));
    });

    it("hooks.queries.update() works with plain useMutation and shares the write key", async () => {
      const hooks = createCrudHooks<{ _id: string }>({
        api: {
          getAll: async () => ({ data: [] }),
          getById: async () => ({}),
          create: async () => ({}),
          update: async ({ id }: { id: string }) => ({ _id: id }),
          delete: async () => ({}),
          count: async () => 0,
        } as never,
        entityKey: "notes2",
        singular: "Note",
      });
      const qc = new QueryClient();
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: qc }, children);
      const { result } = renderHook(() => useMutation(hooks.queries.update()), { wrapper });
      let out: unknown;
      await act(async () => {
        out = await result.current.mutateAsync({ id: "n1", data: {} });
      });
      expect(out).toEqual({ _id: "n1" });
      expect(qc.getMutationCache().getAll()[0]?.options.mutationKey).toEqual(hooks.KEYS.write());
    });
  });
});
