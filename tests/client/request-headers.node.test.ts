/**
 * Request headers against a REAL HTTP server (node:http, ephemeral port): what arc receives.
 *
 * One case-insensitive merge, in three layers (later wins):
 *   1. client defaults: `defaultHeaders`, the internal key, `Accept-Version`, a JSON `Content-Type`,
 *      and the configured token / tenant (`getToken` / `getOrgId`), injected only when no header
 *      below already names them;
 *   2. per-call headers: the api instance's `headers`, then the call's `headerOptions` / `ctx.headers`;
 *   3. explicit per-call options: `organizationId`, `token`, `idempotencyKey`, `elevated`.
 * A header name differing only in case never produces two values, and the tenant a cache key is
 * built for is the one the server receives.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hashKey, QueryClient } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import { configureAuth, configureClient, createClient } from "../../src/client/client.js";
import {
  createEntityQueries,
  type EntityQueries,
  type QueryFnContext,
} from "../../src/query/query-options.js";

type Seen = { raw: string[] };
let server: Server;
let baseUrl = "";
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    seen.push({ raw: req.rawHeaders });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        method: "offset",
        data: [],
        page: 1,
        limit: 10,
        total: 0,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  seen.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  configureClient({ baseUrl });
  configureAuth({ getToken: () => null, getOrgId: () => null });
});
afterEach(() => {
  configureAuth({ getToken: () => null, getOrgId: () => null });
  vi.restoreAllMocks();
});

/** Every received value of one header (any casing), exactly as it arrived on the wire. */
const received = (name: string) => {
  const raw = seen[seen.length - 1]?.raw ?? [];
  const values: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === name) values.push(raw[i + 1]!);
  }
  return values;
};

const CASINGS = ["x-organization-id", "X-Organization-Id", "X-ORGANIZATION-ID"];

/** Fetch through the factory and return the tenant its key was built for. */
async function readThrough(queries: EntityQueries, ctx: QueryFnContext = {}) {
  const options = queries.list({}, ctx);
  await new QueryClient().fetchQuery(options);
  return (options.queryKey[2] as { organizationId: string | null }).organizationId;
}

describe("request headers: one case-insensitive merge, the key names what the wire carries", () => {
  for (const casing of CASINGS) {
    it(`a forwarded ${casing} is sent once and keyed as the tenant`, async () => {
      const queries = createEntityQueries(createCrudApi("rows", { basePath: "/api" }), "rows");
      const keyed = await readThrough(queries, { headers: { [casing]: "tenant-A" } });
      expect(received("x-organization-id")).toEqual(["tenant-A"]);
      expect(keyed).toBe("tenant-A");
    });

    it(`a forwarded ${casing} beats the configured tenant (a default), once`, async () => {
      configureAuth({ getToken: () => null, getOrgId: () => "tenant-Z" });
      const queries = createEntityQueries(createCrudApi("rows", { basePath: "/api" }), "rows");
      const keyed = await readThrough(queries, { headers: { [casing]: "tenant-A" } });
      expect(received("x-organization-id")).toEqual(["tenant-A"]);
      expect(keyed).toBe("tenant-A");
    });

    it(`an explicit organizationId beats a ${casing} header, once`, async () => {
      const queries = createEntityQueries(createCrudApi("rows", { basePath: "/api" }), "rows");
      const keyed = await readThrough(queries, {
        organizationId: "tenant-B",
        headers: { [casing]: "tenant-A" },
      });
      expect(received("x-organization-id")).toEqual(["tenant-B"]);
      expect(keyed).toBe("tenant-B");
    });

    it(`a client default ${casing} header is sent once, under a per-call one`, async () => {
      const client = createClient({
        baseUrl,
        defaultHeaders: { [casing]: "tenant-D" },
        getOrgId: () => "tenant-Z",
      });
      const api = createCrudApi("rows", { basePath: "/api", client });
      const queries = createEntityQueries(api, "rows");
      expect(await readThrough(queries)).toBe("tenant-D");
      expect(received("x-organization-id")).toEqual(["tenant-D"]);

      expect(await readThrough(queries, { headers: { "X-Organization-Id": "tenant-C" } })).toBe(
        "tenant-C",
      );
      expect(received("x-organization-id")).toEqual(["tenant-C"]);
    });

    it(`instance headers (${casing}) sit under the call's headers, once`, async () => {
      const api = createCrudApi("rows", { basePath: "/api", headers: { [casing]: "tenant-I" } });
      const queries = createEntityQueries(api, "rows");
      expect(await readThrough(queries)).toBe("tenant-I");
      expect(received("x-organization-id")).toEqual(["tenant-I"]);
      expect(await readThrough(queries, { headers: { "x-organization-id": "tenant-C" } })).toBe(
        "tenant-C",
      );
      expect(received("x-organization-id")).toEqual(["tenant-C"]);
    });
  }

  it("a per-call Authorization header in any casing is sent once, over the configured token", async () => {
    configureAuth({ getToken: () => "configured", getOrgId: () => null });
    const api = createCrudApi("rows", { basePath: "/api" });
    await api.getAll({ options: { headerOptions: { authorization: "Bearer forwarded" } } });
    expect(received("authorization")).toEqual(["Bearer forwarded"]);
    await api.getAll({
      token: "explicit",
      options: { headerOptions: { AUTHORIZATION: "Bearer x" } },
    });
    expect(received("authorization")).toEqual(["Bearer explicit"]);
  });

  it("hook-style and factory reads of the same tenant share one key", async () => {
    configureAuth({ getToken: () => null, getOrgId: () => "tenant-A" });
    const queries = createEntityQueries(createCrudApi("rows", { basePath: "/api" }), "rows");
    const viaHeader = queries.list({}, { headers: { "X-Organization-Id": "tenant-A" } }).queryKey;
    const viaOption = queries.list({}, { organizationId: "tenant-A" }).queryKey;
    const viaDefault = queries.list({}).queryKey;
    expect(new Set([hashKey(viaHeader), hashKey(viaOption), hashKey(viaDefault)]).size).toBe(1);
  });
});
