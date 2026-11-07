/**
 * Query islands, server half: a Server Component's `prefetchQueries` / `streamQueries` state
 * passed to a `createQueryIsland` island server-renders the REAL content (rows in the HTML), with
 * no QueryClientProvider anywhere above it, and without fetching twice.
 *
 * Bundle half: the island entry module loads without `@tanstack/react-query`; only its lazily
 * imported root reaches React Query. The browser half (held dehydrated until `when`) is in
 * query-island.test.tsx.
 */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import { createClient } from "../../src/client/client.js";
import { createCrudHooks } from "../../src/query/hooks.js";
import { prefetchQueries, streamQueries } from "../../src/query/prefetch.js";
import { createQueryIsland } from "../../src/query/query-island.js";
import { createFakeArc } from "../harness/fake-arc.js";
import { prerenderHtml } from "../harness/prerender.js";

interface Course {
  _id: string;
  title: string;
}

function setup() {
  const arc = createFakeArc({
    resources: {
      courses: [
        { _id: "c1", title: "Algebra" },
        { _id: "c2", title: "Optics" },
      ],
    },
  });
  const client = createClient({ baseUrl: "http://api.test", fetch: arc.fetch });
  const api = createCrudApi<Course>("courses", { basePath: "/api", readAuth: "omit", client });
  const hooks = createCrudHooks<Course>({ api, entityKey: "courses", singular: "Course" });
  function CourseList({ limit }: { limit: number }) {
    const { items } = hooks.useSuspenseList({ limit });
    return React.createElement(
      "ul",
      null,
      items.map((c) => React.createElement("li", { key: c._id }, c.title)),
    );
  }
  const load = vi.fn(async () => ({ default: CourseList }));
  const Island = createQueryIsland(load);
  return { arc, hooks, Island, load };
}

describe("createQueryIsland (server render)", () => {
  it("renders the content from awaited prefetchQueries state, no provider above", async () => {
    const { arc, hooks, Island, load } = setup();
    const state = await prefetchQueries([hooks.queries.list({ limit: 20 })]);

    const out = await prerenderHtml(
      React.createElement(Island, { state, props: { limit: 20 }, fallback: "loading" }),
    );
    expect(out).toContain("<li>Algebra</li>");
    expect(out).toContain("<li>Optics</li>");
    expect(out).toContain('data-query-island=""');
    expect(out).not.toContain("loading");
    expect(load).toHaveBeenCalledTimes(1);
    expect(arc.requests).toHaveLength(1);
  });

  it("renders streamed (pending) streamQueries state once it resolves, without refetching", async () => {
    const { arc, hooks, Island } = setup();
    const state = streamQueries([hooks.queries.list({ limit: 20 })]);
    expect(state.queries[0]?.state.status).toBe("pending");

    const out = await prerenderHtml(React.createElement(Island, { state, props: { limit: 20 } }));
    expect(out).toContain("<li>Optics</li>");
    expect(arc.requests).toHaveLength(1);
  });
});

describe("createQueryIsland (module graph)", () => {
  afterEach(() => {
    vi.doUnmock("@tanstack/react-query");
    vi.resetModules();
  });

  it("the island entry loads without @tanstack/react-query; only its lazy root needs it", async () => {
    vi.resetModules();
    vi.doMock("@tanstack/react-query", () => {
      throw new Error("@tanstack/react-query was loaded");
    });

    const island = await import("../../src/query/query-island.js");
    expect(typeof island.createQueryIsland).toBe("function");
    // Control: the mock is live, so the lazily imported root does fail to load.
    await expect(import("../../src/query/query-island-root.js")).rejects.toThrow();
  });
});
