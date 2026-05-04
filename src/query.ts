"use client";

import { useQuery, useInfiniteQuery, useQueryClient, keepPreviousData, type QueryKey, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

// Server-safe utilities live in ./cache.ts (no "use client") so Server Components
// can import + call them during RSC prefetch. We re-export them here for callers
// already pointing at @classytic/arc-next/query — the import path is the
// boundary, not the directive — but new code SHOULD prefer @classytic/arc-next/cache.
export {
  getItemId,
  extractItem,
  extractItems,
  updateListCache,
  normalizePagination,
  createQueryKeys,
  createCacheUtils,
  DEFAULT_QUERY_CONFIG,
  QUERY_CONFIGS,
  type QueryKeys,
  type CacheUtils,
  type PaginationData,
} from "./cache.js";

import {
  extractItems,
  normalizePagination,
  getItemId,
  extractItem,
  DEFAULT_QUERY_CONFIG,
  QUERY_CONFIGS,
  type PaginationData,
} from "./cache.js";

// ============================================================================
// Types
// ============================================================================

/** Request-level options passed through to the fetch call */
export interface RequestPassthrough {
  cache?: RequestCache;
  revalidate?: number;
  tags?: string[];
  headerOptions?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ListQueryOptions<TData = unknown> {
  public?: boolean;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
  structuralSharing?: boolean;
  prefillDetailCache?: boolean;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  _scope?: string;
  /** Transform raw API response before returning. Runs on each render, receives raw data. */
  select?: (data: unknown) => TData;
  /** Pass-through options for the underlying fetch request (cache, revalidate, tags, headers) */
  request?: RequestPassthrough;
}

export interface DetailQueryOptions<TData = unknown> {
  public?: boolean;
  organizationId?: string | null;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
  structuralSharing?: boolean;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  /** Query params passed to getById (e.g. select, populate) */
  params?: { select?: string; populate?: string | string[] };
  /** Transform raw API response before returning. Runs on each render, receives raw data. */
  select?: (data: unknown) => TData;
  /** Pass-through options for the underlying fetch request (cache, revalidate, tags, headers) */
  request?: RequestPassthrough;
}

export interface ListQueryResult<T> {
  items: T[];
  pagination: PaginationData | null;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  isStale: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
  data: unknown;
}

export interface DetailQueryResult<T> {
  item: T | null;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  isStale: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
  data: unknown;
}

// ============================================================================
// List Query Hook
// ============================================================================

export interface CreateListQueryConfig {
  queryKey: QueryKey;
  queryFn: (context: { signal?: AbortSignal }) => Promise<unknown>;
  enabled?: boolean;
  options?: Record<string, unknown>;
  prefillDetailCache?: boolean;
  detailKeyBuilder?: (id: string) => QueryKey;
  /** Custom ID extractor for cache prefill. Falls back to getItemId (_id → id). */
  itemIdResolver?: (item: unknown) => string | null;
  select?: (data: unknown) => unknown;
}

export function useListQuery<T>({
  queryKey,
  queryFn,
  enabled = true,
  options = {},
  prefillDetailCache = true,
  detailKeyBuilder,
  itemIdResolver,
  select,
}: CreateListQueryConfig): ListQueryResult<T> {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => queryFn({ signal }),
    enabled,
    ...DEFAULT_QUERY_CONFIG,
    ...options,
    ...(select ? { select } : {}),
    placeholderData: keepPreviousData,
  });

  // Memoize to avoid re-running useEffect on every render
  const items = useMemo(() => extractItems<T>(query.data), [query.data]);
  const pagination = useMemo(() => normalizePagination(query.data), [query.data]);

  useEffect(() => {
    if (!prefillDetailCache || !detailKeyBuilder || items.length === 0) return;

    const resolveId = itemIdResolver ?? getItemId;
    items.forEach((item) => {
      const id = resolveId(item);
      if (id) queryClient.setQueryData(detailKeyBuilder(id), { data: item });
    });
  }, [items, prefillDetailCache, detailKeyBuilder, queryClient]);

  return {
    items,
    pagination,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    isStale: query.isStale,
    error: query.error,
    refetch: query.refetch,
    data: query.data,
  };
}

// ============================================================================
// Detail Query Hook
// ============================================================================

export interface CreateDetailQueryConfig {
  queryKey: QueryKey;
  queryFn: (context: { signal?: AbortSignal }) => Promise<unknown>;
  enabled?: boolean;
  options?: Record<string, unknown>;
  select?: (data: unknown) => unknown;
}

export function useDetailQuery<T>({
  queryKey,
  queryFn,
  enabled = true,
  options = {},
  select,
}: CreateDetailQueryConfig): DetailQueryResult<T> {
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => queryFn({ signal }),
    enabled,
    ...DEFAULT_QUERY_CONFIG,
    ...options,
    ...(select ? { select } : {}),
  });

  const item = extractItem<T>(query.data);

  return {
    item,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    isStale: query.isStale,
    error: query.error,
    refetch: query.refetch,
    data: query.data,
  };
}

// ============================================================================
// Infinite List Query Hook
// ============================================================================

export interface InfiniteListQueryOptions {
  public?: boolean;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
  structuralSharing?: boolean;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  _scope?: string;
  request?: RequestPassthrough;
  /**
   * Max pages to keep in memory. Old pages are evicted and re-fetched on scroll-back.
   * Requires `getPreviousPageParam` for backward re-fetching.
   * When unset, all fetched pages are retained (default TanStack Query behavior).
   */
  maxPages?: number;
}

export interface InfiniteListQueryResult<T> {
  items: T[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  isFetchingNextPage: boolean;
  isFetchingPreviousPage: boolean;
  fetchNextPage: () => void;
  fetchPreviousPage: () => void;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
  data: InfiniteData<unknown> | undefined;
}

export interface CreateInfiniteListQueryConfig {
  queryKey: QueryKey;
  queryFn: (context: { signal?: AbortSignal; pageParam: unknown }) => Promise<unknown>;
  enabled?: boolean;
  options?: Record<string, unknown>;
  initialPageParam?: unknown;
  getNextPageParam: (lastPage: unknown) => unknown;
  getPreviousPageParam?: (firstPage: unknown) => unknown;
  /** Max pages to keep in memory. Old pages are evicted when exceeded. */
  maxPages?: number;
}

export function useInfiniteListQuery<T>({
  queryKey,
  queryFn,
  enabled = true,
  options = {},
  initialPageParam = 1,
  getNextPageParam,
  getPreviousPageParam,
  maxPages,
}: CreateInfiniteListQueryConfig): InfiniteListQueryResult<T> {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => queryFn({ pageParam, signal }),
    enabled,
    initialPageParam,
    getNextPageParam,
    getPreviousPageParam,
    ...(maxPages != null ? { maxPages } : {}),
    ...DEFAULT_QUERY_CONFIG,
    ...options,
  });

  const items = useMemo(
    () => query.data?.pages.flatMap((page) => extractItems<T>(page)) ?? [],
    [query.data],
  );

  return {
    items,
    hasNextPage: query.hasNextPage,
    hasPreviousPage: query.hasPreviousPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchingPreviousPage: query.isFetchingPreviousPage,
    fetchNextPage: query.fetchNextPage,
    fetchPreviousPage: query.fetchPreviousPage,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    error: query.error,
    refetch: query.refetch,
    data: query.data,
  };
}

// ============================================================================
// Generic API Query Hook (non-CRUD reads)
// ============================================================================

/** Recognized data-freshness presets. Maps to QUERY_CONFIGS. */
export type QueryFreshness = keyof typeof QUERY_CONFIGS;

/**
 * Identity passthrough — arc emits raw data on success (no envelope; HTTP
 * status discriminates errors via thrown `ArcApiError`). Kept as a named
 * type for the `useApiQuery` default param so the public signature stays
 * `useApiQuery<TResponse, TData = ExtractData<TResponse>>` for callers
 * that want a custom select projection.
 */
export type ExtractData<T> = T;

/** Per-call request pass-through and TanStack Query overrides. */
export interface UseApiQueryOptions {
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  retry?: boolean | number;
  /** Limit re-renders to changes in these specific fields (perf optimization). */
  notifyOnChangeProps?: ('data' | 'error' | 'isLoading' | 'isFetching' | 'isError' | 'isSuccess' | 'isStale')[];
}

export interface UseApiQueryConfig<TResponse, TData> {
  queryKey: QueryKey;
  queryFn: (context: { signal: AbortSignal }) => Promise<TResponse>;
  enabled?: boolean;
  /** Freshness preset name (`realtime` | `frequent` | `stable` | `static`). */
  freshness?: QueryFreshness;
  /**
   * Custom projection from the raw response. When omitted, the response is
   * returned unchanged — arc 2.13+ has no wire envelope, so the response
   * already IS the data.
   */
  select?: (response: TResponse) => TData;
  /** TanStack Query overrides (staleTime, refetchInterval, retry, etc.). */
  options?: UseApiQueryOptions;
}

export interface UseApiQueryResult<TData> {
  data: TData | null;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  isStale: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/**
 * Generic query hook for non-CRUD reads (reports, aggregates, lookups, RPC-style
 * endpoints). Wraps TanStack Query with two ergonomics on top:
 *
 * 1. **Freshness presets.** Pass `freshness: 'realtime' | 'frequent' | 'stable' |
 *    'static'` to map onto `QUERY_CONFIGS`. Per-option overrides still win.
 * 2. **Standardized result shape.** `{ data, isLoading, isFetching, isError,
 *    isSuccess, isStale, error, refetch }` — same contract as the CRUD hooks.
 *
 * Arc emits raw data on success (no envelope), so the response IS the data.
 * Use `select` for shape transformations / multi-field projections.
 *
 * @example
 * // Direct typing — response IS the data
 * const { data } = useApiQuery<DashboardStats>({
 *   queryKey: ['dashboard', 'stats'],
 *   queryFn: ({ signal }) => api.request('GET', '/dashboard/stats', { options: { signal } }),
 *   freshness: 'realtime',
 * });
 *
 * // Custom projection (e.g. extract a sub-field)
 * const { data } = useApiQuery({
 *   queryKey: ['ledger', accountId],
 *   queryFn: ({ signal }) => api.request<{ entries: Entry[] }>('GET', `/ledger/${accountId}`, { options: { signal } }),
 *   select: (res) => res.entries,
 * });
 */
export function useApiQuery<TResponse = unknown, TData = ExtractData<TResponse>>({
  queryKey,
  queryFn,
  enabled = true,
  freshness,
  select,
  options = {},
}: UseApiQueryConfig<TResponse, TData>): UseApiQueryResult<TData> {
  // Stable projection: stash `select` in a ref so an inline arrow at the call
  // site (`select: (r) => r.field`) doesn't change projection identity on every
  // render. TanStack treats a new `select` reference as cause to re-run the
  // projection (structural sharing only saves on equal *output*, not equal
  // *function*); the ref pattern keeps `select` always resolvable to the latest
  // closure while the wrapper stays referentially stable.
  const selectRef = useRef(select);
  selectRef.current = select;
  const projection = useCallback((response: TResponse): TData => {
    const fn = selectRef.current;
    if (fn) return fn(response);
    return response as unknown as TData;
  }, []);

  const preset = freshness ? QUERY_CONFIGS[freshness] : undefined;

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => queryFn({ signal }),
    enabled,
    ...DEFAULT_QUERY_CONFIG,
    ...preset,
    ...options,
    select: projection,
  });

  return {
    data: (query.data ?? null) as TData | null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    isStale: query.isStale,
    error: query.error,
    refetch: query.refetch,
  };
}

