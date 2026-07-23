/**
 * `syncDetailToLists` — pseudo-normalization helper. Covers:
 *
 *  1. Updates matching list entries in-place when a fresh detail lands.
 *  2. Shallow-merge preserves the list-item key set (no detail-only field
 *     bleed into list caches → no memory bloat).
 *  3. Skips list entries that don't contain the item (no spurious writes).
 *  4. Walks infinite-query `pages` arrays.
 *  5. Honors a custom `idField` (matches `createCrudHooks({ idField })`).
 *  6. Never creates new cache entries — only updates existing ones.
 *  7. Returns the count of touched caches for telemetry.
 *
 * Plus the wiring test: `useDetail`'s fresh GET propagates to a mounted
 * `useList` in a sibling component (master/detail layout) without an
 * extra round-trip.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryKeys, syncDetailToLists } from "../src/cache.js";
import { configureAuth, configureClient } from "../src/client.js";
import { type CrudApi, createCrudHooks } from "../src/hooks.js";

function createQc(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

function Wrap(qc: QueryClient) {
  return function Provider({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

type Item = { _id: string; title: string; status?: string; body?: string };

describe("syncDetailToLists (cache.ts helper)", () => {
  const KEYS = createQueryKeys("items");

  it("shallow-merges fresh detail into a matching list entry, preserves list key set", () => {
    const qc = createQc();
    qc.setQueryData(KEYS.lists(), {
      data: [
        { _id: "a", title: "A stale", status: "pending" },
        { _id: "b", title: "B", status: "pending" },
      ],
      total: 2,
    });

    const updated = syncDetailToLists(qc, KEYS.lists(), {
      _id: "a",
      title: "A fresh",
      status: "done",
      body: "detail-only field",
    });

    expect(updated).toBe(1);
    const list = qc.getQueryData(KEYS.lists()) as { data: Item[] };
    // List item received fresh values for keys it ALREADY had (title, status)
    // but NOT the detail-only `body` field — preserves list-cache leanness.
    expect(list.data[0]).toEqual({ _id: "a", title: "A fresh", status: "done" });
    expect((list.data[0] as Item).body).toBeUndefined();
    // Other items left alone.
    expect(list.data[1]).toEqual({ _id: "b", title: "B", status: "pending" });
  });

  it("no-op when list does not contain the doc (no spurious writes)", () => {
    const qc = createQc();
    qc.setQueryData(KEYS.lists(), { data: [{ _id: "x", title: "X" }] });

    const updated = syncDetailToLists(qc, KEYS.lists(), { _id: "a", title: "A" });

    expect(updated).toBe(0);
    expect((qc.getQueryData(KEYS.lists()) as { data: Item[] }).data[0]).toEqual({
      _id: "x",
      title: "X",
    });
  });

  it("walks infinite-query pages arrays", () => {
    const qc = createQc();
    const infiniteKey = [...KEYS.lists(), "infinite"];
    qc.setQueryData(infiniteKey, {
      pages: [
        {
          data: [
            { _id: "a", title: "A old" },
            { _id: "b", title: "B" },
          ],
          total: 4,
        },
        {
          data: [
            { _id: "c", title: "C" },
            { _id: "d", title: "D" },
          ],
          total: 4,
        },
      ],
      pageParams: [1, 2],
    });

    const updated = syncDetailToLists(qc, KEYS.lists(), { _id: "a", title: "A new" });
    expect(updated).toBe(1);
    const cur = qc.getQueryData(infiniteKey) as { pages: { data: Item[] }[] };
    expect(cur.pages[0]!.data[0]).toEqual({ _id: "a", title: "A new" });
    // Page 2 untouched
    expect(cur.pages[1]!.data[0]).toEqual({ _id: "c", title: "C" });
  });

  it('honors a custom idField (e.g. "sku")', () => {
    const qc = createQc();
    const SKEYS = createQueryKeys("products");
    qc.setQueryData(SKEYS.lists(), {
      data: [
        { sku: "AA-1", name: "Widget", price: 10 },
        { sku: "BB-2", name: "Gadget", price: 20 },
      ],
    });

    const updated = syncDetailToLists(
      qc,
      SKEYS.lists(),
      { sku: "BB-2", name: "Gadget Pro", price: 25 },
      { idField: "sku" },
    );
    expect(updated).toBe(1);
    expect((qc.getQueryData(SKEYS.lists()) as { data: Item[] }).data[1]).toEqual({
      sku: "BB-2",
      name: "Gadget Pro",
      price: 25,
    });
  });

  it("never creates new cache entries — only writes to existing keys", () => {
    const qc = createQc();
    // No list cache exists at all.
    expect(qc.getQueryData(KEYS.lists())).toBeUndefined();

    const updated = syncDetailToLists(qc, KEYS.lists(), { _id: "a", title: "A" });
    expect(updated).toBe(0);
    // Still no entry.
    expect(qc.getQueryData(KEYS.lists())).toBeUndefined();
    expect(qc.getQueriesData({ queryKey: KEYS.lists() })).toHaveLength(0);
  });

  it("updates ALL matching list caches when multiple filter variants hold the same item", () => {
    const qc = createQc();
    const k1 = KEYS.scopedList("super-admin", { status: "active" });
    const k2 = KEYS.scopedList("super-admin", { status: "all" });
    qc.setQueryData(k1, { data: [{ _id: "a", title: "A old" }] });
    qc.setQueryData(k2, {
      data: [
        { _id: "a", title: "A old" },
        { _id: "b", title: "B" },
      ],
    });

    const updated = syncDetailToLists(qc, KEYS.lists(), { _id: "a", title: "A new" });
    expect(updated).toBe(2);
    expect((qc.getQueryData(k1) as { data: Item[] }).data[0]!.title).toBe("A new");
    expect((qc.getQueryData(k2) as { data: Item[] }).data[0]!.title).toBe("A new");
  });

  it("returns 0 when nothing actually changed (same values, no spurious setQueryData)", () => {
    const qc = createQc();
    qc.setQueryData(KEYS.lists(), { data: [{ _id: "a", title: "A" }] });
    const setSpy = vi.spyOn(qc, "setQueryData");

    const updated = syncDetailToLists(qc, KEYS.lists(), { _id: "a", title: "A" });
    expect(updated).toBe(0);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("handles entries without a resolvable id (no crash, no update)", () => {
    const qc = createQc();
    qc.setQueryData(KEYS.lists(), { data: [{ name: "no id" }, { _id: "a", title: "A" }] });

    const updated = syncDetailToLists(qc, KEYS.lists(), { _id: "a", title: "A new" });
    expect(updated).toBe(1);
    expect((qc.getQueryData(KEYS.lists()) as { data: Item[] }).data).toEqual([
      { name: "no id" },
      { _id: "a", title: "A new" },
    ]);
  });
});

// ============================================================================
// Wiring — useDetail's fresh GET propagates to a mounted useList
// ============================================================================

function mockApi(): CrudApi<Item> {
  return {
    getAll: vi.fn().mockResolvedValue({
      data: [
        { _id: "a", title: "A from list", status: "pending" },
        { _id: "b", title: "B from list", status: "active" },
      ],
      total: 2,
      page: 1,
      limit: 10,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    }),
    getById: vi.fn().mockResolvedValue({
      _id: "a",
      title: "A from detail",
      status: "archived",
      body: "full body",
    }),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

describe("useDetail → useList pseudo-normalization (master/detail layout)", () => {
  beforeEach(() => {
    configureClient({ baseUrl: "http://api.test" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("detail GET that updates an item propagates to the still-mounted list cache", async () => {
    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: "items", singular: "Item" });
    const qc = createQc();

    // Mount the list — gets {_id, title, status} for both items.
    const list = renderHook(() => hooks.useList(undefined, { public: true }), {
      wrapper: Wrap(qc),
    });
    await waitFor(() => expect(list.result.current.items).toHaveLength(2));
    expect(list.result.current.items[0]).toEqual({
      _id: "a",
      title: "A from list",
      status: "pending",
    });

    // Mount detail — fresh GET returns richer {_id, title, status, body}.
    renderHook(() => hooks.useDetail("a", { public: true }), { wrapper: Wrap(qc) });

    // Wait for the detail GET to resolve AND the post-fetch sync effect to fire.
    await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      // The list cache now reflects the fresh title + status — without firing
      // another list fetch.
      expect(list.result.current.items[0]).toEqual({
        _id: "a",
        title: "A from detail",
        status: "archived",
      });
    });

    // Crucially: list-cache entry stays LEAN (no `body` bleed).
    expect((list.result.current.items[0] as Item).body).toBeUndefined();
    // Other items left alone.
    expect(list.result.current.items[1]).toEqual({
      _id: "b",
      title: "B from list",
      status: "active",
    });
    // No spurious second list fetch.
    expect(api.getAll).toHaveBeenCalledTimes(1);
  });

  it("placeholder fetch (isPlaceholderData: true) does NOT trigger sync", async () => {
    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: "items", singular: "Item" });
    const qc = createQc();

    // Mount list first to seed placeholderData.
    const list = renderHook(() => hooks.useList(undefined, { public: true }), {
      wrapper: Wrap(qc),
    });
    await waitFor(() => expect(list.result.current.items).toHaveLength(2));

    // Mount detail — placeholder fires synchronously, real GET runs after.
    const detail = renderHook(() => hooks.useDetail("a", { public: true }), {
      wrapper: Wrap(qc),
    });
    // First render: placeholder. We must NOT have triggered a list update
    // from this placeholder (otherwise the cycle described in the JSDoc
    // would burn CPU on every render).
    expect(detail.result.current.isPlaceholderData).toBe(true);

    // Now resolve the real GET and check list ends up with fresh values.
    await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(detail.result.current.isPlaceholderData).toBe(false));
    await waitFor(() => {
      expect(list.result.current.items[0]?.title).toBe("A from detail");
    });
  });
});
