// Public CRUD hook contracts. Runtime modules import these types without depending on hooks.ts.

import type { PaginatedResult } from "@classytic/repo-core/pagination";
import type { QueryKey, UseQueryResult } from "@tanstack/react-query";
import type { AggResult, AggRow, BaseApi, ScopedArgs } from "../client/api.js";
import type { ArcClient, RequestAuth } from "../client/client.js";
import type { BulkMethods } from "../client/presets/bulk.js";
import type { SearchPresetMethods } from "../client/presets/search.js";
import type { SlugLookupMethods } from "../client/presets/slug.js";
import type { SoftDeleteMethods } from "../client/presets/soft-delete.js";
import type { TreeMethods } from "../client/presets/tree.js";
import type { CacheUtils, QueryKeys } from "./cache.js";
import type { MutationCallbacks, MutationMessages, TransitionMutationReturn } from "./mutation.js";
import type {
  CursorPager,
  DetailQueryOptions,
  DetailQueryResult,
  InfiniteListQueryOptions,
  InfiniteListQueryResult,
  ListQueryOptions,
  ListQueryResult,
  RequestPassthrough,
} from "./query.js";
import type { EntityQueries } from "./query-options.js";

/** Per-call request options of an action mutation (`ScopedArgs["options"]`: no auth fields). */
export type ActionRequestOptions = NonNullable<ScopedArgs["options"]>;

// ============================================================================
// Types
// ============================================================================

/**
 * CRUD API interface accepted by createCrudHooks.
 *
 * Always-on surface (CRUD + universal helpers) is derived from BaseApi via Pick
 * so types stay in sync. Preset surfaces are optional intersections of the
 * corresponding `XxxMethods` interfaces, so a `withSearchPreset(api)` result
 * satisfies CrudApi & gets `searchEngine`/`searchSimilar`/`embed` typed without
 * any cast — yet a vanilla `createCrudApi('todos')` instance has none of them
 * in autocomplete unless you opt in.
 */
export type CrudApi<T = unknown, TCreate = Partial<T>, TUpdate = Partial<T>> = Pick<
  BaseApi<T, TCreate, TUpdate>,
  "getAll" | "getById" | "create" | "update" | "delete" | "count"
> & {
  upload?: BaseApi<T, TCreate, TUpdate>["upload"];
  dispatchAction?: BaseApi<T, TCreate, TUpdate>["dispatchAction"];
  invokeRoute?: BaseApi<T, TCreate, TUpdate>["invokeRoute"];
  /** Declared aggregations (arc 2.13+). Always available on BaseApi. */
  aggregate?: BaseApi<T, TCreate, TUpdate>["aggregate"];
  /** A document's concurrency version (`BaseApiConfig.versionField`). */
  versionOf?: BaseApi<T, TCreate, TUpdate>["versionOf"];
} & Partial<SoftDeleteMethods<T>> &
  Partial<BulkMethods<T, TCreate, TUpdate>> &
  Partial<SlugLookupMethods<T>> &
  Partial<TreeMethods<T>> &
  Partial<SearchPresetMethods<T>>;

/** Args + options for `useAggregation`. Mirrors `ListQueryOptions` for DX consistency. */
export interface AggregationQueryOptions<TRow extends AggRow = AggRow, TData = AggResult<TRow>> {
  /** Bypass auth gate (for public dashboards behind `allowPublic` permissions). */
  public?: boolean;
  /** `"omit"`: read anonymously (CDN-cacheable; see `ListQueryOptions.auth`). */
  auth?: RequestAuth;
  /** Skip the query (e.g. while a parent filter is being assembled). */
  enabled?: boolean;
  /** Per-call staleTime override. Defaults to factory's `defaults.staleTime`. */
  staleTime?: number;
  /** Per-call gcTime override. */
  gcTime?: number;
  /**
   * Refetch on window focus. Aggregations / dashboards usually want this OFF —
   * long-running compute. Defaults to `false` regardless of factory config.
   */
  refetchOnWindowFocus?: boolean;
  /** Periodic refetch (ms or `false`). Set for live dashboards. */
  refetchInterval?: number | false;
  /** Continue polling while the tab is in the background. */
  refetchIntervalInBackground?: boolean;
  /**
   * Transform `AggResult<TRow>` before exposing it. Common pattern is to
   * pluck the rows array directly:
   *   `select: (r) => r.rows`
   * Or compute a derived value:
   *   `select: (r) => r.rows.reduce((acc, x) => acc + x.total, 0)`
   * Runs on each render after structural-sharing dedupe.
   */
  select?: (data: AggResult<TRow>) => TData;
  /**
   * Pass-through to the underlying fetch call. Use for Next.js ISR — pass
   * `request: { next: { revalidate: 60, tags: ['orders'] } }` so the server-side fetch
   * cache participates in `revalidateTag('orders')` invalidations alongside
   * TanStack's client cache.
   */
  request?: RequestPassthrough;
  /**
   * Show this data while the real query is loading / re-fetching with
   * different filters. Smooths fast filter switches on dashboards.
   */
  placeholderData?:
    | AggResult<TRow>
    | ((prev: AggResult<TRow> | undefined) => AggResult<TRow> | undefined);
}

export interface CrudHooksConfig<T, TCreate = Partial<T>, TUpdate = Partial<T>> {
  api: CrudApi<T, TCreate, TUpdate>;
  entityKey: string;
  singular: string;
  plural?: string;
  /**
   * Primary key field used to extract item IDs from response data.
   * Used for cache key resolution, optimistic updates, and detail cache prefill.
   *
   * Default lookup order: `_id` → `id`.
   * Set this when your resource uses a custom ID field (e.g., `'sku'`, `'slug'`, `'code'`).
   *
   * @example
   * createCrudHooks({ idField: 'sku', ... }) // GET /products/:sku
   */
  idField?: string;
  defaults?: {
    staleTime?: number;
    gcTime?: number;
    refetchOnWindowFocus?: boolean;
    structuralSharing?: boolean;
    /**
     * Poll this resource's list/detail while mounted, in ms.
     *
     * Already supported PER CALL (`useList(params, { refetchInterval })`); this
     * is the resource-level default, so a resource whose freshness matters
     * declares it once instead of at every call site — and cannot be forgotten
     * at one of them.
     *
     * The case that motivated it: an orders dashboard left open on a shop
     * counter. Push notifications are best-effort, so the list is the
     * AUTHORITATIVE path to a new order — but with no interval it relied on
     * `refetchOnMount` / `refetchOnWindowFocus`, and a window that never blurs
     * never refocuses, so it may never refetch. A missed push then reads as a
     * missing record.
     */
    refetchInterval?: number | false;
    /**
     * Keep polling while the tab is hidden. Defaults to TanStack's `false`.
     *
     * Leave it off unless the data must be current the instant the operator
     * returns — a background tab polling forever is load nobody is reading, and
     * `refetchOnWindowFocus` already catches up on return.
     */
    refetchIntervalInBackground?: boolean;
    /**
     * Declare this resource's read endpoints PUBLIC (`allowPublic` on the
     * server — e.g. a storefront catalog). Read hooks then enable token-less
     * requests by default, so callers never have to pass `{ public: true }`
     * per hook. Leave unset for auth-gated resources (cart, orders, account) —
     * they keep the bearer token-gate. An explicit per-call `public` wins.
     */
    defaultPublic?: boolean;
    messages?: {
      createSuccess?: string;
      createError?: string;
      updateSuccess?: string;
      updateError?: string;
      deleteSuccess?: string;
      deleteError?: string;
    };
  };
  callbacks?: {
    onCreate?: MutationCallbacks<T, { data: TCreate }>;
    onUpdate?: MutationCallbacks<T, { id: string; data: TUpdate }>;
    onDelete?: MutationCallbacks<unknown, { id: string }>;
  };
  client?: ArcClient;
}

/** A CRUD write in flight, as `usePendingWrites` reports it. */
export type PendingWrite<TCreate, TUpdate> =
  | { op: "create"; variables: MutationParams<TCreate>; submittedAt: number }
  | { op: "update"; variables: UpdateParams<TUpdate>; submittedAt: number }
  | { op: "delete"; variables: DeleteParams; submittedAt: number };

export interface MutationParams<TData> {
  token?: string | null;
  organizationId?: string | null;
  data: TData;
}

export interface UpdateParams<TData> extends MutationParams<TData> {
  id: string;
  /**
   * Optimistic concurrency (needs `versionField` on the api). The version the
   * edit was based on, sent as `If-Match`; `null` = no precondition ("save
   * anyway" after a conflict). When omitted it is taken from `data[versionField]`
   * — a form that round-trips the document it loaded — then from the cached
   * document. Pass it explicitly when the form holds the version separately:
   * the cache may have been refetched since the user started editing.
   */
  version?: number | null;
}

export interface DeleteParams {
  token?: string | null;
  organizationId?: string | null;
  id: string;
}

export interface CallOptions<TData = unknown> {
  onSuccess?: (data: TData) => void;
  onError?: (error: Error) => void;
  onSettled?: (data: TData | undefined, error: Error | null) => void;
  silent?: boolean;
}

export interface CrudActions<T, TCreate, TUpdate> {
  create: (params: MutationParams<TCreate>, options?: CallOptions<T>) => Promise<T>;
  update: (params: UpdateParams<TUpdate>, options?: CallOptions<T>) => Promise<T>;
  remove: (params: DeleteParams, options?: CallOptions) => Promise<unknown>;
  /** Restore a soft-deleted item. Only available when backend has softDelete preset. */
  restore: (params: DeleteParams, options?: CallOptions<T>) => Promise<T>;
  isCreating: boolean;
  isUpdating: boolean;
  isDeleting: boolean;
  isRestoring: boolean;
  isMutating: boolean;
}

export interface BulkActions<T, TCreate> {
  bulkCreate: (
    params: { data: TCreate[]; token?: string | null; organizationId?: string | null },
    options?: CallOptions<T[]>,
  ) => Promise<T[]>;
  bulkUpdate: (
    params: {
      filter: Record<string, unknown>;
      data: Partial<T>;
      token?: string | null;
      organizationId?: string | null;
    },
    options?: CallOptions,
  ) => Promise<unknown>;
  bulkRemove: (
    params: {
      filter: Record<string, unknown>;
      token?: string | null;
      organizationId?: string | null;
    },
    options?: CallOptions,
  ) => Promise<unknown>;
  isBulkCreating: boolean;
  isBulkUpdating: boolean;
  isBulkDeleting: boolean;
}

export interface NavigationOptions {
  scroll?: boolean;
  replace?: boolean;
}

export type NavigateFn<T> = (href: string, item: T, options?: NavigationOptions) => void;

export interface CrudHooksReturn<T, TCreate, TUpdate> {
  KEYS: QueryKeys;
  /**
   * The resource's option factories (`createEntityQueries`), the same ones every hook here is
   * built from: `useQuery(hooks.queries.list(params))`, `streamQueries([hooks.queries.detail(id)])`
   * in a Server Component, `useMutation(hooks.queries.update())`.
   */
  queries: EntityQueries<T, TCreate, TUpdate>;
  cache: CacheUtils<T>;
  /** Reads with the configured auth context (token + org), or anonymously with `auth: "omit"`. */
  useList: (params?: Record<string, unknown>, options?: ListQueryOptions) => ListQueryResult<T>;
  useDetail: (id: string | null, options?: DetailQueryOptions) => DetailQueryResult<T>;
  /**
   * This resource's CRUD writes still in flight, newest last, from TanStack's mutation cache
   * (`useMutationState`): render a pending row from `variables` without touching the query cache,
   * in any component, even one that did not start the write.
   */
  usePendingWrites: () => PendingWrite<TCreate, TUpdate>[];
  /**
   * Suspense variant of `useList` for Suspense / streaming-SSR routes. Always
   * fetches and SUSPENDS until resolved — wrap the subtree in `<Suspense>` and
   * an error boundary. No `enabled` gate and no `keepPreviousData` preview
   * (TanStack forbids both on suspense queries); `isLoading` is always `false`.
   */
  useSuspenseList: (
    params?: Record<string, unknown>,
    options?: Omit<ListQueryOptions, "enabled">,
  ) => ListQueryResult<T>;
  /**
   * Suspense variant of `useDetail`. `id` must be present (it always fetches).
   * Suspends until resolved; no list→detail `placeholderData` preview.
   */
  useSuspenseDetail: (
    id: string,
    options?: Omit<DetailQueryOptions, "enabled">,
  ) => DetailQueryResult<T>;
  useInfiniteList: (
    params?: Record<string, unknown>,
    options?: InfiniteListQueryOptions,
  ) => InfiniteListQueryResult<T>;
  /**
   * Previous / Next over a keyset (or offset) list, ONE page at a time: the infinite list keeps
   * every fetched page (the cursor stack), Previous is instant, Next past the last page fetches
   * exactly one more, and new params (filters, sort, tenant) start again at page 1 while the old
   * page stays on screen (`keepPrevious`, `isPlaceholderData`) until the new one lands.
   */
  useCursorPager: (
    params?: Record<string, unknown>,
    options?: Omit<InfiniteListQueryOptions, "maxPages">,
  ) => CursorPager<T>;
  useActions: () => CrudActions<T, TCreate, TUpdate>;
  useBulkActions: () => BulkActions<T, TCreate>;
  useDeleted: (params?: Record<string, unknown>, options?: ListQueryOptions) => ListQueryResult<T>;
  /** Count-only query via arc's `?_count=true` dispatch verb — zero documents fetched. */
  useCount: (
    params?: Record<string, unknown>,
    options?: {
      enabled?: boolean;
      public?: boolean;
      auth?: RequestAuth;
      staleTime?: number;
      gcTime?: number;
    },
  ) => UseQueryResult<number, Error>;
  useDetailBySlug: (slug: string | null, options?: DetailQueryOptions) => DetailQueryResult<T>;
  useTree: (params?: Record<string, unknown>, options?: ListQueryOptions) => ListQueryResult<T>;
  useChildren: (
    parentId: string | null,
    params?: Record<string, unknown>,
    options?: ListQueryOptions,
  ) => ListQueryResult<T>;
  /**
   * Mutation against arc's unified action router (`POST /:id/action`).
   * Server discriminates on `body.action`. Use for state transitions
   * (approve/cancel/dispatch) instead of bespoke routes.
   */
  useAction: <
    TResult = T,
    TBody extends Record<string, unknown> = Record<string, unknown>,
  >(options?: {
    invalidateQueries?: QueryKey[];
    /** Default action name. Can be overridden per-call via `mutate({ action })`. */
    action?: string;
    messages?: MutationMessages<TResult, { id: string; action?: string; data?: TBody }>;
    onSuccess?: (data: TResult, variables: { id: string; action: string; data?: TBody }) => void;
    onError?: (error: Error, variables: { id: string; action: string; data?: TBody }) => void;
    onSettled?: (
      data: TResult | undefined,
      error: Error | null,
      variables: { id: string; action: string; data?: TBody },
    ) => void;
  }) => TransitionMutationReturn<
    TResult,
    {
      id: string;
      action?: string;
      data?: TBody;
      /** Per-call request options (`idempotencyKey`, `signal`, `headerOptions`); not in the body. */
      options?: ActionRequestOptions;
    }
  >;
  /** Mutation against the search-preset POST `/search` route. */
  useSearchEngine: <
    TResult = T,
    TBody extends Record<string, unknown> = Record<string, unknown>,
  >(options?: {
    path?: string;
    messages?: MutationMessages<
      TResult[] | PaginatedResult<TResult>,
      { query?: string; body?: TBody }
    >;
    invalidateQueries?: QueryKey[];
  }) => TransitionMutationReturn<
    TResult[] | PaginatedResult<TResult>,
    { query?: string; body?: TBody }
  >;
  /** Mutation against the search-preset POST `/search-similar` route. */
  useSearchSimilar: <
    TResult = T,
    TBody extends Record<string, unknown> = Record<string, unknown>,
  >(options?: {
    path?: string;
    messages?: MutationMessages<
      TResult[] | PaginatedResult<TResult>,
      { query?: string; vector?: number[]; body?: TBody }
    >;
    invalidateQueries?: QueryKey[];
  }) => TransitionMutationReturn<
    TResult[] | PaginatedResult<TResult>,
    { query?: string; vector?: number[]; body?: TBody }
  >;
  /** Mutation against the search-preset POST `/embed` route. */
  useEmbed: (options?: {
    path?: string;
    messages?: MutationMessages;
    invalidateQueries?: QueryKey[];
  }) => TransitionMutationReturn<
    unknown,
    { input: string | string[]; body?: Record<string, unknown> }
  >;
  /**
   * Query against arc's declarative aggregations (arc v2.13+).
   * `GET /:resource/aggregations/:name` — wire shape `{ rows: TRow[] }`.
   *
   * Cached under `KEYS.aggregation(name, filter)` so multiple call sites with
   * the same args share one cache entry. Mutation hooks
   * (`useActions`/`useBulkActions`) auto-invalidate count and aggregation
   * queries so dashboards refresh after CRUD writes — opt out via the mutation's
   * `invalidateQueries` override if you want stale-on-write.
   *
   * @example
   * const { data } = useAggregation<{ day: string; total: number }>({
   *   name: 'salesByDay',
   *   filter: { from: '2025-01-01' },
   *   refetchOnWindowFocus: false,
   * });
   * // data.rows: Array<{ day: string; total: number }>
   */
  useAggregation: <TRow extends AggRow = AggRow, TData = AggResult<TRow>>(
    args: {
      name: string;
      filter?: Record<string, unknown>;
    } & AggregationQueryOptions<TRow, TData>,
  ) => UseQueryResult<TData>;
  useUpload: (options?: {
    invalidateQueries?: QueryKey[];
    messages?: MutationMessages;
    onSuccess?: (data: unknown) => void;
    onError?: (error: Error) => void;
    onSettled?: (data: unknown | undefined, error: Error | null) => void;
  }) => TransitionMutationReturn<unknown, { data: FormData; id?: string; path?: string }>;
  useCustomMutation: <TData = unknown, TVariables = unknown>(config: {
    mutationFn: (variables: TVariables) => Promise<TData>;
    invalidateQueries?: QueryKey[];
    messages?: MutationMessages<TData, TVariables>;
    onSuccess?: (data: TData, variables: TVariables) => void;
    onError?: (error: Error, variables: TVariables) => void;
    onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables) => void;
  }) => TransitionMutationReturn<TData, TVariables>;
  /**
   * Subscribe to live CRUD broadcasts and auto-invalidate this resource's
   * cache. Drop in alongside `createCrudHooks` and every `useList` /
   * `useDetail` rerenders when the backend emits `<resource>.<op>`.
   *
   * `source: 'ws'` uses arc's `websocketPlugin` (`/ws`); `source: 'sse'` uses
   * `ssePlugin` (`/events/stream`). Pass `enabled: false` to opt out.
   */
  useResourceSync: (options?: {
    source?: "ws" | "sse";
    /** Override resource name. Defaults to the factory's `entityKey`. */
    resource?: string;
    /** Override path (default: `/ws` or `/events/stream`). */
    path?: string;
    /** Whether the connection is active. Default: true. */
    enabled?: boolean;
    /** Per-event hook fired AFTER cache invalidation. */
    onEvent?: (event: {
      operation: "created" | "updated" | "deleted";
      id?: string;
      data: unknown;
    }) => void;
    /** Connection-state listener. */
    onConnectionChange?: (connected: boolean) => void;
  }) => { isConnected: boolean };
  useNavigation: () => NavigateFn<T>;
}
