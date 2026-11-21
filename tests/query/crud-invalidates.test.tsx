import type { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CrudApi, createCrudHooks } from "../../src/query/hooks.js";
import { configureToast } from "../../src/query/mutation.js";
import { createTestQueryClient, createWrapper } from "../harness/query-client.js";

/**
 * `defaults.invalidates`: reads a host keeps under the resource's key root with its own shape (a
 * date-range view, a per-station count) are not in the change rule's set (lists, counts,
 * aggregations, details), so a create / update / delete left them stale. The resource names them
 * once and every write refreshes them too.
 */

interface Doc {
  _id: string;
  name: string;
}

const silentToast = { success: () => {}, error: () => {} };

function mockApi(): CrudApi<Doc> {
  return {
    getAll: vi.fn().mockResolvedValue({
      method: "offset",
      data: [],
      total: 0,
      page: 1,
      pages: 1,
      hasNext: false,
    }),
    getById: vi.fn().mockResolvedValue({ _id: "1", name: "A" }),
    create: vi.fn().mockResolvedValue({ _id: "2", name: "B" }),
    update: vi.fn().mockResolvedValue({ _id: "1", name: "A2" }),
    delete: vi.fn().mockResolvedValue({ message: "Deleted", id: "1" }),
  } as unknown as CrudApi<Doc>;
}

describe("defaults.invalidates", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
    configureToast(silentToast);
  });

  afterEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("create, update and remove also invalidate the declared keys (prefix match)", async () => {
    const entityKey = `inv-${crypto.randomUUID()}`;
    const hooks = createCrudHooks<Doc>({
      api: mockApi(),
      entityKey,
      singular: "Doc",
      defaults: { invalidates: [[entityKey, "range"]] },
    });
    const rangeKey = [entityKey, "range", { from: "2026-11-01" }];
    queryClient.setQueryData(rangeKey, { items: [] });
    const { result } = renderHook(() => hooks.useActions(), {
      wrapper: createWrapper(queryClient),
    });

    for (const write of [
      () => result.current.create({ data: { name: "B" } }),
      () => result.current.update({ id: "1", data: { name: "A2" } }),
      () => result.current.remove({ id: "1" }),
    ]) {
      queryClient.setQueryData(rangeKey, { items: [] });
      expect(queryClient.getQueryState(rangeKey)?.isInvalidated).toBe(false);
      await act(async () => {
        await write();
      });
      await waitFor(() => expect(queryClient.getQueryState(rangeKey)?.isInvalidated).toBe(true));
    }
  });

  it("without it, a host key under the root is left alone (the change rule stays narrow)", async () => {
    const entityKey = `inv-${crypto.randomUUID()}`;
    const hooks = createCrudHooks<Doc>({ api: mockApi(), entityKey, singular: "Doc" });
    const rangeKey = [entityKey, "range", { from: "2026-11-01" }];
    queryClient.setQueryData(rangeKey, { items: [] });
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => hooks.useActions(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.create({ data: { name: "B" } });
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: hooks.KEYS.lists() }));
    expect(queryClient.getQueryState(rangeKey)?.isInvalidated).toBe(false);
  });
});
