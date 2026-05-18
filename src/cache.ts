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
  // Short-circuit: when the updater returns the same array reference (the
  // canonical "I didn't actually change anything" signal), return the
  // original wrapper unchanged. Otherwise we'd allocate a new outer object
  // here on every call, which would make `syncDetailToLists` (and any other
  // helper that defers to `updateListCache`) report false-positive updates
  // and cause spurious `setQueryData` writes → re-render cascades.
  if (updated === original) return listData;
  const delta = updated.length - original.length;

  const result: Record<string, unknown> = { ...d, [arrayField]: updated };
  if (delta !== 0) {
    if (d.total != null) result.total = Math.max(0, Number(d.total) + delta);
    if (d.totalDocs != null) result.totalDocs = Math.max(0, Number(d.totalDocs) + delta);
  }

  return result;
}

// ============================================================================
// Cross-cache pseudo-normalization (0.7+)
// ============================================================================
//
// Vocabulary lock-in with arc / repo-core:
//   - `TDoc` (the type) is the backend-facing entity generic. Comes from
//     `BaseApi<TDoc>` / `Repository<TDoc>` / mongokit's `Document`. We don't
//     redefine it here.
//   - `item` (the variable / JSDoc noun) is what arc-next consumers see:
//     `useDetail().item`, `useList().items`, `extractItem`, `getItemId`,
//     `findItemInListCache`. We use `item` consistently on the public
//     helper surface so a reader scanning a hook + a cache call recognizes
//     the same thing without translation.
//   - `data` is the JSON envelope field name on the WIRE (`{ data: [...],
//     total, ... }`). It is NOT a noun for "one entity" — `data[i]` is one
//     item, `data` itself is the list array. We avoid `data` as a variable
//     name in this layer to keep the wire-vs-runtime split clean.
//
// arc-next holds one cache entry per query, not one per entity (TanStack
// Query is a query cache, not an entity store). Without help, the same item
// can live in N places at once: list payloads, detail-by-id, detail-by-slug,
// scoped variants, infinite-query pages, etc. — each with its own staleness
// clock.
//
// `syncDetailToLists` is the cheapest possible fix for the read-side of
// this duplication: after a fresh detail fetch lands, walk every list
// cache containing the item and shallow-merge the new fields in place.
// We do NOT create new cache entries (that was the 0.6 prefill bug — it
// blocked subsequent GETs because the cache looked fresh). We only UPDATE
// entries that already exist, so the user sees consistent values across
// every component reading those caches without any extra network round-trip.
//
// This is pseudo-normalization, not the real thing — copies still exist in
// memory, garbage collection is still per-query. For true normalization
// (one copy per entity, field-level invalidation, GC by reference count),
// use Apollo Client or Relay. arc-next stays opinionated about its niche:
// REST + React Query with a tiny runtime and zero codegen.
// ============================================================================

/** Item-identity helper that respects a custom idField, falling back to `_id` / `id`. */
function resolveId(item: unknown, idField?: string): string | null {
  if (!item || typeof item !== "object") return null;
  if (idField) {
    const v = (item as Record<string, unknown>)[idField];
    if (v != null) return String(v);
  }
  return getItemId(item);
}

/**
 * Shallow-merge updater that preserves the receiver's key set. Detail payloads
 * are often richer than list payloads (populated relations, full body fields).
 * If we replaced wholesale we'd bloat list caches with detail-only fields and
 * force a full re-render on every value change. Merge keeps lists lean while
 * still picking up updates to fields the list already cares about.
 */
function shallowMergeKept<T extends Record<string, unknown>>(
  receiver: T,
  source: Record<string, unknown>,
): T {
  let changed = false;
  const next: Record<string, unknown> = { ...receiver };
  for (const key of Object.keys(receiver)) {
    if (key in source && !Object.is(receiver[key], source[key])) {
      next[key] = source[key];
      changed = true;
    }
  }
  return changed ? (next as T) : receiver;
}

/**
 * After a detail fetch lands, propagate the fresh values into every cached
 * list entry that contains this item. The item's ID is resolved via
 * `idField`, falling back to `_id` / `id`. Handles both flat list payloads
 * and infinite-query page arrays.
 *
 * Only updates EXISTING list entries — never creates new caches or new items
 * in lists. If the item moved between filter buckets (e.g. status changed),
 * the relevant lists will refetch on their own; we don't try to predict
 * filter membership.
 *
 * Returns the number of cache entries updated (useful for tests + telemetry).
 *
 * @param qc TanStack QueryClient
 * @param listsKey Prefix key for this entity's lists (typically `KEYS.lists()`)
 * @param item Fresh entity to merge into matching list items
 * @param opts.idField Custom ID field name (defaults to `_id` / `id` lookup)
 */
export function syncDetailToLists<TItem extends Record<string, unknown>>(
  qc: QueryClient,
  listsKey: QueryKey,
  item: TItem,
  opts: { idField?: string } = {},
): number {
  const targetId = resolveId(item, opts.idField);
  if (!targetId) return 0;

  let updates = 0;
  const entries = qc.getQueriesData<unknown>({ queryKey: listsKey });
  for (const [qKey, raw] of entries) {
    if (!raw) continue;

    // Infinite-query value is `{ pages: unknown[], pageParams }`. Walk pages so
    // we don't double-write the wrapper.
    const isInfinite =
      typeof raw === 'object' && raw !== null &&
      Array.isArray((raw as { pages?: unknown }).pages);

    if (isInfinite) {
      const inf = raw as { pages: unknown[]; pageParams: unknown[] };
      let pagesChanged = false;
      const nextPages = inf.pages.map((page) => {
        const merged = mergeItemIntoListPage(page, targetId, item, opts.idField);
        if (merged !== page) pagesChanged = true;
        return merged;
      });
      if (pagesChanged) {
        qc.setQueryData(qKey, { ...inf, pages: nextPages });
        updates += 1;
      }
      continue;
    }

    const merged = mergeItemIntoListPage(raw, targetId, item, opts.idField);
    if (merged !== raw) {
      qc.setQueryData(qKey, merged);
      updates += 1;
    }
  }
  return updates;
}

/** Internal — merge an item into a single list payload (one filter result or one infinite page). */
function mergeItemIntoListPage<TItem extends Record<string, unknown>>(
  page: unknown,
  targetId: string,
  item: TItem,
  idField?: string,
): unknown {
  return updateListCache(page, (items: unknown[]) => {
    let changed = false;
    const next = items.map((listItem) => {
      if (!listItem || typeof listItem !== 'object') return listItem;
      if (resolveId(listItem, idField) !== targetId) return listItem;
      const merged = shallowMergeKept(listItem as Record<string, unknown>, item);
      if (merged !== listItem) changed = true;
      return merged;
    });
    return changed ? next : items;
  });
}

// NOTE on the reverse direction (list → detail): we intentionally do NOT
// ship a `syncListsToDetail`. List payloads are typically a SUBSET of the
// detail payload (apps trim fields with `select=...` for list-page perf),
// so a post-fetch list → detail merge overwrites the rich detail-cache
// values with the trimmed list values. The detail GET is the authoritative
// read for one item; we mirror it OUT to lists (above), but never IN from
// lists. For propagating optimistic mutations from a list view into open
// detail views, use `useActions.update` — it already fans out to every
// `[entity, 'detail', id, *]` cache (hooks.ts onMutate path).

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
 *
 * **Wire shape:** Arc 2.13+ emits raw documents on `GET /:resource/:id` — no
 * `{ data: ... }` envelope. `setDetail` / `getDetail` write and read the raw
 * doc directly so the cache shape matches `useDetail`'s `queryFn` output,
 * `useNavigation`'s pre-populated entries, and `prefetchDetail`'s server seed.
 * All four paths converge on the same shape: TDoc, not `{ data: TDoc }`.
 */
export function createCacheUtils<T>(KEYS: QueryKeys): CacheUtils<T> {
  return {
    invalidateAll: (client) => client.invalidateQueries({ queryKey: KEYS.all }),
    invalidateLists: (client) => client.invalidateQueries({ queryKey: KEYS.lists() }),
    invalidateDetail: (client, id) => client.invalidateQueries({ queryKey: KEYS.detail(id) }),
    setDetail: (client, id, data) => client.setQueryData(KEYS.detail(id), data),
    getDetail: (client, id) => client.getQueryData<T>(KEYS.detail(id)) ?? undefined,
    removeDetail: (client, id) => client.removeQueries({ queryKey: KEYS.detail(id) }),
    invalidateScopedDetail: (client, id, organizationId) =>
      client.invalidateQueries({ queryKey: KEYS.scopedDetail(id, organizationId) }),
    setScopedDetail: (client, id, organizationId, data) =>
      client.setQueryData(KEYS.scopedDetail(id, organizationId), data),
    getScopedDetail: (client, id, organizationId) =>
      client.getQueryData<T>(KEYS.scopedDetail(id, organizationId)) ?? undefined,
    removeScopedDetail: (client, id, organizationId) =>
      client.removeQueries({ queryKey: KEYS.scopedDetail(id, organizationId) }),
    invalidateAggregations: (client, name) =>
      client.invalidateQueries({
        queryKey: name ? KEYS.aggregation(name) : KEYS.aggregations(),
      }),
  };
}
