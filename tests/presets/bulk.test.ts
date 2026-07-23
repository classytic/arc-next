import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../../src/api.js";
import { configureClient } from "../../src/client.js";
import { withBulk } from "../../src/presets/bulk.js";

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configureClient({ baseUrl: "http://api.test" });
  fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(() => fetchMock.mockRestore());

describe("withBulk", () => {
  it("bulkCreate POSTs to /bulk with `{ items: [...] }` body (arc bulk preset wire shape)", async () => {
    const api = withBulk(createCrudApi("items", { basePath: "/api" }));
    await api.bulkCreate({ data: [{ name: "A" }, { name: "B" }] });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/items/bulk"),
      expect.objectContaining({ method: "POST" }),
    );
    // Arc's bulk handler reads `req.body.items` — sending a raw array yields
    // `400 Bulk create requires a non-empty items array`. Verify wrapper.
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ items: [{ name: "A" }, { name: "B" }] });
  });

  it("bulkUpdate PATCHes /bulk with { filter, data }", async () => {
    const api = withBulk(createCrudApi("items", { basePath: "/api" }));
    await api.bulkUpdate({
      filter: { status: "draft" },
      data: { status: "published" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/items/bulk"),
      expect.objectContaining({ method: "PATCH" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.filter).toEqual({ status: "draft" });
    expect(body.data).toEqual({ status: "published" });
  });

  it("bulkDelete DELETEs /bulk with { filter }", async () => {
    const api = withBulk(createCrudApi("items", { basePath: "/api" }));
    await api.bulkDelete({ filter: { status: "archived" } });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/items/bulk"),
      expect.objectContaining({ method: "DELETE" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.filter).toEqual({ status: "archived" });
  });

  it("forwards auth headers", async () => {
    const api = withBulk(createCrudApi("items", { basePath: "/api" }));
    await api.bulkCreate({ data: [{ a: 1 }], token: "tok", organizationId: "org-1" });

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["x-organization-id"]).toBe("org-1");
  });

  it("vanilla createCrudApi has no bulk methods", () => {
    const vanilla = createCrudApi("items", { basePath: "/api" });
    // @ts-expect-error — bulk only after withBulk()
    void vanilla.bulkCreate;
    // @ts-expect-error
    void vanilla.bulkUpdate;
    // @ts-expect-error
    void vanilla.bulkDelete;
  });
});
