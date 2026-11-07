import { and, contains, eq, gte, in_, lt, TRUE } from "@classytic/repo-core/filter";
import { parseUrl } from "@classytic/repo-core/query-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BaseApi,
  createCrudApi,
  isAggregatePagination,
  isKeysetPagination,
  isOffsetPagination,
} from "../../src/client/api.js";
import {
  ArcApiError,
  configureAuth,
  configureClient,
  createClient,
  createQueryString,
  getQuotaDetails,
  isQuotaExceeded,
} from "../../src/client/client.js";
import { withHistory } from "../../src/client/presets/history.js";

describe("api", () => {
  describe("BaseApi", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    describe("constructor", () => {
      it("creates with default config", () => {
        const api = new BaseApi("products");
        expect(api.entity).toBe("products");
        expect(api.baseUrl).toBe("/api/v1/products");
      });

      it("accepts custom basePath", () => {
        const api = new BaseApi("products", { basePath: "/api" });
        expect(api.baseUrl).toBe("/api/products");
      });

      it("merges default params", () => {
        const api = new BaseApi("products", { defaultParams: { limit: 20 } });
        expect(api.config.defaultParams.limit).toBe(20);
        expect(api.config.defaultParams.page).toBe(1);
      });
    });

    describe("prepareParams", () => {
      const api = new BaseApi("test");

      it("always includes critical filters", () => {
        const result = api.prepareParams({ organizationId: undefined as unknown as string });
        expect(result.organizationId).toBeNull();
      });

      it("keeps organizationId value when provided", () => {
        const result = api.prepareParams({ organizationId: "org-1" });
        expect(result.organizationId).toBe("org-1");
      });

      it("parses page and limit as integers", () => {
        const result = api.prepareParams({
          page: "3" as unknown as number,
          limit: "25" as unknown as number,
        });
        expect(result.page).toBe(3);
        expect(result.limit).toBe(25);
      });

      it("defaults page to 1 and limit to 10 on invalid", () => {
        const result = api.prepareParams({
          page: "abc" as unknown as number,
          limit: "xyz" as unknown as number,
        });
        expect(result.page).toBe(1);
        expect(result.limit).toBe(10);
      });

      it("converts multi-element arrays to [in] syntax", () => {
        const result = api.prepareParams({ status: ["active", "pending"] });
        expect(result["status[in]"]).toBe("active,pending");
      });

      it("converts single-element arrays to plain value", () => {
        const result = api.prepareParams({ status: ["active"] });
        expect(result.status).toBe("active");
      });

      it("skips undefined and empty strings", () => {
        const result = api.prepareParams({ a: undefined, b: "" });
        expect(result).not.toHaveProperty("a");
        expect(result).not.toHaveProperty("b");
      });

      it("passes populateOptions through", () => {
        const opts = [{ path: "author", select: "name" }];
        const result = api.prepareParams({ populateOptions: opts });
        expect(result.populateOptions).toEqual(opts);
      });

      it("skips empty populateOptions", () => {
        const result = api.prepareParams({ populateOptions: [] });
        expect(result).not.toHaveProperty("populateOptions");
      });
    });

    describe("CRUD methods", () => {
      it("getAll sends GET with query params", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.getAll({ params: { page: 2, limit: 5 } });

        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/items?"),
          expect.objectContaining({ method: "GET" }),
        );
        const url = fetchMock.mock.calls[0]![0] as string;
        expect(url).toContain("page=2");
        expect(url).toContain("limit=5");
      });

      it("getById sends GET to /entity/:id", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.getById({ id: "123" });

        expect(fetchMock).toHaveBeenCalledWith(
          "http://api.test/api/items/123",
          expect.objectContaining({ method: "GET" }),
        );
      });

      it("getById throws if no id", async () => {
        const api = createCrudApi("items");
        await expect(api.getById({ id: "" })).rejects.toThrow("ID is required");
      });

      it("create sends POST with body", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.create({ data: { name: "New Item" } });

        expect(fetchMock).toHaveBeenCalledWith(
          "http://api.test/api/items",
          expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "New Item" }) }),
        );
      });

      it("update sends PATCH with body", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.update({ id: "123", data: { name: "Updated" } });

        expect(fetchMock).toHaveBeenCalledWith(
          "http://api.test/api/items/123",
          expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Updated" }) }),
        );
      });

      it("delete sends DELETE", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.delete({ id: "123" });

        expect(fetchMock).toHaveBeenCalledWith(
          "http://api.test/api/items/123",
          expect.objectContaining({ method: "DELETE" }),
        );
      });

      // Former `search()` and `findBy()` methods were removed in 0.5.0 — both
      // were sugar over `getAll({ params })`. The next three cases prove the
      // bracket-key syntax that replaces them works correctly via getAll.

      it("getAll passes bracket-key contains operator (replaces search())", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.getAll({ params: { "name[contains]": "test", page: 1 } });

        const url = fetchMock.mock.calls[0]![0] as string;
        expect(url).toContain("page=1");
        expect(url).toContain("name%5Bcontains%5D=test");
      });

      it("getAll passes bracket-key gte operator (replaces findBy with operator)", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.getAll({ params: { "price[gte]": 100 } });

        const url = fetchMock.mock.calls[0]![0] as string;
        expect(url).toContain("price%5Bgte%5D=100");
      });

      it("getAll passes direct field equality (replaces findBy without operator)", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.getAll({ params: { status: "active" } });

        const url = fetchMock.mock.calls[0]![0] as string;
        expect(url).toContain("status=active");
      });

      it("request sends to custom endpoint", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.request("POST", "/api/items/123/publish", { data: { now: true } });

        expect(fetchMock).toHaveBeenCalledWith(
          "http://api.test/api/items/123/publish",
          expect.objectContaining({ method: "POST", body: JSON.stringify({ now: true }) }),
        );
      });

      it("passes organizationId header", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.getAll({ organizationId: "org-abc" });

        const [, options] = fetchMock.mock.calls[0]!;
        const headers = (options as RequestInit).headers as Record<string, string>;
        expect(headers["x-organization-id"]).toBe("org-abc");
      });
    });

    // The transport's rule (undefined = configured, null = deliberately none, string = exactly)
    // must reach the wire from every BaseApi entry point: an IAM read (`/me`, `/roles`) sends the
    // token but NO org header on a host whose configured org is the active branch.
    describe("token / organizationId: undefined, null, string", () => {
      const headersOf = (i: number) =>
        (fetchMock.mock.calls[i]![1] as RequestInit).headers as Record<string, string>;

      beforeEach(() => {
        fetchMock.mockImplementation(
          async () =>
            new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
        );
        configureAuth({ getToken: () => "configured-token", getOrgId: () => "configured-org" });
      });
      afterEach(() => configureAuth({ getToken: () => null, getOrgId: () => null }));

      it("omitted: the configured token and org", async () => {
        const api = createCrudApi("iam", { basePath: "/api" });
        await api.invokeRoute({ path: "/me" });
        expect(headersOf(0).Authorization).toBe("Bearer configured-token");
        expect(headersOf(0)["x-organization-id"]).toBe("configured-org");
      });

      it("organizationId: null sends the token and NO org header (invokeRoute, request, getAll)", async () => {
        const api = createCrudApi("iam", { basePath: "/api" });
        await api.invokeRoute({ path: "/me", organizationId: null });
        await api.request("GET", "/api/iam/roles", { organizationId: null });
        await api.getAll({ organizationId: null });
        for (const i of [0, 1, 2]) {
          expect(headersOf(i).Authorization).toBe("Bearer configured-token");
          expect(headersOf(i)).not.toHaveProperty("x-organization-id");
        }
      });

      it("token: null sends no Authorization; a string wins over the configured one", async () => {
        const api = createCrudApi("iam", { basePath: "/api" });
        await api.invokeRoute({ path: "/public", token: null });
        await api.getById({ id: "1", token: "call-token", organizationId: "call-org" });
        expect(headersOf(0)).not.toHaveProperty("Authorization");
        expect(headersOf(0)["x-organization-id"]).toBe("configured-org");
        expect(headersOf(1).Authorization).toBe("Bearer call-token");
        expect(headersOf(1)["x-organization-id"]).toBe("call-org");
      });

      it("an organizationId FILTER is a query param, signed in or anonymous", async () => {
        const api = createCrudApi("courses", { basePath: "/api" });
        await api.getAll({ params: { organizationId: "f-1" }, options: { auth: "omit" } });
        await api.getAll({ params: { organizationId: "f-2" } });
        const url = (i: number) => fetchMock.mock.calls[i]![0] as string;
        expect(url(0)).toContain("organizationId=f-1");
        expect(headersOf(0)).not.toHaveProperty("x-organization-id");
        expect(headersOf(0)).not.toHaveProperty("Authorization");
        expect(url(1)).toContain("organizationId=f-2");
        expect(headersOf(1)["x-organization-id"]).toBe("configured-org");
      });

      it("presets forward the same three states (withHistory)", async () => {
        const api = withHistory(createCrudApi("orders", { basePath: "/api" }));
        await api.history({ id: "o1", organizationId: null });
        expect(headersOf(0).Authorization).toBe("Bearer configured-token");
        expect(headersOf(0)).not.toHaveProperty("x-organization-id");
      });

      it("a per-client api (createClient) keeps the rule: null skips its getOrgId", async () => {
        const client = createClient({
          baseUrl: "http://api.test",
          getToken: () => "client-token",
          getOrgId: () => "client-org",
        });
        const api = createCrudApi("iam", { basePath: "/api", client });
        await api.invokeRoute({ path: "/me", organizationId: null });
        await api.invokeRoute({ path: "/me" });
        expect(headersOf(0).Authorization).toBe("Bearer client-token");
        expect(headersOf(0)).not.toHaveProperty("x-organization-id");
        expect(headersOf(1)["x-organization-id"]).toBe("client-org");
      });
    });

    describe("config.headers", () => {
      it("sends instance headers on getAll", async () => {
        const api = createCrudApi("items", {
          basePath: "/api",
          headers: { "x-arc-scope": "platform", "x-custom": "test" },
        });
        await api.getAll();

        const [, options] = fetchMock.mock.calls[0]!;
        const headers = (options as RequestInit).headers as Record<string, string>;
        expect(headers["x-arc-scope"]).toBe("platform");
        expect(headers["x-custom"]).toBe("test");
      });

      it("sends instance headers on getById", async () => {
        const api = createCrudApi("items", {
          basePath: "/api",
          headers: { "x-arc-scope": "platform" },
        });
        await api.getById({ id: "1" });

        const [, options] = fetchMock.mock.calls[0]!;
        const headers = (options as RequestInit).headers as Record<string, string>;
        expect(headers["x-arc-scope"]).toBe("platform");
      });

      it("sends instance headers on create", async () => {
        const api = createCrudApi("items", {
          basePath: "/api",
          headers: { "x-arc-scope": "platform" },
        });
        await api.create({ data: { name: "test" } });

        const [, options] = fetchMock.mock.calls[0]!;
        const headers = (options as RequestInit).headers as Record<string, string>;
        expect(headers["x-arc-scope"]).toBe("platform");
      });

      it("sends instance headers on update", async () => {
        const api = createCrudApi("items", {
          basePath: "/api",
          headers: { "x-arc-scope": "platform" },
        });
        await api.update({ id: "1", data: { name: "updated" } });

        const [, options] = fetchMock.mock.calls[0]!;
        const headers = (options as RequestInit).headers as Record<string, string>;
        expect(headers["x-arc-scope"]).toBe("platform");
      });

      it("sends instance headers on delete", async () => {
        const api = createCrudApi("items", {
          basePath: "/api",
          headers: { "x-arc-scope": "platform" },
        });
        await api.delete({ id: "1" });

        const [, options] = fetchMock.mock.calls[0]!;
        const headers = (options as RequestInit).headers as Record<string, string>;
        expect(headers["x-arc-scope"]).toBe("platform");
      });

      it("sends instance headers on request()", async () => {
        const api = createCrudApi("items", {
          basePath: "/api",
          headers: { "x-arc-scope": "platform" },
        });
        await api.request("POST", "/api/items/1/publish", { data: {} });

        const [, options] = fetchMock.mock.calls[0]!;
        const headers = (options as RequestInit).headers as Record<string, string>;
        expect(headers["x-arc-scope"]).toBe("platform");
      });

      it("per-call headerOptions override instance headers", async () => {
        const api = createCrudApi("items", {
          basePath: "/api",
          headers: { "x-arc-scope": "platform", "x-keep": "yes" },
        });
        await api.getAll({ options: { headerOptions: { "x-arc-scope": "member" } } });

        const [, options] = fetchMock.mock.calls[0]!;
        const headers = (options as RequestInit).headers as Record<string, string>;
        expect(headers["x-arc-scope"]).toBe("member");
        expect(headers["x-keep"]).toBe("yes");
      });

      it("does not send headers when config.headers is empty", async () => {
        const api = createCrudApi("items", { basePath: "/api" });
        await api.getAll();

        const [, options] = fetchMock.mock.calls[0]!;
        const headers = (options as RequestInit).headers as Record<string, string>;
        expect(headers["x-arc-scope"]).toBeUndefined();
      });
    });
  });

  // ============================================================================
  // Upload Method
  // ============================================================================

  describe("BaseApi upload", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("sends FormData via POST without Content-Type header", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      const formData = new FormData();
      formData.append("file", "test-content");

      await api.upload({ data: formData });

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api.test/api/items",
        expect.objectContaining({ method: "POST" }),
      );
      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
      expect((options as RequestInit).body).toBe(formData);
    });

    it("upload supports custom path suffix", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      const formData = new FormData();
      formData.append("file", "test-content");

      await api.upload({ data: formData, path: "import" });

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api.test/api/items/import",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("upload sends organizationId header", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      const formData = new FormData();
      formData.append("file", "test-content");

      await api.upload({ data: formData, organizationId: "org-123" });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-organization-id"]).toBe("org-123");
    });

    it("upload with id posts to baseUrl/{id}/upload", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      const formData = new FormData();
      formData.append("file", "test-content");

      await api.upload({ data: formData, id: "doc-123" });

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api.test/api/items/doc-123/upload",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("upload path takes precedence over id", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      const formData = new FormData();
      formData.append("file", "test-content");

      await api.upload({ data: formData, id: "doc-123", path: "bulk-import" });

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api.test/api/items/bulk-import",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("upload without id or path posts to base collection URL", async () => {
      const api = createCrudApi("items", { basePath: "/api" });
      const formData = new FormData();
      formData.append("file", "test-content");

      await api.upload({ data: formData });

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api.test/api/items",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  // ============================================================================
  // Type Guards
  // ============================================================================

  describe("type guards", () => {
    it("isOffsetPagination", () => {
      expect(
        isOffsetPagination({
          method: "offset",
          data: [],
          page: 1,
          limit: 10,
          total: 0,
          pages: 0,
          hasNext: false,
          hasPrev: false,
        }),
      ).toBe(true);
      expect(
        isOffsetPagination({ method: "keyset", data: [], limit: 10, hasMore: false, next: null }),
      ).toBe(false);
    });

    it("isKeysetPagination", () => {
      expect(
        isKeysetPagination({ method: "keyset", data: [], limit: 10, hasMore: false, next: null }),
      ).toBe(true);
      expect(
        isKeysetPagination({
          method: "offset",
          data: [],
          page: 1,
          limit: 10,
          total: 0,
          pages: 0,
          hasNext: false,
          hasPrev: false,
        }),
      ).toBe(false);
    });

    it("isAggregatePagination", () => {
      expect(
        isAggregatePagination({
          method: "aggregate",
          data: [],
          page: 1,
          limit: 10,
          total: 0,
          pages: 0,
          hasNext: false,
          hasPrev: false,
        }),
      ).toBe(true);
      expect(
        isAggregatePagination({
          method: "offset",
          data: [],
          page: 1,
          limit: 10,
          total: 0,
          pages: 0,
          hasNext: false,
          hasPrev: false,
        }),
      ).toBe(false);
    });
  });

  // ============================================================================
  // createCrudApi factory
  // ============================================================================

  describe("createCrudApi", () => {
    it("returns a BaseApi instance", () => {
      const api = createCrudApi("products");
      expect(api).toBeInstanceOf(BaseApi);
      expect(api.entity).toBe("products");
    });

    it("passes config through", () => {
      const api = createCrudApi("products", { basePath: "/v2" });
      expect(api.baseUrl).toBe("/v2/products");
    });
  });

  // ============================================================================
  // BaseApi with ArcClient (Multi-Client)
  // ============================================================================

  describe("BaseApi with client", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://global.test" });
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: [], total: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("uses client baseUrl instead of global", async () => {
      const client = createClient({ baseUrl: "http://analytics.test" });
      const api = createCrudApi("events", { basePath: "/api", client });

      await api.getAll();

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("http://analytics.test/api/events");
    });

    it("global and client APIs coexist", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true, data: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const client = createClient({ baseUrl: "http://other.test" });

      const globalApi = createCrudApi("items", { basePath: "/api" });
      const clientApi = createCrudApi("items", { basePath: "/api", client });

      await globalApi.getById({ id: "1" });
      await clientApi.getById({ id: "2" });

      expect(fetchMock.mock.calls[0]![0]).toBe("http://global.test/api/items/1");
      expect(fetchMock.mock.calls[1]![0]).toBe("http://other.test/api/items/2");
    });

    it("client API sends POST with body", async () => {
      const client = createClient({ baseUrl: "http://other.test" });
      const api = createCrudApi("items", { basePath: "/api", client });

      await api.create({ data: { name: "New" } });

      expect(fetchMock).toHaveBeenCalledWith(
        "http://other.test/api/items",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "New" }) }),
      );
    });

    it("client PROVIDER thunk is re-resolved on every request (late binding)", async () => {
      // A consumer SDK passes `() => currentClient` so reconfiguration after
      // API construction takes effect without Proxy tricks.
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true, data: [], total: 0 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      let current = createClient({ baseUrl: "http://first.test" });
      const api = createCrudApi("items", { basePath: "/api", client: () => current });

      await api.getAll();
      expect(fetchMock.mock.calls[0]![0] as string).toContain("http://first.test/api/items");

      // Swap the underlying client AFTER the API instance exists.
      current = createClient({ baseUrl: "http://second.test" });
      await api.getAll();
      expect(fetchMock.mock.calls[1]![0] as string).toContain("http://second.test/api/items");
    });

    it("client API sends internalApiKey", async () => {
      const client = createClient({ baseUrl: "http://other.test", internalApiKey: "key-123" });
      const api = createCrudApi("items", { basePath: "/api", client });

      await api.getAll();

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-internal-api-key"]).toBe("key-123");
    });

    // ========== v0.3.1: defaultParams merge into request methods ==========

    describe("defaultParams merge", () => {
      it("getAll includes defaultParams in query string", async () => {
        const api = createCrudApi("items", { basePath: "/api", defaultParams: { limit: 25 } });

        await api.getAll({ params: { status: "active" } });

        const url = fetchMock.mock.calls[0]![0] as string;
        expect(url).toContain("limit=25");
        expect(url).toContain("status=active");
      });

      it("explicit params override defaultParams", async () => {
        const api = createCrudApi("items", { basePath: "/api", defaultParams: { limit: 25 } });

        await api.getAll({ params: { limit: 50 } });

        const url = fetchMock.mock.calls[0]![0] as string;
        expect(url).toContain("limit=50");
        expect(url).not.toContain("limit=25");
      });

      it("getAll free-text search includes defaultParams in query string", async () => {
        const api = createCrudApi("items", { basePath: "/api", defaultParams: { limit: 15 } });

        await api.getAll({ params: { q: "test" } });

        const url = fetchMock.mock.calls[0]![0] as string;
        expect(url).toContain("limit=15");
        expect(url).toContain("q=test");
      });

      it("getAll single-field equality includes defaultParams in query string", async () => {
        const api = createCrudApi("items", { basePath: "/api", defaultParams: { limit: 30 } });

        await api.getAll({ params: { status: "active" } });

        const url = fetchMock.mock.calls[0]![0] as string;
        expect(url).toContain("limit=30");
        expect(url).toContain("status=active");
      });
    });

    // ==========================================================================
    // Soft Delete Preset
    // ==========================================================================

    // Soft-delete, bulk, slug, tree presets all moved to tests/presets/*.test.ts
    // alongside their respective `withXxx()` factories. Only the always-on
    // BaseApi surface is tested here.

    // ==========================================================================
    // Lookup params
    // ==========================================================================

    describe("prepareParams — lookup", () => {
      const api = new BaseApi("test");

      it("serializes simple string lookup", () => {
        const result = api.prepareParams({ lookup: { dept: "departments" } });
        expect(result["lookup[dept]"]).toBe("departments");
      });

      it("serializes full lookup config", () => {
        const result = api.prepareParams({
          lookup: {
            dept: {
              from: "departments",
              localField: "deptId",
              foreignField: "_id",
              select: "name",
            },
          },
        });
        expect(result["lookup[dept][from]"]).toBe("departments");
        expect(result["lookup[dept][localField]"]).toBe("deptId");
        expect(result["lookup[dept][foreignField]"]).toBe("_id");
        expect(result["lookup[dept][select]"]).toBe("name");
      });
    });

    // ==========================================================================
    // invokeRoute — generic helper for resource-relative custom routes
    // ==========================================================================

    describe("invokeRoute", () => {
      let invokeFetch: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        configureClient({ baseUrl: "http://api.test" });
        invokeFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(JSON.stringify({ success: true, data: { ok: true } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      afterEach(() => invokeFetch.mockRestore());

      it("GET /:resource/<path> defaults to GET method", async () => {
        const api = createCrudApi("todos", { basePath: "/api/v1" });
        await api.invokeRoute({ path: "/stats" });

        expect(invokeFetch).toHaveBeenCalledWith(
          "http://api.test/api/v1/todos/stats",
          expect.objectContaining({ method: "GET" }),
        );
      });

      it("prepends slash automatically when omitted", async () => {
        const api = createCrudApi("todos", { basePath: "/api/v1" });
        await api.invokeRoute({ path: "recent" });

        const url = invokeFetch.mock.calls[0]![0] as string;
        expect(url).toBe("http://api.test/api/v1/todos/recent");
      });

      it("passes params through prepareParams", async () => {
        const api = createCrudApi("todos", { basePath: "/api/v1" });
        await api.invokeRoute({ path: "/recent", params: { limit: 5, status: "active" } });

        const url = invokeFetch.mock.calls[0]![0] as string;
        expect(url).toContain("limit=5");
        expect(url).toContain("status=active");
      });

      it("POST with body", async () => {
        const api = createCrudApi("products", { basePath: "/api/v1" });
        await api.invokeRoute({
          method: "POST",
          path: "/import",
          data: { source: "csv", count: 42 },
        });

        const [url, init] = invokeFetch.mock.calls[0]!;
        expect(url).toBe("http://api.test/api/v1/products/import");
        expect((init as RequestInit).method).toBe("POST");
        expect((init as RequestInit).body).toBe(JSON.stringify({ source: "csv", count: 42 }));
      });

      it("forwards token + organizationId", async () => {
        const api = createCrudApi("todos", { basePath: "/api/v1" });
        await api.invokeRoute({ path: "/stats", token: "tok-1", organizationId: "org-9" });

        const headers = (invokeFetch.mock.calls[0]![1] as RequestInit).headers as Record<
          string,
          string
        >;
        expect(headers["Authorization"]).toBe("Bearer tok-1");
        expect(headers["x-organization-id"]).toBe("org-9");
      });

      it("throws when path is empty", async () => {
        const api = createCrudApi("todos", { basePath: "/api/v1" });
        await expect(api.invokeRoute({ path: "" })).rejects.toThrow("path is required");
      });

      it("respects custom idField resource (uses entity name unchanged)", async () => {
        const api = createCrudApi("products", { basePath: "/api/v1" });
        await api.invokeRoute({ path: "/by-sku/SKU-1" });
        expect(invokeFetch.mock.calls[0]![0]).toBe("http://api.test/api/v1/products/by-sku/SKU-1");
      });
    });

    // ==========================================================================
    // action — POST /:id/action with { action, ...data }
    // ==========================================================================

    describe("action", () => {
      let actionFetch: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        configureClient({ baseUrl: "http://api.test" });
        actionFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(JSON.stringify({ success: true, data: { _id: "1", status: "completed" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      afterEach(() => actionFetch.mockRestore());

      it("POSTs to /:id/action with body { action }", async () => {
        const api = createCrudApi("todos", { basePath: "/api/v1" });
        await api.dispatchAction({ id: "123", action: "complete" });

        const [url, init] = actionFetch.mock.calls[0]!;
        expect(url).toBe("http://api.test/api/v1/todos/123/action");
        expect((init as RequestInit).method).toBe("POST");
        expect((init as RequestInit).body).toBe(JSON.stringify({ action: "complete" }));
      });

      it("flattens data into the body alongside action name", async () => {
        const api = createCrudApi("todos", { basePath: "/api/v1" });
        await api.dispatchAction({ id: "1", action: "prioritize", data: { priority: 7 } });

        const body = (actionFetch.mock.calls[0]![1] as RequestInit).body as string;
        expect(JSON.parse(body)).toEqual({ action: "prioritize", priority: 7 });
      });

      it("throws on missing id", async () => {
        const api = createCrudApi("todos", { basePath: "/api/v1" });
        await expect(api.dispatchAction({ id: "", action: "complete" })).rejects.toThrow(
          "ID is required",
        );
      });

      it("throws on missing action name", async () => {
        const api = createCrudApi("todos", { basePath: "/api/v1" });
        await expect(api.dispatchAction({ id: "1", action: "" })).rejects.toThrow(
          "Action name is required",
        );
      });
    });

    // ==========================================================================
    // aggregate — GET /aggregations/:name (arc 2.13+)
    // ==========================================================================

    describe("aggregate", () => {
      let aggFetch: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        configureClient({ baseUrl: "http://api.test" });
        aggFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(JSON.stringify({ rows: [{ day: "2025-01-01", total: 100 }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      afterEach(() => aggFetch.mockRestore());

      it("GETs /aggregations/:name with no filter", async () => {
        const api = createCrudApi("orders", { basePath: "/api" });
        const result = await api.aggregate({ name: "salesByDay" });

        const [url, init] = aggFetch.mock.calls[0]!;
        expect(url).toBe("http://api.test/api/orders/aggregations/salesByDay");
        expect((init as RequestInit).method).toBe("GET");
        expect(result).toEqual({ rows: [{ day: "2025-01-01", total: 100 }] });
      });

      it("encodes filter as query string", async () => {
        const api = createCrudApi("orders", { basePath: "/api" });
        await api.aggregate({
          name: "salesByDay",
          filter: { from: "2025-01-01", to: "2025-12-31", region: "NA" },
        });

        const url = aggFetch.mock.calls[0]![0] as string;
        expect(url).toContain("/api/orders/aggregations/salesByDay?");
        expect(url).toContain("from=2025-01-01");
        expect(url).toContain("to=2025-12-31");
        expect(url).toContain("region=NA");
      });

      it("preserves the canonical AggResult shape (no envelope unwrap)", async () => {
        const api = createCrudApi("orders");
        const result = await api.aggregate<{ day: string; total: number }>({ name: "salesByDay" });
        // Wire shape is `{ rows: TRow[] }` — caller reads `.rows` directly.
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]!.day).toBe("2025-01-01");
        expect(result.rows[0]!.total).toBe(100);
      });

      it("throws on missing name", async () => {
        const api = createCrudApi("orders");
        await expect(api.aggregate({ name: "" })).rejects.toThrow("Aggregation name is required");
      });

      it("forwards organizationId as x-organization-id header", async () => {
        const api = createCrudApi("orders");
        await api.aggregate({ name: "salesByDay", organizationId: "org_42" });

        const headers = (aggFetch.mock.calls[0]![1] as RequestInit).headers as Record<
          string,
          string
        >;
        expect(headers["x-organization-id"]).toBe("org_42");
      });
    });

    // ==========================================================================
    // findBy with geo operators (mongokit URL grammar)
    // ==========================================================================

    describe("getAll — geo & range operators (mongokit URL grammar)", () => {
      let geoFetch: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        configureClient({ baseUrl: "http://api.test" });
        geoFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
          new Response(JSON.stringify({ success: true, data: [], total: 0 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      afterEach(() => geoFetch.mockRestore());

      it("withinRadius preserves [lng, lat, radius] as comma-joined value", async () => {
        const api = createCrudApi("places", { basePath: "/api/v1" });
        await api.getAll({ params: { "location[withinRadius]": [-73.98, 40.75, 5000] } });

        const url = geoFetch.mock.calls[0]![0] as string;
        // Should NOT be `location[in]=...` — should be `location[withinRadius]=lng,lat,r`
        expect(url).toContain("location%5BwithinRadius%5D=-73.98%2C40.75%2C5000");
        expect(url).not.toContain("location%5Bin%5D");
      });

      it("near with maxDistance preserves [lng, lat, max]", async () => {
        const api = createCrudApi("places", { basePath: "/api/v1" });
        await api.getAll({ params: { "location[near]": [-73.98, 40.75, 4000] } });

        const url = geoFetch.mock.calls[0]![0] as string;
        expect(url).toContain("location%5Bnear%5D=-73.98%2C40.75%2C4000");
      });

      it("geoWithin bounding box [minLng, minLat, maxLng, maxLat]", async () => {
        const api = createCrudApi("places", { basePath: "/api/v1" });
        await api.getAll({ params: { "location[geoWithin]": [-74.02, 40.7, -73.93, 40.79] } });

        const url = geoFetch.mock.calls[0]![0] as string;
        expect(url).toContain("location%5BgeoWithin%5D=-74.02%2C40.7%2C-73.93%2C40.79");
      });

      it("non-geo operator still uses [in] for arrays", async () => {
        const api = createCrudApi("items", { basePath: "/api/v1" });
        await api.getAll({
          params: { "status[in]": ["active", "pending"] },
        });

        const url = geoFetch.mock.calls[0]![0] as string;
        // [in] operator → `field[in]=a,b`
        expect(url).toContain("status%5Bin%5D=active%2Cpending");
      });
    });

    // search preset moved to tests/presets/search.test.ts
  });
});

describe("Next fetch cache options", () => {
  /**
   * Next.js App Router fetch options — the host-facing data-fetching contract.
   *
   * A Next host passes `next: { revalidate, tags }` (1:1 with what it would hand to `fetch`). `revalidate: false` caches indefinitely. `cache` passes
   * straight through. All land on the underlying `fetch(url, init)` call.
   */

  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: "http://api.test" });
    fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  afterEach(() => fetchMock.mockRestore());

  function lastInit(): RequestInit & { next?: { revalidate?: number | false; tags?: string[] } } {
    return fetchMock.mock.calls.at(-1)![1] as never;
  }

  describe("Next.js fetch options", () => {
    const api = () => createCrudApi("things", { basePath: "/api" });

    it("forwards the idiomatic next:{revalidate,tags} object to fetch", async () => {
      await api().getAll({ options: { next: { revalidate: 60, tags: ["things"] } } });
      expect(lastInit().next).toEqual({ revalidate: 60, tags: ["things"] });
    });

    it("supports revalidate:false (cache indefinitely)", async () => {
      await api().getAll({ options: { next: { revalidate: false } } });
      expect(lastInit().next).toEqual({ revalidate: false });
    });

    it("passes cache through to fetch", async () => {
      await api().getAll({ options: { cache: "force-cache" } });
      expect(lastInit().cache).toBe("force-cache");
    });

    it("omits next entirely when no cache directives are given", async () => {
      await api().getAll({ options: { cache: undefined } });
      expect(lastInit().next).toBeUndefined();
    });
  });

  /**
   * Regression: a configured `cache` default (instance or ClientConfig) must be
   * ISR-aware, and there is no SDK-chosen default at all.
   *
   * A caller asking for `revalidate` is opting into ISR, and forcing `no-store`
   * alongside it makes Next.js throw ("cache: 'no-store' and revalidate are
   * contradictory") and otherwise pins the route dynamic — so a single read can
   * never be cached. `withCacheDefault` gates the default on caller intent. This
   * is what lets a storefront product page's per-call `revalidate` produce an
   * actually-cacheable fetch instead of a silently-dynamic one.
   */
  describe("cache default is opt-in and revalidate-aware (withCacheDefault)", () => {
    const api = () => createCrudApi("things", { basePath: "/api" });

    it("a bare read sends no cache mode at all (no SDK default; RN whatwg-fetch appends _= for no-store)", async () => {
      await api().getAll({});
      expect(lastInit().cache).toBeUndefined();
      expect(lastInit().next).toBeUndefined();
    });

    it("an instance cache is applied to bare reads", async () => {
      await createCrudApi("things", { basePath: "/api", cache: "no-store" }).getAll({});
      expect(lastInit().cache).toBe("no-store");
    });

    it("the deployment's ClientConfig.cache is applied to bare reads, and per-call revalidate still wins", async () => {
      configureClient({ baseUrl: "http://api.test", cache: "no-store" });
      fetchMock.mockImplementation(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      await api().getAll({});
      expect(lastInit().cache).toBe("no-store");
      await api().getAll({ options: { next: { revalidate: 60 } } });
      expect(lastInit().cache).toBeUndefined();
    });

    it("per-call revalidate is NOT clobbered by the no-store default → ISR", async () => {
      await api().getAll({ options: { next: { revalidate: 60 } } });
      expect(lastInit().cache).toBeUndefined(); // the fix — never no-store here
      expect(lastInit().next).toEqual({ revalidate: 60 });
    });

    it("explicit cache wins over the no-store default", async () => {
      await api().getAll({ options: { cache: "force-cache" } });
      expect(lastInit().cache).toBe("force-cache");
    });

    it("request() (the path getBySlug/custom routes use) is ISR-aware too", async () => {
      // getBySlug rides BaseApi.request via the slugLookup preset; this is the
      // exact call shape the product detail page issues.
      await api().request("GET", "/api/things/slug/widget", {
        options: { next: { revalidate: 300 } },
      });
      expect(lastInit().cache).toBeUndefined();
      expect(lastInit().next).toEqual({ revalidate: 300 });
    });

    it("request() with no options sends no cache mode by default", async () => {
      await api().request("GET", "/api/things/slug/widget");
      expect(lastInit().cache).toBeUndefined();
      expect(lastInit().next).toBeUndefined();
    });
  });
});

describe("bracket grammar round trip", () => {
  /**
   * Encoder ↔ parser roundtrip — arc-next URL emission must reverse cleanly
   * through `@classytic/repo-core/query-parser`'s `parseUrl()`.
   *
   * Locks the cross-package grammar contract: every shape arc-next encodes
   * (CRUD `getAll` filters, aggregation filters, custom-route params) MUST
   * produce a URL that arc's server-side parser converts back into a Filter
   * IR matching the host's intent. Drift here = silent data corruption.
   *
   * Note on values: `parseUrl()` keeps everything as strings — type coercion
   * (number / boolean / Date) happens at the **kit layer** using schema
   * introspection (mongokit reads the Mongoose schema, sqlitekit the Drizzle
   * one). These tests assert on string values; numeric coercion is a
   * separate concern tested in each kit's QueryParser suite.
   */

  /**
   * Run a value through arc-next's encoder, parse the result with repo-core's
   * URL parser, and return the parsed filter IR for comparison.
   */
  function roundtrip(input: Record<string, unknown>) {
    const encoded = createQueryString(input);
    const params = new URLSearchParams(encoded);
    return parseUrl(params);
  }

  describe("encoder ↔ parseUrl — bracket grammar alignment", () => {
    it('plain equality: { status: "active" } → eq', () => {
      const parsed = roundtrip({ status: "active" });
      expect(parsed.filter).toEqual(eq("status", "active"));
    });

    it("nested operator: { age: { gte: 18 } } → gte", () => {
      const parsed = roundtrip({ age: { gte: 18 } });
      expect(parsed.filter).toEqual(gte("age", 18));
    });

    it("multi-op nested: { age: { gte: 18, lt: 65 } } → and(gte, lt)", () => {
      const parsed = roundtrip({ age: { gte: 18, lt: 65 } });
      // Parser ANDs multiple operators on the same field.
      expect(parsed.filter).toEqual(and(gte("age", 18), lt("age", 65)));
    });

    it('array shorthand: { tags: ["a","b"] } → in_', () => {
      const parsed = roundtrip({ tags: ["a", "b"] });
      expect(parsed.filter).toEqual(in_("tags", ["a", "b"]));
    });

    it('explicit in op: { role: { in: ["admin","editor"] } } → in_', () => {
      const parsed = roundtrip({ role: { in: ["admin", "editor"] } });
      expect(parsed.filter).toEqual(in_("role", ["admin", "editor"]));
    });

    it('contains: { name: { contains: "john" } } → contains', () => {
      const parsed = roundtrip({ name: { contains: "john" } });
      expect(parsed.filter).toEqual(contains("name", "john"));
    });

    it("mixed: status + nested age range → AND of all three", () => {
      const parsed = roundtrip({ status: "active", age: { gte: 18, lt: 65 } });
      // Parser composes the field-level filters into an AND.
      expect(parsed.filter).toEqual(and(eq("status", "active"), gte("age", 18), lt("age", 65)));
    });

    it('pre-bracketed key: { "age[gte]": 18 } → gte (back-compat path)', () => {
      // Existing callers who built the bracket key themselves still work.
      const parsed = roundtrip({ "age[gte]": 18 });
      expect(parsed.filter).toEqual(gte("age", 18));
    });

    it("empty params → TRUE filter (no narrowing)", () => {
      const parsed = roundtrip({});
      expect(parsed.filter).toEqual(TRUE);
    });

    it("reserved control params (page, limit, sort) bypass the filter IR", () => {
      const parsed = roundtrip({ page: 2, limit: 50, sort: "-createdAt", status: "x" });
      expect(parsed.page).toBe(2);
      expect(parsed.limit).toBe(50);
      expect(parsed.sort).toEqual({ createdAt: -1 });
      // Only `status` should land in the filter — control params are stripped.
      expect(parsed.filter).toEqual(eq("status", "x"));
    });

    it('null encodes as the string "null" (matches mongokit/sqlitekit grammar)', () => {
      const encoded = createQueryString({ deletedAt: null });
      expect(encoded).toContain("deletedAt=null");
    });

    it("a Date encodes as ISO-8601 — top level, as an operand, and inside an in-list", () => {
      const d = new Date("2026-09-01T00:00:00.000Z");
      // repo-core reads ISO back as a Date for range operands only; equality keeps the string
      // (a date-looking value is far more likely an id than a date predicate).
      expect(roundtrip({ createdAt: d }).filter).toEqual(eq("createdAt", d.toISOString()));
      expect(roundtrip({ createdAt: { gte: d } }).filter).toEqual(gte("createdAt", d));
      expect(createQueryString({ at: [d, d] })).toBe(
        `at%5Bin%5D=${encodeURIComponent(`${d.toISOString()},${d.toISOString()}`)}`,
      );
    });

    it("populate match encodes in bracket form, which the parser reads back", () => {
      const encoded = createQueryString({
        populateOptions: [{ path: "customer", match: { status: "active" } }],
      });
      expect(decodeURIComponent(encoded)).toBe("populate[customer][match][status]=active");
      expect(parseUrl(new URLSearchParams(encoded)).populate).toEqual([
        { path: "customer", match: { status: "active" } },
      ]);
    });
  });
});

describe("dispatch verbs, history and quota", () => {
  /**
   * arc 2.22 client parity (designs/arc-2.22-parity.md):
   *  1. Dispatch verbs — api.count/exists/distinct hit the LIST route with
   *     `_count`/`_exists`/`_distinct` and parse both envelope variants.
   *  2. withHistory — GET /:id/history with paging params.
   *  3. Quota 429 surface — isQuotaExceeded guard, getQuotaDetails shape,
   *     query-client NEVER retries quota errors even when retries are on.
   */
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
        const { getQueryClient } = await import("../../src/query/query-client.js");
        const qc = getQueryClient({ retry: 3 });
        const retry = qc.getDefaultOptions().queries?.retry as (n: number, e: unknown) => boolean;
        expect(retry(0, quotaError)).toBe(false); // quota → never
        expect(retry(0, new Error("flaky"))).toBe(true); // ordinary errors respect retry: 3
        expect(retry(3, new Error("flaky"))).toBe(false); // ...up to the cap
      });
    });
  });
});

describe("operators and the action router", () => {
  /**
   * v0.5.0 — Action router, search preset, geo operators, fieldErrors shape, elevated header.
   *
   * Tests target the new surface area only. Existing behavior coverage stays
   * in the per-module test files (api.test.ts, client.test.ts, hooks.test.tsx).
   */

  describe("v0.5.0 — geo / between operators", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("preserves coordinate arrays as comma-joined for [near] (no [in] rewriting)", () => {
      const api = new BaseApi("places");
      const result = api.prepareParams({ "location[near]": [-73.98, 40.75, 1000] });
      expect(result["location[near]"]).toBe("-73.98,40.75,1000");
      expect(result["location[near][in]"]).toBeUndefined();
    });

    it("preserves coordinate arrays for [withinRadius]", () => {
      const api = new BaseApi("places");
      const result = api.prepareParams({ "location[withinRadius]": [-73.98, 40.75, 5000] });
      expect(result["location[withinRadius]"]).toBe("-73.98,40.75,5000");
    });

    it("preserves bounding box for [geoWithin]", () => {
      const api = new BaseApi("places");
      const result = api.prepareParams({ "location[geoWithin]": [-74, 40, -73, 41] });
      expect(result["location[geoWithin]"]).toBe("-74,40,-73,41");
    });

    it("preserves comma list for [between]", () => {
      const api = new BaseApi("orders");
      const result = api.prepareParams({ "createdAt[between]": ["2025-01-01", "2025-12-31"] });
      expect(result["createdAt[between]"]).toBe("2025-01-01,2025-12-31");
    });

    it("non-geo array params still rewrite to [in]", () => {
      const api = new BaseApi("todos");
      const result = api.prepareParams({ status: ["active", "pending"] });
      expect(result["status[in]"]).toBe("active,pending");
      expect(result.status).toBeUndefined();
    });

    it("getAll with near operator passes array through to query string", async () => {
      const api = createCrudApi("places");
      await api.getAll({ params: { "location[near]": [-73.98, 40.75, 500] } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("location%5Bnear%5D=-73.98%2C40.75%2C500");
    });

    it("getAll with withinRadius accepts array", async () => {
      const api = createCrudApi("places");
      await api.getAll({ params: { "location[withinRadius]": [-73.98, 40.75, 1000] } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("location%5BwithinRadius%5D=-73.98%2C40.75%2C1000");
    });

    it("getAll with between accepts string list", async () => {
      const api = createCrudApi("orders");
      await api.getAll({ params: { "createdAt[between]": "2025-01-01,2025-12-31" } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("createdAt%5Bbetween%5D=2025-01-01%2C2025-12-31");
    });
  });

  describe("v0.5.0 — action router", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { _id: "t1", status: "completed" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("POSTs to /:id/action with body containing { action, ...payload }", async () => {
      const api = createCrudApi("todos");
      const result = await api.dispatchAction({ id: "t1", action: "complete" });

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("http://api.test/api/v1/todos/t1/action");
      expect((init as RequestInit).method).toBe("POST");
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toEqual({ action: "complete" });
      expect(result).toMatchObject({ success: true });
    });

    it("merges data payload into action body", async () => {
      const api = createCrudApi("orders");
      await api.dispatchAction({
        id: "o1",
        action: "dispatch",
        data: { courier: "fedex", tracking: "ABC123" },
      });

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ action: "dispatch", courier: "fedex", tracking: "ABC123" });
    });

    it("throws on missing id", async () => {
      const api = createCrudApi("todos");
      await expect(api.dispatchAction({ id: "", action: "complete" })).rejects.toThrow(
        "ID is required",
      );
    });

    it("throws on missing action name", async () => {
      const api = createCrudApi("todos");
      await expect(api.dispatchAction({ id: "t1", action: "" })).rejects.toThrow(
        "Action name is required",
      );
    });
  });
});
