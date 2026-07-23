import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { createEntityQueries, type EntityReadApi, type QueryFnContext } from "./query-options.js";

// Re-exports for convenience in Server Components.
// `HydrationBoundary` is the canonical wrapper around the Client Component
// child that consumes the prefetched cache — re-exporting saves callers a
// second @tanstack/react-query import in their RSC files.
export { dehydrate, HydrationBoundary } from "@tanstack/react-query";

// ============================================================================
// Types
// ============================================================================

export interface PrefetchAuthContext {
  /** Auth token for protected endpoints. Required for bearer/header auth on server. */
  token?: string | null;
  /** Organization ID for multi-tenant prefetch. Sent as x-organization-id header. */
  organizationId?: string | null;
  /** Additional headers (e.g., x-api-key for header auth). */
  headers?: Record<string, string>;
}

export interface PrefetchOptions extends PrefetchAuthContext {
  staleTime?: number;
  /**
   * Next.js fetch caching forwarded to the underlying API call. A Server
   * Component that prefetches with `revalidate` lets that data participate in
   * ISR — without it the SDK's default `no-store` pins the whole route to
   * dynamic rendering (e.g. a shared layout prefetch silently disables ISR on
   * every page under it). Inert off-Next (React Native / plain browser fetch).
   */
  cache?: RequestCache;
  revalidate?: number | false;
  tags?: string[];
}

export interface PrefetchDetailOptions extends PrefetchOptions {
  /** Query params (select, populate) — key must match useDetail's params to share cache */
  params?: { select?: string; populate?: string | string[] };
}

export interface CrudPrefetcher {
  /**
   * Prefetch a list query on the server. Uses the same query keys as useList.
   *
   * @example
   * const queryClient = getQueryClient();
   * await productsPrefetcher.prefetchList(queryClient, { limit: 20 });
   */
  prefetchList: (
    queryClient: QueryClient,
    params?: Record<string, unknown>,
    options?: PrefetchOptions,
  ) => Promise<void>;

  /**
   * Prefetch a detail query on the server. Uses the same query keys as useDetail
   * (tenant-scoped when `organizationId` is provided).
   */
  prefetchDetail: (
    queryClient: QueryClient,
    id: string,
    options?: PrefetchDetailOptions,
  ) => Promise<void>;

  /**
   * Prefetch a detail-by-slug query. Uses the same query keys as useDetailBySlug.
   * Only available when the API has a `getBySlug` method (slugLookup preset).
   */
  prefetchBySlug: (
    queryClient: QueryClient,
    slug: string,
    options?: PrefetchDetailOptions,
  ) => Promise<void>;

  /**
   * Prefetch soft-deleted items. Uses the same query keys as useDeleted.
   * Only available when the API has a `getDeleted` method (softDelete preset).
   */
  prefetchDeleted: (
    queryClient: QueryClient,
    params?: Record<string, unknown>,
    options?: PrefetchOptions,
  ) => Promise<void>;

  /**
   * Prefetch a tree query. Uses the same query keys as useTree.
   * Only available when the API has a `getTree` method (tree preset).
   */
  prefetchTree: (
    queryClient: QueryClient,
    params?: Record<string, unknown>,
    options?: PrefetchOptions,
  ) => Promise<void>;

  /**
   * Prefetch a declared aggregation (arc 2.13+). Uses the same query key as
   * `useAggregation` so RSC-pre-rendered dashboard rows hydrate without a
   * client refetch.
   *
   * @example
   * await ordersPrefetcher.prefetchAggregation(
   *   queryClient,
   *   'salesByDay',
   *   { from: '2025-01-01', to: '2025-12-31' },
   *   { token: jwt, organizationId: orgId, staleTime: 60_000 },
   * );
   */
  prefetchAggregation: (
    queryClient: QueryClient,
    name: string,
    filter?: Record<string, unknown>,
    options?: PrefetchOptions,
  ) => Promise<void>;

  /**
   * Prefetch an infinite list query (cursor / page-based pagination). Uses the
   * same query keys as `useInfiniteList` and seeds the `{ pages, pageParams }`
   * shape TanStack Query expects for `useInfiniteQuery` — a flat
   * `prefetchQuery` would NOT match the cache shape and the client hook would
   * re-fetch from scratch, defeating the prefetch.
   *
   * @example
   * await productsPrefetcher.prefetchInfiniteList(queryClient, { limit: 20 });
   */
  prefetchInfiniteList: (
    queryClient: QueryClient,
    params?: Record<string, unknown>,
    options?: PrefetchOptions,
  ) => Promise<void>;
}

// ============================================================================
// Factory
// ============================================================================

/** Extract the queryFn context (auth + fetch caching) from prefetch options. */
function toCtx(options: PrefetchOptions): QueryFnContext {
  const { staleTime: _staleTime, ...ctx } = options;
  return ctx;
}

/**
 * Create server-safe prefetch helpers for CRUD queries.
 * Use in Next.js server components to pre-populate the query cache before rendering.
 *
 * Since 0.10 this is a thin layer over `createEntityQueries`
 * (@classytic/arc-next/query-options) — the queryOptions factories are the
 * single source of key + queryFn, shared with the client CRUD hooks, so
 * prefetch keys can never drift from hook keys. Prefer the factories directly
 * for new code that also needs `ensureQueryData` / router-loader integration:
 *
 *   const products = createEntityQueries(productApi, 'products');
 *   await queryClient.prefetchQuery({ ...products.list({ limit: 20 }, { token }), staleTime: 60_000 });
 *
 * @example
 * // products-prefetch.ts
 * import { productsApi } from '@/api/products-api';
 * import { createCrudPrefetcher } from '@classytic/arc-next/prefetch';
 * export const productsPrefetcher = createCrudPrefetcher(productsApi, 'products');
 *
 * // app/products/page.tsx (server component)
 * import { getQueryClient } from '@classytic/arc-next/query-client';
 * import { dehydrate } from '@classytic/arc-next/prefetch';
 * import { HydrationBoundary } from '@tanstack/react-query';
 *
 * export default async function ProductsPage() {
 *   const queryClient = getQueryClient();
 *   await productsPrefetcher.prefetchList(queryClient, { limit: 20 });
 *   return (
 *     <HydrationBoundary state={dehydrate(queryClient)}>
 *       <ProductsList />
 *     </HydrationBoundary>
 *   );
 * }
 */
export function createCrudPrefetcher(api: EntityReadApi, entityKey: string): CrudPrefetcher {
  const queries = createEntityQueries(api, entityKey);

  return {
    async prefetchList(queryClient, params = {}, options = {}) {
      await queryClient.prefetchQuery({
        ...queries.list(params, toCtx(options)),
        staleTime: options.staleTime,
      });
    },

    async prefetchDetail(queryClient, id, options = {}) {
      const { staleTime, ...detailOpts } = options;
      await queryClient.prefetchQuery({
        ...queries.detail(id, detailOpts),
        staleTime,
      });
    },

    async prefetchBySlug(queryClient, slug, options = {}) {
      if (!api.getBySlug) {
        throw new Error(
          `[arc-next] prefetchBySlug requires an api with getBySlug (slugLookup preset)`,
        );
      }
      const { staleTime, ...detailOpts } = options;
      await queryClient.prefetchQuery({
        ...queries.bySlug(slug, detailOpts),
        staleTime,
      });
    },

    async prefetchDeleted(queryClient, params = {}, options = {}) {
      if (!api.getDeleted) {
        throw new Error(
          `[arc-next] prefetchDeleted requires an api with getDeleted (softDelete preset)`,
        );
      }
      await queryClient.prefetchQuery({
        ...queries.deleted(params, toCtx(options)),
        staleTime: options.staleTime,
      });
    },

    async prefetchAggregation(queryClient, name, filter, options = {}) {
      if (!api.aggregate) {
        throw new Error(
          `[arc-next] prefetchAggregation requires an api with aggregate (arc 2.13+)`,
        );
      }
      if (!name) throw new Error("[arc-next] prefetchAggregation: aggregation name is required");
      await queryClient.prefetchQuery({
        ...queries.aggregation(name, filter, toCtx(options)),
        staleTime: options.staleTime,
      });
    },

    async prefetchTree(queryClient, params = {}, options = {}) {
      if (!api.getTree) {
        throw new Error(`[arc-next] prefetchTree requires an api with getTree (tree preset)`);
      }
      await queryClient.prefetchQuery({
        ...queries.tree(params, toCtx(options)),
        staleTime: options.staleTime,
      });
    },

    async prefetchInfiniteList(queryClient, params = {}, options = {}) {
      await queryClient.prefetchInfiniteQuery({
        ...queries.infiniteList(params, toCtx(options)),
        staleTime: options.staleTime,
      });
    },
  };
}

// ============================================================================
// Type guard: dehydrated state for streaming
// ============================================================================

/** Re-export for callers that build their own dehydration logic. */
export type { InfiniteData };
