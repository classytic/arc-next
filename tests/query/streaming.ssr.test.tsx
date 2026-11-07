/**
 * Streaming SSR end to end, the way a Next Server Component uses it:
 *
 *   server: streamQueries([courses.list(...)])  -> dehydrated state with a PENDING query + promise
 *   client: <HydrationBoundary state>  +  useSuspenseList  -> suspends on the streamed promise
 *   render: react-dom/static prerenderToNodeStream waits for Suspense and emits the rows
 *
 * The api talks to the contract-true fake arc server (repo-core envelopes), not hand-written JSON.
 */

import { HydrationBoundary, QueryClientProvider } from "@tanstack/react-query";
import React, { Suspense } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import { createClient } from "../../src/client/client.js";
import { createCrudHooks } from "../../src/query/hooks.js";
import { prefetchQueries, streamQueries } from "../../src/query/prefetch.js";
import { makeQueryClient } from "../../src/query/query-client.js";
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
  function CourseList() {
    const { items } = hooks.useSuspenseList({ limit: 20 });
    return React.createElement(
      "ul",
      null,
      items.map((c) => React.createElement("li", { key: c._id }, c.title)),
    );
  }
  return { arc, hooks, CourseList };
}

const page = (state: unknown, CourseList: () => React.ReactElement) => {
  const browser = makeQueryClient();
  return React.createElement(
    QueryClientProvider,
    { client: browser },
    React.createElement(
      HydrationBoundary,
      { state: state as never },
      React.createElement(Suspense, { fallback: "loading" }, React.createElement(CourseList)),
    ),
  );
};

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("streaming SSR", () => {
  it("streams a pending query; the client renders it without fetching again", async () => {
    const { arc, hooks, CourseList } = setup();
    const state = streamQueries([hooks.queries.list({ limit: 20 })]);
    expect(state.queries[0]?.state.status).toBe("pending");

    const out = await prerenderHtml(page(state, CourseList));
    expect(out).toContain("<li>Algebra</li>");
    expect(out).toContain("<li>Optics</li>");
    // One request: the server's. The hydrated promise answered the client.
    expect(arc.requests).toHaveLength(1);
    // Anonymous (readAuth: "omit"), so arc's http-cache may keep it at the CDN.
    expect(arc.requests[0]?.headers.authorization).toBeUndefined();
    expect(arc.requests[0]?.credentials).toBe("omit");
  });

  it("prefetchQueries ships complete data (no pending promise in the state)", async () => {
    const { hooks, CourseList } = setup();
    const state = await prefetchQueries([hooks.queries.list({ limit: 20 })]);
    expect(state.queries[0]?.state.status).toBe("success");
    expect(await prerenderHtml(page(state, CourseList))).toContain("<li>Optics</li>");
  });
});
