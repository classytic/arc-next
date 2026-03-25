"use client";

import { useQuery, useInfiniteQuery, useQueryClient, keepPreviousData, type QueryKey, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";

// ============================================================================
// Types
// ============================================================================

export interface PaginationData {
  /** Pagination method detected from response (offset | keyset | aggregate) */
  method: 'offset' | 'keyset' | 'aggregate' | null;
  total: number;
  pages: number;
  page: number;
  limit: number;
  hasNext: boolean;
  hasPrev: boolean;
  /** Keyset cursor for next page (keyset pagination only) */
  next?: string | null;
}

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

export interface QueryKeys {
  all: string[];
  lists: () => QueryKey;
  list: (params?: unknown) => QueryKey;
  details: () => QueryKey;
  detail: (id: string) => QueryKey;
  custom: (key: string, ...args: unknown[]) => QueryKey;
  scopedList: (scope: string, params?: unknown) => QueryKey;
}

export interface CacheUtils<T> {
  invalidateAll: (client: QueryClient) => Promise<void>;
  invalidateLists: (client: QueryClient) => Promise<void>;
  invalidateDetail: (client: QueryClient, id: string) => Promise<void>;
  setDetail: (client: QueryClient, id: string, data: T) => void;
  getDetail: (client: QueryClient, id: string) => T | undefined;
  removeDetail: (client: QueryClient, id: string) => void;
}

// ============================================================================
// Default Config
// ============================================================================

export const DEFAULT_QUERY_CONFIG = {
  staleTime: 5 * 60 * 1000,
  gcTime: 30 * 60 * 1000,
  refetchOnWindowFocus: false,
  retry: 0,
} as const;

// ============================================================================
// Utilities
// ============================================================================

export function getItemId(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const id = obj._id ?? obj.id;
  return typeof id === "string" ? id : id ? String(id) : null;
}

function normalizePagination(data: unknown): PaginationData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  // Detect pagination method from response
  const method = (d.method as PaginationData['method']) ?? null;

  // Keyset pagination: has hasMore but no total/pages
  const isKeyset = method === 'keyset' || (d.hasMore != null && d.total == null && d.pages == null);

  const hasTotal = d.total != null || d.totalDocs != null;
  const hasPages = d.pages != null || d.totalPages != null;

  // Return null only when no pagination signal exists at all
  if (!hasTotal && !hasPages && !isKeyset) return null;

  return {
    method,
    total: Number(d.total ?? d.totalDocs ?? 0),
    pages: Number(d.pages ?? d.totalPages ?? (isKeyset ? 0 : 1)),
    page: Number(d.page ?? d.currentPage ?? (isKeyset ? 0 : 1)),
    limit: Number(d.limit ?? 10),
    hasNext: Boolean(d.hasNext ?? d.hasNextPage ?? d.hasMore ?? false),
    hasPrev: Boolean(d.hasPrev ?? d.hasPrevPage ?? false),
    ...(isKeyset ? { next: (d.next as string | null) ?? null } : {}),
  };
}

/** Well-known keys checked in order for list responses. */
const LIST_KEYS = ['docs', 'data', 'items', 'results'] as const;
/** Well-known keys checked in order for detail responses. */
const DETAIL_KEYS = ['data', 'doc', 'item', 'result'] as const;

function extractItems<T>(data: unknown): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as T[];
  if (typeof data !== "object") return [];

  const d = data as Record<string, unknown>;

  // 1. Check well-known keys first
  for (const key of LIST_KEYS) {
    if (Array.isArray(d[key])) return d[key] as T[];
  }

  // 2. Fallback: find the first top-level array (handles { products: [...] } etc.)
  for (const value of Object.values(d)) {
    if (Array.isArray(value)) return value as T[];
  }

  return [];
}

function extractItem<T>(data: unknown): T | null {
  if (data == null) return null;
  // Primitive response (string, number, boolean) — return directly
  if (typeof data !== "object") return data as T;

  const d = data as Record<string, unknown>;

  // 1. Check well-known keys first (accept any non-null value, including primitives)
  for (const key of DETAIL_KEYS) {
    if (d[key] != null) return d[key] as T;
  }

  // 2. Fallback: return the response itself (direct object)
  return d as T;
}

export function updateListCache<T>(listData: unknown, updater: (items: T[]) => T[]): unknown {
  if (!listData) return listData;

  if (Array.isArray(listData)) {
    return updater(listData as T[]);
  }

  if (typeof listData !== "object") return listData;
  const d = listData as Record<string, unknown>;

  // Detect the items array field: well-known keys first, then first array found
  let arrayField: string | null = null;
  for (const key of LIST_KEYS) {
    if (Array.isArray(d[key])) { arrayField = key; break; }
  }
  if (!arrayField) {
    for (const [key, value] of Object.entries(d)) {
      if (Array.isArray(value)) { arrayField = key; break; }
    }
  }

  if (!arrayField) return listData;

  const updated = updater(d[arrayField] as T[]);
  const original = d[arrayField] as T[];
  const delta = updated.length - original.length;

  // Update total/totalDocs when item count changes (optimistic add/delete)
  const result: Record<string, unknown> = { ...d, [arrayField]: updated };
  if (delta !== 0) {
    if (d.total != null) result.total = Math.max(0, Number(d.total) + delta);
    if (d.totalDocs != null) result.totalDocs = Math.max(0, Number(d.totalDocs) + delta);
  }

  return result;
}

// ============================================================================
// Query Keys Factory
// ============================================================================

export function createQueryKeys(entityKey: string): QueryKeys {
  return {
    all: [entityKey],
    lists: () => [entityKey, "list"],
    list: (params) => [entityKey, "list", params],
    details: () => [entityKey, "detail"],
    detail: (id) => [entityKey, "detail", id],
    custom: (key, ...args) => [entityKey, key, ...args],
    scopedList: (scope, params) => [entityKey, "list", { _scope: scope, ...(params as object) }],
  };
}

// ============================================================================
// Cache Utilities Factory
// ============================================================================

export function createCacheUtils<T>(KEYS: QueryKeys): CacheUtils<T> {
  return {
    invalidateAll: (client) => client.invalidateQueries({ queryKey: KEYS.all }),
    invalidateLists: (client) => client.invalidateQueries({ queryKey: KEYS.lists() }),
    invalidateDetail: (client, id) => client.invalidateQueries({ queryKey: KEYS.detail(id) }),
    setDetail: (client, id, data) => client.setQueryData(KEYS.detail(id), { data }),
    getDetail: (client, id) => {
      const cached = client.getQueryData(KEYS.detail(id)) as { data?: T } | undefined;
      return cached?.data;
    },
    removeDetail: (client, id) => client.removeQueries({ queryKey: KEYS.detail(id) }),
  };
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
  select?: (data: unknown) => unknown;
}

export function useListQuery<T>({
  queryKey,
  queryFn,
  enabled = true,
  options = {},
  prefillDetailCache = true,
  detailKeyBuilder,
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

    items.forEach((item) => {
      const id = getItemId(item);
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
}

export function useInfiniteListQuery<T>({
  queryKey,
  queryFn,
  enabled = true,
  options = {},
  initialPageParam = 1,
  getNextPageParam,
  getPreviousPageParam,
}: CreateInfiniteListQueryConfig): InfiniteListQueryResult<T> {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => queryFn({ pageParam, signal }),
    enabled,
    initialPageParam,
    getNextPageParam,
    getPreviousPageParam,
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

// Deprecated aliases — use useListQuery, useDetailQuery, useInfiniteListQuery
/** @deprecated Use `useListQuery` */
export const createListQuery = useListQuery;
/** @deprecated Use `useDetailQuery` */
export const createDetailQuery = useDetailQuery;
/** @deprecated Use `useInfiniteListQuery` */
export const createInfiniteListQuery = useInfiniteListQuery;
