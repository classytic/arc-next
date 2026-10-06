/**
 * Optimistic concurrency — `versionField` → `If-Match`, against arc's contract:
 * GET/PATCH answer `ETag: "<version>"`, an update carrying a stale `If-Match`
 * is refused `412 arc.precondition_failed`, and no `If-Match` means no
 * client precondition.
 *
 * The version must be the one the EDIT was based on, not whatever the cache
 * holds at submit time — a background refetch would otherwise let a stale
 * form silently overwrite the change it missed. Hence the resolution order:
 * explicit `version` → `data[versionField]` → cached document.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../src/api.js";
import { ArcApiError, configureClient, isPreconditionFailed } from "../src/client.js";
import type { CrudApi } from "../src/hooks.js";
import { createCrudHooks } from "../src/hooks.js";
import { configureToast } from "../src/mutation.js";

type Doc = { _id: string; name: string; __v: number };

describe("BaseApi — If-Match", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: "http://api.test" });
    fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ _id: "1", name: "x", __v: 4 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  afterEach(() => fetchMock.mockRestore());

  const headersOf = () =>
    (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;

  it('sends If-Match: "<version>" — the ETag form arc compares', async () => {
    const api = createCrudApi<Doc>("items", { basePath: "/api", headers: { "x-keep": "yes" } });
    await api.update({ id: "1", data: { name: "x" }, version: 3 });
    expect(headersOf()["If-Match"]).toBe('"3"');
    expect(headersOf()["x-keep"]).toBe("yes");
  });

  it("sends no precondition without a version (or with null)", async () => {
    const api = createCrudApi<Doc>("items", { basePath: "/api" });
    await api.update({ id: "1", data: { name: "x" }, version: null });
    expect(headersOf()["If-Match"]).toBeUndefined();
  });

  it("versionOf reads the configured field, numbers only", () => {
    const api = createCrudApi<Doc>("items", { versionField: "__v" });
    expect(api.versionOf({ __v: 7 })).toBe(7);
    expect(api.versionOf({ __v: "7" })).toBeUndefined();
    expect(createCrudApi("items").versionOf({ __v: 7 })).toBeUndefined();
  });
});

describe("useActions().update — which version is sent", () => {
  let queryClient: QueryClient;
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    configureToast({ success: vi.fn(), error: vi.fn() });
  });
  afterEach(() => queryClient.clear());

  function setup(
    update = vi.fn(async ({ id }: { id: string }) => ({ _id: id, name: "n", __v: 9 })),
  ) {
    const api = {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      update,
      versionOf: (doc: unknown) => {
        const v = (doc as { __v?: unknown } | null | undefined)?.__v;
        return typeof v === "number" ? v : undefined;
      },
    } as unknown as CrudApi<Doc>;
    const hooks = createCrudHooks<Doc>({
      api,
      entityKey: `cc-${crypto.randomUUID()}`,
      singular: "Doc",
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => hooks.useActions(), { wrapper });
    return { hooks, update, actions: () => result.current };
  }

  const sentVersion = (update: ReturnType<typeof vi.fn>, call = 0) =>
    (update.mock.calls[call]![0] as { version?: number }).version;

  it("an explicit version wins over the cache", async () => {
    const { hooks, update, actions } = setup();
    queryClient.setQueryData(hooks.KEYS.detail("1"), { _id: "1", name: "a", __v: 5 });
    await act(() => actions().update({ id: "1", data: { name: "b" }, version: 3 }));
    expect(sentVersion(update)).toBe(3);
  });

  it("data[versionField] is the snapshot the form edited — preferred over a refetched cache", async () => {
    const { hooks, update, actions } = setup();
    // The cache was refetched to v5 while the user edited a form loaded at v3.
    queryClient.setQueryData(hooks.KEYS.detail("1"), { _id: "1", name: "theirs", __v: 5 });
    await act(() => actions().update({ id: "1", data: { name: "mine", __v: 3 } as Partial<Doc> }));
    expect(sentVersion(update)).toBe(3); // → 412, not a silent overwrite
  });

  it("falls back to the cached detail, then to a list row", async () => {
    const { hooks, update, actions } = setup();
    queryClient.setQueryData(hooks.KEYS.detail("1"), { _id: "1", name: "a", __v: 5 });
    await act(() => actions().update({ id: "1", data: { name: "b" } }));
    expect(sentVersion(update)).toBe(5);

    queryClient.setQueryData(hooks.KEYS.list({}), { data: [{ _id: "2", name: "r", __v: 11 }] });
    await act(() => actions().update({ id: "2", data: { name: "b" } }));
    expect(sentVersion(update, 1)).toBe(11);
  });

  it("version: null sends no precondition — the 'save anyway' path", async () => {
    const { hooks, update, actions } = setup();
    queryClient.setQueryData(hooks.KEYS.detail("1"), { _id: "1", name: "a", __v: 5 });
    await act(() => actions().update({ id: "1", data: { name: "b" }, version: null }));
    expect(sentVersion(update)).toBeUndefined();
  });

  it("a second queued update to the same record uses the version the first one returned", async () => {
    let v = 5;
    const update = vi.fn(async ({ id }: { id: string }) => ({ _id: id, name: "n", __v: ++v }));
    const { hooks, actions } = setup(update);
    queryClient.setQueryData(hooks.KEYS.detail("1"), { _id: "1", name: "a", __v: 5 });
    await act(async () => {
      await Promise.all([
        actions().update({ id: "1", data: { name: "b" } }),
        actions().update({ id: "1", data: { name: "c" } }),
      ]);
    });
    expect(sentVersion(update, 0)).toBe(5);
    expect(sentVersion(update, 1)).toBe(6); // not 5 — that would 412 against our own write
  });

  it("a 412 surfaces as isPreconditionFailed and rolls the optimistic edit back", async () => {
    const stale = new ArcApiError("changed", {
      status: 412,
      statusText: "Precondition Failed",
      json: { code: "arc.precondition_failed", message: "changed", status: 412 },
      endpoint: "/api/v1/items/1",
      method: "PATCH",
    });
    const { hooks, actions } = setup(vi.fn().mockRejectedValue(stale));
    const before = { _id: "1", name: "theirs", __v: 5 };
    queryClient.setQueryData(hooks.KEYS.detail("1"), before);

    let caught: unknown;
    await act(async () => {
      await actions()
        .update({ id: "1", data: { name: "mine" }, version: 3 })
        .catch((e: unknown) => {
          caught = e;
        });
    });
    expect(isPreconditionFailed(caught)).toBe(true);
    expect(queryClient.getQueryData(hooks.KEYS.detail("1"))).toEqual(before);
  });
});
