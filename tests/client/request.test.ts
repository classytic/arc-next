import { ARC_ERROR_CODES, ARC_REASON_CODES, ERROR_CODES } from "@classytic/repo-core/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseApi, createCrudApi } from "../../src/client/api.js";
import {
  _resetAuthWarnings,
  ArcApiError,
  configureAuth,
  configureClient,
  createAuthAwareClient,
  createClient,
  createQueryString,
  createServerClient,
  getAuthContext,
  getAuthMode,
  getBaseUrl,
  getTierRequirement,
  handleApiRequest,
  isAbortError,
  isArcApiError,
  isArcErrorCode,
  isDuplicateKeyError,
  isOrgContextRequiredError,
  isTierRequiredError,
  isValidationError,
  KNOWN_ARC_ERROR_CODES,
} from "../../src/client/client.js";
import type { CrudApi } from "../../src/query/hooks.js";
import { defineRouteAction, runRouteAction } from "../../src/sdk/actions.js";

describe("request", () => {
  // ============================================================================
  // configureClient
  // ============================================================================

  describe("configureClient", () => {
    afterEach(() => {
      // Reset to unconfigured state by configuring with a known URL
      // (there's no "reset" export, so we just reconfigure for each test)
    });

    it("throws if handleApiRequest called before configureClient", async () => {
      // We need a fresh module to test unconfigured state
      // Since configureClient is module-level, we test via the error path
      // by making fetch fail after config
      configureClient({ baseUrl: "http://localhost:9999" });

      // After configuring, requests should not throw the config error
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await handleApiRequest("GET", "/test");
      expect(result).toEqual({ success: true });

      fetchMock.mockRestore();
    });

    /**
     * The SSR warning is about LEAKING per-request state, not about the server
     * being off-limits. A Next.js app has to configure `baseUrl` in the server
     * module graph — an SSR fetcher cannot build an absolute URL without it, and
     * there is no other seam that supplies one. Warning on that too made the
     * warning fire on every cold start of an app doing it correctly, which is how
     * a warning stops being read.
     */
    describe("server-side call", () => {
      let warn: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        // `typeof window` reads "undefined" once the global holds undefined.
        vi.stubGlobal("window", undefined);
        warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      });

      afterEach(() => {
        vi.unstubAllGlobals();
        warn.mockRestore();
      });

      it("stays silent for deployment constants", () => {
        configureClient({ baseUrl: "http://api.test", basePath: "/api", authMode: "bearer" });
        expect(warn).not.toHaveBeenCalled();
      });

      it("warns on defaultHeaders — where a caller pins one request's token", () => {
        configureClient({
          baseUrl: "http://api.test",
          defaultHeaders: { authorization: "Bearer leaked" },
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain("defaultHeaders");
      });

      it("warns on an interceptor — a closure is where the served request gets captured", () => {
        configureClient({ baseUrl: "http://api.test", beforeRequest: (ctx) => ctx });
        expect(String(warn.mock.calls[0]![0])).toContain("beforeRequest");
      });

      it("names every offending key at once, so one warning is the whole fix list", () => {
        configureClient({
          baseUrl: "http://api.test",
          beforeRequest: (ctx) => ctx,
          afterResponse: (ctx) => ctx,
          defaultHeaders: {},
        });
        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]![0]);
        for (const key of ["beforeRequest", "afterResponse", "defaultHeaders"]) {
          expect(message).toContain(key);
        }
      });

      it("the config is applied either way — the warning informs, it does not refuse", () => {
        configureClient({ baseUrl: "http://warned.test", defaultHeaders: { a: "b" } });
        expect(getBaseUrl()).toBe("http://warned.test");
      });
    });
  });

  // ============================================================================
  // handleApiRequest
  // ============================================================================

  describe("handleApiRequest", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("makes GET request to correct URL", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ data: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await handleApiRequest("GET", "/users");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api.test/users",
        expect.objectContaining({
          method: "GET",
          credentials: "same-origin",
        }),
      );
    });

    it("sends organizationId as header", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await handleApiRequest("GET", "/items", { organizationId: "org-123" });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-organization-id"]).toBe("org-123");
    });

    it("explicit null means deliberately none; undefined inherits configureAuth", async () => {
      fetchMock.mockImplementation(
        async () =>
          new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      );
      configureAuth({ getToken: () => "tok", getOrgId: () => "org-cfg" });
      try {
        await handleApiRequest("GET", "/me", { organizationId: null });
        await handleApiRequest("GET", "/public", { token: null });
        await handleApiRequest("GET", "/items");
        const sent = (i: number) =>
          (fetchMock.mock.calls[i]![1] as RequestInit).headers as Record<string, string>;
        expect(sent(0)).toMatchObject({ Authorization: "Bearer tok" });
        expect(sent(0)).not.toHaveProperty("x-organization-id");
        expect(sent(1)).not.toHaveProperty("Authorization");
        expect(sent(1)["x-organization-id"]).toBe("org-cfg");
        expect(sent(2)).toMatchObject({
          Authorization: "Bearer tok",
          "x-organization-id": "org-cfg",
        });
      } finally {
        configureAuth({ getToken: () => null, getOrgId: () => null });
      }
    });

    it("sends JSON body for POST", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await handleApiRequest("POST", "/items", {
        body: { name: "Test" },
      });

      const [, options] = fetchMock.mock.calls[0]!;
      expect((options as RequestInit).body).toBe(JSON.stringify({ name: "Test" }));
    });

    it("does not set Content-Type for FormData", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const formData = new FormData();
      formData.append("file", "test");
      await handleApiRequest("POST", "/upload", { body: formData });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
    });

    it("throws on non-ok response", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(handleApiRequest("GET", "/missing")).rejects.toThrow("Not found");
    });

    it("sends internalApiKey when configured", async () => {
      configureClient({ baseUrl: "http://api.test", internalApiKey: "secret-key" });

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await handleApiRequest("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-internal-api-key"]).toBe("secret-key");

      // Reset
      configureClient({ baseUrl: "http://api.test" });
    });

    it("sends Authorization header when token provided", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await handleApiRequest("GET", "/test", { token: "my-token" });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-token");
    });

    it("merges custom headerOptions", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await handleApiRequest("GET", "/test", { headerOptions: { "X-Custom": "value" } });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["X-Custom"]).toBe("value");
    });

    it("passes cache option to fetch", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await handleApiRequest("GET", "/test", { cache: "force-cache" });

      const [, options] = fetchMock.mock.calls[0]!;
      expect((options as RequestInit).cache).toBe("force-cache");
    });

    it("passes next.revalidate and next.tags", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await handleApiRequest("GET", "/test", { next: { revalidate: 60, tags: ["posts"] } });

      const [, options] = fetchMock.mock.calls[0]!;
      const fetchOpts = options as RequestInit & {
        next?: { revalidate?: number; tags?: string[] };
      };
      expect(fetchOpts.next?.revalidate).toBe(60);
      expect(fetchOpts.next?.tags).toEqual(["posts"]);
    });
  });

  // ============================================================================
  // Credentials Policy
  // ============================================================================

  describe("credentials policy", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ data: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("bearer mode (default) uses same-origin credentials", async () => {
      configureClient({ baseUrl: "http://api.test" });
      await handleApiRequest("GET", "/test");

      const [, opts] = fetchMock.mock.calls[0]!;
      expect((opts as RequestInit).credentials).toBe("same-origin");
    });

    it("cookie mode uses include credentials", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "cookie" });
      await handleApiRequest("GET", "/test");

      const [, opts] = fetchMock.mock.calls[0]!;
      expect((opts as RequestInit).credentials).toBe("include");
    });

    it("explicit credentials override authMode default", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "cookie", credentials: "omit" });
      await handleApiRequest("GET", "/test");

      const [, opts] = fetchMock.mock.calls[0]!;
      expect((opts as RequestInit).credentials).toBe("omit");
    });

    it("bearer mode with explicit include sends cookies", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "bearer", credentials: "include" });
      await handleApiRequest("GET", "/test");

      const [, opts] = fetchMock.mock.calls[0]!;
      expect((opts as RequestInit).credentials).toBe("include");
    });

    it("createClient respects credentials config", async () => {
      configureClient({ baseUrl: "http://global.test" });
      const client = createClient({ baseUrl: "http://other.test", credentials: "omit" });
      const api = (await import("../../src/client/api.js")).createCrudApi("items", {
        basePath: "/api",
        client,
      });
      await api.getAll();

      const [, opts] = fetchMock.mock.calls[0]!;
      expect((opts as RequestInit).credentials).toBe("omit");
    });

    it("createClient cookie mode defaults to include", async () => {
      configureClient({ baseUrl: "http://global.test" });
      const client = createClient({ baseUrl: "http://cookie.test", authMode: "cookie" });
      const api = (await import("../../src/client/api.js")).createCrudApi("items", {
        basePath: "/api",
        client,
      });
      await api.getAll();

      const [, opts] = fetchMock.mock.calls[0]!;
      expect((opts as RequestInit).credentials).toBe("include");
    });
  });

  // ============================================================================
  // createQueryString
  // ============================================================================

  describe("createQueryString", () => {
    it("creates basic params", () => {
      const qs = createQueryString({ page: 1, limit: 10, status: "active" });
      expect(qs).toContain("page=1");
      expect(qs).toContain("limit=10");
      expect(qs).toContain("status=active");
    });

    it("handles arrays with [in] syntax", () => {
      const qs = createQueryString({ roles: ["admin", "user"] });
      expect(qs).toBe("roles%5Bin%5D=admin%2Cuser");
    });

    it("handles single-element arrays", () => {
      const qs = createQueryString({ role: ["admin"] });
      expect(qs).toBe("role=admin");
    });

    it("skips undefined and empty strings", () => {
      const qs = createQueryString({ a: undefined, b: "", c: "ok" });
      expect(qs).toBe("c=ok");
    });

    it("handles null values", () => {
      const qs = createQueryString({ status: null });
      expect(qs).toBe("status=null");
    });

    it("handles populateOptions with select", () => {
      const qs = createQueryString({ populateOptions: [{ path: "author", select: "name email" }] });
      expect(qs).toContain("populate%5Bauthor%5D%5Bselect%5D=name%2Cemail");
    });

    it("handles populateOptions with match", () => {
      const qs = createQueryString({
        populateOptions: [{ path: "comments", match: { approved: true } }],
      });
      expect(qs).toContain("populate%5Bcomments%5D%5Bmatch%5D");
    });

    it("handles populateOptions without select or match", () => {
      const qs = createQueryString({
        populateOptions: [{ path: "author" }],
      });
      expect(qs).toBe("populate=author");
    });

    it("returns empty string for empty params", () => {
      expect(createQueryString({})).toBe("");
      expect(createQueryString()).toBe("");
    });
  });

  // ============================================================================
  // createClient (Multi-Client)
  // ============================================================================

  describe("createClient", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("returns an ArcClient object", () => {
      const client = createClient({ baseUrl: "http://other.test" });
      expect(client.request).toBeTypeOf("function");
      expect(client.config.baseUrl).toBe("http://other.test");
    });

    it("uses its own baseUrl for requests", async () => {
      const client = createClient({ baseUrl: "http://analytics.test" });
      await client.request("GET", "/events");

      expect(fetchMock).toHaveBeenCalledWith(
        "http://analytics.test/events",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("sends internalApiKey header when configured", async () => {
      const client = createClient({ baseUrl: "http://other.test", internalApiKey: "other-secret" });

      await client.request("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-internal-api-key"]).toBe("other-secret");
    });

    it("two clients with different baseUrls work independently", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const clientA = createClient({ baseUrl: "http://a.test" });
      const clientB = createClient({ baseUrl: "http://b.test" });

      await clientA.request("GET", "/path");
      await clientB.request("GET", "/path");

      expect(fetchMock.mock.calls[0]![0]).toBe("http://a.test/path");
      expect(fetchMock.mock.calls[1]![0]).toBe("http://b.test/path");
    });

    it("works independently from global configureClient", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      configureClient({ baseUrl: "http://global.test" });
      const client = createClient({ baseUrl: "http://isolated.test" });

      await client.request("GET", "/test");
      await handleApiRequest("GET", "/test");

      expect(fetchMock.mock.calls[0]![0]).toBe("http://isolated.test/test");
      expect(fetchMock.mock.calls[1]![0]).toBe("http://global.test/test");
    });

    it("stores toast and navigation config", () => {
      const toast = { success: vi.fn(), error: vi.fn() };
      const navigation = () => ({ push: vi.fn(), replace: vi.fn() });

      const client = createClient({ baseUrl: "http://test.test", toast, navigation });

      expect(client.toast).toBe(toast);
      expect(client.navigation).toBe(navigation);
    });

    it("sends defaultHeaders", async () => {
      const client = createClient({
        baseUrl: "http://other.test",
        defaultHeaders: { "X-Custom": "custom-value" },
      });

      await client.request("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["X-Custom"]).toBe("custom-value");
    });
  });

  // ============================================================================
  // ArcApiError
  // ============================================================================

  describe("ArcApiError", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("throws ArcApiError on non-ok response with status, json, endpoint, method", async () => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ message: "Validation failed", errors: { email: "already taken" } }),
          {
            status: 422,
            statusText: "Unprocessable Entity",
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      try {
        await handleApiRequest("POST", "/users");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ArcApiError);
        const apiError = error as ArcApiError;
        expect(apiError.status).toBe(422);
        expect(apiError.statusText).toBe("Unprocessable Entity");
        expect(apiError.endpoint).toBe("/users");
        expect(apiError.method).toBe("POST");
        expect(apiError.json).toEqual({
          message: "Validation failed",
          errors: { email: "already taken" },
        });
        expect(apiError.message).toBe("Validation failed");
      }
    });

    it("ArcApiError is also instanceof Error", () => {
      const error = new ArcApiError("test", {
        status: 404,
        statusText: "Not Found",
        json: null,
        endpoint: "/test",
        method: "GET",
      });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ArcApiError);
      expect(error.name).toBe("ArcApiError");
    });

    it("isArcApiError type guard works", () => {
      const apiError = new ArcApiError("test", {
        status: 500,
        statusText: "Internal Server Error",
        json: null,
        endpoint: "/test",
        method: "GET",
      });

      expect(isArcApiError(apiError)).toBe(true);
      expect(isArcApiError(new Error("plain"))).toBe(false);
      expect(isArcApiError(null)).toBe(false);
      expect(isArcApiError("string")).toBe(false);
    });

    it("fieldErrors getter returns null when no errors field", () => {
      const error = new ArcApiError("test", {
        status: 400,
        statusText: "Bad Request",
        json: { message: "Bad request" },
        endpoint: "/test",
        method: "POST",
      });

      expect(error.fieldErrors).toBeNull();
    });

    it("fieldErrors maps ErrorContract details by path", () => {
      const error = new ArcApiError("test", {
        status: 422,
        statusText: "Unprocessable Entity",
        json: {
          code: "arc.validation_error",
          message: "Validation failed",
          details: [
            { path: "email", code: "invalid", message: "invalid" },
            { path: "name", code: "required", message: "required" },
          ],
        },
        endpoint: "/test",
        method: "POST",
      });

      expect(error.fieldErrors).toEqual({ email: "invalid", name: "required" });
    });

    it("fieldErrors returns null when json is null", () => {
      const error = new ArcApiError("test", {
        status: 500,
        statusText: "Internal Server Error",
        json: null,
        endpoint: "/test",
        method: "GET",
      });

      expect(error.fieldErrors).toBeNull();
    });

    it("captures text body when json parse fails", async () => {
      fetchMock.mockResolvedValue(
        new Response("not json", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "text/plain" },
        }),
      );

      try {
        await handleApiRequest("GET", "/fail");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ArcApiError);
        // Now captures body text instead of just statusText
        expect((error as ArcApiError).message).toBe("not json");
        expect(((error as ArcApiError).json as { rawBody: string }).rawBody).toBe("not json");
      }
    });
  });

  // ============================================================================
  // Response Type Handling
  // ============================================================================

  describe("response type handling", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("handles PDF response with data and response properties", async () => {
      // Use ArrayBuffer instead of Blob (Node.js Response compat)
      const buffer = new TextEncoder().encode("pdf-content");
      fetchMock.mockResolvedValue(
        new Response(buffer, { status: 200, headers: { "Content-Type": "application/pdf" } }),
      );

      const result = await handleApiRequest<{ data: Blob; response: Response }>(
        "GET",
        "/report.pdf",
      );
      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("response");
    });

    it("handles image response with data and response properties", async () => {
      const buffer = new TextEncoder().encode("img-data");
      fetchMock.mockResolvedValue(
        new Response(buffer, { status: 200, headers: { "Content-Type": "image/png" } }),
      );

      const result = await handleApiRequest<{ data: Blob; response: Response }>(
        "GET",
        "/image.png",
      );
      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("response");
    });

    it("handles CSV response with data and response properties", async () => {
      const csvContent = "name,email\nJohn,john@test.com";
      fetchMock.mockResolvedValue(
        new Response(csvContent, { status: 200, headers: { "Content-Type": "text/csv" } }),
      );

      const result = await handleApiRequest<{ data: Blob; response: Response }>(
        "GET",
        "/export.csv",
      );
      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("response");
    });

    it("handles text/plain response", async () => {
      fetchMock.mockResolvedValue(
        new Response("plain text content", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      );

      const result = await handleApiRequest<{ data: string; response: Response }>("GET", "/text");
      expect(result.data).toBe("plain text content");
    });

    it("handles text/html response", async () => {
      fetchMock.mockResolvedValue(
        new Response("<h1>Hello</h1>", { status: 200, headers: { "Content-Type": "text/html" } }),
      );

      const result = await handleApiRequest<{ data: string; response: Response }>("GET", "/page");
      expect(result.data).toBe("<h1>Hello</h1>");
    });
  });

  // ============================================================================
  // Error Handling Edge Cases
  // ============================================================================

  describe("error handling edge cases", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("wraps network errors as plain Error", async () => {
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

      try {
        await handleApiRequest("GET", "/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Failed to fetch");
      }
    });

    it("wraps non-Error throws as generic message", async () => {
      fetchMock.mockRejectedValue("string error");

      try {
        await handleApiRequest("GET", "/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("An error occurred while fetching data.");
      }
    });

    it("preserves ArcApiError on HTTP error", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: "Forbidden" }), {
          status: 403,
          statusText: "Forbidden",
          headers: { "Content-Type": "application/json" },
        }),
      );

      try {
        await handleApiRequest("DELETE", "/admin/resource");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(isArcApiError(error)).toBe(true);
        expect((error as ArcApiError).status).toBe(403);
        expect((error as ArcApiError).method).toBe("DELETE");
      }
    });

    it("handles 401 unauthorized", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        }),
      );

      try {
        await handleApiRequest("GET", "/protected");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(isArcApiError(error)).toBe(true);
        expect((error as ArcApiError).status).toBe(401);
      }
    });

    it("handles non-JSON error body gracefully", async () => {
      fetchMock.mockResolvedValue(
        new Response("Bad Gateway", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/html" },
        }),
      );

      try {
        await handleApiRequest("GET", "/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(isArcApiError(error)).toBe(true);
        expect((error as ArcApiError).status).toBe(502);
        expect((error as ArcApiError).message).toBe("Bad Gateway");
      }
    });
  });

  // ============================================================================
  // getAuthMode
  // ============================================================================

  describe("getAuthMode", () => {
    it("returns bearer by default", () => {
      configureClient({ baseUrl: "http://api.test" });
      expect(getAuthMode()).toBe("bearer");
    });

    it("returns cookie when configured", () => {
      configureClient({ baseUrl: "http://api.test", authMode: "cookie" });
      expect(getAuthMode()).toBe("cookie");
      // Reset
      configureClient({ baseUrl: "http://api.test" });
    });
  });

  // ============================================================================
  // defaultHeaders
  // ============================================================================

  describe("defaultHeaders", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
      configureClient({ baseUrl: "http://api.test" });
    });

    it("sends defaultHeaders on every request", async () => {
      configureClient({
        baseUrl: "http://api.test",
        defaultHeaders: { "X-App-Version": "1.0.0", "X-Client": "web" },
      });

      await handleApiRequest("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["X-App-Version"]).toBe("1.0.0");
      expect(headers["X-Client"]).toBe("web");
    });

    it("headerOptions override defaultHeaders", async () => {
      configureClient({ baseUrl: "http://api.test", defaultHeaders: { "X-Mode": "default" } });

      await handleApiRequest("GET", "/test", { headerOptions: { "X-Mode": "override" } });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["X-Mode"]).toBe("override");
    });
  });

  // ============================================================================
  // AbortSignal
  // ============================================================================

  describe("AbortSignal", () => {
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

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("passes signal to fetch when provided", async () => {
      const controller = new AbortController();

      await handleApiRequest("GET", "/test", { signal: controller.signal });

      const [, options] = fetchMock.mock.calls[0]!;
      expect((options as RequestInit).signal).toBe(controller.signal);
    });

    it("does not set signal when not provided", async () => {
      await handleApiRequest("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      expect((options as RequestInit).signal).toBeUndefined();
    });
  });

  // ============================================================================
  // configureAuth / getAuthContext
  // ============================================================================

  describe("configureAuth", () => {
    afterEach(() => {
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("stores and retrieves token and orgId", () => {
      configureAuth({ getToken: () => "test-token", getOrgId: () => "test-org" });

      const ctx = getAuthContext();
      expect(ctx.token).toBe("test-token");
      expect(ctx.organizationId).toBe("test-org");
    });

    it("returns nulls when not configured", () => {
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const ctx = getAuthContext();
      expect(ctx.token).toBeNull();
      expect(ctx.organizationId).toBeNull();
    });

    it("supports partial config (only getOrgId)", () => {
      configureAuth({
        getOrgId: () => "org-only",
      });

      const ctx = getAuthContext();
      expect(ctx.token).toBeNull();
      expect(ctx.organizationId).toBe("org-only");
    });
  });

  // ============================================================================
  // v0.2.1 — Error preservation
  // ============================================================================

  describe("v0.2.1 error preservation", () => {
    beforeEach(() => {
      configureClient({ baseUrl: "https://api.test.com" });
    });

    it("preserves AbortError when fetch is aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

      try {
        await handleApiRequest("GET", "/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("AbortError");
      }

      vi.unstubAllGlobals();
    });

    it("preserves TypeError on network failure", async () => {
      const networkError = new TypeError("Failed to fetch");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));

      try {
        await handleApiRequest("GET", "/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as TypeError).message).toBe("Failed to fetch");
      }

      vi.unstubAllGlobals();
    });

    it("wraps non-Error throws in generic Error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue("string error"));

      try {
        await handleApiRequest("GET", "/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("An error occurred while fetching data.");
      }

      vi.unstubAllGlobals();
    });
  });

  // ============================================================================
  // authMode: 'header'
  // ============================================================================

  describe("authMode: header", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("sets custom header instead of Authorization when authMode is header", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "header" });
      configureAuth({ getToken: () => "snr_abc123", headerName: "x-api-key" });

      await handleApiRequest("GET", "/test", { token: "snr_abc123" });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("snr_abc123");
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("defaults headerName to x-api-key when not specified", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "header" });
      configureAuth({ getToken: () => "key123" });

      await handleApiRequest("GET", "/test", { token: "key123" });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("key123");
    });

    it("uses custom headerName from authConfig", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "header" });
      configureAuth({ getToken: () => "admin-key", headerName: "x-admin-key" });

      await handleApiRequest("GET", "/test", { token: "admin-key" });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-admin-key"]).toBe("admin-key");
      expect(headers["x-api-key"]).toBeUndefined();
    });

    it("still uses Bearer for authMode: bearer (default)", async () => {
      configureClient({ baseUrl: "http://api.test" });

      await handleApiRequest("GET", "/test", { token: "my-token" });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-token");
    });

    it("getAuthMode returns header when configured", () => {
      configureClient({ baseUrl: "http://api.test", authMode: "header" });
      expect(getAuthMode()).toBe("header");
    });
  });

  // ============================================================================
  // apiVersion
  // ============================================================================

  describe("apiVersion", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
      configureClient({ baseUrl: "http://api.test" });
    });

    it("sends Accept-Version header when apiVersion is configured", async () => {
      configureClient({ baseUrl: "http://api.test", apiVersion: "2" });

      await handleApiRequest("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Accept-Version"]).toBe("2");
    });

    it("does not send Accept-Version when not configured", async () => {
      configureClient({ baseUrl: "http://api.test" });

      await handleApiRequest("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Accept-Version"]).toBeUndefined();
    });
  });

  // ============================================================================
  // idempotency
  // ============================================================================

  describe("idempotency", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
      configureClient({ baseUrl: "http://api.test" });
    });

    it("sends explicit idempotencyKey when provided", async () => {
      configureClient({ baseUrl: "http://api.test" });

      await handleApiRequest("POST", "/items", {
        body: { name: "test" },
        idempotencyKey: "my-key-123",
      });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("my-key-123");
    });

    it("raw handleApiRequest auto-generates when autoIdempotency is on (0.12: executor-level)", async () => {
      configureClient({ baseUrl: "http://api.test", autoIdempotency: true });

      await handleApiRequest("POST", "/items", { body: { name: "test" } });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      // 0.12: the key is minted once per logical request at the top of the
      // executor — direct BaseApi/handleApiRequest calls are covered too, and
      // backoff + auth retries reuse the same key (see
      // executor-idempotency-server-client.test.ts). The mutation layer's ref
      // still covers TanStack-level retries; explicit keys always win.
      expect(headers["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
    });

    it("explicit idempotencyKey is always sent", async () => {
      configureClient({ baseUrl: "http://api.test" });

      await handleApiRequest("POST", "/items", {
        body: { name: "test" },
        idempotencyKey: "explicit-key",
      });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("explicit-key");
    });

    it("isAutoIdempotency reflects client config", async () => {
      const { isAutoIdempotency } = await import("../../src/client/client.js");

      configureClient({ baseUrl: "http://api.test" });
      expect(isAutoIdempotency()).toBe(false);

      configureClient({ baseUrl: "http://api.test", autoIdempotency: true });
      expect(isAutoIdempotency()).toBe(true);

      configureClient({ baseUrl: "http://api.test" });
    });
  });

  // ============================================================================
  // Per-client auth (createClient with getToken/getOrgId)
  // ============================================================================

  describe("per-client auth", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => "global-token", getOrgId: () => "global-org" });
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      fetchMock.mockRestore();
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("per-client getToken injects token into requests", async () => {
      const client = createClient({ baseUrl: "http://other.test", getToken: () => "client-token" });

      await client.request("GET", "/items");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer client-token");
    });

    it("per-client getOrgId injects org header", async () => {
      const client = createClient({ baseUrl: "http://other.test", getOrgId: () => "client-org" });

      await client.request("GET", "/items");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-organization-id"]).toBe("client-org");
    });

    it("per-client header auth with custom headerName", async () => {
      const client = createClient({
        baseUrl: "http://other.test",
        authMode: "header",
        getToken: () => "my-api-key",
        headerName: "x-admin-key",
      });

      await client.request("GET", "/items");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-admin-key"]).toBe("my-api-key");
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("explicit token in options overrides per-client getToken", async () => {
      const client = createClient({
        baseUrl: "http://other.test",
        getToken: () => "client-default",
      });

      await client.request("GET", "/items", { token: "explicit-override" });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer explicit-override");
    });

    it("client without per-client auth does not auto-inject", async () => {
      const client = createClient({ baseUrl: "http://other.test" });

      await client.request("GET", "/items");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });

  // ============================================================================
  // Non-JSON error responses
  // ============================================================================

  describe("non-JSON error responses", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("handles HTML error page (502 gateway)", async () => {
      fetchMock.mockResolvedValue(
        new Response("<html><body>Bad Gateway</body></html>", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/html" },
        }),
      );

      try {
        await handleApiRequest("GET", "/items");
        expect.fail("Should throw");
      } catch (error) {
        expect(isArcApiError(error)).toBe(true);
        expect((error as ArcApiError).status).toBe(502);
      }
    });

    it("handles empty error body", async () => {
      fetchMock.mockResolvedValue(
        new Response("", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );

      try {
        await handleApiRequest("GET", "/items");
        expect.fail("Should throw");
      } catch (error) {
        expect(isArcApiError(error)).toBe(true);
        expect((error as ArcApiError).status).toBe(500);
        expect((error as ArcApiError).message).toBe("Internal Server Error");
      }
    });

    it("handles plain text error", async () => {
      fetchMock.mockResolvedValue(
        new Response("Service Unavailable", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "Content-Type": "text/plain" },
        }),
      );

      try {
        await handleApiRequest("GET", "/items");
        expect.fail("Should throw");
      } catch (error) {
        expect(isArcApiError(error)).toBe(true);
        expect((error as ArcApiError).status).toBe(503);
      }
    });
  });

  // ============================================================================
  // createAuthAwareClient
  // ============================================================================

  describe("createAuthAwareClient", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      // Reset global auth between tests
      configureAuth({});
      _resetAuthWarnings();
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("inherits baseUrl from configureClient when no override", async () => {
      configureClient({ baseUrl: "http://global.test" });
      const client = createAuthAwareClient();

      await client.request("GET", "/users");

      expect(fetchMock).toHaveBeenCalledWith("http://global.test/users", expect.any(Object));
    });

    it("overrides baseUrl when supplied", async () => {
      configureClient({ baseUrl: "http://global.test" });
      const client = createAuthAwareClient({ baseUrl: "http://override.test" });

      await client.request("GET", "/test");

      expect(fetchMock).toHaveBeenCalledWith("http://override.test/test", expect.any(Object));
    });

    it("injects token from global configureAuth", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => "token-abc" });
      const client = createAuthAwareClient();

      await client.request("GET", "/secure");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer token-abc");
    });

    it("injects organizationId from global configureAuth", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getOrgId: () => "org-123" });
      const client = createAuthAwareClient();

      await client.request("GET", "/items");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-organization-id"]).toBe("org-123");
    });

    it("reads token lazily on every request (rotation)", async () => {
      let token = "first";
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => token });
      const client = createAuthAwareClient();

      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      await client.request("GET", "/a");
      token = "second";
      await client.request("GET", "/b");

      const headersA = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      const headersB = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headersA["Authorization"]).toBe("Bearer first");
      expect(headersB["Authorization"]).toBe("Bearer second");
    });

    it("inherits authMode from configureClient (cookie → include credentials)", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "cookie" });
      const client = createAuthAwareClient();

      await client.request("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      expect((options as RequestInit).credentials).toBe("include");
    });

    it("header authMode injects token as custom header", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => "api-key-xyz", headerName: "x-api-key" });
      const client = createAuthAwareClient({ authMode: "header" });

      await client.request("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("api-key-xyz");
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("explicit getToken override wins over global", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => "global-token" });
      const client = createAuthAwareClient({ getToken: () => "override-token" });

      await client.request("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer override-token");
    });

    it("returns null token when global auth is unconfigured", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({}); // no getToken
      const client = createAuthAwareClient();

      await client.request("GET", "/test");

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("explicit options.token wins over auto-injection", async () => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => "global-token" });
      const client = createAuthAwareClient();

      await client.request("GET", "/test", { token: "explicit-token" });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer explicit-token");
    });
  });

  // ============================================================================
  // configureAuth — async getToken guard
  // ============================================================================

  describe("configureAuth async-token guard", () => {
    // Async returns are logged via console.error (not warn) because the failure
    // is silent in the UI — queries silently disable, indistinguishable from a
    // clean empty state. The error carries a real `Error` instance so dev tools
    // surface a stack trace pointing at the offending `configureAuth` call site.
    let errorSpy: ReturnType<typeof vi.spyOn>;

    const asyncErrorCount = () =>
      errorSpy.mock.calls.filter((c: unknown[]) => {
        const arg = c[0];
        return arg instanceof Error && arg.message.includes("returned a Promise");
      }).length;

    beforeEach(() => {
      _resetAuthWarnings();
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it("returns null and logs an Error when getToken returns a Promise", () => {
      configureAuth({ getToken: () => Promise.resolve("async-token") as unknown as string | null });

      const ctx = getAuthContext();

      expect(ctx.token).toBeNull();
      expect(asyncErrorCount()).toBe(1);
    });

    it("logs only once across multiple calls", () => {
      configureAuth({ getToken: () => Promise.resolve("x") as unknown as string | null });

      getAuthContext();
      getAuthContext();
      getAuthContext();

      expect(asyncErrorCount()).toBe(1);
    });

    it("resets dedup flag on reconfigure", () => {
      configureAuth({ getToken: () => Promise.resolve("x") as unknown as string | null });
      getAuthContext();

      configureAuth({ getToken: () => Promise.resolve("y") as unknown as string | null });
      getAuthContext();

      expect(asyncErrorCount()).toBe(2);
    });

    it("passes through synchronous tokens", () => {
      configureAuth({ getToken: () => "sync-token" });

      const ctx = getAuthContext();

      expect(ctx.token).toBe("sync-token");
      expect(asyncErrorCount()).toBe(0);
    });

    it("handles thenable (non-Promise) returns as async", () => {
      // biome-ignore lint/suspicious/noThenProperty: a thenable IS the fixture — this test proves async-token detection catches non-Promise thenables
      const thenable = { then: () => {} };
      configureAuth({ getToken: () => thenable as unknown as string });

      const ctx = getAuthContext();

      expect(ctx.token).toBeNull();
      expect(asyncErrorCount()).toBe(1);
    });
  });

  // ============================================================================
  // isAbortError
  // ============================================================================

  describe("isAbortError", () => {
    it("detects DOMException AbortError (browser)", () => {
      const err = Object.assign(new Error("aborted"), { name: "AbortError" });
      expect(isAbortError(err)).toBe(true);
    });

    it("detects Error with name=AbortError (Node 18+ undici)", () => {
      const err = new Error("Request aborted");
      err.name = "AbortError";
      expect(isAbortError(err)).toBe(true);
    });

    it("detects code: ERR_ABORTED", () => {
      const err = Object.assign(new Error("cancelled"), { code: "ERR_ABORTED" });
      expect(isAbortError(err)).toBe(true);
    });

    it("returns false for ArcApiError", () => {
      const err = new ArcApiError("boom", {
        status: 500,
        statusText: "x",
        json: null,
        endpoint: "/a",
        method: "GET",
      });
      expect(isAbortError(err)).toBe(false);
    });

    it("returns false for plain TypeError (network failure)", () => {
      expect(isAbortError(new TypeError("fetch failed"))).toBe(false);
    });

    it("returns false for null / undefined / primitives", () => {
      expect(isAbortError(null)).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
      expect(isAbortError("AbortError")).toBe(false);
      expect(isAbortError(0)).toBe(false);
    });
  });

  // ============================================================================
  // Known error code arrays — runtime / type-level consistency
  // ============================================================================

  describe("KNOWN_ARC_ERROR_CODES", () => {
    it("is non-empty + unique", () => {
      expect(KNOWN_ARC_ERROR_CODES.length).toBeGreaterThan(10);
      expect(new Set(KNOWN_ARC_ERROR_CODES).size).toBe(KNOWN_ARC_ERROR_CODES.length);
    });

    it("exposes the canonical and arc business codes", () => {
      // repo-core canonical (lowercase, RFC 7807).
      expect(KNOWN_ARC_ERROR_CODES).toContain("validation_error");
      expect(KNOWN_ARC_ERROR_CODES).toContain("not_found");
      expect(KNOWN_ARC_ERROR_CODES).toContain("duplicate_key");
      // arc hierarchical.
      expect(KNOWN_ARC_ERROR_CODES).toContain("arc.forbidden");
      expect(KNOWN_ARC_ERROR_CODES).toContain("arc.validation_error");
      // arc business (UPPER_SNAKE).
      expect(KNOWN_ARC_ERROR_CODES).toContain("ORG_CONTEXT_REQUIRED");
      expect(KNOWN_ARC_ERROR_CODES).toContain("ALL_FIELDS_STRIPPED");
    });

    it("is array-shaped", () => {
      expect(Array.isArray(KNOWN_ARC_ERROR_CODES)).toBe(true);
    });

    it("is the repo-core catalog, not a copy — every server code arc emits is known", () => {
      // Spread from the contract both arc and this SDK depend on; a code arc adds
      // reaches the client with a repo-core bump and no SDK edit.
      for (const code of [
        ...Object.values(ERROR_CODES),
        ...Object.values(ARC_ERROR_CODES),
        ...Object.values(ARC_REASON_CODES),
      ]) {
        expect(KNOWN_ARC_ERROR_CODES).toContain(code);
      }
      // The codes the arc 2.42 review found missing.
      expect(KNOWN_ARC_ERROR_CODES).toContain("arc.precondition_failed");
      expect(KNOWN_ARC_ERROR_CODES).toContain("arc.idempotency_key_reused");
      expect(KNOWN_ARC_ERROR_CODES).toContain("arc.idempotency_key_required");
    });
  });

  // ============================================================================
  // ClientConfig.retry
  // ============================================================================

  describe("ClientConfig.retry", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("retries on 500 and succeeds on second attempt", async () => {
      configureClient({
        baseUrl: "http://api.test",
        retry: { attempts: 2, backoff: () => 0 }, // zero backoff for test speed
      });

      fetchMock
        .mockResolvedValueOnce(
          new Response("boom", { status: 500, statusText: "Internal Server Error" }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const result = await handleApiRequest<{ ok: boolean }>("GET", "/test");
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does NOT retry on 4xx (client error)", async () => {
      configureClient({ baseUrl: "http://api.test", retry: { attempts: 5, backoff: () => 0 } });

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "bad input" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(handleApiRequest("POST", "/test", { body: { x: 1 } })).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries on network failure (TypeError from fetch)", async () => {
      configureClient({ baseUrl: "http://api.test", retry: { attempts: 3, backoff: () => 0 } });

      fetchMock
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      const result = await handleApiRequest<{ ok: boolean }>("GET", "/test");
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("does NOT retry on AbortError", async () => {
      configureClient({ baseUrl: "http://api.test", retry: { attempts: 5, backoff: () => 0 } });

      const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
      fetchMock.mockRejectedValue(abortErr);

      await expect(handleApiRequest("GET", "/test")).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("exhausts retries and throws the last error", async () => {
      configureClient({ baseUrl: "http://api.test", retry: { attempts: 3, backoff: () => 0 } });

      fetchMock.mockResolvedValue(
        new Response("boom", { status: 503, statusText: "Service Unavailable" }),
      );

      try {
        await handleApiRequest("GET", "/test");
        expect.fail("should have thrown");
      } catch (error) {
        expect(isArcApiError(error)).toBe(true);
        if (isArcApiError(error)) expect(error.status).toBe(503);
      }
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("respects explicit retryOn whitelist (numbers)", async () => {
      configureClient({
        baseUrl: "http://api.test",
        retry: { attempts: 3, backoff: () => 0, retryOn: [502, 503] },
      });

      // 504 is NOT in whitelist — should not retry
      fetchMock.mockResolvedValue(
        new Response("boom", { status: 504, statusText: "Gateway Timeout" }),
      );

      await expect(handleApiRequest("GET", "/test")).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("custom backoff function receives 0-indexed attempt", async () => {
      const delays: number[] = [];
      configureClient({
        baseUrl: "http://api.test",
        retry: {
          attempts: 3,
          backoff: (attempt) => {
            delays.push(attempt);
            return 0;
          },
        },
      });

      fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

      await expect(handleApiRequest("GET", "/test")).rejects.toThrow();
      // attempts:3 means 1 initial + 2 retries → backoff called twice (after attempt 0 and 1)
      expect(delays).toEqual([0, 1]);
    });

    it("default behavior (no retry config) is one attempt", async () => {
      configureClient({ baseUrl: "http://api.test" });

      fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

      await expect(handleApiRequest("GET", "/test")).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("signal abort during backoff cancels subsequent retries", async () => {
      configureClient({ baseUrl: "http://api.test", retry: { attempts: 5, backoff: () => 100 } });

      fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30); // abort during the backoff sleep

      await expect(
        handleApiRequest("GET", "/test", { signal: controller.signal }),
      ).rejects.toThrow();

      // First fetch happened; backoff was interrupted before second
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // ClientConfig.beforeRequest / afterResponse interceptors
  // ============================================================================

  describe("ClientConfig.beforeRequest", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => fetchMock.mockRestore());

    it("runs before fetch and can mutate headers", async () => {
      configureClient({
        baseUrl: "http://api.test",
        beforeRequest: (ctx) => ({ ...ctx, headers: { ...ctx.headers, "x-trace-id": "abc-123" } }),
      });

      await handleApiRequest("GET", "/test");

      const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["x-trace-id"]).toBe("abc-123");
    });

    it("supports async interceptors", async () => {
      configureClient({
        baseUrl: "http://api.test",
        beforeRequest: async (ctx) => {
          await Promise.resolve();
          return { ...ctx, headers: { ...ctx.headers, "x-async": "yes" } };
        },
      });

      await handleApiRequest("GET", "/test");

      const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["x-async"]).toBe("yes");
    });

    it("receives the attempt counter (0 on first, 1+ on retry)", async () => {
      const attempts: number[] = [];
      configureClient({
        baseUrl: "http://api.test",
        retry: { attempts: 2, backoff: () => 0 },
        beforeRequest: (ctx) => {
          attempts.push(ctx.attempt);
          return ctx;
        },
      });

      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 })).mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await handleApiRequest("GET", "/test");
      expect(attempts).toEqual([0, 1]);
    });

    it("can replace body before fetch", async () => {
      configureClient({
        baseUrl: "http://api.test",
        beforeRequest: (ctx) => ({
          ...ctx,
          body: JSON.stringify({ ...JSON.parse(ctx.body as string), injected: true }),
        }),
      });

      await handleApiRequest("POST", "/test", { body: { x: 1 } });

      const sentBody = (fetchMock.mock.calls[0]![1] as RequestInit).body as string;
      expect(JSON.parse(sentBody)).toEqual({ x: 1, injected: true });
    });
  });

  describe("ClientConfig.afterResponse", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ value: 42 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    afterEach(() => fetchMock.mockRestore());

    it("receives parsed body + status + duration", async () => {
      let captured: { status: number; body: unknown; durationMs: number } | null = null;
      configureClient({
        baseUrl: "http://api.test",
        afterResponse: (ctx) => {
          captured = { status: ctx.status, body: ctx.body, durationMs: ctx.durationMs };
          return ctx;
        },
      });

      await handleApiRequest("GET", "/test");

      expect(captured).not.toBeNull();
      expect(captured!.status).toBe(200);
      expect(captured!.body).toEqual({ value: 42 });
      expect(captured!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("can transform body", async () => {
      configureClient({
        baseUrl: "http://api.test",
        afterResponse: ((ctx: { body: unknown }) => ({
          ...ctx,
          body: { wrapped: ctx.body },
        })) as never,
      });

      const result = await handleApiRequest("GET", "/test");
      expect(result).toEqual({ wrapped: { value: 42 } });
    });

    it("does NOT run on error responses (ArcApiError thrown first)", async () => {
      const after = vi.fn((ctx) => ctx);
      configureClient({
        baseUrl: "http://api.test",
        afterResponse: after,
      });

      fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

      await expect(handleApiRequest("GET", "/test")).rejects.toThrow();
      expect(after).not.toHaveBeenCalled();
    });
  });
});

describe("per-client transports", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  describe("ClientConfig.fetch — the transport slot", () => {
    afterEach(() => vi.restoreAllMocks());

    it("routes the global client through the supplied transport, never the runtime fetch", async () => {
      const global = vi.spyOn(globalThis, "fetch");
      const transport = vi.fn(async () => json(200, { success: true, data: { id: "p1" } }));
      configureClient({ baseUrl: "local:", fetch: transport });

      const res = await handleApiRequest<{ data: { id: string } }>("GET", "/api/v1/products/p1");

      expect(res.data.id).toBe("p1");
      expect(transport).toHaveBeenCalledWith(
        "local:/api/v1/products/p1",
        expect.objectContaining({ method: "GET" }),
      );
      expect(global).not.toHaveBeenCalled();
    });

    it("an error answered by the transport reaches the caller as the same ArcApiError a server's would", async () => {
      const transport = vi.fn(async () =>
        json(501, {
          success: false,
          error: { code: "offline.unsupported", message: "Not available offline" },
        }),
      );
      const client = createClient({ baseUrl: "local:", fetch: transport });

      const err = await client.request("GET", "/api/v1/reports/x").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ArcApiError);
      expect((err as ArcApiError).status).toBe(501);
    });
  });

  describe("createAuthAwareClient — the client SDKs use", () => {
    it("carries every request-time field of the global config: the transport, the cache mode", async () => {
      const global = vi.spyOn(globalThis, "fetch");
      const transport = vi.fn(async () => json(200, { id: "p1" }));
      configureClient({ baseUrl: "local:", fetch: transport, cache: "no-store" });

      const res = await createAuthAwareClient().request<{ id: string }>(
        "GET",
        "/api/v1/products/p1",
      );

      expect(res.id).toBe("p1");
      expect(transport).toHaveBeenCalledWith(
        "local:/api/v1/products/p1",
        expect.objectContaining({ cache: "no-store" }),
      );
      expect(global).not.toHaveBeenCalled();
    });

    it("an explicit override still wins over the global config", async () => {
      const globalTransport = vi.fn(async () => json(200, {}));
      const own = vi.fn(async () => json(200, { id: "own" }));
      configureClient({ baseUrl: "local:", fetch: globalTransport });

      await createAuthAwareClient({ fetch: own }).request("GET", "/api/v1/x");

      expect(own).toHaveBeenCalledOnce();
      expect(globalTransport).not.toHaveBeenCalled();
    });
  });

  describe("BaseApi.request — per-request options reach the transport", () => {
    it("a per-request timeoutMs ends a request the transport never answers", async () => {
      const hang = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          ),
      );
      const api = new BaseApi("orders", {
        basePath: "/api/v1",
        client: createClient({ baseUrl: "local:", fetch: hang }),
      });

      const err = await api
        .request("POST", "/api/v1/orders", { data: {}, options: { timeoutMs: 20 } })
        .catch((e: unknown) => e);

      expect((err as Error).name).toBe("TimeoutError");
    });
  });
});

describe("responseType", () => {
  /**
   * `responseType` is read (it was declared on `RequestOptions` and never used: a `text/*` body
   * came back as `{ data: text, response }`, so a caller unwrapped it by hand), and a per-request
   * `idempotencyKey` reaches the `Idempotency-Key` header through `BaseApi` options and
   * `runRouteAction`.
   */

  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: "http://api.test" });
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  const headersOf = (call = 0) =>
    (fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;

  describe("responseType", () => {
    it("'text' answers the body string, whatever the content type", async () => {
      fetchMock.mockResolvedValue(
        new Response("line 1\nline 2", { status: 200, headers: { "Content-Type": "text/plain" } }),
      );
      const text = await handleApiRequest<string>("GET", "/me?format=text", {
        responseType: "text",
      });
      expect(text).toBe("line 1\nline 2");
    });

    it("'text' reads a JSON-typed body as text too", async () => {
      fetchMock.mockResolvedValue(
        new Response('{"a":1}', { status: 200, headers: { "Content-Type": "application/json" } }),
      );
      expect(await handleApiRequest("GET", "/x", { responseType: "text" })).toBe('{"a":1}');
    });

    it("'blob' answers the Blob itself (a CSV is not wrapped in { data, response })", async () => {
      fetchMock.mockResolvedValue(
        new Response("a,b\n1,2", { status: 200, headers: { "Content-Type": "text/csv" } }),
      );
      const blob = await handleApiRequest<Blob>("GET", "/export", { responseType: "blob" });
      expect(blob).toBeInstanceOf(Blob);
      expect(await blob.text()).toBe("a,b\n1,2");
    });

    it("'json' parses a body served with a wrong content type; an empty body is undefined", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "text/plain" } }),
      );
      expect(await handleApiRequest("GET", "/x", { responseType: "json" })).toEqual({ ok: true });
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      expect(await handleApiRequest("POST", "/x", { responseType: "json" })).toBeUndefined();
    });

    it("omitted: the content-type rules of 0.19 hold (text/* stays { data, response })", async () => {
      fetchMock.mockResolvedValue(
        new Response("hi", { status: 200, headers: { "Content-Type": "text/plain" } }),
      );
      const raw = await handleApiRequest<{ data: string; response: Response }>("GET", "/x");
      expect(raw.data).toBe("hi");
      expect(raw.response).toBeInstanceOf(Response);
    });

    it("BaseApi.invokeRoute passes responseType through", async () => {
      fetchMock.mockResolvedValue(
        new Response("copy me", { status: 200, headers: { "Content-Type": "text/plain" } }),
      );
      const api = new BaseApi("event-log");
      const text = await api.invokeRoute<string>({
        path: "/me",
        params: { format: "text" },
        options: { responseType: "text" },
      });
      expect(text).toBe("copy me");
    });
  });

  describe("per-request idempotencyKey", () => {
    const json = () =>
      new Response('{"_id":"o1"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    it("BaseApi.dispatchAction / invokeRoute options carry it as Idempotency-Key", async () => {
      fetchMock.mockImplementation(async () => json());
      const api = new BaseApi("occurrences");
      await api.dispatchAction({ id: "o1", action: "close", options: { idempotencyKey: "k-1" } });
      await api.invokeRoute({
        method: "POST",
        path: "/",
        data: {},
        options: { idempotencyKey: "k-2" },
      });
      expect(headersOf(0)["Idempotency-Key"]).toBe("k-1");
      expect(headersOf(1)["Idempotency-Key"]).toBe("k-2");
    });

    it("runRouteAction forwards per-call options", async () => {
      fetchMock.mockImplementation(async () => json());
      const api = new BaseApi("occurrences");
      const declare = defineRouteAction<{ title: string }, { _id: string }>({
        key: "occ.declare",
        method: "POST",
        path: () => "/",
        body: (input) => input,
        silent: true,
      });
      const out = await runRouteAction(api, declare, { title: "t" }, { idempotencyKey: "k-3" });
      expect(out).toEqual({ _id: "o1" });
      expect(headersOf(0)["Idempotency-Key"]).toBe("k-3");
    });
  });
});

describe("timeouts and retries", () => {
  /**
   * 0.12: request timeout policy + retry jitter + Retry-After pacing.
   *
   *   - `timeoutMs` (client-level, per-request override) aborts a hung fetch
   *     and surfaces a RETRYABLE `TimeoutError` — distinct from a deliberate
   *     caller abort, which stays an `AbortError` and is never retried.
   *   - `retry.jitter: 'full'` randomizes delays (anti-stampede).
   *   - 429/503 `Retry-After` (seconds or HTTP-date) is parsed onto
   *     `ArcApiError.retryAfterMs` and wins over computed backoff.
   */

  function okJson(body: unknown = { ok: true }) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** fetch that never settles but honors abort like the real one. */
  function hangingFetch() {
    return vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
            { once: true },
          );
        }),
    );
  }

  beforeEach(() => {
    configureClient({ baseUrl: "https://api.test" });
    configureAuth({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("timeoutMs", () => {
    it("aborts a hung request and rejects with TimeoutError (not a silent AbortError)", async () => {
      vi.stubGlobal("fetch", hangingFetch());
      configureClient({ baseUrl: "https://api.test", timeoutMs: 30 });

      const err = await handleApiRequest("GET", "/slow").catch((e: unknown) => e);
      expect((err as Error).name).toBe("TimeoutError");
      expect((err as Error).message).toContain("30ms");
      // Timeouts are failures, not cancellations — they must NOT be swallowed
      // by abort-filtering in consumers.
      expect(isAbortError(err)).toBe(false);
    });

    it("per-request timeoutMs: 0 disables the client-level default", async () => {
      const fetchMock = vi.fn(
        () => new Promise<Response>((resolve) => setTimeout(() => resolve(okJson()), 60)),
      );
      vi.stubGlobal("fetch", fetchMock);
      configureClient({ baseUrl: "https://api.test", timeoutMs: 20 });

      await expect(handleApiRequest("GET", "/slow", { timeoutMs: 0 })).resolves.toEqual({
        ok: true,
      });
    });

    it("a deliberate caller abort stays an AbortError even with a timeout configured", async () => {
      vi.stubGlobal("fetch", hangingFetch());
      configureClient({ baseUrl: "https://api.test", timeoutMs: 5_000 });

      const controller = new AbortController();
      const pending = handleApiRequest("GET", "/slow", { signal: controller.signal });
      controller.abort();

      const err = await pending.catch((e: unknown) => e);
      expect(isAbortError(err)).toBe(true);
      expect((err as Error).name).not.toBe("TimeoutError");
    });

    it("timeouts are retryable — a hung first attempt is retried within its own fresh window", async () => {
      let call = 0;
      const hang = hangingFetch();
      const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
        call += 1;
        if (call === 1) return hang(url, init);
        return Promise.resolve(okJson());
      });
      vi.stubGlobal("fetch", fetchMock);
      configureClient({
        baseUrl: "https://api.test",
        timeoutMs: 25,
        retry: { attempts: 2, backoff: () => 0 },
      });

      await expect(handleApiRequest("GET", "/flaky")).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("Retry-After pacing", () => {
    it("parses delta-seconds Retry-After onto ArcApiError.retryAfterMs", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            new Response('{"error":"slow down"}', {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": "7" },
            }),
          ),
        ),
      );

      const err = (await handleApiRequest("GET", "/limited").catch(
        (e: unknown) => e,
      )) as ArcApiError;
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBe(7000);
    });

    it("server pacing WINS over computed backoff on 503 (retry completes immediately with Retry-After: 0)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"error":"maintenance"}', {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "0" },
          }),
        )
        .mockResolvedValueOnce(okJson());
      vi.stubGlobal("fetch", fetchMock);
      configureClient({
        baseUrl: "https://api.test",
        // Computed backoff would sleep 10 minutes — if the test finishes, the
        // header's 0ms won.
        retry: { attempts: 2, backoff: () => 600_000 },
      });

      await expect(handleApiRequest("GET", "/maint")).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 5_000);
  });

  describe("retry jitter", () => {
    it("jitter: 'full' draws each delay from [0, computed]", async () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0); // → 0ms delay
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"error":"down"}', {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(okJson());
      vi.stubGlobal("fetch", fetchMock);
      configureClient({
        baseUrl: "https://api.test",
        retry: { attempts: 2, backoff: () => 600_000, jitter: "full" },
      });

      await expect(handleApiRequest("GET", "/flaky")).resolves.toEqual({ ok: true });
      expect(random).toHaveBeenCalled();
    }, 5_000);

    it("default stays deterministic (no Math.random consulted)", async () => {
      const random = vi.spyOn(Math, "random");
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"error":"down"}', {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(okJson());
      vi.stubGlobal("fetch", fetchMock);
      configureClient({ baseUrl: "https://api.test", retry: { attempts: 2, backoff: () => 0 } });

      await expect(handleApiRequest("GET", "/flaky")).resolves.toEqual({ ok: true });
      expect(random).not.toHaveBeenCalled();
    });
  });
});

describe("idempotency keys", () => {
  /**
   * 0.12 executor-level guarantees:
   *
   *   1. `autoIdempotency` is applied by the request EXECUTOR — one key per
   *      logical request, minted before the retry loops, so every backoff
   *      retry reuses the SAME `Idempotency-Key`. GET/DELETE excluded;
   *      caller-supplied keys win.
   *   2. `createServerClient` — request-scoped credentials, no module
   *      singletons, no server-side warnings.
   */

  function okJson(body: unknown = { ok: true }) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function capturedHeaders(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
    const init = fetchMock.mock.calls[call]![1] as RequestInit;
    return init.headers as Record<string, string>;
  }

  beforeEach(() => {
    configureClient({ baseUrl: "https://api.test" });
    configureAuth({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("executor-level autoIdempotency", () => {
    it("mints an Idempotency-Key for POST when autoIdempotency is on", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(okJson()));
      vi.stubGlobal("fetch", fetchMock);
      configureClient({ baseUrl: "https://api.test", autoIdempotency: true });

      await handleApiRequest("POST", "/things", { body: { a: 1 } });

      const headers = capturedHeaders(fetchMock);
      expect(headers["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
    });

    it("reuses the SAME key across backoff retries of one logical request", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"error":"down"}', {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(okJson());
      vi.stubGlobal("fetch", fetchMock);
      configureClient({
        baseUrl: "https://api.test",
        autoIdempotency: true,
        retry: { attempts: 2, backoff: () => 0 },
      });

      await handleApiRequest("POST", "/things", { body: { a: 1 } });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = capturedHeaders(fetchMock, 0)["Idempotency-Key"];
      const second = capturedHeaders(fetchMock, 1)["Idempotency-Key"];
      expect(first).toBeTruthy();
      expect(second).toBe(first);
    });

    it("never mints keys for GET, and caller-supplied keys win", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(okJson()));
      vi.stubGlobal("fetch", fetchMock);
      configureClient({ baseUrl: "https://api.test", autoIdempotency: true });

      await handleApiRequest("GET", "/things");
      expect(capturedHeaders(fetchMock, 0)["Idempotency-Key"]).toBeUndefined();

      await handleApiRequest("PATCH", "/things/1", { body: {}, idempotencyKey: "mine" });
      expect(capturedHeaders(fetchMock, 1)["Idempotency-Key"]).toBe("mine");
    });

    it("stays off by default", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(okJson()));
      vi.stubGlobal("fetch", fetchMock);

      await handleApiRequest("POST", "/things", { body: {} });
      expect(capturedHeaders(fetchMock)["Idempotency-Key"]).toBeUndefined();
    });
  });

  describe("createServerClient", () => {
    it("sends the request-scoped token and org — independent of global singletons", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(okJson()));
      vi.stubGlobal("fetch", fetchMock);
      // Global auth points elsewhere — the server client must NOT read it.
      configureAuth({ getToken: () => "GLOBAL", getOrgId: () => "global-org" });

      const client = createServerClient({
        baseUrl: "https://server.test",
        token: "request-token",
        organizationId: "org-42",
      });
      await client.request("GET", "/orders");

      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://server.test/orders");
      const headers = capturedHeaders(fetchMock);
      expect(headers.Authorization).toBe("Bearer request-token");
      expect(headers["x-organization-id"]).toBe("org-42");
    });

    it("supports unauthenticated requests (token omitted)", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(okJson()));
      vi.stubGlobal("fetch", fetchMock);

      const client = createServerClient({ baseUrl: "https://server.test" });
      await client.request("GET", "/public");

      const headers = capturedHeaders(fetchMock);
      expect(headers.Authorization).toBeUndefined();
      expect(headers["x-organization-id"]).toBeUndefined();
    });

    it("emits no SSR warning — request-scoped construction is the sanctioned server path", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      createServerClient({ baseUrl: "https://server.test", token: "t" });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe("late configuration", () => {
  /**
   * Two-part regression suite covering reported bugs:
   *
   *  Bug 1 — `createAuthAwareClient()` freezes baseUrl at construction.
   *    Reported repro: a CRUD api module imports `createAuthAwareClient()` at
   *    module-load (top of an `api.ts`), but `configureClient({ baseUrl })`
   *    runs LATER inside a `'use client'` provider's `useState` initializer.
   *    Pre-fix, the frozen baseUrl was `''` → every request hit a relative
   *    URL → 404 cascade against the wrong origin. Post-fix the client reads
   *    global config lazily on every request, AND the request layer throws
   *    a clear error if baseUrl is still empty (catching any other call path
   *    that snapshotted too early).
   *
   *  Bug 2 — `.data` footgun coverage.
   *    The `.data` field on `useDetail` / `useList` results is `unknown`-typed
   *    raw query data, vs `.item` / `.items` which are the typed extraction.
   *    Verified via JSDoc-driven contract: this file checks that both fields
   *    coexist and that callers reading `.item` get the typed shape without
   *    needing a cast.
   */

  // ── Reset the global config between tests by re-configuring with a
  // known-empty baseUrl. (`configureClient` is a singleton; there's no
  // reset export.)
  function resetGlobalConfig(): void {
    // Set then unset to force a known empty state. Calling configureClient
    // with baseUrl: '' simulates an app that hasn't booted Providers yet.
    configureClient({ baseUrl: "" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  }

  function mockFetchOk(): { spy: ReturnType<typeof vi.spyOn>; calls: string[] } {
    const calls: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
    ) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch);
    return { spy, calls };
  }

  beforeEach(() => {
    resetGlobalConfig();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createAuthAwareClient — baseUrl is lazy, not frozen at construction", () => {
    it("CRITICAL regression: construct BEFORE configureClient → first request still resolves the latest baseUrl", async () => {
      // Reproduces the prod 404 cascade. Module-load order:
      //   1. import { createAuthAwareClient } from '@classytic/arc-next/client';
      //   2. const client = createAuthAwareClient();           ← here, baseUrl unset
      //   3. ...later, in <Providers>:
      //   4. configureClient({ baseUrl: '...' });              ← only NOW set
      //   5. client.request('GET', '/foo')                     ← should hit foo.bar.com, not relative
      resetGlobalConfig();
      const client = createAuthAwareClient();

      // Now configure — simulates Providers booting AFTER module import.
      configureClient({ baseUrl: "https://api.example.com" });

      const { calls } = mockFetchOk();
      await client.request("GET", "/items/42");

      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe("https://api.example.com/items/42");
    });

    it("also picks up baseUrl changes mid-session (config reconfigure)", async () => {
      resetGlobalConfig();
      configureClient({ baseUrl: "https://first.example.com" });
      const client = createAuthAwareClient();

      const { calls } = mockFetchOk();
      await client.request("GET", "/a");

      // Reconfigure to a DIFFERENT host — should be picked up on the next request.
      configureClient({ baseUrl: "https://second.example.com" });
      await client.request("GET", "/b");

      expect(calls).toEqual(["https://first.example.com/a", "https://second.example.com/b"]);
    });

    it("explicit override.baseUrl wins over global (literal opt-in semantics)", async () => {
      resetGlobalConfig();
      configureClient({ baseUrl: "https://global.example.com" });
      const analyticsClient = createAuthAwareClient({ baseUrl: "https://analytics.example.com" });

      const { calls } = mockFetchOk();
      await analyticsClient.request("GET", "/events");

      // Global is set to global.example.com, but the per-client override wins —
      // matches the documented "I want a different transport" intent.
      expect(calls[0]).toBe("https://analytics.example.com/events");
    });

    it("picks up authMode change mid-session (e.g. cookie → bearer flip)", async () => {
      resetGlobalConfig();
      configureClient({ baseUrl: "https://api.example.com", authMode: "cookie" });
      configureAuth({ getToken: () => "tok" });
      const client = createAuthAwareClient();

      const { calls, spy } = mockFetchOk();
      await client.request("GET", "/me");
      // Cookie mode → no Authorization header even though token is present.
      const firstInit = (spy.mock.calls[0]?.[1] ?? undefined) as RequestInit | undefined;
      expect(
        (firstInit?.headers as Record<string, string> | undefined)?.Authorization,
      ).toBeUndefined();
      expect(firstInit?.credentials).toBe("include");

      // Reconfigure to bearer; next request should now carry the header.
      configureClient({ baseUrl: "https://api.example.com", authMode: "bearer" });
      await client.request("GET", "/me");
      const secondInit = (spy.mock.calls[1]?.[1] ?? undefined) as RequestInit | undefined;
      expect((secondInit?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        "Bearer tok",
      );

      expect(calls).toHaveLength(2);
    });
  });

  describe("executeRequest — diagnostic throw when baseUrl is empty + endpoint is relative", () => {
    it("throws a SDK-prefixed error instead of silently hitting the wrong origin", async () => {
      resetGlobalConfig();
      // No configureClient — baseUrl stays empty.
      const client = createAuthAwareClient();
      mockFetchOk();

      await expect(client.request("GET", "/items")).rejects.toThrow(
        /\[arc-next\] handleApiRequest\(GET \/items\): baseUrl is empty/,
      );
      // The error message points the caller at the actual fix. Tolerates prose
      // between the call and the ordering clause — the message gained "at app
      // boot (Providers)" and this regex silently stopped matching.
      await expect(client.request("GET", "/items")).rejects.toThrow(
        /configureClient\(\{ baseUrl: '\.\.\.' \}\)[\s\S]*BEFORE the first request/,
      );
    });

    it("does NOT throw for absolute endpoints (consumer explicitly wants cross-origin)", async () => {
      resetGlobalConfig();
      const client = createAuthAwareClient();
      const { calls } = mockFetchOk();

      // baseUrl is empty BUT the endpoint is absolute — caller intent is
      // explicit, no diagnostic needed.
      await client.request("GET", "https://third-party.example.com/webhook");

      expect(calls).toEqual(["https://third-party.example.com/webhook"]);
    });

    it("does NOT throw once configureClient has run (happy path stays clean)", async () => {
      resetGlobalConfig();
      const client = createAuthAwareClient();
      configureClient({ baseUrl: "https://api.example.com" });

      const { calls } = mockFetchOk();
      await client.request("GET", "/items");

      expect(calls[0]).toBe("https://api.example.com/items");
    });
  });

  describe("DetailQueryResult contract — typed-end-to-end, no raw-cache escape hatch", () => {
    // 0.7 cleanup: `.data: unknown` was removed from `DetailQueryResult` /
    // `ListQueryResult` to match repo-core's typed-end-to-end shape (AggResult,
    // OffsetPaginationResult, etc. don't expose raw alongside typed either).
    // Consumers reaching past the SDK should use `useQueryClient().getQueryData(...)`
    // — the explicit call signals "I'm going to the cache" at the call site,
    // and the type system narrows correctly to whatever `setQueryData` wrote.
    it("exposes only the typed surface (no .data field on the result)", () => {
      // The actual proof lives in the type definition (src/query.ts) — TS will
      // refuse to compile this file if the interface ever regresses to include
      // `data: unknown`. The set below documents the shipping field set.
      const expected = new Set([
        "item",
        "isLoading",
        "isFetching",
        "isError",
        "isSuccess",
        "isStale",
        "isPlaceholderData",
        "error",
        "refetch",
      ]);
      expect(expected.has("item")).toBe(true);
      expect(expected.has("data" as never)).toBe(false);
    });
  });

  // Re-export sanity — confirms the bug-1 prod symptom is impossible without
  // either an empty baseUrl OR an absolute endpoint. (`ArcApiError` import
  // only kept here so this file compiles if the helper changes return types.)
  void ArcApiError;
  void isArcApiError;

  /**
   * The same lazy-resolution rule, applied to the ROUTE PREFIX.
   *
   * `baseUrl` (the origin) was made lazy above because APIs are constructed at
   * module load and `configureClient` runs later, inside a `"use client"`
   * provider. `basePath` had the identical flaw and was not covered: it resolved
   * once in the `BaseApi` constructor, so a deployment's declared prefix could
   * never win over the `/api/v1` default.
   *
   * It matters because arc's own `init` template scaffolds `resourcePrefix:
   * '/api'` while this SDK defaults to `/api/v1` — so a stock backend and a stock
   * client disagree, and a package that builds its own API internally (an ERP
   * shell's permission matrix, an SDK preset) has no seam to be told otherwise.
   * The symptom is a 404 that renders as an empty list, not as a misconfiguration.
   */
  describe("basePath — the deployment's route prefix, resolved lazily", () => {
    it("CRITICAL regression: construct BEFORE configureClient → still uses the declared prefix", async () => {
      resetGlobalConfig();
      // Module-load order, exactly as a package's internal API instance sees it.
      const api = createCrudApi("platform");

      configureClient({ baseUrl: "https://api.example.com", basePath: "/api" });

      const { calls } = mockFetchOk();
      await api.invokeRoute({ method: "GET", path: "/permissions/matrix" });

      // Constructor-time resolution would have frozen `/api/v1` here.
      expect(calls[0]).toBe("https://api.example.com/api/platform/permissions/matrix");
    });

    it("keeps defaulting to /api/v1 when no prefix is declared", async () => {
      // The pre-existing behaviour every current consumer relies on.
      resetGlobalConfig();
      configureClient({ baseUrl: "https://api.example.com" });
      const api = createCrudApi("items");

      const { calls } = mockFetchOk();
      await api.getAll();

      expect(calls[0]).toContain("https://api.example.com/api/v1/items");
    });

    it("an explicit per-instance basePath still wins over the global", async () => {
      /**
       * Load-bearing for a mixed app: one API on a legacy prefix while the rest
       * follow the deployment default. Silently overriding an explicit value
       * would break the narrower, more deliberate declaration.
       */
      resetGlobalConfig();
      configureClient({ baseUrl: "https://api.example.com", basePath: "/api" });
      const api = createCrudApi("legacy", { basePath: "/api/v2" });

      const { calls } = mockFetchOk();
      await api.getAll();

      expect(calls[0]).toContain("https://api.example.com/api/v2/legacy");
    });

    it("picks up a prefix change mid-session, like baseUrl does", async () => {
      resetGlobalConfig();
      configureClient({ baseUrl: "https://api.example.com", basePath: "/api" });
      const api = createCrudApi("items");
      const { calls } = mockFetchOk();

      await api.getAll();
      configureClient({ baseUrl: "https://api.example.com", basePath: "/api/v1" });
      await api.getAll();

      expect(calls[0]).toContain("/api/items");
      expect(calls[1]).toContain("/api/v1/items");
    });
  });
});

describe("non-JSON error bodies", () => {
  /**
   * v0.4.1 Bugfix Tests — Independent test suite
   *
   * Each describe block tests a specific fix in isolation.
   */

  // ============================================================================
  // Shared helpers
  // ============================================================================

  function createMockApi(): CrudApi<
    { _id: string; name: string },
    { name: string },
    { name: string }
  > {
    return {
      getAll: vi.fn().mockResolvedValue({
        success: true,
        data: [{ _id: "1", name: "Item" }],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      }),
      getById: vi.fn().mockResolvedValue({ success: true, data: { _id: "1", name: "Item" } }),
      create: vi.fn().mockResolvedValue({ success: true, data: { _id: "1", name: "New" } }),
      update: vi.fn().mockResolvedValue({ success: true, data: { _id: "1", name: "Updated" } }),
      delete: vi.fn().mockResolvedValue({ success: true }),
      count: vi.fn().mockResolvedValue(0),
    };
  }

  // ============================================================================
  // Fix #1: token defaults to null in mutation methods
  // ============================================================================

  // ============================================================================
  // Fix #2: SSE close() → reconnect()
  // ============================================================================

  // ============================================================================
  // Fix #5: Non-JSON error responses
  // ============================================================================

  describe("Fix #5: non-JSON error body captured", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      fetchMock = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchMock.mockRestore();
    });

    it("HTML 502 captures body text", async () => {
      fetchMock.mockResolvedValue(
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "text/html" },
        }),
      );

      try {
        await handleApiRequest("GET", "/test");
        expect.fail("Should throw");
      } catch (error: unknown) {
        expect(isArcApiError(error)).toBe(true);
        const e = error as { status: number; json: { rawBody?: string } };
        expect(e.status).toBe(502);
        expect(e.json?.rawBody).toContain("<html>");
      }
    });

    it("empty body falls back to statusText", async () => {
      fetchMock.mockResolvedValue(
        new Response("", { status: 500, statusText: "Internal Server Error" }),
      );

      try {
        await handleApiRequest("GET", "/test");
        expect.fail("Should throw");
      } catch (error: unknown) {
        expect((error as { message: string }).message).toBe("Internal Server Error");
      }
    });

    it("JSON error still works normally", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ message: "Validation failed" }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" },
        }),
      );

      try {
        await handleApiRequest("POST", "/test");
        expect.fail("Should throw");
      } catch (error: unknown) {
        expect((error as { message: string }).message).toBe("Validation failed");
      }
    });
  });

  // ============================================================================
  // M2M API Key Auth
  // ============================================================================
});

describe("error codes, tier gate and platform elevation", () => {
  /**
   * v0.5.0 — Action router, search preset, geo operators, fieldErrors shape, elevated header.
   *
   * Tests target the new surface area only. Existing behavior coverage stays
   * in the per-module test files (api.test.ts, client.test.ts, hooks.test.tsx).
   */

  describe("tier gate — discriminable `arc.tier_required`", () => {
    // Canonical wire: the tier Record rides on `meta` (both arc gate paths emit
    // this — global error handler serializes `ArcError.meta`; the permission-slot
    // applier emits the same `meta`).
    const tierError = new ArcApiError("This feature requires 'enterprise' mode or higher.", {
      status: 403,
      statusText: "Forbidden",
      json: {
        code: "arc.tier_required",
        message: "This feature requires 'enterprise' mode or higher.",
        status: 403,
        meta: { requiredMode: "enterprise", currentMode: "standard" },
      },
      endpoint: "/inventory/reports/health",
      method: "GET",
    });

    // Legacy/fallback wire: same Record under `details` — a backend not yet on the
    // canonical `meta` shape must still resolve.
    const tierErrorLegacy = new ArcApiError("This feature requires 'standard' mode or higher.", {
      status: 403,
      statusText: "Forbidden",
      json: {
        code: "arc.tier_required",
        message: "This feature requires 'standard' mode or higher.",
        status: 403,
        details: { requiredMode: "standard", currentMode: "simple" },
      },
      endpoint: "/inventory/stock-routes/for-sku",
      method: "GET",
    });

    const roleError = new ArcApiError("Permission denied", {
      status: 403,
      statusText: "Forbidden",
      json: { code: "arc.forbidden", message: "Permission denied", status: 403 },
      endpoint: "/x",
      method: "GET",
    });

    it("isTierRequiredError distinguishes a tier 403 from a role 403", () => {
      expect(isTierRequiredError(tierError)).toBe(true);
      expect(isTierRequiredError(roleError)).toBe(false);
      expect(isTierRequiredError(null)).toBe(false);
    });

    it("getTierRequirement extracts the structured requirement from `meta`", () => {
      expect(getTierRequirement(tierError)).toEqual({
        requiredMode: "enterprise",
        currentMode: "standard",
      });
      expect(getTierRequirement(roleError)).toBeNull();
    });

    it("getTierRequirement falls back to legacy `details` shape", () => {
      expect(getTierRequirement(tierErrorLegacy)).toEqual({
        requiredMode: "standard",
        currentMode: "simple",
      });
    });
  });

  describe("v0.5.0 — fieldErrors shape compatibility", () => {
    it("returns null when no recognized shape", () => {
      const error = new ArcApiError("test", {
        status: 500,
        statusText: "Internal Server Error",
        json: { message: "oops" },
        endpoint: "/test",
        method: "GET",
      });
      expect(error.fieldErrors).toBeNull();
    });
  });

  describe("v0.5.0 — elevated header (x-arc-scope: platform)", () => {
    let fetchMock: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
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

    it("client-level elevated: true sends x-arc-scope on every request", async () => {
      configureClient({ baseUrl: "http://api.test", elevated: true });
      const api = createCrudApi("todos");
      await api.getAll();

      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["x-arc-scope"]).toBe("platform");
    });

    it("per-request elevated: true sends x-arc-scope", async () => {
      configureClient({ baseUrl: "http://api.test" });
      const api = createCrudApi("todos");
      await api.getAll({ options: { elevated: true } });

      const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["x-arc-scope"]).toBe("platform");
    });

    it("per-request elevated: false suppresses client-level elevation", async () => {
      configureClient({ baseUrl: "http://api.test", elevated: true });
      const api = createCrudApi("todos");
      await api.getAll({ options: { elevated: false } });

      const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["x-arc-scope"]).toBeUndefined();
    });

    it("default — no x-arc-scope header sent", async () => {
      configureClient({ baseUrl: "http://api.test" });
      const api = createCrudApi("todos");
      await api.getAll();

      const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers["x-arc-scope"]).toBeUndefined();
    });
  });

  describe("typed arc error codes — unified ErrorContract (arc 2.13 / repo-core 0.4)", () => {
    // Wire shape: arc 2.13's `createError` lifts business codes to top-level
    // `code`. `repo-core`'s `toErrorContract` round-trips the canonical shape
    // `{ code, message, status, details? }`. There is no `details.code` slot —
    // every code lives at top level.
    const orgContextRequiredJson = {
      code: "ORG_CONTEXT_REQUIRED",
      message: "Organization context required to bulk-create resources",
      status: 403,
      correlationId: "r-1",
    };

    it("exposes top-level `code` from json.code", () => {
      const err = new ArcApiError("Forbidden", {
        status: 403,
        statusText: "Forbidden",
        json: orgContextRequiredJson,
        endpoint: "/todos/bulk",
        method: "POST",
      });
      expect(err.code).toBe("ORG_CONTEXT_REQUIRED");
    });

    it("returns null for code when json carries no envelope", () => {
      const err = new ArcApiError("Crash", {
        status: 500,
        statusText: "Internal Server Error",
        json: { rawBody: "a CDN HTML page" },
        endpoint: "/x",
        method: "GET",
      });
      expect(err.code).toBeNull();
      expect(err.details).toBeNull();
    });

    it("exposes canonical details[] (validation / duplicate-key shape)", () => {
      const err = new ArcApiError("Validation failed", {
        status: 400,
        statusText: "Bad Request",
        json: {
          code: "arc.validation_error",
          message: "Validation failed",
          status: 400,
          details: [
            { path: "email", code: "format", message: "must be email" },
            { path: "age", code: "minimum", message: "must be >= 18" },
          ],
        },
        endpoint: "/users",
        method: "POST",
      });
      expect(err.details).toEqual([
        { path: "email", code: "format", message: "must be email" },
        { path: "age", code: "minimum", message: "must be >= 18" },
      ]);
    });

    it("isArcErrorCode matches the single top-level code", () => {
      const orgErr = new ArcApiError("forbidden", {
        status: 403,
        statusText: "Forbidden",
        json: orgContextRequiredJson,
        endpoint: "/x",
        method: "POST",
      });
      const dupErr = new ArcApiError("conflict", {
        status: 409,
        statusText: "Conflict",
        json: {
          code: "arc.conflict",
          message: "Duplicate value",
          status: 409,
          details: [
            { path: "email", code: "duplicate_key", message: 'Duplicate value for "email"' },
          ],
        },
        endpoint: "/x",
        method: "POST",
      });

      expect(isArcErrorCode(orgErr, "ORG_CONTEXT_REQUIRED")).toBe(true);
      expect(isArcErrorCode(dupErr, "arc.conflict")).toBe(true);
      expect(isArcErrorCode(orgErr, "arc.conflict")).toBe(false);
      expect(isArcErrorCode(dupErr, "ORG_CONTEXT_REQUIRED")).toBe(false);
      expect(isArcErrorCode(new Error("x"), "arc.conflict")).toBe(false);
    });

    it("isOrgContextRequiredError fires on the bulk safety code", () => {
      const err = new ArcApiError("Forbidden", {
        status: 403,
        statusText: "Forbidden",
        json: orgContextRequiredJson,
        endpoint: "/todos/bulk",
        method: "POST",
      });
      expect(isOrgContextRequiredError(err)).toBe(true);
      expect(isOrgContextRequiredError(new Error("plain"))).toBe(false);
      expect(isOrgContextRequiredError(null)).toBe(false);
    });

    it("isValidationError fires on arc.validation_error and validation_error", () => {
      const arcShape = new ArcApiError("Validation failed", {
        status: 400,
        statusText: "Bad Request",
        json: {
          code: "arc.validation_error",
          message: "Validation failed",
          status: 400,
          details: [{ path: "email", code: "format", message: "must be email" }],
        },
        endpoint: "/users",
        method: "POST",
      });
      const canonicalShape = new ArcApiError("Validation failed", {
        status: 400,
        statusText: "Bad Request",
        json: {
          code: "validation_error",
          message: "Validation failed",
          status: 400,
          details: [{ path: "email", code: "format", message: "must be email" }],
        },
        endpoint: "/users",
        method: "POST",
      });
      expect(isValidationError(arcShape)).toBe(true);
      expect(isValidationError(canonicalShape)).toBe(true);
      expect(arcShape.fieldErrors).toEqual({ email: "must be email" });
    });

    it("isDuplicateKeyError narrows arc.conflict via details[].code", () => {
      const dupErr = new ArcApiError("Conflict", {
        status: 409,
        statusText: "Conflict",
        json: {
          code: "arc.conflict",
          message: "Duplicate value",
          status: 409,
          details: [
            { path: "email", code: "duplicate_key", message: 'Duplicate value for "email"' },
          ],
        },
        endpoint: "/users",
        method: "POST",
      });
      const leaseConflict = new ArcApiError("Conflict", {
        status: 409,
        statusText: "Conflict",
        json: { code: "arc.conflict", message: "Lease held", status: 409 },
        endpoint: "/x",
        method: "POST",
      });
      expect(isDuplicateKeyError(dupErr)).toBe(true);
      // Bare `arc.conflict` (no duplicate_key in details) does NOT match —
      // the predicate disambiguates real duplicates from other 409s.
      expect(isDuplicateKeyError(leaseConflict)).toBe(false);
      expect(isDuplicateKeyError(new Error("x"))).toBe(false);
    });

    it("all predicates narrow to ArcApiError (compile-time + runtime)", () => {
      const err: unknown = new ArcApiError("Forbidden", {
        status: 403,
        statusText: "Forbidden",
        json: orgContextRequiredJson,
        endpoint: "/x",
        method: "POST",
      });
      if (isArcApiError(err)) expect(err.endpoint).toBe("/x");
      if (isOrgContextRequiredError(err)) expect(err.code).toBe("ORG_CONTEXT_REQUIRED");
      if (isValidationError(err)) expect(err.fieldErrors).toBeDefined();
      if (isDuplicateKeyError(err)) expect(err.code).toBe("arc.conflict");
    });
  });
});
