import { dehydrate, type QueryClient, type InfiniteData } from '@tanstack/react-query';
import { createQueryKeys } from './cache.js';

// Re-exports for convenience in Server Components.
// `HydrationBoundary` is the canonical wrapper around the Client Component
// child that consumes the prefetched cache — re-exporting saves callers a
// second @tanstack/react-query import in their RSC files.
export { dehydrate, HydrationBoundary } from '@tanstack/react-query';

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
   * Prefetch a detail query on the server. Uses the same query keys as useDetail.
   *
   * @example
   * const queryClient = getQueryClient();
   * await productsPrefetcher.prefetchDetail(queryClient, productId);
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
   * Prefetch an infinite list query (cursor / page-based pagination). Uses the
   * same query keys as `useInfiniteList` and seeds the `{ pages, pageParams }`
   * shape TanStack Query expects for `useInfiniteQuery` — a flat
   * `prefetchQuery` would NOT match the cache shape and the client hook would
   * re-fetch from scratch, defeating the prefetch.
   *
   * @example
   * await productsPrefetcher.prefetchInfiniteList(queryClient, { limit: 20 });
   */
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
  prefetchInfiniteList: (
    queryClient: QueryClient,
    params?: Record<string, unknown>,
    options?: PrefetchOptions,
  ) => Promise<void>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create server-safe prefetch helpers for CRUD queries.
 * Use in Next.js server components to pre-populate the query cache before rendering.
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
export function createCrudPrefetcher(
  api: {
    getAll: (opts: {
      params?: Record<string, unknown>;
      token?: string | null;
      organizationId?: string | null;
      options?: { headerOptions?: Record<string, string> };
    }) => Promise<unknown>;
    getById: (opts: {
      id: string;
      token?: string | null;
      organizationId?: string | null;
      options?: { headerOptions?: Record<string, string> };
    }) => Promise<unknown>;
    getBySlug?: (opts: {
      slug: string;
      token?: string | null;
      organizationId?: string | null;
      params?: Record<string, unknown>;
      options?: { headerOptions?: Record<string, string> };
    }) => Promise<unknown>;
    getDeleted?: (opts: {
      params?: Record<string, unknown>;
      token?: string | null;
      organizationId?: string | null;
      options?: { headerOptions?: Record<string, string> };
    }) => Promise<unknown>;
    aggregate?: (opts: {
      name: string;
      filter?: Record<string, unknown>;
      token?: string | null;
      organizationId?: string | null;
      options?: { headerOptions?: Record<string, string> };
    }) => Promise<unknown>;
    getTree?: (opts: {
      params?: Record<string, unknown>;
      token?: string | null;
      organizationId?: string | null;
      options?: { headerOptions?: Record<string, string> };
    }) => Promise<unknown>;
  },
  entityKey: string,
): CrudPrefetcher {
  const KEYS = createQueryKeys(entityKey);

  return {
    async prefetchList(queryClient, params = {}, options = {}) {
      const { organizationId: paramOrgId, ...restParams } = params;
      const orgId = (paramOrgId as string | null) ?? options.organizationId ?? null;
      const scope = orgId ? 'tenant' : 'super-admin';
      const queryKey = KEYS.scopedList(scope, { ...(orgId ? { organizationId: orgId } : {}), ...restParams });

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getAll({
          params: restParams,
          token: options.token ?? null,
          organizationId: orgId,
          ...(options.headers ? { options: { headerOptions: options.headers } } : {}),
        }),
        staleTime: options.staleTime,
      });
    },

    async prefetchDetail(queryClient, id, options = {}) {
      const { params, staleTime, token, organizationId } = options as PrefetchDetailOptions;
      const baseKey = KEYS.detail(id);
      const queryKey = params ? [...baseKey, params] : baseKey;

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getById({
          id,
          token: token ?? null,
          organizationId: organizationId ?? null,
          ...(params ? { params } : {}),
          ...(options.headers ? { options: { headerOptions: options.headers } } : {}),
        }),
        staleTime,
      });
    },

    async prefetchBySlug(queryClient, slug, options = {}) {
      if (!api.getBySlug) {
        throw new Error(`[arc-next] prefetchBySlug requires an api with getBySlug (slugLookup preset)`);
      }
      const { params, staleTime, token, organizationId } = options as PrefetchDetailOptions;
      const queryKey = params ? KEYS.custom('slug', slug, params) : KEYS.custom('slug', slug);

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getBySlug!({
          slug,
          token: token ?? null,
          organizationId: organizationId ?? null,
          ...(params ? { params } : {}),
          ...(options.headers ? { options: { headerOptions: options.headers } } : {}),
        }),
        staleTime,
      });
    },

    async prefetchDeleted(queryClient, params = {}, options = {}) {
      if (!api.getDeleted) {
        throw new Error(`[arc-next] prefetchDeleted requires an api with getDeleted (softDelete preset)`);
      }
      const { organizationId: paramOrgId, ...restParams } = params;
      const orgId = (paramOrgId as string | null) ?? options.organizationId ?? null;
      const queryKey = KEYS.custom('deleted', { ...(orgId ? { organizationId: orgId } : {}), ...restParams });

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getDeleted!({
          params: restParams,
          token: options.token ?? null,
          organizationId: orgId,
          ...(options.headers ? { options: { headerOptions: options.headers } } : {}),
        }),
        staleTime: options.staleTime,
      });
    },

    async prefetchAggregation(queryClient, name, filter, options = {}) {
      if (!api.aggregate) {
        throw new Error(`[arc-next] prefetchAggregation requires an api with aggregate (arc 2.13+)`);
      }
      if (!name) throw new Error('[arc-next] prefetchAggregation: aggregation name is required');
      const orgId = options.organizationId ?? null;
      // Mirror useAggregation's tenant-scoped filter key so hydration matches.
      const filterKey = orgId ? { _org: orgId, ...(filter ?? {}) } : (filter ?? {});

      await queryClient.prefetchQuery({
        queryKey: KEYS.aggregation(name, filterKey),
        queryFn: () => api.aggregate!({
          name,
          filter,
          token: options.token ?? null,
          organizationId: orgId,
          ...(options.headers ? { options: { headerOptions: options.headers } } : {}),
        }),
        staleTime: options.staleTime,
      });
    },

    async prefetchTree(queryClient, params = {}, options = {}) {
      if (!api.getTree) {
        throw new Error(`[arc-next] prefetchTree requires an api with getTree (tree preset)`);
      }
      const { organizationId: paramOrgId, ...restParams } = params;
      const orgId = (paramOrgId as string | null) ?? options.organizationId ?? null;
      const queryKey = KEYS.custom('tree', { ...(orgId ? { organizationId: orgId } : {}), ...restParams });

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getTree!({
          params: restParams,
          token: options.token ?? null,
          organizationId: orgId,
          ...(options.headers ? { options: { headerOptions: options.headers } } : {}),
        }),
        staleTime: options.staleTime,
      });
    },

    async prefetchInfiniteList(queryClient, params = {}, options = {}) {
      const { organizationId: paramOrgId, ...restParams } = params;
      const orgId = (paramOrgId as string | null) ?? options.organizationId ?? null;
      // Match useInfiniteList's scoped key so client + server share the cache.
      const scope = orgId ? 'tenant' : 'super-admin';
      const queryKey = [
        ...KEYS.scopedList(scope, { ...(orgId ? { organizationId: orgId } : {}), ...restParams }),
        'infinite',
      ];

      await queryClient.prefetchInfiniteQuery({
        queryKey,
        queryFn: ({ pageParam }) => api.getAll({
          // Cursor pagination + offset both supported; the hook decides which to use.
          params: { ...restParams, ...(pageParam ? { page: pageParam } : {}) } as Record<string, unknown>,
          token: options.token ?? null,
          organizationId: orgId,
          ...(options.headers ? { options: { headerOptions: options.headers } } : {}),
        }),
        initialPageParam: 1 as unknown,
        // useInfiniteQuery requires getNextPageParam at runtime, but for SSR
        // prefetch we only need the first page to seed `{ pages: [first] }`.
        // `getNextPageParam` is purely advisory at this stage.
        getNextPageParam: () => undefined,
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
