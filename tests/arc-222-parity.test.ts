/**
 * arc 2.22 client parity (designs/arc-2.22-parity.md):
 *  1. Dispatch verbs — api.count/exists/distinct hit the LIST route with
 *     `_count`/`_exists`/`_distinct` and parse both envelope variants.
 *  2. withHistory — GET /:id/history with paging params.
 *  3. Quota 429 surface — isQuotaExceeded guard, getQuotaDetails shape,
 *     query-client NEVER retries quota errors even when retries are on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../src/api.js";
import { ArcApiError, configureClient, getQuotaDetails, isQuotaExceeded } from "../src/client.js";
import { withHistory } from "../src/presets/history.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("arc 2.22 parity", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: "http://api.test" });
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe("dispatch verbs", () => {
    it("count() hits the list route with _count=true and returns the number", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ count: 42 }));
      const api = createCrudApi<{ _id: string }>("orders");

      const n = await api.count({ params: { status: "active" } });
      expect(n).toBe(42);

      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).toContain("/orders?");
      expect(url).toContain("_count=true");
      expect(url).toContain("status=active");
    });

    it("parses the enveloped variant defensively ({ data: { count } })", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { count: 7 } }));
      const api = createCrudApi("orders");
      expect(await api.count()).toBe(7);
    });

    it("exists() and distinct() use their verbs", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ exists: true }));
      const api = createCrudApi("orders");
      expect(await api.exists({ params: { sku: "X" } })).toBe(true);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("_exists=true");

      fetchMock.mockResolvedValue(jsonResponse({ values: ["a", "b"] }));
      expect(await api.distinct<string>({ field: "status" })).toEqual(["a", "b"]);
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain("_distinct=status");
    });

    it("distinct() requires a field", async () => {
      const api = createCrudApi("orders");
      await expect(api.distinct({ field: "" })).rejects.toThrow(/field is required/);
    });
  });

  describe("withHistory (arc 2.22 `history: true`)", () => {
    it("GETs /:id/history with paging params", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ data: [{ action: "update", changes: ["status"] }], limit: 25, offset: 0 }),
      );
      const orders = withHistory(createCrudApi("orders"));

      const page = await orders.history({ id: "ord-1", params: { limit: 25 } });
      expect(page.data[0]?.action).toBe("update");
      expect(page.limit).toBe(25);

      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).toContain("/orders/ord-1/history");
      expect(url).toContain("limit=25");
    });

    it("requires an id", async () => {
      const orders = withHistory(createCrudApi("orders"));
      await expect(orders.history({ id: "" })).rejects.toThrow(/ID is required/);
    });
  });

  describe("quota 429 surface", () => {
    const quotaError = new ArcApiError("Quota exceeded", {
      status: 429,
      statusText: "Too Many Requests",
      endpoint: "/orders",
      method: "POST",
      json: {
        code: "quota.exceeded",
        message: "Quota exceeded",
        status: 429,
        details: {
          kind: "export.runs",
          used: 50,
          limit: 50,
          period: "2026-07",
          resetsAt: "2026-08-01T00:00:00.000Z",
        },
      },
    });

    it("isQuotaExceeded discriminates precisely", () => {
      expect(isQuotaExceeded(quotaError)).toBe(true);
      expect(isQuotaExceeded(new Error("nope"))).toBe(false);
      const plain429 = new ArcApiError("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
        endpoint: "/x",
        method: "GET",
        json: { code: "rate_limit" },
      });
      expect(isQuotaExceeded(plain429)).toBe(false);
    });

    it("getQuotaDetails returns the renderable meter shape", () => {
      const q = getQuotaDetails(quotaError);
      expect(q).toMatchObject({ kind: "export.runs", used: 50, limit: 50, period: "2026-07" });
      expect(new Date(q?.resetsAt ?? 0).getUTCMonth()).toBe(7); // August
      expect(getQuotaDetails(new Error("x"))).toBeNull();
    });

    it("query client never retries quota errors even with retries enabled", async () => {
      const { getQueryClient } = await import("../src/query-client.js");
      const qc = getQueryClient({ retry: 3 });
      const retry = qc.getDefaultOptions().queries?.retry as (n: number, e: unknown) => boolean;
      expect(retry(0, quotaError)).toBe(false); // quota → never
      expect(retry(0, new Error("flaky"))).toBe(true); // ordinary errors respect retry: 3
      expect(retry(3, new Error("flaky"))).toBe(false); // ...up to the cap
    });
  });
});
