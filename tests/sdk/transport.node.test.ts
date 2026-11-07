import { describe, expect, it } from "vitest";
import { BaseApi } from "../../src/client/api.js";
import {
  errorCode,
  errorStatus,
  isNetworkFailure,
  mapError,
  SdkRequestError,
} from "../../src/sdk/errors.js";
import { localized, localizedName } from "../../src/sdk/localized.js";
import { defineSdkResource, invalidateRoots, keyRoot } from "../../src/sdk/resource.js";
import { compact, enc, fetchAllPages, PageLimitError } from "../../src/sdk/route.js";
import {
  bareCollectionPath,
  createIsolatedClient,
  DEFAULT_API_BASE_PATH,
  requireGlobalTransport,
  resolveTransport,
} from "../../src/sdk/transport.js";

function fakeFetch(respond: (url: string, init: RequestInit) => unknown, status = 200) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  const fn = (async (input: string, init: RequestInit) => {
    calls.push({ url: input, method: String(init.method), headers: new Headers(init.headers) });
    return Response.json(respond(input, init), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("trailing-slash normalization", () => {
  it("strips the slash arc-next adds for a route call with path '/'", () => {
    expect(bareCollectionPath("http://api.test/api/things/?limit=5")).toBe(
      "http://api.test/api/things?limit=5",
    );
    expect(bareCollectionPath("http://api.test/api/things/")).toBe("http://api.test/api/things");
    expect(bareCollectionPath("http://api.test/api/things//#top")).toBe(
      "http://api.test/api/things#top",
    );
    expect(bareCollectionPath("http://api.test/api/things")).toBe("http://api.test/api/things");
    expect(bareCollectionPath("http://api.test/api/things/mine?x=1")).toBe(
      "http://api.test/api/things/mine?x=1",
    );
    expect(bareCollectionPath("http://api.test")).toBe("http://api.test");
  });

  it("an isolated client sends a collection route bare, an item route unchanged", async () => {
    const { fn, calls } = fakeFetch(() => ({ data: [] }));
    const { client, transport } = createIsolatedClient({
      baseUrl: "http://api.test/",
      basePath: "/api",
      getToken: () => "tok",
      fetch: fn,
    });
    const api = new BaseApi("things", { client, basePath: transport.basePath });
    await api.invokeRoute({ path: "/", params: { limit: 5 } });
    await api.invokeRoute({ path: "/mine" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://api.test/api/things?limit=5",
      "http://api.test/api/things/mine",
    ]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("bareCollectionPaths: false leaves the url as arc-next built it", async () => {
    const { fn, calls } = fakeFetch(() => ({}));
    const { client, transport } = createIsolatedClient({
      baseUrl: "http://api.test",
      getToken: () => null,
      fetch: fn,
      bareCollectionPaths: false,
    });
    expect(transport.basePath).toBe(DEFAULT_API_BASE_PATH);
    await new BaseApi("things", { client, basePath: transport.basePath }).invokeRoute({
      path: "/",
    });
    expect(calls[0]?.url).toBe("http://api.test/api/v1/things/");
  });

  it("resolveTransport trims the origin and keeps the raw fetch for downloads", () => {
    const { fn } = fakeFetch(() => ({}));
    const t = resolveTransport({ baseUrl: "http://api.test//", getToken: () => null, fetch: fn });
    expect(t.baseUrl).toBe("http://api.test");
    expect(t.fetch).toBe(fn);
    expect(t.apiFetch).not.toBe(fn);
  });

  it("requireGlobalTransport is exported and explains how to fix a missing init", () => {
    expect(typeof requireGlobalTransport).toBe("function");
  });
});

describe("error mapping", () => {
  it("exposes the server code, status and field errors through a real isolated client; a 409 is not a network failure", async () => {
    const { fn } = fakeFetch(
      () => ({
        code: "role.in_use",
        message: "Role is in use",
        details: [{ path: "roles.0", code: "x", message: "in use" }],
      }),
      409,
    );
    const { client } = createIsolatedClient({
      baseUrl: "http://api.test",
      getToken: () => "t",
      fetch: fn,
    });
    const error = await new BaseApi("roles", { client })
      .delete({ id: "r1" })
      .catch((e: unknown) => e);
    expect(errorCode(error)).toBe("role.in_use");
    expect(errorStatus(error)).toBe(409);
    expect(isNetworkFailure(error)).toBe(false);
    expect(mapError(error)).toMatchObject({ code: "role.in_use", status: 409, network: false });
  });

  it("SdkRequestError, plain objects and TypeErrors", () => {
    const error = new SdkRequestError("Network error", "network", 0);
    expect(mapError(error)).toEqual({ code: "network", status: 0, network: true, fields: null });
    expect(errorCode({ json: { code: "a.b" } })).toBe("a.b");
    expect(errorCode({ code: "c.d" })).toBe("c.d");
    expect(errorCode(new Error("x"))).toBeUndefined();
    expect(isNetworkFailure(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("resource definitions and keys", () => {
  it("the key root is the route path with / as -, one root per route", () => {
    const r = defineSdkResource<{ _id: string }>({
      path: "catalog/items",
      singular: "Item",
      plural: "Items",
      permission: "items",
    });
    expect(r.keyRoot).toEqual(["catalog-items"]);
    expect(r.hooksConfig.entityKey).toBe("catalog-items");
    expect(r.hooksConfig.idField).toBe("_id");
    expect(keyRoot("catalog/items")).toEqual(["catalog-items"]);
    expect(keyRoot("stations")).toEqual(["stations"]);
  });

  it("registers CRUD message keys unless routes-only, and explicit defaults win", () => {
    const crud = defineSdkResource({
      path: "r1",
      singular: "Thing",
      plural: "Things",
      permission: null,
      defaults: { messages: { createSuccess: "Custom!" } },
    });
    const messages = crud.hooksConfig.defaults?.messages as Record<string, string>;
    expect(messages.createSuccess).toBe("Custom!");
    expect(messages.deleteError).toContain("crud.r1.delete.error");
    const routes = defineSdkResource({
      path: "r2",
      singular: "Thing",
      plural: "Things",
      permission: null,
      routesOnly: true,
    });
    expect(routes.hooksConfig.defaults?.messages).toBeUndefined();
  });

  it("bind() rebuilds the same route against an isolated client", async () => {
    const { fn, calls } = fakeFetch(() => ({ _id: "1" }));
    const { client, transport } = createIsolatedClient({
      baseUrl: "http://api.test",
      basePath: "/api",
      getToken: () => "t",
      fetch: fn,
    });
    const r = defineSdkResource({ path: "r3/x", singular: "T", plural: "Ts", permission: null });
    await r.bind(client, transport.basePath).getById({ id: "1" });
    expect(calls[0]?.url).toBe("http://api.test/api/r3/x/1");
  });

  it("invalidateRoots invalidates every root", async () => {
    const seen: unknown[] = [];
    await invalidateRoots(
      {
        invalidateQueries: async (f: { queryKey: unknown }) => void seen.push(f.queryKey),
      } as never,
      [["a"], ["b-c"]],
    );
    expect(seen).toEqual([["a"], ["b-c"]]);
  });
});

describe("route helpers", () => {
  it("compact drops unset values; enc encodes", () => {
    expect(compact({ a: 1, b: "", c: undefined, d: null, e: false, f: "x", g: {} })).toEqual({
      a: 1,
      e: false,
      f: "x",
    });
    expect(enc("a/b c")).toBe("a%2Fb%20c");
  });

  it("fetchAllPages walks pages, and throws instead of truncating", async () => {
    const pages = [
      { data: [1, 2], hasNext: true },
      { data: [3], hasNext: false },
    ];
    expect(await fetchAllPages(async (p) => pages[p - 1] ?? { data: [], hasNext: false })).toEqual([
      1, 2, 3,
    ]);
    expect(await fetchAllPages(async (p) => ({ data: p === 1 ? [1, 2] : [3], total: 3 }))).toEqual([
      1, 2, 3,
    ]);
    await expect(
      fetchAllPages(async () => ({ data: [1], hasNext: true }), { maxPages: 3 }),
    ).rejects.toMatchObject({
      kind: "too-many",
    });
    await expect(fetchAllPages(async () => ({ data: [], hasNext: true }))).rejects.toBeInstanceOf(
      PageLimitError,
    );
  });
});

describe("localized", () => {
  it("localized falls back to English", () => {
    expect(localized({ en: "Hi", ar: "x" }, "ar")).toBe("x");
    expect(localized({ en: "Hi" }, "ar")).toBe("Hi");
    expect(localized(undefined, "en")).toBe("");
  });

  it("localizedName prefers the Arabic sibling, then English, never throws", () => {
    expect(localizedName({ title: "Boss", titleAr: " X " }, "ar")).toBe("X");
    expect(localizedName({ title: "Boss", titleAr: " " }, "ar")).toBe("Boss");
    expect(localizedName({ name: "Ops", nameAr: "Y" }, "en")).toBe("Ops");
    expect(localizedName({ label: { en: "L", ar: "Z" } }, "ar")).toBe("Z");
    expect(localizedName({ labelAr: "Q" }, "ar")).toBe("Q");
    expect(localizedName(null, "ar")).toBe("");
    expect(localizedName({}, "en")).toBe("");
  });
});
