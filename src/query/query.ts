"use client";

import {
  type InfiniteData,
  infiniteQueryOptions,
  keepPreviousData,
  type QueryClient,
  type QueryFunction,
  type QueryKey,
  queryOptions,
  type SkipToken,
  useInfiniteQuery,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import type { NextFetchOptions, RequestAuth } from "../client/client.js";

import {
  DEFAULT_QUERY_CONFIG,
  extractItem,
  extractItems,
  getItemId,
  normalizePagination,
  type PaginationData,
  QUERY_CONFIGS,
} from "./cache.js";

// ============================================================================
// Types
// ============================================================================

/** Request-level options passed through to the fetch call */
export interface RequestPassthrough {
  cache?: RequestCache;
  next?: NextFetchOptions;
  timeoutMs?: number;
  headerOptions?: Record<string, string>;
}

/** Any query function a factory or a caller builds (typed keys and page params included). */
// biome-ignore lint/suspicious/noExplicitAny: accepts every factory's typed query function
export type AnyQueryFunction = QueryFunction<any, any, any> | SkipToken;

export interface ListQueryOptions<TData = unknown> {
  public?: boolean;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
  structuralSharing?: boolean;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  /**
   * Keep showing the previous params' rows while the new ones load (TanStack `keepPreviousData`),
   * flagged by `isPlaceholderData`. Default `true` for `useList`: a filter or page change does
   * not flash an empty table.
   */
  keepPrevious?: boolean;
  /**
   * The server's response for EXACTLY this query (a Server Component fetched the same params),
   * as the raw wire payload `api.getAll` / `api.getById` returns. It seeds the cache, so the
   * client does not fetch again what the page already rendered. Pass it only for the params the
   * server used; a different filter must not inherit another page's data. Pair it with
   * `initialDataUpdatedAt` (when the server fetched) so `staleTime` decides the refetch.
   * The Server Component alternative is `streamQueries` / `prefetchQueries` (`./prefetch`) with
   * `HydrationBoundary`.
   */
  initialData?: unknown;
  /** When `initialData` was fetched (ms since epoch); defaults to now. */
  initialDataUpdatedAt?: number;
  /**
   * `"omit"`: read anonymously (no token, org, keys or cookies), so the request is the same as a
   * guest's and arc's http-cache can serve it from the CDN. Enabled without a session; cached
   * apart from signed-in reads. Only for endpoints that answer the same for everyone.
   */
  auth?: RequestAuth;
  /**
   * The tenant (`x-organization-id`) for this read. Omitted: the configured org. `null`: no org
   * header. An `organizationId` in `params` is a query-string filter, not this.
   */
  organizationId?: string | null;
  /** An explicit cache partition for two reads with equal params that must not share a cache. */
  scope?: string;
  /** Transform raw API response before returning. Runs on each render, receives raw data. */
  select?: (data: unknown) => TData;
  /** Pass-through options for the underlying fetch request (cache, next, headers) */
  request?: RequestPassthrough;
}

export interface DetailQueryOptions<TData = unknown> {
  public?: boolean;
  /** `"omit"`: read anonymously (see `ListQueryOptions.auth`). */
  auth?: RequestAuth;
  /** The tenant (`x-organization-id`). Omitted: the configured org. `null`: no org header. */
  organizationId?: string | null;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
  structuralSharing?: boolean;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  /**
   * The server's response for EXACTLY this query (a Server Component fetched the same params),
   * as the raw wire payload `api.getAll` / `api.getById` returns. It seeds the cache, so the
   * client does not fetch again what the page already rendered. Pass it only for the params the
   * server used; a different filter must not inherit another page's data. Pair it with
   * `initialDataUpdatedAt` (when the server fetched) so `staleTime` decides the refetch.
   * The Server Component alternative is `streamQueries` / `prefetchQueries` (`./prefetch`) with
   * `HydrationBoundary`.
   */
  initialData?: unknown;
  /** When `initialData` was fetched (ms since epoch); defaults to now. */
  initialDataUpdatedAt?: number;
  /** Query params passed to getById (e.g. select, populate) */
  params?: { select?: string; populate?: string | string[] };
  /** Transform raw API response before returning. Runs on each render, receives raw data. */
  select?: (data: unknown) => TData;
  /** Pass-through options for the underlying fetch request (cache, next, headers) */
  request?: RequestPassthrough;
}

/**
 * Result of `useList` (and `useListQuery`). Matches the same typed-end-to-end
 * shape `repo-core` uses for its server-side result interfaces (`AggResult`,
 * `OffsetPaginationResult`, etc.) — no raw-cache escape hatch on the public
 * surface, just the typed extracted view.
 *
 * Need the raw cache entry? Use `useQueryClient().getQueryData(KEYS.list(...))`
 * — it's typed against whatever `setQueryData` last wrote, and it makes the
 * "I'm reaching past the SDK" intent explicit.
 */
export interface ListQueryResult<T> {
  /**
   * The rows, `T[]`: arc's list `data` (offset, keyset and aggregate pages alike) or a bare
   * array response. Always typed and flat.
   */
  items: T[];
  /**
   * Normalized pagination snapshot — offset / keyset / aggregate all map
   * onto the same `{ method, total, pages, page, limit, hasNext, hasPrev, next? }`
   * shape. `null` when the response carries no pagination signal.
   */
  pagination: PaginationData | null;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  isStale: boolean;
  /** `true` while `items` are the previous params' rows (`keepPrevious`) and the new ones load. */
  isPlaceholderData: boolean;
  /**
   * When this list's own data last landed (ms epoch, TanStack `dataUpdatedAt`); `0` before the
   * first answer. For an "Updated 14:02" / "stale for 2 min" stamp read from the list itself.
   * Always set by this package's hooks; optional so result objects built by hand (adapters, test
   * doubles) still type-check.
   */
  dataUpdatedAt?: number;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/**
 * Result of `useDetail` (and `useDetailQuery`). Matches the typed-end-to-end
 * shape repo-core uses for its result interfaces — no raw-cache escape
 * hatch on the public surface, just the typed extracted view.
 *
 * Need the raw cache entry? `useQueryClient().getQueryData(KEYS.detail(id))`
 * — typed against whatever `setQueryData` last wrote, and the explicit
 * `getQueryData` call signals "I'm reaching past the SDK" at the call site.
 */
export interface DetailQueryResult<T> {
  /**
   * The extracted entity — `T | null`. Always typed, always the raw doc
   * (not a wrapper), always consistent with what a `queries.detail` prefetch /
   * `cache.getDetail` / `useNavigation` write back.
   */
  item: T | null;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
  isStale: boolean;
  /**
   * `true` while the detail GET is in flight and the consumer is seeing a
   * preview derived from a list cache entry (or any other `placeholderData`).
   * Use to dim or label the preview, e.g. `<article aria-busy={isPlaceholderData}>`.
   * Flips to `false` once the real detail payload resolves.
   */
  isPlaceholderData: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/**
 * A `select` whose identity is stable across renders while it always calls the latest closure.
 * TanStack re-runs `select` whenever its reference changes, so an inline arrow at a call site
 * (`select: (r) => r.items`) would re-project on every render (TanStack render-optimizations).
 */
function useStableSelect(
  select: ((data: unknown) => unknown) | undefined,
): ((data: unknown) => unknown) | undefined {
  const ref = useRef(select);
  ref.current = select;
  const stable = useCallback((data: unknown) => (ref.current ? ref.current(data) : data), []);
  return select ? stable : undefined;
}

// ============================================================================
// List Query Hook
// ============================================================================

export interface CreateListQueryConfig {
  queryKey: QueryKey;
  queryFn: AnyQueryFunction;
  enabled?: boolean;
  options?: Record<string, unknown>;
  select?: (data: unknown) => unknown;
  /** Show the previous key's rows while a new key loads (`isPlaceholderData`). Default `true`. */
  keepPrevious?: boolean;
}

/**
 * List query hook. Returns the canonical `{ items, pagination, ... }` shape
 * derived from arc's `PaginatedResult` wire envelope.
 *
 * **No detail-cache prefill.** Older revisions of this hook wrote each list
 * item into the detail cache via `setQueryData`. That pattern was wrong on
 * three counts: (1) it stored a `{ data: ... }` envelope that didn't match
 * arc 2.13+'s raw doc wire shape, (2) the fresh-default `staleTime` made
 * subsequent `useDetail` calls reuse the partial list payload and never fetch
 * the rich detail response, and (3) the unstable `detailKeyBuilder` ref made
 * the prefill effect re-run on every render, clobbering successful detail
 * fetches. The clean fix is on the read side: `useDetail` now reads list cache
 * directly via `placeholderData`, so the detail GET still fires while the
 * consumer sees an instant list-shaped preview. See `findItemInListCache`.
 */
export function useListQuery<T>({
  queryKey,
  queryFn,
  enabled = true,
  options = {},
  select,
  keepPrevious = true,
}: CreateListQueryConfig): ListQueryResult<T> {
  const stableSelect = useStableSelect(select);
  const query = useQuery({
    ...queryOptions({ queryKey, queryFn }),
    enabled,
    ...DEFAULT_QUERY_CONFIG,
    ...options,
    ...(stableSelect ? { select: stableSelect } : {}),
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });

  const items = useMemo(() => extractItems<T>(query.data), [query.data]);
  const pagination = useMemo(() => normalizePagination(query.data), [query.data]);

  return {
    items,
    pagination,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    isStale: query.isStale,
    isPlaceholderData: query.isPlaceholderData,
    dataUpdatedAt: query.dataUpdatedAt,
    error: query.error,
    refetch: query.refetch,
  };
}

// ============================================================================
// List → Detail placeholder lookup
// ============================================================================

/**
 * Find an item in any list cache for this entity by ID.
 *
 * Walks every `[entity, 'list', ...]` query (including scoped variants and
 * infinite-list page arrays) and extracts items via the permissive list
 * detector. Returns the first match — list payloads are subsets of detail
 * payloads, so the consumer sees an instant preview while the real detail
 * GET runs in the background.
 *
 * This is the canonical TanStack pattern for "show list data while fetching
 * detail": pass the returned value as `placeholderData` to `useDetail`. The
 * value isn't persisted to the detail cache (no pollution), `staleTime`
 * doesn't apply to it (always refetches), and `isPlaceholderData` is `true`
 * until the GET resolves.
 *
 * @param qc TanStack QueryClient (typically from `useQueryClient()`)
 * @param listsKey Prefix key for this entity's lists (e.g. `KEYS.lists()`)
 * @param id Item ID being requested
 * @param idField Optional custom ID field (matches `createCrudHooks({ idField })`)
 */
export function findItemInListCache<T>(
  qc: QueryClient,
  listsKey: QueryKey,
  id: string,
  idField?: string,
): T | undefined {
  if (!id) return undefined;
  const entries = qc.getQueriesData<unknown>({ queryKey: listsKey });
  for (const [, raw] of entries) {
    if (!raw) continue;
    // Infinite-query data is `{ pages: unknown[], pageParams: ... }`; flatten
    // pages so callers don't need to special-case the infinite shape.
    const pages =
      typeof raw === "object" && raw !== null && Array.isArray((raw as { pages?: unknown }).pages)
        ? (raw as { pages: unknown[] }).pages
        : [raw];
    for (const page of pages) {
      const items = extractItems<T>(page);
      for (const item of items) {
        const got = idField ? (item as Record<string, unknown> | null)?.[idField] : getItemId(item);
        if (got != null && String(got) === id) return item;
      }
    }
  }
  return undefined;
}

// ============================================================================
// Detail Query Hook
// ============================================================================

export interface CreateDetailQueryConfig<T = unknown> {
  queryKey: QueryKey;
  queryFn: AnyQueryFunction;
  enabled?: boolean;
  options?: Record<string, unknown>;
  select?: (data: unknown) => unknown;
  /**
   * Lazy placeholder. Returns a value (or `undefined`) on each render to show
   * before the detail GET resolves. Use with `findItemInListCache` to derive
   * an instant preview from list cache without polluting the detail cache —
   * the canonical TanStack pattern for "show list data while fetching detail."
   */
  placeholderData?: () => T | undefined;
}

export function useDetailQuery<T>({
  queryKey,
  queryFn,
  enabled = true,
  options = {},
  select,
  placeholderData,
}: CreateDetailQueryConfig<T>): DetailQueryResult<T> {
  const stableSelect = useStableSelect(select);
  const query = useQuery({
    ...queryOptions({ queryKey, queryFn }),
    enabled,
    ...DEFAULT_QUERY_CONFIG,
    ...options,
    ...(stableSelect ? { select: stableSelect } : {}),
    ...(placeholderData ? { placeholderData } : {}),
  });

  const item = extractItem<T>(query.data);

  return {
    item,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    isStale: query.isStale,
    isPlaceholderData: query.isPlaceholderData,
    error: query.error,
    refetch: query.refetch,
  };
}

// ============================================================================
// Suspense Query Hooks
// ============================================================================
//
// `useSuspenseQuery` variants for Suspense / streaming-SSR routes: the query
// always fetches (no `enabled` gate) and SUSPENDS until data resolves, so the
// component renders with `data` guaranteed-defined and never sees a loading
// branch — wrap the subtree in `<Suspense fallback={...}>` and an
// `<ErrorBoundary>` (errors throw to the boundary instead of populating
// `isError`). TanStack forbids `enabled` / `placeholderData` on the suspense
// hook, so these variants intentionally drop both (the list→detail
// `placeholderData` preview is a non-suspense feature — use `useDetailQuery`
// when you want it). The result shape mirrors the non-suspense hooks so call
// sites can switch between them with no other changes (`isLoading` is always
// `false`; `isPlaceholderData` is always `false`).

/** Suspense variant of {@link useListQuery}. Always enabled; suspends until resolved. */
export function useSuspenseListQuery<T>({
  queryKey,
  queryFn,
  options = {},
  select,
}: Omit<CreateListQueryConfig, "enabled">): ListQueryResult<T> {
  const stableSelect = useStableSelect(select);
  const query = useSuspenseQuery({
    ...queryOptions({ queryKey, queryFn: queryFn as QueryFunction<unknown> }),
    ...DEFAULT_QUERY_CONFIG,
    ...options,
    ...(stableSelect ? { select: stableSelect } : {}),
  });

  const items = useMemo(() => extractItems<T>(query.data), [query.data]);
  const pagination = useMemo(() => normalizePagination(query.data), [query.data]);

  return {
    items,
    pagination,
    isLoading: false,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    isStale: query.isStale,
    isPlaceholderData: false,
    dataUpdatedAt: query.dataUpdatedAt,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Suspense variant of {@link useDetailQuery}. Always enabled; suspends until resolved. */
export function useSuspenseDetailQuery<T>({
  queryKey,
  queryFn,
  options = {},
  select,
}: Omit<CreateDetailQueryConfig<T>, "enabled" | "placeholderData">): DetailQueryResult<T> {
  const stableSelect = useStableSelect(select);
  const query = useSuspenseQuery({
    ...queryOptions({ queryKey, queryFn: queryFn as QueryFunction<unknown> }),
    ...DEFAULT_QUERY_CONFIG,
    ...options,
    ...(stableSelect ? { select: stableSelect } : {}),
  });

  const item = extractItem<T>(query.data);

  return {
    item,
    isLoading: false,
    isFetching: query.isFetching,
    isError: query.isError,
    isSuccess: query.isSuccess,
    isStale: query.isStale,
    isPlaceholderData: false,
    error: query.error,
    refetch: query.refetch,
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
  /**
   * `"omit"`: read anonymously (no token, org, keys or cookies), so the request is the same as a
   * guest's and arc's http-cache can serve it from the CDN. Enabled without a session; cached
   * apart from signed-in reads. Only for endpoints that answer the same for everyone.
   */
  auth?: RequestAuth;
  /** An explicit cache partition for two reads with equal params that must not share a cache. */
  scope?: string;
  /** The tenant (`x-organization-id`). Omitted: the configured org. `null`: no org header. */
  organizationId?: string | null;
  request?: RequestPassthrough;
  /**
   * Max pages to keep in memory. Old pages are evicted and re-fetched on scroll-back.
   * Requires `getPreviousPageParam` for backward re-fetching.
   * When unset, all fetched pages are retained (default TanStack Query behavior).
   */
  maxPages?: number;
  /**
   * Keep showing the previous params' pages while the new first page loads
   * (`isPlaceholderData`). Default `false`: a new filter starts from a loading state.
   */
  keepPrevious?: boolean;
}

export interface InfiniteListQueryResult<T> {
  items: T[];
  /** `true` while the pages shown belong to the previous params (`keepPrevious`). */
  isPlaceholderData: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  isFetchingNextPage: boolean;
  isFetchingPreviousPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  fetchPreviousPage: () => Promise<unknown>;
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
  queryFn: AnyQueryFunction;
  enabled?: boolean;
  options?: Record<string, unknown>;
  initialPageParam?: unknown;
  getNextPageParam: (lastPage: unknown) => unknown;
  getPreviousPageParam?: (firstPage: unknown) => unknown;
  /** Max pages to keep in memory. Old pages are evicted when exceeded. */
  maxPages?: number;
  /** Show the previous key's pages while a new key loads (`isPlaceholderData`). Default `false`. */
  keepPrevious?: boolean;
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
  keepPrevious = false,
}: CreateInfiniteListQueryConfig): InfiniteListQueryResult<T> {
  const query = useInfiniteQuery({
    ...infiniteQueryOptions({
      queryKey,
      queryFn: queryFn as QueryFunction<unknown, QueryKey, unknown>,
      initialPageParam,
      getNextPageParam,
      getPreviousPageParam,
    }),
    enabled,
    ...(maxPages != null ? { maxPages } : {}),
    ...DEFAULT_QUERY_CONFIG,
    ...options,
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });

  const items = useMemo(
    () => query.data?.pages.flatMap((page) => extractItems<T>(page)) ?? [],
    [query.data],
  );

  return {
    items,
    isPlaceholderData: query.isPlaceholderData,
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
// Cursor pager: one page at a time over an infinite list
// ============================================================================

/** What {@link useCursorPager} reads: `useInfiniteList`'s result and TanStack's `useInfiniteQuery` fit. */
export interface CursorPagerSource {
  data: InfiniteData<unknown, unknown> | undefined;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
  isLoading: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/** Previous / Next paging state from {@link useCursorPager}. */
export interface CursorPager<T> {
  /** The rows of the page shown. */
  items: T[];
  /** 1-based index of the page shown. */
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** One page back (instant: the page is already held). */
  prev: () => void;
  /** One page forward: a held page at once, else exactly one fetch. */
  next: () => void;
  /** Move to a 1-based page: any held page, or the one right after the last held page. */
  goTo: (page: number) => void;
  isLoading: boolean;
  isFetching: boolean;
  /** `true` while the page shown belongs to the previous params (new ones still loading). */
  isPlaceholderData: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/**
 * Show ONE page of an infinite (keyset or offset) list at a time, with Previous / Next.
 *
 * A keyset list has no page numbers: each page carries the cursor of the next, so "Previous" has to
 * be remembered client-side. The infinite query already holds every fetched page (the cursor
 * stack); this keeps an index over them. A new `resetKey` (filters, sort, tenant: anything that
 * makes it a different list) starts at page 1, derived during render rather than reset in an
 * effect, so the stale page is never painted at the old index.
 *
 * `createCrudHooks(...).useCursorPager(params)` wires it to a resource; use this directly over a
 * custom route's `useInfiniteQuery` (with `placeholderData: keepPreviousData`).
 */
export function useCursorPager<T>(source: CursorPagerSource, resetKey: unknown): CursorPager<T> {
  const pages = useMemo(() => source.data?.pages ?? [], [source.data]);
  const key = typeof resetKey === "string" ? resetKey : JSON.stringify(resetKey ?? null);
  const [position, setPosition] = useState<{ key: string; index: number }>({ key, index: 0 });
  const index = position.key === key ? position.index : 0;

  const shown = Math.min(index, Math.max(0, pages.length - 1));
  const current = pages[shown];
  const hasNext = shown < pages.length - 1 || source.hasNextPage;
  const items = useMemo(() => extractItems<T>(current), [current]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = source;
  const goTo = useCallback(
    (page: number) => {
      const target = page - 1;
      if (target < 0) return;
      if (target < pages.length) {
        setPosition({ key, index: target });
        return;
      }
      if (target === pages.length && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage().then(() => setPosition({ key, index: target }));
      }
    },
    [key, pages.length, hasNextPage, isFetchingNextPage, fetchNextPage],
  );

  return {
    items,
    page: shown + 1,
    hasPrev: shown > 0,
    hasNext,
    prev: () => goTo(shown),
    next: () => goTo(shown + 2),
    goTo,
    isLoading: source.isLoading,
    isFetching: source.isFetching,
    isPlaceholderData: source.isPlaceholderData,
    error: source.error,
    refetch: source.refetch,
  };
}

// ============================================================================
// Generic API Query Hook (non-CRUD reads)
// ============================================================================

/** Recognized data-freshness presets. Maps to QUERY_CONFIGS. */
export type QueryFreshness = keyof typeof QUERY_CONFIGS;

/** Per-call request pass-through and TanStack Query overrides. */
export interface UseApiQueryOptions {
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
  refetchInterval?: number | false;
  refetchIntervalInBackground?: boolean;
  retry?: boolean | number;
  /** Limit re-renders to changes in these specific fields (perf optimization). */
  notifyOnChangeProps?: (
    | "data"
    | "error"
    | "isLoading"
    | "isFetching"
    | "isError"
    | "isSuccess"
    | "isStale"
  )[];
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
export function useApiQuery<TResponse = unknown, TData = TResponse>({
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
    ...queryOptions({ queryKey, queryFn }),
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
