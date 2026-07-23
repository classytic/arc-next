/**
 * v0.5.0 — Action router, search preset, geo operators, fieldErrors shape, elevated header.
 *
 * Tests target the new surface area only. Existing behavior coverage stays
 * in the per-module test files (api.test.ts, client.test.ts, hooks.test.tsx).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseApi, createCrudApi } from "../src/api.js";
import {
  ArcApiError,
  configureClient,
  isArcApiError,
  isArcErrorCode,
  isDuplicateKeyError,
  isOrgContextRequiredError,
  isValidationError,
} from "../src/client.js";
import { withSearchPreset } from "../src/presets/search.js";

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
    expect(result.success).toBe(true);
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
    await expect(
      // @ts-expect-error — empty id should throw
      api.dispatchAction({ id: "", action: "complete" }),
    ).rejects.toThrow("ID is required");
  });

  it("throws on missing action name", async () => {
    const api = createCrudApi("todos");
    await expect(
      // @ts-expect-error — empty action should throw
      api.dispatchAction({ id: "t1", action: "" }),
    ).rejects.toThrow("Action name is required");
  });
});

describe("v0.5.0 — search preset", () => {
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

  it("searchEngine POSTs to /search with body { query }", async () => {
    const api = withSearchPreset(createCrudApi("products"));
    await api.searchEngine({ query: "azure laptop" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/v1/products/search");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ query: "azure laptop" });
  });

  it("searchEngine merges body fields alongside query", async () => {
    const api = withSearchPreset(createCrudApi("products"));
    await api.searchEngine({ query: "tee", body: { topK: 25, filter: { inStock: true } } });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ topK: 25, filter: { inStock: true }, query: "tee" });
  });

  it("searchEngine respects custom path override", async () => {
    const api = withSearchPreset(createCrudApi("products"));
    await api.searchEngine({ query: "q", path: "/abc/search" });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe("http://api.test/api/v1/products/abc/search");
  });

  it("searchSimilar POSTs to /search-similar with vector", async () => {
    const api = withSearchPreset(createCrudApi("products"));
    await api.searchSimilar({ vector: [0.1, 0.2, 0.3], body: { topK: 5 } });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/v1/products/search-similar");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      topK: 5,
      vector: [0.1, 0.2, 0.3],
    });
  });

  it("embed POSTs to /embed with input", async () => {
    const api = withSearchPreset(createCrudApi("products"));
    await api.embed({ input: "hello world" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/v1/products/embed");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ input: "hello world" });
  });

  it("embed accepts array input", async () => {
    const api = withSearchPreset(createCrudApi("products"));
    await api.embed({ input: ["a", "b", "c"], body: { model: "text-embedding-3-small" } });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      input: ["a", "b", "c"],
      model: "text-embedding-3-small",
    });
  });
});

describe("v0.5.0 — fieldErrors shape compatibility", () => {
  it("reads legacy `errors` record shape", () => {
    const error = new ArcApiError("test", {
      status: 422,
      statusText: "Unprocessable Entity",
      json: { errors: { email: "invalid", name: "required" } },
      endpoint: "/test",
      method: "POST",
    });
    expect(error.fieldErrors).toEqual({ email: "invalid", name: "required" });
  });

  it("reads arc's `details.errors[]` array shape (Fastify AJV pass-through)", () => {
    const error = new ArcApiError("Validation failed", {
      status: 400,
      statusText: "Bad Request",
      json: {
        success: false,
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: {
          errors: [
            { field: "email", message: "must match format 'email'", keyword: "format" },
            { field: "priority", message: "must be number", keyword: "type" },
          ],
        },
      },
      endpoint: "/users",
      method: "POST",
    });
    expect(error.fieldErrors).toEqual({
      email: "must match format 'email'",
      priority: "must be number",
    });
  });

  it("reads raw AJV instancePath shape", () => {
    const error = new ArcApiError("Validation failed", {
      status: 400,
      statusText: "Bad Request",
      json: {
        details: {
          errors: [
            { instancePath: "/email", message: "must be string", keyword: "type" },
            {
              instancePath: "",
              message: "must have required property 'name'",
              params: { missingProperty: "name" },
            },
          ],
        },
      },
      endpoint: "/users",
      method: "POST",
    });
    const fe = error.fieldErrors;
    expect(fe?.email).toBe("must be string");
    // missingProperty falls through when instancePath is empty
    expect(fe?.name).toBe("must have required property 'name'");
  });

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

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-arc-scope"]).toBe("platform");
  });

  it("per-request elevated: false suppresses client-level elevation", async () => {
    configureClient({ baseUrl: "http://api.test", elevated: true });
    const api = createCrudApi("todos");
    await api.getAll({ options: { elevated: false } });

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-arc-scope"]).toBeUndefined();
  });

  it("default — no x-arc-scope header sent", async () => {
    configureClient({ baseUrl: "http://api.test" });
    const api = createCrudApi("todos");
    await api.getAll();

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
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
        details: [{ path: "email", code: "duplicate_key", message: 'Duplicate value for "email"' }],
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
        details: [{ path: "email", code: "duplicate_key", message: 'Duplicate value for "email"' }],
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
