import { describe, expect, it } from "vitest";
import { normalizePagination } from "../src/cache";

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
    expect(p).toMatchObject({ next: "n-cursor", prev: "p-cursor", hasPrev: true, end: "e-cursor" });
  });

  it("the first page has no prev, and an offset page gets no cursor fields", () => {
    const first = normalizePagination({ method: "keyset", data: [], limit: 5, hasMore: true, next: "n", prev: null, hasPrev: false });
    expect(first?.prev).toBeNull();
    expect(first?.hasPrev).toBe(false);
    const offset = normalizePagination({ method: "offset", data: [], total: 3, pages: 1, page: 1, limit: 5 });
    expect(offset && "prev" in offset).toBe(false);
  });
});
