// Server Component prefetch + streaming, in one call.
//
// Server-safe (no "use client"). The option factories (`createEntityQueries`, or `hooks.queries`
// from `createCrudHooks`) are the single source of keys, so what the server seeds is exactly what
// the client hook reads.
//
//   // app/courses/page.tsx (Server Component)
//   import { HydrationBoundary, streamQueries } from "@classytic/arc-next/prefetch";
//   export default function Page() {
//     return (
//       <HydrationBoundary state={streamQueries([courses.list({ limit: 20 }, { auth: "omit" })])}>
//         <Suspense fallback={<Shelf />}><CourseList /></Suspense>   // useSuspenseList(...)
//       </HydrationBoundary>
//     );
//   }

import {
  type DehydratedState,
  dehydrate,
  type InfiniteData,
  noop,
  type QueryClient,
  type QueryFunction,
  type QueryKey,
} from "@tanstack/react-query";
import { makeQueryClient } from "./query-client.js";

// `HydrationBoundary` is the client wrapper that consumes the state; re-exported so an RSC file
// needs one import.
export { dehydrate, HydrationBoundary } from "@tanstack/react-query";
export type { DehydratedState, InfiniteData };

/** Anything `queryOptions` / `infiniteQueryOptions` (or the arc factories) return. */
export interface PrefetchableQuery {
  queryKey: QueryKey;
  // biome-ignore lint/suspicious/noExplicitAny: accepts every factory's typed query function
  queryFn?: QueryFunction<any, any, any> | unknown;
  staleTime?: unknown;
  initialPageParam?: unknown;
  getNextPageParam?: unknown;
}

export interface PrefetchStateOptions {
  /** Seed this client instead of a fresh per-request one (e.g. to read data back afterwards). */
  queryClient?: QueryClient;
}

const isInfinite = (q: PrefetchableQuery) =>
  q.getNextPageParam !== undefined && q.initialPageParam !== undefined;

/** Start every query on `client` without awaiting. Failures are left for the client to retry. */
function start(client: QueryClient, queries: readonly PrefetchableQuery[]): Promise<unknown>[] {
  return queries.map((q) =>
    (isInfinite(q)
      ? client.infiniteQuery(q as Parameters<QueryClient["infiniteQuery"]>[0])
      : client.query(q as Parameters<QueryClient["query"]>[0])
    ).catch(noop),
  );
}

/**
 * STREAM: start the queries and dehydrate at once, pending ones included (their promises travel
 * to the client). The Server Component renders without waiting; a client `useSuspense*` hook with
 * the same key suspends on the streamed promise, so the content still server-renders as it
 * resolves. With a plain `useQuery` the data arrives on the client instead.
 *
 * Uses a NEW per-request QueryClient unless one is passed: never the browser singleton.
 */
export function streamQueries(
  queries: readonly PrefetchableQuery[],
  options: PrefetchStateOptions = {},
): DehydratedState {
  const client = options.queryClient ?? makeQueryClient();
  start(client, queries);
  return dehydrate(client);
}

/**
 * AWAIT: run the queries to completion, then dehydrate. For pages that must ship complete HTML
 * (SEO-critical content, no Suspense boundary). A failed query is simply not in the state; the
 * client hook fetches it.
 */
export async function prefetchQueries(
  queries: readonly PrefetchableQuery[],
  options: PrefetchStateOptions = {},
): Promise<DehydratedState> {
  const client = options.queryClient ?? makeQueryClient();
  await Promise.all(start(client, queries));
  return dehydrate(client);
}
