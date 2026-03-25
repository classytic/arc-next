import { dehydrate, type QueryClient, type QueryKey } from '@tanstack/react-query';

// Re-export for convenience in server components
export { dehydrate } from '@tanstack/react-query';

// ============================================================================
// Types
// ============================================================================

export interface PrefetchOptions {
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
}

// ============================================================================
// Query Key Generators (must match createQueryKeys in query.ts)
// ============================================================================

function scopedListKey(entityKey: string, scope: string, params?: Record<string, unknown>): QueryKey {
  return [entityKey, 'list', { _scope: scope, ...(params || {}) }];
}

function detailKey(entityKey: string, id: string): QueryKey {
  return [entityKey, 'detail', id];
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
    }) => Promise<unknown>;
    getById: (opts: {
      id: string;
      token?: string | null;
      organizationId?: string | null;
    }) => Promise<unknown>;
  },
  entityKey: string,
): CrudPrefetcher {
  return {
    async prefetchList(queryClient, params = {}, options = {}) {
      const { organizationId, ...restParams } = params;
      const scope = organizationId ? 'tenant' : 'super-admin';
      const queryKey = scopedListKey(entityKey, scope, { organizationId, ...restParams });

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getAll({
          params: restParams,
          organizationId: (organizationId as string | null) ?? null,
        }),
        staleTime: options.staleTime,
      });
    },

    async prefetchDetail(queryClient, id, options = {}) {
      const { params, staleTime } = options as PrefetchDetailOptions;
      // Key matches useDetail: [entity, "detail", id] or [entity, "detail", id, params]
      const baseKey = detailKey(entityKey, id);
      const queryKey = params ? [...baseKey, params] : baseKey;

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getById({
          id,
          ...(params ? { params } : {}),
        }),
        staleTime,
      });
    },
  };
}
