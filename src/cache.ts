// Server-safe cache + response-shape utilities.
//
// Lives WITHOUT a `"use client"` directive so Server Components (Next.js
// App Router prefetch, RSC streaming) can import + call these functions
// during SSR. The matching React hooks (`useListQuery`, `useDetailQuery`,
// `useInfiniteListQuery`, `useApiQuery`) live in `./query.ts`, which IS
// `"use client"` because hooks can only run on the client.
//
// Anything in this file MUST stay free of React hooks and browser APIs.

import type { QueryKey, QueryClient } from "@tanstack/react-query";

// ============================================================================
// Pagination shape
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

// ============================================================================
// TanStack Query defaults + freshness presets
// ============================================================================

export const DEFAULT_QUERY_CONFIG = {
  staleTime: 5 * 60 * 1000,
  gcTime: 30 * 60 * 1000,
  refetchOnWindowFocus: false,
  retry: 0,
} as const;

/** Pre-built query config presets for common data freshness patterns. */
export const QUERY_CONFIGS = {
  /** Live data: 20s stale, 30s polling */
  realtime: { staleTime: 20_000, refetchInterval: 30_000 },
  /** Frequently updated: 60s stale */
  frequent: { staleTime: 60_000 },
  /** Stable data: 5min stale (same as default) */
  stable: { staleTime: 300_000 },
  /** Rarely changes: 10min stale */
  static: { staleTime: 600_000 },
} as const;

// ============================================================================
// Response-shape utilities
// ============================================================================

/**
 * Well-known keys checked in order for list responses.
 *
 * Arc emits `{data: T[]}` for both paginated and bare-list endpoints, so
 * `docs` is the canonical key. `items` / `results` cover non-arc backends
 * the permissive detector still supports — the any-array fallback below
 * keeps `{products: [...]}` / `{users: [...]}` working without per-resource
 * configuration.
 */
const LIST_KEYS = ['data', 'items', 'results'] as const;

/**
 * Extract `_id` or `id` from any item. Returns `null` if neither exists.
 * Coerces numeric IDs to strings so cache keys stay consistent.
 */
export function getItemId(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const id = obj._id ?? obj.id;
  return typeof id === "string" ? id : id ? String(id) : null;
}

/**
 * Normalize any pagination response shape (offset / keyset / aggregate) to a
 * uniform `PaginationData` object. Returns `null` when no pagination signal
 * is present.
 */
export function normalizePagination(data: unknown): PaginationData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;

  const method = (d.method as PaginationData['method']) ?? null;
  const isKeyset = method === 'keyset' || (d.hasMore != null && d.total == null && d.pages == null);

  const hasTotal = d.total != null || d.totalDocs != null;
  const hasPages = d.pages != null || d.totalPages != null;

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

/**
 * Permissive list extractor. Checks well-known keys (`docs`, `data`, `items`,
 * `results`) then falls back to *any* top-level array — so `{ products: [...] }`
 * and `{ users: [...] }` work without per-resource configuration.
 */
export function extractItems<T>(data: unknown): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as T[];
  if (typeof data !== "object") return [];

  const d = data as Record<string, unknown>;

  for (const key of LIST_KEYS) {
    if (Array.isArray(d[key])) return d[key] as T[];
  }
  for (const value of Object.values(d)) {
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

/**
 * Detail extractor. Arc emits the doc directly (no envelope wrapper) — this
 * function is identity-with-null-guard. Kept as a named helper so callers
 * have a stable seam if a future backend ever ships an envelope, and so
 * `null` / `undefined` responses normalize to `null` consistently.
 */
export function extractItem<T>(data: unknown): T | null {
  if (data == null) return null;
  return data as T;
}

/**
 * Optimistic-update helper that mutates the items array of a list cache
 * regardless of which key holds it. Auto-adjusts `total`/`totalDocs` when
 * the array length changes.
 */
export function updateListCache<T>(listData: unknown, updater: (items: T[]) => T[]): unknown {
  if (!listData) return listData;

  if (Array.isArray(listData)) {
    return updater(listData as T[]);
  }

  if (typeof listData !== "object") return listData;
  const d = listData as Record<string, unknown>;

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

  const result: Record<string, unknown> = { ...d, [arrayField]: updated };
  if (delta !== 0) {
    if (d.total != null) result.total = Math.max(0, Number(d.total) + delta);
    if (d.totalDocs != null) result.totalDocs = Math.max(0, Number(d.totalDocs) + delta);
  }

  return result;
}

// ============================================================================
// Query keys factory
// ============================================================================

export interface QueryKeys {
  all: string[];
  lists: () => QueryKey;
  list: (params?: unknown) => QueryKey;
  details: () => QueryKey;
  detail: (id: string) => QueryKey;
  /** Tenant-scoped detail key. Use when IDs are only unique within an org. */
  scopedDetail: (id: string, organizationId: string | null) => QueryKey;
  custom: (key: string, ...args: unknown[]) => QueryKey;
  scopedList: (scope: string, params?: unknown) => QueryKey;
  /** Prefix for every aggregation on this resource — invalidate all at once. */
  aggregations: () => QueryKey;
  /**
   * Aggregation key (`arc 2.13+ /aggregations/:name`). The `filter` arg is
   * structurally hashed by TanStack — pass the same object identity (or
   * structurally identical) you pass to `useAggregation` so the cache hits.
   */
  aggregation: (name: string, filter?: unknown) => QueryKey;
}

/**
 * Build a hierarchical query-key factory for a resource. The returned shape
 * is identical between server (prefetch) and client (hooks), so RSC SSR
 * hydration matches what client-side `useList`/`useDetail` produce.
 */
export function createQueryKeys(entityKey: string): QueryKeys {
  return {
    all: [entityKey],
    lists: () => [entityKey, "list"],
    list: (params) => [entityKey, "list", params],
    details: () => [entityKey, "detail"],
    detail: (id) => [entityKey, "detail", id],
    scopedDetail: (id, organizationId) =>
      organizationId ? [entityKey, "detail", id, { _org: organizationId }] : [entityKey, "detail", id],
    custom: (key, ...args) => [entityKey, key, ...args],
    scopedList: (scope, params) => [entityKey, "list", { _scope: scope, ...(params as object) }],
    aggregations: () => [entityKey, "aggregation"],
    aggregation: (name, filter) =>
      filter !== undefined ? [entityKey, "aggregation", name, filter] : [entityKey, "aggregation", name],
  };
}

// ============================================================================
// Cache utilities factory
// ============================================================================

export interface CacheUtils<T> {
  invalidateAll: (client: QueryClient) => Promise<void>;
  invalidateLists: (client: QueryClient) => Promise<void>;
  /** Invalidate detail by ID (prefix-matches all scoped/parameterized variants). */
  invalidateDetail: (client: QueryClient, id: string) => Promise<void>;
  setDetail: (client: QueryClient, id: string, data: T) => void;
  getDetail: (client: QueryClient, id: string) => T | undefined;
  removeDetail: (client: QueryClient, id: string) => void;
  /** Invalidate tenant-scoped detail (prefix-matches parameterized variants within org). */
  invalidateScopedDetail: (client: QueryClient, id: string, organizationId: string | null) => Promise<void>;
  /** Set tenant-scoped detail cache. */
  setScopedDetail: (client: QueryClient, id: string, organizationId: string | null, data: T) => void;
  /** Get tenant-scoped detail from cache. */
  getScopedDetail: (client: QueryClient, id: string, organizationId: string | null) => T | undefined;
  /** Remove tenant-scoped detail from cache. */
  removeScopedDetail: (client: QueryClient, id: string, organizationId: string | null) => void;
  /**
   * Invalidate every aggregation for this resource. Call from mutation
   * `onSuccess` so dashboards refresh after CRUD writes.
   *
   * For targeted invalidation of a single aggregation pass the name —
   * prefix-matches every parameterized variant.
   */
  invalidateAggregations: (client: QueryClient, name?: string) => Promise<void>;
}

/**
 * Build cache read/write/invalidate helpers bound to the given key factory.
 * Server-safe — operates on a `QueryClient` instance which can be a per-request
 * server client (during prefetch) or the browser singleton.
 */
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
    invalidateScopedDetail: (client, id, organizationId) =>
      client.invalidateQueries({ queryKey: KEYS.scopedDetail(id, organizationId) }),
    setScopedDetail: (client, id, organizationId, data) =>
      client.setQueryData(KEYS.scopedDetail(id, organizationId), { data }),
    getScopedDetail: (client, id, organizationId) => {
      const cached = client.getQueryData(KEYS.scopedDetail(id, organizationId)) as { data?: T } | undefined;
      return cached?.data;
    },
    removeScopedDetail: (client, id, organizationId) =>
      client.removeQueries({ queryKey: KEYS.scopedDetail(id, organizationId) }),
    invalidateAggregations: (client, name) =>
      client.invalidateQueries({
        queryKey: name ? KEYS.aggregation(name) : KEYS.aggregations(),
      }),
  };
}
