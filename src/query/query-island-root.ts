"use client";

// The React Query half of a query island (`./query-island`). Internal: only `createQueryIsland`
// reaches this module, through a dynamic import, so `@tanstack/react-query` lands in the island's
// async chunk instead of the page's first-load JS.

import {
  type DehydratedState,
  HydrationBoundary,
  QueryClientContext,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createElement, type ReactNode, useContext, useState } from "react";
import { getQueryClient } from "./query-client.js";

interface QueryIslandRootProps {
  state: DehydratedState | null | undefined;
  children?: ReactNode;
}

/**
 * Hydrates `state` into the nearest QueryClient. With no provider above (the point of an island),
 * it provides `getQueryClient()`: a fresh client per server render, the shared browser singleton
 * on the client, so every island on a page reads one cache.
 */
export function QueryIslandRoot({ state, children }: QueryIslandRootProps) {
  const outer = useContext(QueryClientContext);
  const [own] = useState(() => (outer ? undefined : getQueryClient()));
  const boundary = createElement(HydrationBoundary, { state }, children);
  return own ? createElement(QueryClientProvider, { client: own }, boundary) : boundary;
}
