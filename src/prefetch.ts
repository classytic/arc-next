import { dehydrate, type QueryClient } from '@tanstack/react-query';
import { createQueryKeys } from './query.js';

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
    getBySlug?: (opts: {
      slug: string;
      token?: string | null;
      organizationId?: string | null;
      params?: Record<string, unknown>;
    }) => Promise<unknown>;
    getDeleted?: (opts: {
      params?: Record<string, unknown>;
      token?: string | null;
      organizationId?: string | null;
    }) => Promise<unknown>;
    getTree?: (opts: {
      params?: Record<string, unknown>;
      token?: string | null;
      organizationId?: string | null;
    }) => Promise<unknown>;
  },
  entityKey: string,
): CrudPrefetcher {
  const KEYS = createQueryKeys(entityKey);

  return {
    async prefetchList(queryClient, params = {}, options = {}) {
      const { organizationId, ...restParams } = params;
      const scope = organizationId ? 'tenant' : 'super-admin';
      const queryKey = KEYS.scopedList(scope, { organizationId, ...restParams });

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
      const baseKey = KEYS.detail(id);
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

    async prefetchBySlug(queryClient, slug, options = {}) {
      if (!api.getBySlug) {
        throw new Error(`[arc-next] prefetchBySlug requires an api with getBySlug (slugLookup preset)`);
      }
      const { params, staleTime } = options as PrefetchDetailOptions;
      const queryKey = params ? KEYS.custom('slug', slug, params) : KEYS.custom('slug', slug);

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getBySlug!({ slug, ...(params ? { params } : {}) }),
        staleTime,
      });
    },

    async prefetchDeleted(queryClient, params = {}, options = {}) {
      if (!api.getDeleted) {
        throw new Error(`[arc-next] prefetchDeleted requires an api with getDeleted (softDelete preset)`);
      }
      const { organizationId, ...restParams } = params;
      const queryKey = KEYS.custom('deleted', { organizationId, ...restParams });

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getDeleted!({
          params: restParams,
          organizationId: (organizationId as string | null) ?? null,
        }),
        staleTime: options.staleTime,
      });
    },

    async prefetchTree(queryClient, params = {}, options = {}) {
      if (!api.getTree) {
        throw new Error(`[arc-next] prefetchTree requires an api with getTree (tree preset)`);
      }
      const { organizationId, ...restParams } = params;
      const queryKey = KEYS.custom('tree', { organizationId, ...restParams });

      await queryClient.prefetchQuery({
        queryKey,
        queryFn: () => api.getTree!({
          params: restParams,
          organizationId: (organizationId as string | null) ?? null,
        }),
        staleTime: options.staleTime,
      });
    },
  };
}
