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

import { describe, expect, it } from "vitest";
import { prependToListCache, replaceItemInListCache, updateListCache } from "../src/cache.js";

type Item = { _id: string; name: string };

const page = (ids: string[], total?: number) => ({
  data: ids.map((id) => ({ _id: id, name: `n${id}` })),
  ...(total !== undefined ? { total } : {}),
});

const infinite = (...pages: unknown[]) => ({
  pages,
  pageParams: pages.map((_, i) => i + 1),
});

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
    const result = updateListCache<Item>(cache, (items) => items.filter((i) => i._id !== "3")) as {
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
