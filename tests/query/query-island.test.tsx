/**
 * Query islands, browser half: over server HTML the island stays DEHYDRATED (HTML kept, its chunk
 * not even requested) until `when` fires, then hydrates in place from the server state without a
 * mismatch or a refetch. A client-side render (no server HTML) loads at once behind `fallback`.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import React, { act, useState } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import { createClient } from "../../src/client/client.js";
import { createCrudHooks } from "../../src/query/hooks.js";
import { prefetchQueries } from "../../src/query/prefetch.js";
import { makeQueryClient } from "../../src/query/query-client.js";
import { createQueryIsland, type QueryIslandTrigger } from "../../src/query/query-island.js";
import { createFakeArc } from "../harness/fake-arc.js";
import { prerenderHtml } from "../harness/prerender.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Course {
  _id: string;
  title: string;
}

function setup() {
  const arc = createFakeArc({ resources: { courses: [{ _id: "c1", title: "Algebra" }] } });
  const client = createClient({ baseUrl: "http://api.test", fetch: arc.fetch });
  const api = createCrudApi<Course>("courses", { basePath: "/api", readAuth: "omit", client });
  const hooks = createCrudHooks<Course>({ api, entityKey: "courses", singular: "Course" });
  function CourseList() {
    const { items } = hooks.useSuspenseList({ limit: 20 });
    const [likes, setLikes] = useState(0);
    return React.createElement(
      "section",
      null,
      React.createElement("p", null, items.map((c) => c.title).join(",")),
      React.createElement(
        "button",
        { type: "button", onClick: () => setLikes(likes + 1) },
        `likes ${likes}`,
      ),
    );
  }
  const load = vi.fn(async () => ({ default: CourseList }));
  return {
    arc,
    hooks,
    load,
    Island: createQueryIsland(load),
    serverIsland: createQueryIsland(async () => ({ default: CourseList })),
  };
}

/** What the server sends: rendered without `window` and with a per-request client. */
async function serverHtml(el: React.ReactElement): Promise<string> {
  vi.stubGlobal("window", undefined);
  try {
    const tree = React.createElement(QueryClientProvider, { client: makeQueryClient() }, el);
    return await prerenderHtml(tree);
  } finally {
    vi.unstubAllGlobals();
  }
}

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function hydrateIsland(when: QueryIslandTrigger) {
  const ctx = setup();
  const state = await prefetchQueries([ctx.hooks.queries.list({ limit: 20 })]);
  // The server and the browser each have their own module instance (and lazy cache): build the
  // server's island separately so `load` counts browser chunk requests only.
  const html = await serverHtml(React.createElement(ctx.serverIsland, { state, when }));
  const el = React.createElement(ctx.Island, { state, when });

  container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const onRecoverableError = vi.fn();
  await act(async () => {
    root = hydrateRoot(container as HTMLElement, el, { onRecoverableError });
  });
  return { ...ctx, onRecoverableError, html };
}

const button = () => container?.querySelector("button") as HTMLButtonElement;

describe("createQueryIsland (hydration)", () => {
  it("keeps the server HTML and does not load the chunk until the trigger fires", async () => {
    const { load, onRecoverableError, arc } = await hydrateIsland("interaction");

    expect(container?.textContent).toContain("Algebra");
    expect(load).not.toHaveBeenCalled();
    // Not hydrated: React ignores the click (the island's handlers are not attached yet).
    await act(async () => button().click());
    expect(button().textContent).toBe("likes 0");

    await act(async () => {
      button().dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => button().click());
    expect(button().textContent).toBe("likes 1");
    expect(container?.textContent).toContain("Algebra");
    expect(onRecoverableError).not.toHaveBeenCalled();
    // Only the server's request: the client hydrated the prefetched state.
    expect(arc.requests).toHaveLength(1);
  });

  it('"idle" hydrates on its own after the first idle period', async () => {
    const { load, onRecoverableError } = await hydrateIsland("idle");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => button().click());
    expect(button().textContent).toBe("likes 1");
    expect(onRecoverableError).not.toHaveBeenCalled();
  });

  it("a parent update before activation loads it at once instead of blanking the HTML", async () => {
    const { Island, hooks, load, onRecoverableError } = await hydrateIsland("interaction");
    const state = await prefetchQueries([hooks.queries.list({ limit: 20 })]);
    await act(async () => {
      root?.render(React.createElement(Island, { state, when: "interaction" }));
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("Algebra");
    await act(async () => button().click());
    expect(button().textContent).toBe("likes 1");
    expect(onRecoverableError).not.toHaveBeenCalled();
  });

  it("a client-side render loads at once and shows the fallback meanwhile", async () => {
    const { hooks, Island, load } = setup();
    const state = await prefetchQueries([hooks.queries.list({ limit: 20 })]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const inner = load.getMockImplementation();
    load.mockImplementation(async () => {
      await held;
      return (inner as NonNullable<typeof inner>)();
    });

    await act(async () => {
      root?.render(
        React.createElement(Island, { state, when: "interaction", fallback: "loading" }),
      );
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("loading");

    await act(async () => release());
    expect(container.textContent).toContain("Algebra");
  });
});
