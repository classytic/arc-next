/**
 * `useCursorPager` (resource hook and standalone) and `keepPrevious` on lists: one page at a time
 * over a keyset list, against the contract-true fake arc server.
 */

import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import { configureAuth, configureClient } from "../../src/client/client.js";
import { createCrudHooks } from "../../src/query/hooks.js";
import { createFakeArc } from "../harness/fake-arc.js";
import { renderWithClient } from "../harness/query-client.js";

type Row = { _id: string; n: number };
const rows = Array.from({ length: 7 }, (_, i) => ({ _id: `r${i + 1}`, n: i + 1 }));

let fake: ReturnType<typeof createFakeArc>;
const makeHooks = () =>
  createCrudHooks<Row>({
    api: createCrudApi<Row>("rows", { basePath: "/api" }),
    entityKey: "rows",
    singular: "Row",
    defaults: { defaultPublic: true },
  });

beforeEach(() => {
  fake = createFakeArc({ resources: { rows }, keyset: ["rows"] });
  configureClient({ baseUrl: "http://api.test", fetch: fake.fetch });
});
afterEach(() => configureAuth({ getToken: () => null, getOrgId: () => null }));

const ids = (items: Row[]) => items.map((r) => r._id);
const listCalls = () => fake.requests.filter((r) => r.method === "GET");

describe("useCursorPager (resource hook)", () => {
  it("shows one page at a time; Next fetches once, Previous is instant", async () => {
    const hooks = makeHooks();
    const { result } = renderWithClient(() => hooks.useCursorPager({ limit: 3 }));
    await waitFor(() => expect(ids(result.current.items)).toEqual(["r1", "r2", "r3"]));
    expect(result.current).toMatchObject({ page: 1, hasPrev: false, hasNext: true });

    act(() => result.current.next());
    await waitFor(() => expect(ids(result.current.items)).toEqual(["r4", "r5", "r6"]));
    expect(listCalls()).toHaveLength(2);
    expect(listCalls()[1]!.url.searchParams.get("after")).toBe("3");

    act(() => result.current.next());
    await waitFor(() => expect(ids(result.current.items)).toEqual(["r7"]));
    expect(result.current).toMatchObject({ page: 3, hasNext: false, hasPrev: true });

    act(() => result.current.prev());
    expect(ids(result.current.items)).toEqual(["r4", "r5", "r6"]);
    act(() => result.current.goTo(1));
    expect(ids(result.current.items)).toEqual(["r1", "r2", "r3"]);
    expect(listCalls()).toHaveLength(3); // going back never fetched
  });

  it("new params start again at page 1, keeping the old page visible until the new one lands", async () => {
    const hooks = makeHooks();
    const { result, rerender } = renderWithClient(
      ({ status }: { status: string }) => hooks.useCursorPager({ limit: 3, status }),
      { initialProps: { status: "a" } },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.page).toBe(2));

    rerender({ status: "b" });
    expect(result.current.page).toBe(1);
    expect(result.current.items).toHaveLength(3); // previous list, not an empty table
    expect(result.current.isPlaceholderData).toBe(true);
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(listCalls().at(-1)!.url.searchParams.get("status")).toBe("b");
  });

  it("goTo ignores pages beyond the next one and below 1", async () => {
    const hooks = makeHooks();
    const { result } = renderWithClient(() => hooks.useCursorPager({ limit: 3 }));
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    act(() => result.current.goTo(5));
    act(() => result.current.goTo(0));
    expect(result.current.page).toBe(1);
    expect(listCalls()).toHaveLength(1);
  });
});

describe("keepPrevious on lists", () => {
  it("useList keeps the previous rows by default, and not with keepPrevious: false", async () => {
    const hooks = makeHooks();
    const keep = renderWithClient(({ s }: { s: string }) => hooks.useList({ limit: 2, s }), {
      initialProps: { s: "a" },
    });
    await waitFor(() => expect(keep.result.current.items).toHaveLength(2));
    keep.rerender({ s: "b" });
    expect(keep.result.current.items).toHaveLength(2);
    expect(keep.result.current.isPlaceholderData).toBe(true);

    const drop = renderWithClient(
      ({ s }: { s: string }) => hooks.useList({ limit: 2, s }, { keepPrevious: false }),
      { initialProps: { s: "c" } },
    );
    await waitFor(() => expect(drop.result.current.items).toHaveLength(2));
    drop.rerender({ s: "d" });
    expect(drop.result.current.items).toEqual([]);
    expect(drop.result.current.isPlaceholderData).toBe(false);
  });

  it("useInfiniteList keeps the previous pages only with keepPrevious: true", async () => {
    const hooks = makeHooks();
    const keep = renderWithClient(
      ({ s }: { s: string }) => hooks.useInfiniteList({ limit: 2, s }, { keepPrevious: true }),
      { initialProps: { s: "a" } },
    );
    await waitFor(() => expect(keep.result.current.items).toHaveLength(2));
    keep.rerender({ s: "b" });
    expect(keep.result.current.items).toHaveLength(2);
    expect(keep.result.current.isPlaceholderData).toBe(true);

    const drop = renderWithClient(
      ({ s }: { s: string }) => hooks.useInfiniteList({ limit: 2, s }),
      { initialProps: { s: "c" } },
    );
    await waitFor(() => expect(drop.result.current.items).toHaveLength(2));
    drop.rerender({ s: "d" });
    expect(drop.result.current.items).toEqual([]);
  });
});
