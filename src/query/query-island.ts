"use client";

/**
 * `@classytic/arc-next/query-island`: a React Query island that keeps `@tanstack/react-query` out
 * of a public page's first-load JS.
 *
 * The server renders the island's real content (from `prefetchQueries` / `streamQueries` state)
 * into the HTML. In the browser the island's Suspense boundary is held DEHYDRATED (server HTML
 * kept as is, no React Query loaded) until `when` fires; then the island's chunk (React Query,
 * the provider, `HydrationBoundary` and your component) downloads and hydrates in place. On a
 * client-side navigation (no server HTML) it loads at once, showing `fallback` meanwhile.
 *
 * This module imports React only; `import type` keeps the TanStack types erased.
 *
 * @example
 * // course-list.island.ts ("use client"): the dynamic import is the code-split point
 * export const CourseListIsland = createQueryIsland(() => import("./course-list"));
 *
 * // app/courses/page.tsx (Server Component)
 * const state = await prefetchQueries([courses.list({ limit: 20 }, { auth: "omit" })]);
 * return <CourseListIsland state={state} props={{ limit: 20 }} when="visible" />;
 */

import type { DehydratedState } from "@tanstack/react-query";
import {
  type ComponentType,
  createElement,
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  use,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * When a server-rendered island hydrates:
 * - `"idle"` (default): the browser's first idle period (`requestIdleCallback`, 2 s timeout).
 * - `"visible"`: when any of its elements scrolls into view.
 * - `"interaction"`: on the first pointer, touch or focus inside it. React drops a click that
 *   lands before the chunk has hydrated (native defaults such as links still work), so prefer
 *   `"visible"` for content whose first click must count.
 */
export type QueryIslandTrigger = "idle" | "visible" | "interaction";

type IslandState = DehydratedState | null | undefined;

export type QueryIslandProps<P extends object> = {
  /** `prefetchQueries` / `streamQueries` output from the Server Component. */
  state: IslandState;
  /** Default `"idle"`. Read on mount. */
  when?: QueryIslandTrigger;
  /** Shown while the chunk loads on a client-side render (never over server HTML). */
  fallback?: ReactNode;
} & (Partial<P> extends P ? { props?: P } : { props: P });

export type QueryIsland<P extends object> = (props: QueryIslandProps<P>) => ReactElement;

interface Gate {
  promise: Promise<void>;
  /** Idempotent. */
  open: () => void;
}

/** The island's activation: born open on the server, closed in the browser. */
function createGate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = () => {
      // React's thenable protocol: a fulfilled `status` lets `use()` read it without suspending.
      Object.assign(promise, { status: "fulfilled", value: undefined });
      resolve();
    };
  });
  if (typeof window === "undefined") open();
  return { promise, open };
}

const subscribeNothing = () => () => {};

/**
 * Holds a HYDRATING boundary until the gate opens: a Suspense boundary that suspends during
 * hydration stays dehydrated, so React keeps the server HTML untouched and neither renders nor
 * downloads what is below. `useSyncExternalStore` reads its server snapshot (`true`) only on the
 * server and while hydrating; on a client-side render (a navigation, or React client-rendering
 * the boundary after a parent update) there is no server HTML to keep, so the gate opens at once.
 * `use()` runs on every render either way (React requires it once it has suspended).
 */
function GateHold({ gate }: { gate: Gate }): null {
  const hydrating = useSyncExternalStore(
    subscribeNothing,
    () => false,
    () => true,
  );
  if (!hydrating) gate.open();
  use(gate.promise);
  return null;
}

function watch(el: HTMLElement, when: QueryIslandTrigger, activate: () => void): () => void {
  if (when === "visible" && typeof IntersectionObserver === "function") {
    // The wrapper is `display: contents` (no box), so observe its rendered children.
    const targets = Array.from(el.children);
    if (targets.length > 0) {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) activate();
      });
      for (const t of targets) io.observe(t);
      return () => io.disconnect();
    }
  }
  if (when === "interaction") {
    // Capture on the document: React's own root listeners stop events that target a dehydrated
    // boundary, so a listener on the island itself would never hear them.
    const events = ["pointerover", "pointerdown", "touchstart", "focusin"] as const;
    const onEvent = (e: Event) => {
      if (e.target instanceof Node && el.contains(e.target)) activate();
    };
    for (const e of events) document.addEventListener(e, onEvent, { capture: true, passive: true });
    return () => {
      for (const e of events) document.removeEventListener(e, onEvent, { capture: true });
    };
  }
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(activate, { timeout: 2000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(activate, 1);
  return () => clearTimeout(id);
}

/**
 * Build an island from a component that uses arc-next / React Query hooks. Call it at module
 * scope in a `"use client"` file and pass a dynamic `import()`: that import is what keeps the
 * component and React Query out of the first-load JS.
 */
export function createQueryIsland<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): QueryIsland<P> {
  const Content = lazy(async () => {
    const [{ QueryIslandRoot }, { default: Component }] = await Promise.all([
      import("./query-island-root.js"),
      load(),
    ]);
    function IslandContent({ state, props }: { state: IslandState; props: P }) {
      return createElement(QueryIslandRoot, { state }, createElement(Component, props));
    }
    return { default: IslandContent };
  });

  return function QueryIslandBoundary(islandProps: QueryIslandProps<P>) {
    const { state, when = "idle", fallback = null } = islandProps;
    const props = (islandProps.props ?? {}) as P;
    const [gate] = useState(createGate);
    const wrapper = useRef<HTMLDivElement>(null);
    const trigger = useRef(when);

    useEffect(() => {
      const el = wrapper.current;
      if (!el) return;
      return watch(el, trigger.current, gate.open);
    }, [gate]);

    return createElement(
      "div",
      { ref: wrapper, "data-query-island": "", style: { display: "contents" } },
      createElement(
        Suspense,
        { fallback },
        createElement(GateHold, { gate }),
        createElement(Content, { state, props }),
      ),
    );
  };
}
