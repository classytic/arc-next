/**
 * The server-cache seams: change events after every write (with the document as it was before a
 * delete), the shared query-enable rule for hand-written queries, `initialData` from a Server
 * Component, and the one tag naming both ends of a server cache use.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authGate, queryAuthEnabled } from "../src/auth-gate.js";
import { arcTag } from "../src/cache.js";
import { configureAuth, configureClient } from "../src/client.js";
import { type ArcChangeEvent, onArcChange } from "../src/events.js";
import type { CrudApi } from "../src/hooks.js";
import { createCrudHooks } from "../src/hooks.js";
import { configureToast } from "../src/mutation.js";

type Lesson = { _id: string; title: string; courseId: string };

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  configureToast({ success: vi.fn(), error: vi.fn() });
  configureClient({ baseUrl: "http://api.test" });
  configureAuth({ getToken: () => "t" });
});
afterEach(() => queryClient.clear());

function setup(overrides: Partial<Record<keyof CrudApi<Lesson>, unknown>> = {}) {
  const api = {
    getAll: vi.fn(async () => ({ data: [{ _id: "9", title: "fetched", courseId: "c1" }] })),
    getById: vi.fn(),
    create: vi.fn(async () => ({ _id: "n1", title: "new", courseId: "c1" })),
    update: vi.fn(async ({ id }: { id: string }) => ({ _id: id, title: "after", courseId: "c1" })),
    delete: vi.fn(async ({ id }: { id: string }) => ({ message: "Deleted successfully", id })),
    count: vi.fn(),
    ...overrides,
  } as unknown as CrudApi<Lesson>;
  const entityKey = `lessons-${crypto.randomUUID()}`;
  const hooks = createCrudHooks<Lesson>({ api, entityKey, singular: "Lesson" });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { api, hooks, entityKey, wrapper };
}

describe("onArcChange", () => {
  it("reports create, update and delete; a delete carries the document it removed", async () => {
    const { hooks, entityKey, wrapper } = setup();
    const events: ArcChangeEvent[] = [];
    const off = onArcChange((e) => {
      if (e.entity === entityKey) events.push(e);
    });
    // the dashboard had the lesson in a list: the delete response will carry only its id
    queryClient.setQueryData(hooks.KEYS.list({}), {
      data: [{ _id: "1", title: "before", courseId: "c7" }],
    });
    const { result } = renderHook(() => hooks.useActions(), { wrapper });

    await act(() => result.current.create({ data: { title: "new" } }));
    await act(() => result.current.update({ id: "1", data: { title: "after" } }));
    await act(() => result.current.remove({ id: "1" }));
    off();

    expect(events.map((e) => [e.op, e.id])).toEqual([
      ["create", "n1"],
      ["update", "1"],
      ["delete", "1"],
    ]);
    expect(events[1]!.previous).toMatchObject({ title: "before" });
    // read before the optimistic update dropped it from the list: the parent survives the delete
    expect(events[2]!.item).toBeNull();
    expect(events[2]!.previous).toMatchObject({ courseId: "c1" });
  });

  it("a failed write emits nothing, and a failing listener never fails the write", async () => {
    const { hooks, entityKey, wrapper } = setup({
      delete: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const listener = vi.fn((e: ArcChangeEvent) => {
      if (e.entity === entityKey) throw new Error("listener broke");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const off = onArcChange(listener);
    const { result } = renderHook(() => hooks.useActions(), { wrapper });

    await expect(act(() => result.current.remove({ id: "1" }))).rejects.toThrow("boom");
    expect(listener).not.toHaveBeenCalled();

    await act(() => result.current.update({ id: "1", data: { title: "x" } }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    off();
    error.mockRestore();
  });
});

describe("queryAuthEnabled / authGate", () => {
  it("bearer auth needs a token; public endpoints and static auth do not", () => {
    expect(authGate(null, {}, "bearer", false)).toBe(false);
    expect(authGate("t", {}, "bearer", false)).toBe(true);
    expect(authGate(null, { public: true }, "bearer", false)).toBe(true);
    expect(authGate(null, {}, "cookie", false)).toBe(true);
    expect(authGate(null, {}, "bearer", true)).toBe(true);
    expect(authGate("t", { enabled: false }, "bearer", false)).toBe(false);
  });

  it("a per-user endpoint needs the user's token even with static auth; cookie auth carries the user", () => {
    expect(authGate(null, { user: true }, "bearer", true)).toBe(false);
    expect(authGate("t", { user: true }, "bearer", true)).toBe(true);
    expect(authGate("t", { user: true, enabled: false }, "bearer", true)).toBe(false);
    expect(authGate(null, { user: true }, "cookie", false)).toBe(true);
  });

  it("reads the configured token, so a signed-out visitor's per-user query never fires", () => {
    configureAuth({ getToken: () => null });
    expect(queryAuthEnabled({ enabled: true })).toBe(false);
    configureAuth({ getToken: () => "t" });
    expect(queryAuthEnabled({ enabled: true })).toBe(true);
    expect(queryAuthEnabled({ enabled: false })).toBe(false);
  });
});

describe("initialData from a Server Component", () => {
  it("seeds the list without a fetch while it is fresh", async () => {
    const { api, hooks, wrapper } = setup();
    const server = { data: [{ _id: "s1", title: "from the server", courseId: "c1" }] };
    const { result } = renderHook(
      () => hooks.useList({}, { initialData: server, staleTime: 60_000 }),
      { wrapper },
    );
    expect(result.current.items).toEqual(server.data);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getAll).not.toHaveBeenCalled();
  });

  it("refetches when initialData is older than staleTime", async () => {
    const { api, hooks, wrapper } = setup();
    renderHook(
      () =>
        hooks.useList(
          {},
          {
            initialData: { data: [] },
            initialDataUpdatedAt: Date.now() - 120_000,
            staleTime: 60_000,
          },
        ),
      { wrapper },
    );
    await waitFor(() => expect(api.getAll).toHaveBeenCalledTimes(1));
  });
});

describe("arcTag", () => {
  it("names a resource, a record and a scoped collection the same way at both ends", () => {
    expect(arcTag("lessons")).toBe("arc:lessons");
    expect(arcTag("lessons", "42")).toBe("arc:lessons:42");
    expect(arcTag("lessons", undefined, { by: "course", id: "c1" })).toBe("arc:lessons@course:c1");
  });
});
