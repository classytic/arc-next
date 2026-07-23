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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrudApi } from "../src/hooks.js";
import { createCrudHooks } from "../src/hooks.js";
import { configureToast } from "../src/mutation.js";

type Doc = { _id: string; name: string };

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

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
    expect(queryClient.getQueryData(hooks.KEYS.detail("server-1"))).toEqual(server);
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
    queryClient.setQueryData(hooks.KEYS.detail("1"), { _id: "1", name: "Old", extra: "kept" });

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => hooks.useActions(), { wrapper });

    let done: Promise<Doc>;
    act(() => {
      done = result.current.update({ id: "1", data: { name: "New" } });
    });

    await waitFor(() => {
      // Raw merge — updated field applied at TOP level, sibling fields kept,
      // and no nested `data` envelope introduced.
      expect(queryClient.getQueryData(hooks.KEYS.detail("1"))).toEqual({
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
    const api = createMockApi({
      update: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const hooks = makeHooks(api);
    const listKey = hooks.KEYS.list({});
    const detailBefore = { _id: "1", name: "Old" };
    const listBefore = { data: [{ _id: "1", name: "Old" }], total: 1 };
    queryClient.setQueryData(hooks.KEYS.detail("1"), detailBefore);
    queryClient.setQueryData(listKey, listBefore);

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => hooks.useActions(), { wrapper });

    await act(async () => {
      await expect(result.current.update({ id: "1", data: { name: "New" } })).rejects.toThrow(
        "boom",
      );
    });

    expect(queryClient.getQueryData(hooks.KEYS.detail("1"))).toEqual(detailBefore);
    expect(queryClient.getQueryData(listKey)).toEqual(listBefore);
  });

  it("does not touch detail caches of OTHER records", async () => {
    const api = createMockApi();
    const hooks = makeHooks(api);
    const other = { _id: "2", name: "Other" };
    queryClient.setQueryData(hooks.KEYS.detail("2"), other);

    const wrapper = createWrapper(queryClient);
    const { result } = renderHook(() => hooks.useActions(), { wrapper });

    await act(async () => {
      await result.current.update({ id: "1", data: { name: "New" } });
    });

    expect(queryClient.getQueryData(hooks.KEYS.detail("2"))).toEqual(other);
  });
});

// ============================================================================
// 3. per-record write ordering
// ============================================================================

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
      bulkUpdate: vi
        .fn()
        .mockResolvedValue({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }),
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
      bulkUpdate: vi
        .fn()
        .mockResolvedValue({ acknowledged: true, matchedCount: 3, modifiedCount: 3 }),
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

    expect(queryClient.getQueryData(hooks.KEYS.detail("b1"))).toEqual(created[0]);
    expect(queryClient.getQueryData(hooks.KEYS.detail("b2"))).toEqual(created[1]);
  });
});
