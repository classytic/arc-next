/**
 * Server Component prefetch: `streamQueries` (no await, pending queries dehydrated with their
 * promises) and `prefetchQueries` (awaited). Both use a fresh per-request QueryClient and the
 * same option factories the hooks use, so the client hydrates without refetching.
 */

import { hydrate, QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { prefetchQueries, streamQueries } from "../../src/query/prefetch.js";
import { getQueryClient, makeQueryClient } from "../../src/query/query-client.js";
import { createEntityQueries, type EntityApi } from "../../src/query/query-options.js";

const page = { method: "offset", data: [{ _id: "p1" }], page: 1, hasNext: false, total: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("streamQueries", () => {
  it("dehydrates a PENDING query with its promise, without awaiting it", async () => {
    const gate = deferred<unknown>();
    const getAll = vi.fn(() => gate.promise);
    const products = createEntityQueries({ getAll, getById: vi.fn() } as EntityApi, "products");

    const state = streamQueries([products.list({ limit: 20 }, { auth: "omit" })]);
    expect(getAll).toHaveBeenCalledTimes(1);
    expect((getAll.mock.calls[0] as unknown[])[0]).toMatchObject({
      params: { limit: 20 },
      token: undefined,
      organizationId: undefined,
      options: expect.objectContaining({ auth: "omit" }),
    });
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]!.state.status).toBe("pending");
    expect(state.queries[0]!.queryKey).toEqual(
      products.list({ limit: 20 }, { auth: "omit" }).queryKey,
    );

    // The client hydrates the pending query and receives the data when the server promise settles.
    const client = new QueryClient();
    hydrate(client, state);
    gate.resolve(page);
    await vi.waitFor(() =>
      expect(client.getQueryData(products.list({ limit: 20 }, { auth: "omit" }).queryKey)).toEqual(
        page,
      ),
    );
  });

  it("starts infinite queries with the infinite shape", async () => {
    const getAll = vi.fn(async () => page);
    const products = createEntityQueries({ getAll, getById: vi.fn() } as EntityApi, "products");
    const qc = makeQueryClient();
    streamQueries([products.infiniteList({ limit: 5 })], { queryClient: qc });
    await vi.waitFor(() =>
      expect(qc.getQueryData(products.infiniteList({ limit: 5 }).queryKey)).toEqual({
        pages: [page],
        pageParams: [1],
      }),
    );
  });
});

describe("prefetchQueries", () => {
  it("awaits every query; a failure is left out instead of failing the page", async () => {
    const api: EntityApi = {
      getAll: vi.fn(async () => page),
      getById: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const products = createEntityQueries(api, "products");
    const state = await prefetchQueries([
      products.list({}, { token: "t", organizationId: "o" }),
      products.detail("missing"),
    ]);
    const success = state.queries.filter((q) => q.state.status === "success");
    expect(success).toHaveLength(1);
    expect(success[0]!.queryKey).toEqual(products.list({}, { organizationId: "o" }).queryKey);
    expect(api.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ token: "t", organizationId: "o" }),
    );
  });

  it("forwards Next caching to the api call (ISR-eligible prefetch)", async () => {
    const getAll = vi.fn(async () => page);
    const products = createEntityQueries({ getAll, getById: vi.fn() } as EntityApi, "products");
    await prefetchQueries([
      products.list({}, { next: { revalidate: 60, tags: ["arc:products"] } }),
    ]);
    expect((getAll.mock.calls[0] as unknown[])[0]).toMatchObject({
      options: expect.objectContaining({ next: { revalidate: 60, tags: ["arc:products"] } }),
    });
  });
});

describe("per-request clients", () => {
  it("makeQueryClient is fresh every call and keeps pending queries dehydratable", () => {
    const a = makeQueryClient();
    expect(a).not.toBe(makeQueryClient());
    expect(a.getDefaultOptions().queries?.networkMode).toBe("offlineFirst");
    expect(a.getDefaultOptions().dehydrate?.shouldRedactErrors?.(new Error("x"))).toBe(false);
  });

  it("getQueryClient on the server is a new client per call (never shared between requests)", () => {
    expect(getQueryClient()).not.toBe(getQueryClient());
  });
});
