import { describe, expect, it } from "vitest";
import { normalizePagination } from "../src/cache";

describe("normalizePagination — mongokit estimated totals", () => {
  it("carries totalIsEstimate and countedAt through", () => {
    const p = normalizePagination({
      method: "offset",
      docs: [],
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
    const p = normalizePagination({ docs: [], total: 42, pages: 3, page: 1, limit: 20 });
    expect(p?.totalIsEstimate).toBe(false);
    expect(p?.countedAt).toBeUndefined();
  });
});
