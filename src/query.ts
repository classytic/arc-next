"use client";

import { useQuery, useInfiniteQuery, useQueryClient, keepPreviousData, type QueryKey, type InfiniteData } from "@tanstack/react-query";
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";

// ============================================================================
// Types
// ============================================================================

export interface PaginationData {
  total: number;
  pages: number;
  page: number;
  limit: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Request-level options passed through to the fetch call */
export interface RequestPassthrough {
  cache?: RequestCache;
  revalidate?: number;
  tags?: string[];
  headerOptions?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ListQueryOptions {
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
  /** Pass-through options for the underlying fetch request (cache, revalidate, tags, headers) */
  request?: RequestPassthrough;
}

export interface DetailQueryOptions {
  public?: boolean;
  organizationId?: string | null;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  structuralSharing?: boolean;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  /** Query params passed to getById (e.g. select, populate) */
  params?: { select?: string; populate?: string | string[] };
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

  const hasTotal = d.total != null || d.totalDocs != null;
  const hasPages = d.pages != null || d.totalPages != null;
  if (!hasTotal && !hasPages) return null;

  return {
    total: Number(d.total ?? d.totalDocs ?? 0),
    pages: Number(d.pages ?? d.totalPages ?? 1),
    page: Number(d.page ?? d.currentPage ?? 1),
    limit: Number(d.limit ?? 10),
    hasNext: Boolean(d.hasNext ?? d.hasNextPage ?? d.hasMore ?? false),
    hasPrev: Boolean(d.hasPrev ?? d.hasPrevPage ?? false),
  };
}

function extractItems<T>(data: unknown): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as T[];
  if (typeof data !== "object") return [];

  const d = data as Record<string, unknown>;
  const items = d.docs ?? d.data ?? d.items ?? d.results;
  return Array.isArray(items) ? (items as T[]) : [];
}

function extractItem<T>(data: unknown): T | null {
  if (!data) return null;
  if (typeof data !== "object") return null;

  const d = data as Record<string, unknown>;
  return (d.data ?? d) as T | null;
}

export function updateListCache<T>(listData: unknown, updater: (items: T[]) => T[]): unknown {
  if (!listData) return listData;

  if (typeof listData === "object" && "docs" in (listData as object)) {
    const d = listData as Record<string, unknown>;
    const updatedDocs = updater(d.docs as T[]);
    return { ...d, docs: updatedDocs, total: updatedDocs.length, totalDocs: updatedDocs.length };
  }

  if (Array.isArray(listData)) {
    return updater(listData as T[]);
  }

  if (typeof listData === "object" && "data" in (listData as object)) {
    const d = listData as Record<string, unknown>;
    if (Array.isArray(d.data)) {
      return { ...d, data: updater(d.data as T[]) };
    }
  }

  return listData;
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
}

export function createListQuery<T>({
  queryKey,
  queryFn,
  enabled = true,
  options = {},
  prefillDetailCache = true,
  detailKeyBuilder,
}: CreateListQueryConfig): ListQueryResult<T> {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey,
    queryFn: () => queryFn({}),
    enabled,
    ...DEFAULT_QUERY_CONFIG,
    ...options,
    placeholderData: keepPreviousData,
  });

  const items = extractItems<T>(query.data);
  const pagination = normalizePagination(query.data);

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
}

export function createDetailQuery<T>({
  queryKey,
  queryFn,
  enabled = true,
  options = {},
}: CreateDetailQueryConfig): DetailQueryResult<T> {
  const query = useQuery({
    queryKey,
    queryFn: () => queryFn({}),
    enabled,
    ...DEFAULT_QUERY_CONFIG,
    ...options,
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

export function createInfiniteListQuery<T>({
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
    queryFn: ({ pageParam }) => queryFn({ pageParam }),
    enabled,
    initialPageParam,
    getNextPageParam,
    getPreviousPageParam,
    ...DEFAULT_QUERY_CONFIG,
    ...options,
  });

  const items: T[] = query.data?.pages.flatMap((page) => extractItems<T>(page)) ?? [];

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
