import { hashKey, QueryClient, type QueryKey } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAuth, configureClient } from "../../src/client/client.js";
import {
  arcTag,
  changeTags,
  createCacheUtils,
  createQueryKeys,
  DEFAULT_QUERY_CONFIG,
  getItemId,
  invalidateForChange,
  type KeyScope,
  normalizePagination,
  prependToListCache,
  replaceItemInListCache,
  resourceTags,
  syncDetailToLists,
  updateListCache,
} from "../../src/query/cache.js";
import { type CrudApi, createCrudHooks } from "../../src/query/hooks.js";
import { createTestQueryClient, createWrapper } from "../harness/query-client.js";

/** The default partition segment: signed in, no tenant, no scope. */
const P0 = { auth: "inherit", organizationId: null, scope: null };

describe("keys and list helpers", () => {
  // ============================================================================
  // getItemId
  // ============================================================================

  describe("getItemId", () => {
    it("extracts _id", () => {
      expect(getItemId({ _id: "abc" })).toBe("abc");
    });

    it("extracts id", () => {
      expect(getItemId({ id: "xyz" })).toBe("xyz");
    });

    it("prefers _id over id", () => {
      expect(getItemId({ _id: "abc", id: "xyz" })).toBe("abc");
    });

    it("converts numeric id to string", () => {
      expect(getItemId({ _id: 123 })).toBe("123");
    });

    it("returns null for missing id", () => {
      expect(getItemId({})).toBeNull();
      expect(getItemId({ name: "test" })).toBeNull();
    });

    it("returns null for non-objects", () => {
      expect(getItemId(null)).toBeNull();
      expect(getItemId(undefined)).toBeNull();
      expect(getItemId("string")).toBeNull();
      expect(getItemId(42)).toBeNull();
    });
  });

  // ============================================================================
  // updateListCache
  // ============================================================================

  describe("updateListCache", () => {
    it("handles docs format", () => {
      const data = { data: [{ _id: "1" }, { _id: "2" }], total: 2 };
      const result = updateListCache(data, (items: unknown[]) =>
        items.filter((i: any) => i._id !== "1"),
      );
      expect(result).toEqual({ data: [{ _id: "2" }], total: 1 });
    });

    it("handles array format", () => {
      const data = [{ id: "1" }, { id: "2" }];
      const result = updateListCache(data, (items: unknown[]) => [...items, { id: "3" }]);
      expect(result).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
    });

    it("handles data format", () => {
      const data = { data: [{ id: "1" }], success: true };
      const result = updateListCache(data, (items: unknown[]) => []);
      expect(result).toEqual({ data: [], success: true });
    });

    it("does not add totalDocs when not originally present", () => {
      const data = { data: [{ _id: "1" }], total: 1 };
      const result = updateListCache(data, (items: unknown[]) => [...items, { _id: "2" }]);
      expect(result).toEqual({ data: [{ _id: "1" }, { _id: "2" }], total: 2 });
      expect(result).not.toHaveProperty("totalDocs");
    });

    it("returns unchanged for null/undefined", () => {
      expect(updateListCache(null, (items: unknown[]) => items)).toBeNull();
      expect(updateListCache(undefined, (items: unknown[]) => [])).toBeUndefined();
    });

    it("returns unchanged for unrecognized format", () => {
      const data = { other: "value" };
      expect(updateListCache(data, () => [])).toEqual(data);
    });
  });

  // ============================================================================
  // Flexible response extraction (custom keys)
  // ============================================================================

  describe("extractItems flexibility (via updateListCache)", () => {
    it("well-known keys take precedence over custom keys", () => {
      // If both `docs` and `products` exist, `docs` wins
      const data = { data: [{ _id: "1" }], products: [{ _id: "2" }], total: 1 };
      const result = updateListCache(data, (items: unknown[]) => [...items, { _id: "3" }]);
      const r = result as Record<string, unknown>;
      expect(r.data).toEqual([{ _id: "1" }, { _id: "3" }]);
      expect(r.products).toEqual([{ _id: "2" }]); // untouched
    });

    it("returns unchanged when no array field exists", () => {
      const data = { message: "ok", count: 0 };
      expect(updateListCache(data, () => [])).toEqual(data);
    });
  });

  // ============================================================================
  // createQueryKeys
  // ============================================================================

  describe("createQueryKeys", () => {
    const KEYS = createQueryKeys("posts");

    it("creates all key", () => {
      expect(KEYS.all).toEqual(["posts"]);
    });

    it("creates lists key", () => {
      expect(KEYS.lists()).toEqual(["posts", "list"]);
    });

    it("creates list key with params", () => {
      expect(KEYS.list({ page: 1 })).toEqual(["posts", "list", P0, { page: 1 }]);
    });

    it("lists(partition) is the exact prefix of that partition's lists", () => {
      expect(KEYS.lists({ organizationId: "o" })).toEqual([
        "posts",
        "list",
        { auth: "inherit", organizationId: "o", scope: null },
      ]);
    });

    it("creates details key", () => {
      expect(KEYS.details()).toEqual(["posts", "detail"]);
    });

    it("creates detail key with id", () => {
      expect(KEYS.detail("abc")).toEqual(["posts", "detail", "abc"]);
    });

    it("creates custom key", () => {
      expect(KEYS.custom("capabilities")).toEqual(["posts", "capabilities"]);
      expect(KEYS.custom("stats", "monthly")).toEqual(["posts", "stats", "monthly"]);
    });

    it("keys the tenant in the partition only; an organizationId param stays a filter", () => {
      expect(KEYS.list({}, { organizationId: "org-1" })).toEqual([
        "posts",
        "list",
        { ...P0, organizationId: "org-1" },
        {},
      ]);
      expect(KEYS.list({ organizationId: "org-1" })).toEqual([
        "posts",
        "list",
        P0,
        { organizationId: "org-1" },
      ]);
      expect(KEYS.list({}, { organizationId: null })).toEqual(["posts", "list", P0, {}]);
    });

    it("every key kind x every partition is a distinct entry (auth, tenant, scope)", () => {
      const kinds: Record<string, (p: KeyScope) => QueryKey> = {
        list: (p) => KEYS.list({ limit: 5 }, p),
        infinite: (p) => KEYS.infinite({ limit: 5 }, p),
        detail: (p) => KEYS.detail("p1", p),
        detailParams: (p) => KEYS.detail("p1", { ...p, params: { select: "title" } }),
        slug: (p) => KEYS.slug("s1", p),
        count: (p) => KEYS.count({}, p),
        deleted: (p) => KEYS.deleted({}, p),
        tree: (p) => KEYS.tree({}, p),
        children: (p) => KEYS.children("c1", {}, p),
        aggregation: (p) => KEYS.aggregation("sales", { from: "x" }, p),
        route: (p) => KEYS.route("/stats", {}, p),
      };
      const partitions: KeyScope[] = [
        {},
        { auth: "omit" },
        { organizationId: "org-A" },
        { organizationId: "org-B" },
        { scope: "A" },
        { scope: "B" },
        { organizationId: "org-A", scope: "A" },
        { auth: "omit", scope: "A" },
      ];
      const seen = new Map<string, string>();
      for (const [kind, build] of Object.entries(kinds)) {
        for (const partition of partitions) {
          const hash = hashKey(build(partition));
          const label = `${kind} ${JSON.stringify(partition)}`;
          expect(seen.get(hash), `${label} collides with ${seen.get(hash)}`).toBeUndefined();
          seen.set(hash, label);
        }
      }
    });

    it("an anonymous key drops the tenant: auth omit with or without an org is one entry", () => {
      expect(hashKey(KEYS.detail("p1", { auth: "omit", organizationId: "org-A" }))).toBe(
        hashKey(KEYS.detail("p1", { auth: "omit" })),
      );
    });

    it("creates custom-route keys under routes()", () => {
      expect(KEYS.route("me")).toEqual(["posts", "route", "/me", P0, {}]);
      expect(KEYS.route("/stats", { from: "x" }, { organizationId: "o" })).toEqual([
        "posts",
        "route",
        "/stats",
        { ...P0, organizationId: "o" },
        { from: "x" },
      ]);
      expect(KEYS.route("/stats").slice(0, 2)).toEqual(KEYS.routes());
    });
  });

  // ============================================================================
  // createCacheUtils
  // ============================================================================

  describe("createCacheUtils", () => {
    const KEYS = createQueryKeys("items");
    const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

    it("setDetail and getDetail", () => {
      const client = new QueryClient();
      const item = { _id: "1", name: "Item 1" };

      cache.setDetail(client, "1", item);
      expect(cache.getDetail(client, "1")).toEqual(item);
    });

    it("getDetail returns undefined for missing", () => {
      const client = new QueryClient();
      expect(cache.getDetail(client, "nonexistent")).toBeUndefined();
    });

    it("removeDetail clears cache", () => {
      const client = new QueryClient();
      cache.setDetail(client, "1", { _id: "1", name: "Item" });
      cache.removeDetail(client, "1");
      expect(cache.getDetail(client, "1")).toBeUndefined();
    });

    it("invalidateAll calls invalidateQueries", async () => {
      const client = new QueryClient();
      const spy = vi.spyOn(client, "invalidateQueries");
      await cache.invalidateAll(client);
      expect(spy).toHaveBeenCalledWith({ queryKey: ["items"] });
    });

    it("invalidateLists calls invalidateQueries", async () => {
      const client = new QueryClient();
      const spy = vi.spyOn(client, "invalidateQueries");
      await cache.invalidateLists(client);
      expect(spy).toHaveBeenCalledWith({ queryKey: ["items", "list"] });
    });

    it("invalidateDetail calls invalidateQueries with id", async () => {
      const client = new QueryClient();
      const spy = vi.spyOn(client, "invalidateQueries");
      await cache.invalidateDetail(client, "42");
      expect(spy).toHaveBeenCalledWith({ queryKey: ["items", "detail", "42"] });
    });
  });

  // ============================================================================
  // updateListCache — edge cases
  // ============================================================================

  describe("updateListCache edge cases", () => {
    it("returns primitive values unchanged", () => {
      expect(updateListCache(42, () => [])).toBe(42);
      expect(updateListCache("string", () => [])).toBe("string");
      expect(updateListCache(true, () => [])).toBe(true);
    });

    it("handles empty docs array", () => {
      const data = { data: [] as unknown[], total: 0 };
      const result = updateListCache(data, (items: unknown[]) => [...items, { _id: "1" }]);
      expect(result).toEqual({ data: [{ _id: "1" }], total: 1 });
    });

    it("handles data field with non-array value (skips)", () => {
      const data = { data: "not-an-array", success: true };
      expect(updateListCache(data, () => [])).toEqual(data);
    });

    it("preserves extra properties on wrapper objects", () => {
      const data = { data: [{ _id: "1" }], total: 1, page: 1, limit: 10, hasNext: false };
      const result = updateListCache(data, (items: unknown[]) => items) as Record<string, unknown>;
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.hasNext).toBe(false);
    });

    it("total does not go below zero", () => {
      const data = { data: [{ _id: "1" }], total: 0 };
      const result = updateListCache(data, () => []) as Record<string, unknown>;
      expect(result.total).toBe(0);
    });

    it("handles delta when adding multiple items", () => {
      const data = { data: [{ _id: "1" }], total: 1 };
      const result = updateListCache(data, (items: unknown[]) => [
        ...items,
        { _id: "2" },
        { _id: "3" },
        { _id: "4" },
      ]) as Record<string, unknown>;
      expect(result.total).toBe(4);
    });

    it("handles empty array input", () => {
      const data: unknown[] = [];
      const result = updateListCache(data, (items: unknown[]) => [...items, { id: "1" }]);
      expect(result).toEqual([{ id: "1" }]);
    });

    it("does not modify total when item count is unchanged (replace)", () => {
      const data = { data: [{ _id: "1" }, { _id: "2" }], total: 2 };
      const result = updateListCache(data, (items: unknown[]) =>
        items.map((i: any) => ({ ...i, updated: true })),
      ) as Record<string, unknown>;
      expect(result.total).toBe(2);
    });
  });

  // ============================================================================
  // createQueryKeys — edge cases
  // ============================================================================

  describe("createQueryKeys edge cases", () => {
    const KEYS = createQueryKeys("posts");

    it("list without params is the empty-params key", () => {
      expect(KEYS.list()).toEqual(["posts", "list", P0, {}]);
    });

    it("list with empty params", () => {
      const key = KEYS.list({});
      expect(key).toEqual(["posts", "list", P0, {}]);
    });

    it("detail with numeric-like string id", () => {
      expect(KEYS.detail("123")).toEqual(["posts", "detail", "123"]);
    });

    it("custom with no extra args", () => {
      expect(KEYS.custom("stats")).toEqual(["posts", "stats"]);
    });

    it("custom with multiple args", () => {
      expect(KEYS.custom("analytics", "monthly", "2024")).toEqual([
        "posts",
        "analytics",
        "monthly",
        "2024",
      ]);
    });

    it("an explicit scope partitions a list key", () => {
      expect(KEYS.list({ status: "active" }, { scope: "picker" })).toEqual([
        "posts",
        "list",
        { ...P0, scope: "picker" },
        { status: "active" },
      ]);
    });
  });

  // ============================================================================
  // createCacheUtils — edge cases
  // ============================================================================

  describe("createCacheUtils edge cases", () => {
    const KEYS = createQueryKeys("items");
    const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

    it("setDetail writes the raw doc (no { data } envelope) — matches arc 2.13+ wire shape", () => {
      const client = new QueryClient();
      cache.setDetail(client, "1", { _id: "1", name: "Item" });
      const raw = client.getQueryData(KEYS.detail("1", {})) as Record<string, unknown>;
      expect(raw).toEqual({ _id: "1", name: "Item" });
    });

    it("getDetail reads the raw doc — matches what useDetail / prefetch / useNavigation all write", () => {
      const client = new QueryClient();
      client.setQueryData(KEYS.detail("1", {}), { _id: "1", name: "Raw" });
      expect(cache.getDetail(client, "1")).toEqual({ _id: "1", name: "Raw" });
    });

    it("setDetail then getDetail roundtrips correctly", () => {
      const client = new QueryClient();
      const item = { _id: "abc", name: "Test" };
      cache.setDetail(client, "abc", item);
      expect(cache.getDetail(client, "abc")).toEqual(item);
    });

    it("removeDetail then getDetail returns undefined", () => {
      const client = new QueryClient();
      cache.setDetail(client, "1", { _id: "1", name: "Item" });
      cache.removeDetail(client, "1");
      expect(cache.getDetail(client, "1")).toBeUndefined();
    });

    it("invalidateAll uses the broadest key", async () => {
      const client = new QueryClient();
      const spy = vi.spyOn(client, "invalidateQueries");
      await cache.invalidateAll(client);
      expect(spy).toHaveBeenCalledWith({ queryKey: ["items"] });
    });
  });

  // ============================================================================
  // getItemId — edge cases
  // ============================================================================

  describe("getItemId edge cases", () => {
    it("handles zero id (falsy — returns null)", () => {
      // 0 is falsy, so getItemId returns null (by design — MongoDB _ids are never 0)
      expect(getItemId({ _id: 0 })).toBeNull();
    });

    it("handles boolean id (falsy path)", () => {
      expect(getItemId({ _id: false })).toBeNull();
    });

    it("handles nested objects (does not traverse)", () => {
      expect(getItemId({ nested: { _id: "deep" } })).toBeNull();
    });

    it("handles array as input", () => {
      expect(getItemId([1, 2, 3])).toBeNull();
    });
  });

  // ============================================================================
  // DEFAULT_QUERY_CONFIG
  // ============================================================================

  describe("DEFAULT_QUERY_CONFIG", () => {
    it("has expected defaults", () => {
      expect(DEFAULT_QUERY_CONFIG.staleTime).toBe(300_000);
      expect(DEFAULT_QUERY_CONFIG.gcTime).toBe(1_800_000);
      expect(DEFAULT_QUERY_CONFIG.refetchOnWindowFocus).toBe(false);
      expect(DEFAULT_QUERY_CONFIG.retry).toBe(0);
    });
  });

  // ============================================================================
  // Arc Backend Response Shape Coverage
  // ============================================================================

  describe("Arc backend response shapes", () => {
    describe("BaseController.list — offset pagination", () => {
      const response = {
        success: true,
        method: "offset",
        data: [{ _id: "1" }, { _id: "2" }],
        page: 1,
        limit: 10,
        total: 50,
        pages: 5,
        hasNext: true,
        hasPrev: false,
      };

      it("extractItems returns docs", () => {
        const items = updateListCache(response, (i: unknown[]) => i);
        expect((items as Record<string, unknown>).data).toEqual(response.data);
      });

      it("updateListCache updates docs and total", () => {
        const result = updateListCache(response, (items: unknown[]) => [
          ...items,
          { _id: "3" },
        ]) as Record<string, unknown>;
        expect((result.data as unknown[]).length).toBe(3);
        expect(result.total).toBe(51);
      });
    });

    describe("BaseController.list — keyset pagination", () => {
      const response = {
        success: true,
        method: "keyset",
        data: [{ _id: "a" }, { _id: "b" }],
        limit: 20,
        hasMore: true,
        next: "cursor_abc",
      };

      it("extractItems returns docs", () => {
        const result = updateListCache(response, (i: unknown[]) => i);
        expect((result as Record<string, unknown>).data).toEqual(response.data);
      });

      it("updateListCache works on keyset response", () => {
        const result = updateListCache(response, (items: unknown[]) =>
          items.filter((i: any) => i._id !== "a"),
        ) as Record<string, unknown>;
        expect((result.data as unknown[]).length).toBe(1);
        // keyset has no total — should not add one
        expect(result.total).toBeUndefined();
      });
    });

    describe("BaseController.list — aggregate pagination", () => {
      const response = {
        success: true,
        method: "aggregate",
        data: [{ _id: "1", sum: 100 }],
        page: 1,
        limit: 10,
        total: 1,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      };

      it("updateListCache updates docs", () => {
        const result = updateListCache(response, (items: unknown[]) => [
          ...items,
          { _id: "2", sum: 200 },
        ]) as Record<string, unknown>;
        expect((result.data as unknown[]).length).toBe(2);
        expect(result.total).toBe(2);
      });
    });

    describe("BaseController.get — detail response", () => {
      it("handles { success, data: TDoc }", () => {
        const response = { success: true, data: { _id: "1", name: "Widget" } };
        // extractItem would pull out `data`
        const d = response as Record<string, unknown>;
        expect(d.data).toEqual({ _id: "1", name: "Widget" });
      });
    });

    describe("BaseController.delete — delete response", () => {
      it("handles { success, data: { message, id, soft } }", () => {
        const response = {
          success: true,
          data: { message: "Deleted successfully", id: "1", soft: true },
        };
        expect(response.data.message).toBe("Deleted successfully");
        expect(response.data.soft).toBe(true);
      });
    });

    describe("createActionRouter — action response", () => {
      it("handles { success, data: result } with object result", () => {
        const response = { success: true, data: { status: "approved", approvedBy: "admin" } };
        expect(response.data.status).toBe("approved");
      });

      it("handles { success, data: result } with primitive result", () => {
        const response = { success: true, data: "ok" };
        expect(response.data).toBe("ok");
      });
    });

    describe("additional routes — custom response shapes", () => {
      it("handles plain array response", () => {
        const response = [{ _id: "1" }, { _id: "2" }];
        const result = updateListCache(response, (items: unknown[]) =>
          items.filter((i: any) => i._id !== "1"),
        );
        expect((result as unknown[]).length).toBe(1);
      });
    });
  });
});

describe("infinite list helpers", () => {
  /**
   * 0.12: infinite-aware list-cache primitives.
   *
   * `updateListCache` must recognize the TanStack infinite shape
   * (`{ pages, pageParams }`) and walk pages — before this, the any-array
   * fallback treated `pages` ITSELF as the items array, splicing optimistic
   * items between pages (cache corruption).
   *
   * `prependToListCache` targets exactly one insertion point (first page);
   * `replaceItemInListCache` swaps a matched item in place (temp-ID
   * reconciliation primitive).
   */

  type Item = { _id: string; name: string };

  const page = (ids: string[], total?: number) => ({
    data: ids.map((id) => ({ _id: id, name: `n${id}` })),
    ...(total !== undefined ? { total } : {}),
  });

  const infinite = (...pages: unknown[]) => ({ pages, pageParams: pages.map((_, i) => i + 1) });

  describe("updateListCache — infinite shape", () => {
    it("maps the updater over every page instead of treating pages as items", () => {
      const cache = infinite(page(["1", "2"]), page(["3"]));
      const result = updateListCache<Item>(cache, (items) =>
        items.map((i) => (i._id === "3" ? { ...i, name: "renamed" } : i)),
      ) as { pages: Array<{ data: Item[] }>; pageParams: unknown[] };

      // Wrapper shape preserved — still { pages, pageParams }, page count intact.
      expect(result.pages).toHaveLength(2);
      expect(result.pageParams).toEqual([1, 2]);
      expect(result.pages[0]!.data.map((i) => i._id)).toEqual(["1", "2"]);
      expect(result.pages[1]!.data[0]).toMatchObject({ _id: "3", name: "renamed" });
    });

    it("returns the same reference when no page changed", () => {
      const cache = infinite(page(["1"]), page(["2"]));
      const result = updateListCache<Item>(cache, (items) => items);
      expect(result).toBe(cache);
    });

    it("filter updaters remove items from any page and adjust that page total", () => {
      const cache = infinite(page(["1", "2"], 3), page(["3"], 3));
      const result = updateListCache<Item>(cache, (items) =>
        items.filter((i) => i._id !== "3"),
      ) as {
        pages: Array<{ data: Item[]; total: number }>;
      };
      expect(result.pages[0]!.data).toHaveLength(2);
      expect(result.pages[0]!.total).toBe(3); // untouched page keeps its total
      expect(result.pages[1]!.data).toHaveLength(0);
      expect(result.pages[1]!.total).toBe(2);
    });
  });

  describe("prependToListCache", () => {
    it("prepends to a flat list payload and bumps total", () => {
      const result = prependToListCache(page(["1"], 1), { _id: "x", name: "new" }) as {
        data: Item[];
        total: number;
      };
      expect(result.data.map((i) => i._id)).toEqual(["x", "1"]);
      expect(result.total).toBe(2);
    });

    it("prepends to the FIRST page only of an infinite cache", () => {
      const cache = infinite(page(["1"], 3), page(["2"], 3));
      const result = prependToListCache(cache, { _id: "x", name: "new" }) as {
        pages: Array<{ data: Item[] }>;
      };
      expect(result.pages[0]!.data.map((i) => i._id)).toEqual(["x", "1"]);
      expect(result.pages[1]!.data.map((i) => i._id)).toEqual(["2"]); // untouched
    });

    it("is a no-op for an infinite cache with zero pages", () => {
      const cache = { pages: [], pageParams: [] };
      expect(prependToListCache(cache, { _id: "x" })).toBe(cache);
    });
  });

  describe("replaceItemInListCache", () => {
    it("replaces the matched item in a flat payload without touching others", () => {
      const server = { _id: "real-1", name: "server" };
      const cache = {
        data: [
          { _id: "temp-abc", name: "optimistic", _optimistic: true },
          { _id: "2", name: "n2" },
        ],
        total: 2,
      };
      const result = replaceItemInListCache(cache, "temp-abc", server) as {
        data: Item[];
        total: number;
      };
      expect(result.data[0]).toBe(server);
      expect(result.data[1]).toEqual({ _id: "2", name: "n2" });
      expect(result.total).toBe(2); // replacement, not insertion
    });

    it("replaces across infinite pages", () => {
      const server = { _id: "9", name: "server" };
      const cache = infinite(page(["1"]), page(["temp-x"]));
      const result = replaceItemInListCache(
        { ...cache, pages: [cache.pages[0], { data: [{ _id: "temp-x", name: "o" }] }] },
        "temp-x",
        server,
      ) as { pages: Array<{ data: Item[] }> };
      expect(result.pages[1]!.data[0]).toBe(server);
    });

    it("honors a custom idField", () => {
      const cache = { data: [{ sku: "A1", name: "a" }] };
      const result = replaceItemInListCache(
        cache,
        "A1",
        { sku: "A1", name: "b" },
        { idField: "sku" },
      ) as {
        data: Array<{ sku: string; name: string }>;
      };
      expect(result.data[0]!.name).toBe("b");
    });

    it("returns the same reference when nothing matches", () => {
      const cache = page(["1"]);
      expect(replaceItemInListCache(cache, "nope", { _id: "nope" })).toBe(cache);
    });
  });
});

describe("syncDetailToLists", () => {
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

  type Item = { _id: string; title: string; status?: string; body?: string };

  describe("syncDetailToLists (cache.ts helper)", () => {
    const KEYS = createQueryKeys("items");

    it("shallow-merges fresh detail into a matching list entry, preserves list key set", () => {
      const qc = createTestQueryClient();
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
      const qc = createTestQueryClient();
      qc.setQueryData(KEYS.lists(), { data: [{ _id: "x", title: "X" }] });

      const updated = syncDetailToLists(qc, KEYS.lists(), { _id: "a", title: "A" });

      expect(updated).toBe(0);
      expect((qc.getQueryData(KEYS.lists()) as { data: Item[] }).data[0]).toEqual({
        _id: "x",
        title: "X",
      });
    });

    it("walks infinite-query pages arrays", () => {
      const qc = createTestQueryClient();
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
      const qc = createTestQueryClient();
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
      const qc = createTestQueryClient();
      // No list cache exists at all.
      expect(qc.getQueryData(KEYS.lists())).toBeUndefined();

      const updated = syncDetailToLists(qc, KEYS.lists(), { _id: "a", title: "A" });
      expect(updated).toBe(0);
      // Still no entry.
      expect(qc.getQueryData(KEYS.lists())).toBeUndefined();
      expect(qc.getQueriesData({ queryKey: KEYS.lists() })).toHaveLength(0);
    });

    it("updates ALL matching list caches when multiple filter variants hold the same item", () => {
      const qc = createTestQueryClient();
      const k1 = KEYS.list({ status: "active" });
      const k2 = KEYS.list({ status: "all" });
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
      const qc = createTestQueryClient();
      qc.setQueryData(KEYS.lists(), { data: [{ _id: "a", title: "A" }] });
      const setSpy = vi.spyOn(qc, "setQueryData");

      const updated = syncDetailToLists(qc, KEYS.lists(), { _id: "a", title: "A" });
      expect(updated).toBe(0);
      expect(setSpy).not.toHaveBeenCalled();
    });

    it("handles entries without a resolvable id (no crash, no update)", () => {
      const qc = createTestQueryClient();
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
      count: vi.fn().mockResolvedValue(0),
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
      const qc = createTestQueryClient();

      // Mount the list — gets {_id, title, status} for both items.
      const list = renderHook(() => hooks.useList(undefined, { public: true }), {
        wrapper: createWrapper(qc),
      });
      await waitFor(() => expect(list.result.current.items).toHaveLength(2));
      expect(list.result.current.items[0]).toEqual({
        _id: "a",
        title: "A from list",
        status: "pending",
      });

      // Mount detail — fresh GET returns richer {_id, title, status, body}.
      renderHook(() => hooks.useDetail("a", { public: true }), { wrapper: createWrapper(qc) });

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
      const qc = createTestQueryClient();

      // Mount list first to seed placeholderData.
      const list = renderHook(() => hooks.useList(undefined, { public: true }), {
        wrapper: createWrapper(qc),
      });
      await waitFor(() => expect(list.result.current.items).toHaveLength(2));

      // Mount detail — placeholder fires synchronously, real GET runs after.
      const detail = renderHook(() => hooks.useDetail("a", { public: true }), {
        wrapper: createWrapper(qc),
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

  // A detail read merges into, and previews from, only the lists read as the SAME identity
  // (auth, tenant, scope): never a private read into an anonymous (CDN-shared) list.
  describe("useDetail sync and placeholders stay inside the read's partition", () => {
    const publicThenPrivate = (): CrudApi<Item> => ({
      ...mockApi(),
      getAll: vi.fn().mockResolvedValue({
        method: "offset",
        data: [{ _id: "a", title: "Public" }],
        total: 1,
      }),
      getById: vi.fn().mockResolvedValue({ _id: "a", title: "Private" }),
    });

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => "tok", getOrgId: () => null });
    });
    afterEach(() => {
      configureAuth({ getToken: () => null, getOrgId: () => null });
      vi.restoreAllMocks();
    });

    it("a private detail never overwrites an anonymous list", async () => {
      const api = publicThenPrivate();
      const hooks = createCrudHooks({ api, entityKey: "items", singular: "Item" });
      const qc = createTestQueryClient();
      const wrapper = createWrapper(qc);
      const anonymous = renderHook(() => hooks.useList({}, { auth: "omit" }), { wrapper });
      await waitFor(() => expect(anonymous.result.current.items).toHaveLength(1));

      const detail = renderHook(() => hooks.useDetail("a"), { wrapper });
      await waitFor(() => expect(detail.result.current.item?.title).toBe("Private"));
      await new Promise((r) => setTimeout(r, 0));

      expect(anonymous.result.current.items[0]?.title).toBe("Public");
      const anonymousKey = hooks.queries.list({}, { auth: "omit" }).queryKey;
      expect((qc.getQueryData(anonymousKey) as { data: Item[] }).data[0]?.title).toBe("Public");
    });

    it("a detail merges into lists of another tenant or scope never, its own always", async () => {
      const api = publicThenPrivate();
      const hooks = createCrudHooks({ api, entityKey: "items", singular: "Item" });
      const qc = createTestQueryClient();
      const row = () => ({ data: [{ _id: "a", title: "Stale" }] });
      const own = hooks.queries.list({}).queryKey;
      const otherTenant = hooks.queries.list({}, { organizationId: "org-B" }).queryKey;
      const otherScope = hooks.queries.list({}, { scope: "admin" }).queryKey;
      for (const key of [own, otherTenant, otherScope]) qc.setQueryData(key, row());

      const detail = renderHook(() => hooks.useDetail("a"), { wrapper: createWrapper(qc) });
      await waitFor(() => expect(detail.result.current.item?.title).toBe("Private"));
      await waitFor(() =>
        expect((qc.getQueryData(own) as { data: Item[] }).data[0]?.title).toBe("Private"),
      );
      expect((qc.getQueryData(otherTenant) as { data: Item[] }).data[0]?.title).toBe("Stale");
      expect((qc.getQueryData(otherScope) as { data: Item[] }).data[0]?.title).toBe("Stale");
    });

    it("an anonymous detail never previews a row from a signed-in list", () => {
      const api = publicThenPrivate();
      api.getById = vi.fn(() => new Promise<never>(() => {}));
      const hooks = createCrudHooks({ api, entityKey: "items", singular: "Item" });
      const qc = createTestQueryClient();
      qc.setQueryData(hooks.queries.list({}).queryKey, {
        data: [{ _id: "a", title: "Private" }],
      });
      const anonymous = renderHook(() => hooks.useDetail("a", { auth: "omit" }), {
        wrapper: createWrapper(qc),
      });
      expect(anonymous.result.current.isPlaceholderData).toBe(false);
      expect(anonymous.result.current.item).toBeNull();

      const signedIn = renderHook(() => hooks.useDetail("a"), { wrapper: createWrapper(qc) });
      expect(signedIn.result.current.isPlaceholderData).toBe(true);
      expect(signedIn.result.current.item?.title).toBe("Private");
    });
  });
});

describe("estimated totals", () => {
  describe("normalizePagination — mongokit estimated totals", () => {
    it("carries totalIsEstimate and countedAt through", () => {
      const p = normalizePagination({
        method: "offset",
        data: [],
        total: 10000,
        pages: 500,
        page: 1,
        limit: 20,
        hasNext: true,
        hasPrev: false,
        totalIsEstimate: true,
        countedAt: "2026-10-10T06:00:00.000Z",
      });
      expect(p?.totalIsEstimate).toBe(true);
      expect(p?.countedAt).toBe("2026-10-10T06:00:00.000Z");
    });

    it("an exact total says so", () => {
      const p = normalizePagination({
        method: "offset",
        data: [],
        total: 42,
        pages: 3,
        page: 1,
        limit: 20,
      });
      expect(p?.totalIsEstimate).toBe(false);
      expect(p?.countedAt).toBeUndefined();
    });
  });
});

describe("keyset paging back", () => {
  describe("normalizePagination — keyset paging back", () => {
    it("carries prev, hasPrev and end so a UI can page backwards", () => {
      const p = normalizePagination({
        method: "keyset",
        data: [],
        limit: 5,
        hasMore: true,
        next: "n-cursor",
        prev: "p-cursor",
        hasPrev: true,
        end: "e-cursor",
      });
      expect(p).toMatchObject({
        next: "n-cursor",
        prev: "p-cursor",
        hasPrev: true,
        end: "e-cursor",
      });
    });

    it("the first page has no prev, and an offset page gets no cursor fields", () => {
      const first = normalizePagination({
        method: "keyset",
        data: [],
        limit: 5,
        hasMore: true,
        next: "n",
        prev: null,
        hasPrev: false,
      });
      expect(first?.prev).toBeNull();
      expect(first?.hasPrev).toBe(false);
      const offset = normalizePagination({
        method: "offset",
        data: [],
        total: 3,
        pages: 1,
        page: 1,
        limit: 5,
      });
      expect(offset && "prev" in offset).toBe(false);
    });
  });
});

describe("tags and change invalidation", () => {
  /**
   * One tag vocabulary and one invalidation rule.
   *
   * - `resourceTags` IS arc's http-cache rule (`@classytic/arc/http-cache` policy/tags.ts); the
   *   expected values below are arc's own, so a drift on either side fails here.
   * - `arcTag` = "arc:" + that rule (Next server caches), `changeTags` = what one write invalidates.
   * - `invalidateForChange` refreshes exactly what a write can have changed.
   */

  describe("tag rule (shared with arc's http-cache resourceTags)", () => {
    it("matches arc: `<resource>` and `<resource>:<id>`; empty / nullish ids are the collection", () => {
      expect(resourceTags("lessons")).toEqual(["lessons"]);
      expect(resourceTags("lessons", "l1")).toEqual(["lessons", "lessons:l1"]);
      expect(resourceTags("lessons", 42)).toEqual(["lessons", "lessons:42"]);
      expect(resourceTags("lessons", "")).toEqual(["lessons"]);
      expect(resourceTags("lessons", null)).toEqual(["lessons"]);
    });

    it("arcTag is `arc:` + the resource tag; stripping the prefix gives arc's CDN tag", () => {
      expect(arcTag("lessons")).toBe("arc:lessons");
      expect(arcTag("lessons", "l1")).toBe("arc:lessons:l1");
      expect(arcTag("lessons", "l1").slice(4)).toBe(resourceTags("lessons", "l1")[1]);
      expect(arcTag("lessons", undefined, { by: "course", id: "c1" })).toBe(
        "arc:lessons@course:c1",
      );
    });

    it("changeTags: collection + record for a write that names a record", () => {
      expect(changeTags({ entity: "lessons", id: "l1" })).toEqual([
        "arc:lessons",
        "arc:lessons:l1",
      ]);
      expect(changeTags({ entity: "lessons" })).toEqual(["arc:lessons"]);
    });
  });

  describe("invalidateForChange (scoped, never the whole resource)", () => {
    const KEYS = createQueryKeys("lessons");
    const run = async (change: Parameters<typeof invalidateForChange>[2]) => {
      const qc = new QueryClient();
      const invalidate = vi.spyOn(qc, "invalidateQueries");
      const remove = vi.spyOn(qc, "removeQueries");
      await invalidateForChange(qc, KEYS, change);
      return {
        invalidated: invalidate.mock.calls.map(([f]) => (f as { queryKey: unknown }).queryKey),
        removed: remove.mock.calls.map(([f]) => (f as { queryKey: unknown }).queryKey),
      };
    };

    it("create: lists, counts, aggregations; no detail", async () => {
      const { invalidated, removed } = await run({ op: "create", id: "l1" });
      expect(invalidated).toEqual([KEYS.lists(), KEYS.counts(), KEYS.aggregations()]);
      expect(removed).toEqual([]);
    });

    it("update: plus that record's detail and slug variants, not every detail", async () => {
      const { invalidated } = await run({ op: "update", id: "l1" });
      expect(invalidated).toContainEqual(KEYS.detail("l1"));
      expect(invalidated).toContainEqual(KEYS.slugs());
      expect(invalidated).not.toContainEqual(KEYS.details());
      expect(invalidated).not.toContainEqual(KEYS.all);
    });

    it("delete: the record's detail is removed (a refetch would 404), lists refresh", async () => {
      const { invalidated, removed } = await run({ op: "delete", id: "l1" });
      expect(removed).toEqual([KEYS.detail("l1")]);
      expect(invalidated).toContainEqual(KEYS.lists());
      expect(invalidated).not.toContainEqual(KEYS.detail("l1"));
    });

    it("restore: also the soft-deleted list", async () => {
      const { invalidated } = await run({ op: "restore", id: "l1" });
      expect(invalidated).toContainEqual(["lessons", "deleted"]);
      expect(invalidated).toContainEqual(KEYS.detail("l1"));
    });

    it("an unrelated record's cached detail stays fresh after an update", async () => {
      const qc = new QueryClient();
      qc.setQueryData(KEYS.detail("other"), { _id: "other" });
      qc.setQueryData(KEYS.detail("l1", { organizationId: "o" }), { _id: "l1" });
      await invalidateForChange(qc, KEYS, { op: "update", id: "l1" });
      expect(qc.getQueryState(KEYS.detail("other"))?.isInvalidated).toBe(false);
      expect(qc.getQueryState(KEYS.detail("l1", { organizationId: "o" }))?.isInvalidated).toBe(
        true,
      );
    });
  });
});
