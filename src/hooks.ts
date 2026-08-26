"use client";

import type { PaginatedResult } from "@classytic/repo-core/pagination";
import {
  type QueryKey,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AggResult, AggRow, BaseApi } from "./api.js";
import { isKeysetPagination, isOffsetPagination } from "./api.js";
import type { CacheUtils, QueryKeys } from "./cache.js";
// Utilities live in the server-safe cache module — import directly so this
// hook layer doesn't accidentally take a dependency on a client-marked path.
import {
  createCacheUtils,
  createQueryKeys,
  DEFAULT_QUERY_CONFIG,
  extractItem,
  getItemId,
  prependToListCache,
  replaceItemInListCache,
  syncDetailToLists,
  updateListCache,
  withOrgParams,
} from "./cache.js";
import type { ArcClient, ToastHandler, UseRouterHook } from "./client.js";
import { getAuthMode, getClientAuthContext, hasGlobalStaticAuth } from "./client.js";
import type { MutationCallbacks, MutationMessages, TransitionMutationReturn } from "./mutation.js";
import { useMutationWithTransition, useOptimisticMutation } from "./mutation.js";
import type { BulkMethods } from "./presets/bulk.js";
import type { SearchPresetMethods } from "./presets/search.js";
import type { SlugLookupMethods } from "./presets/slug.js";
import type { SoftDeleteMethods } from "./presets/soft-delete.js";
import type { TreeMethods } from "./presets/tree.js";
import type {
  DetailQueryOptions,
  DetailQueryResult,
  InfiniteListQueryOptions,
  InfiniteListQueryResult,
  ListQueryOptions,
  ListQueryResult,
  RequestPassthrough,
} from "./query.js";
import {
  findItemInListCache,
  useDetailQuery,
  useInfiniteListQuery,
  useListQuery,
  useSuspenseDetailQuery,
  useSuspenseListQuery,
} from "./query.js";
import { type CrudOperation, subscribeToEvents } from "./sse.js";
import { connectWs } from "./ws.js";

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
} & Partial<SoftDeleteMethods<T>> &
  Partial<BulkMethods<T, TCreate, TUpdate>> &
  Partial<SlugLookupMethods<T>> &
  Partial<TreeMethods<T>> &
  Partial<SearchPresetMethods<T>>;

/** Args + options for `useAggregation`. Mirrors `ListQueryOptions` for DX consistency. */
export interface AggregationQueryOptions<TRow extends AggRow = AggRow, TData = AggResult<TRow>> {
  /** Bypass auth gate (for public dashboards behind `allowPublic` permissions). */
  public?: boolean;
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
   * `request: { revalidate: 60, tags: ['orders'] }` so the server-side fetch
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

export interface MutationParams<TData> {
  token?: string | null;
  organizationId?: string | null;
  data: TData;
}

export interface UpdateParams<TData> extends MutationParams<TData> {
  id: string;
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
  cache: CacheUtils<T>;
  useList: {
    /** New signature — auto-injects token/orgId from configureAuth() context */
    (params?: Record<string, unknown>, options?: ListQueryOptions<T>): ListQueryResult<T>;
    /** Legacy signature — explicit token */
    (
      token: string | null,
      params?: Record<string, unknown>,
      options?: ListQueryOptions<T>,
    ): ListQueryResult<T>;
  };
  useDetail: {
    /** New signature — auto-injects token from configureAuth() context */
    (id: string | null, options?: DetailQueryOptions<T>): DetailQueryResult<T>;
    /** Legacy signature — explicit token */
    (
      id: string | null,
      token: string | null,
      options?: DetailQueryOptions<T>,
    ): DetailQueryResult<T>;
  };
  /**
   * Suspense variant of `useList` for Suspense / streaming-SSR routes. Always
   * fetches and SUSPENDS until resolved — wrap the subtree in `<Suspense>` and
   * an error boundary. No `enabled` gate and no `keepPreviousData` preview
   * (TanStack forbids both on suspense queries); `isLoading` is always `false`.
   */
  useSuspenseList: (
    params?: Record<string, unknown>,
    options?: Omit<ListQueryOptions<T>, "enabled">,
  ) => ListQueryResult<T>;
  /**
   * Suspense variant of `useDetail`. `id` must be present (it always fetches).
   * Suspends until resolved; no list→detail `placeholderData` preview.
   */
  useSuspenseDetail: (
    id: string,
    options?: Omit<DetailQueryOptions<T>, "enabled">,
  ) => DetailQueryResult<T>;
  useInfiniteList: {
    /** New signature — auto-injects token/orgId from configureAuth() context */
    (
      params?: Record<string, unknown>,
      options?: InfiniteListQueryOptions,
    ): InfiniteListQueryResult<T>;
    /** Legacy signature — explicit token */
    (
      token: string | null,
      params?: Record<string, unknown>,
      options?: InfiniteListQueryOptions,
    ): InfiniteListQueryResult<T>;
  };
  useActions: () => CrudActions<T, TCreate, TUpdate>;
  useBulkActions: () => BulkActions<T, TCreate>;
  useDeleted: (
    params?: Record<string, unknown>,
    options?: ListQueryOptions<T>,
  ) => ListQueryResult<T>;
  /** Count-only query via arc's `?_count=true` dispatch verb — zero documents fetched. */
  useCount: (
    params?: Record<string, unknown>,
    options?: { enabled?: boolean; staleTime?: number; gcTime?: number },
  ) => UseQueryResult<number, Error>;
  useDetailBySlug: (slug: string | null, options?: DetailQueryOptions<T>) => DetailQueryResult<T>;
  useTree: (params?: Record<string, unknown>, options?: ListQueryOptions<T>) => ListQueryResult<T>;
  useChildren: (
    parentId: string | null,
    params?: Record<string, unknown>,
    options?: ListQueryOptions<T>,
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
  }) => TransitionMutationReturn<TResult, { id: string; action?: string; data?: TBody }>;
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
   * (`useActions`/`useBulkActions`) auto-invalidate `KEYS.aggregations()` so
   * dashboards refresh after CRUD writes — opt out via the mutation's
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

// ============================================================================
// Navigation Configuration (Global)
// ============================================================================

let useRouterHook: UseRouterHook | null = null;

/**
 * Configure the router hook for useNavigation. Call once at app init.
 *
 * **SSR safety:** This sets module-level state. Call only in client-side code.
 *
 * @example
 * import { useRouter } from "next/navigation";
 * configureNavigation(useRouter);
 */
export function configureNavigation(hook: UseRouterHook): void {
  useRouterHook = hook;
}

// ============================================================================
// Enabled Rule
// ============================================================================

function createEnabledRule(
  token: string | null,
  options: { public?: boolean; enabled?: boolean },
  authMode: "bearer" | "cookie" | "header" = getAuthMode(),
  hasStaticAuth = false,
): boolean {
  // Cookie auth or public: always enabled
  if (authMode === "cookie" || options.public) {
    return options.enabled ?? true;
  }
  // Static auth (defaultHeaders, internalApiKey, per-client headers): always enabled
  if (hasStaticAuth) {
    return options.enabled ?? true;
  }
  // Bearer/header auth: require token
  return options.enabled !== undefined ? options.enabled && !!token : !!token;
}

// ============================================================================
// Create CRUD Hooks Factory
// ============================================================================

export function createCrudHooks<T, TCreate = Partial<T>, TUpdate = Partial<T>>({
  api,
  entityKey,
  singular,
  plural,
  idField,
  defaults = {},
  callbacks = {},
  client,
}: CrudHooksConfig<T, TCreate, TUpdate>): CrudHooksReturn<T, TCreate, TUpdate> {
  const pluralName = plural ?? `${singular}s`;

  /** Resolve auth context — per-client auth takes priority over global */
  const resolveAuth = () => getClientAuthContext(client);

  /**
   * Whether auth is provided via static config — no per-request token needed.
   * Sources (in priority order):
   *   1. Per-client `defaultHeaders` / `internalApiKey` (when `client` is passed in).
   *   2. Per-client custom auth (e.g. `createClient({ getToken })`).
   *   3. Global `configureClient({ internalApiKey | defaultHeaders | authMode: 'cookie' })`.
   *
   * Resolved lazily on every render so that an app calling `configureClient`
   * inside a "use client" provider after factory creation still picks up the
   * global static-auth signal — previously a global `internalApiKey` was
   * ignored, leaving every protected query stuck in a permanently-disabled state.
   */
  const resolveHasStaticAuth = () =>
    !!(client?.config?.defaultHeaders || client?.config?.internalApiKey || client?.auth) ||
    hasGlobalStaticAuth();

  /** Extract ID from an item using configured idField, falling back to _id → id */
  function resolveItemId(item: unknown): string | null {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    if (idField) {
      const val = obj[idField];
      if (val != null) return String(val);
    }
    return getItemId(item);
  }
  const KEYS = createQueryKeys(entityKey);
  const cache = createCacheUtils<T>(KEYS);

  /**
   * Shared identity for this resource's write mutations (create / update /
   * delete). Powers last-standing invalidation in `useOptimisticMutation`:
   * rapid sequential writes trigger ONE settled refetch instead of N racing
   * ones, so an early write's refetch can never clobber a later write's
   * optimistic state.
   */
  const WRITE_MUTATION_KEY = [entityKey, "write"] as const;

  /**
   * Per-record write ordering. `update`/`remove`/`restore` calls against the
   * SAME record are chained (call order = server application order = cache
   * application order); writes to different records stay fully parallel. A
   * failed write does not block the next one — each link runs regardless of
   * the previous outcome. Factory-scoped so every component using this
   * resource's hooks shares one chain per record.
   */
  const writeChains = new Map<string, Promise<unknown>>();
  function enqueueWrite<R>(recordId: string, run: () => Promise<R>): Promise<R> {
    const prev = writeChains.get(recordId) ?? Promise.resolve();
    const result = prev.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    writeChains.set(recordId, tail);
    tail.then(() => {
      if (writeChains.get(recordId) === tail) writeChains.delete(recordId);
    });
    return result;
  }

  // Resolve toast handler: client instance → global
  const instanceToast: ToastHandler | undefined = client?.toast;
  // Resolve navigation hook: client instance → global
  const instanceNavigation: UseRouterHook | null = client?.navigation ?? null;
  // Resolve auth mode: client instance → global (fixes multi-client query enablement)
  // Lazy: read at query time, not factory time (global config can change after createCrudHooks)
  const resolveAuthMode = () => client?.config?.authMode ?? getAuthMode();

  const config = {
    ...DEFAULT_QUERY_CONFIG,
    ...defaults,
    structuralSharing: defaults.structuralSharing,
    messages: {
      createSuccess: `${singular} created successfully`,
      createError: `Failed to create ${singular.toLowerCase()}`,
      updateSuccess: `${singular} updated successfully`,
      updateError: `Failed to update ${singular.toLowerCase()}`,
      deleteSuccess: `${singular} deleted successfully`,
      deleteError: `Failed to delete ${singular.toLowerCase()}`,
      ...defaults.messages,
    },
  };

  // `enabled` for every read hook below. When this resource is declared
  // `defaultPublic: true` (its endpoints are `allowPublic` — e.g. a storefront
  // catalog), a token-less read is enabled by DEFAULT, so consumers never have
  // to remember `{ public: true }` per call (the bug class where a public read
  // silently returns empty for unauthenticated visitors). Crucially this is
  // PER-RESOURCE, not per-subtree: catalog defaults public; cart/orders/account
  // stay token-gated. An explicit per-call `public`/`enabled` still wins. A
  // plain function (not a hook) so it composes with each hook's own `extraGate`
  // (`!!id`, `!!api.getTree`) with no rules-of-hooks hazard. The auth token is
  // still SENT when present, so an authed caller (dashboard) is unaffected.
  const computeEnabled = (
    token: string | null,
    options: { public?: boolean; enabled?: boolean },
    extraGate = true,
  ): boolean => {
    const merged =
      options.public === undefined && config.defaultPublic ? { ...options, public: true } : options;
    return extraGate && createEnabledRule(token, merged, resolveAuthMode(), resolveHasStaticAuth());
  };

  // ========== useList ==========

  function useList(
    tokenOrParams?: string | null | Record<string, unknown>,
    paramsOrOptions?: Record<string, unknown> | ListQueryOptions,
    maybeOptions?: ListQueryOptions,
  ): ListQueryResult<T> {
    let token: string | null;
    let params: Record<string, unknown>;
    let options: ListQueryOptions;

    // Detect which overload:
    // Legacy: useList(token: string|null, params, options) — string first arg, or null with 3 args
    // New:    useList(params?, options?) — object/undefined first arg, or null with ≤2 args
    const isLegacy =
      typeof tokenOrParams === "string" || (tokenOrParams === null && maybeOptions !== undefined);

    if (isLegacy) {
      token = tokenOrParams as string | null;
      params = (paramsOrOptions as Record<string, unknown>) ?? {};
      options = maybeOptions ?? {};
    } else {
      const auth = resolveAuth();
      token = auth.token;
      params = (tokenOrParams as Record<string, unknown>) ?? {};
      options = (paramsOrOptions as ListQueryOptions) ?? {};
      if (auth.organizationId && !params.organizationId) {
        params = { ...params, organizationId: auth.organizationId };
      }
    }

    const { organizationId, ...restParams } = params;
    const scope = options._scope || (organizationId ? "tenant" : "super-admin");
    const { request: requestOpts, ...queryOpts } = options;

    return useListQuery<T>({
      // withOrgParams: omit nullish org from the KEY (hash parity with the
      // server prefetcher — `{organizationId: null}` would be a distinct hash).
      queryKey: KEYS.scopedList(
        scope,
        withOrgParams(organizationId as string | null | undefined, restParams),
      ),
      queryFn: ({ signal }) =>
        api.getAll({
          token,
          organizationId: organizationId as string | null,
          params: restParams,
          options: { signal, ...requestOpts },
        }),
      enabled: computeEnabled(token, queryOpts),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
        refetchOnWindowFocus: queryOpts.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: queryOpts.structuralSharing ?? config.structuralSharing,
        // `??` so an explicit per-call `false` still disables polling — a
        // `||` here would let the resource default override it.
        refetchInterval: queryOpts.refetchInterval ?? config.refetchInterval,
        refetchIntervalInBackground:
          queryOpts.refetchIntervalInBackground ?? config.refetchIntervalInBackground,
      },
      select: queryOpts.select,
    });
    // NOTE: we deliberately do NOT fan-out from list → detail. Bidirectional
    // sync creates a last-write-wins race when list + detail both fetch
    // around the same time: list payloads are typically stale-er than the
    // detail GET response (lists often use `select=...` to drop fields the
    // detail GET fully populates), so a post-fetch list → detail merge
    // overwrites the rich detail value with the trimmed list one. The
    // canonical flow is detail → list (detail is the authoritative read for
    // a single doc), implemented in `useDetail` below.
  }

  // ========== useDetail ==========

  function useDetail(
    id: string | null,
    tokenOrOptions?: string | null | DetailQueryOptions,
    maybeOptions?: DetailQueryOptions,
  ): DetailQueryResult<T> {
    let token: string | null;
    let options: DetailQueryOptions;

    // Legacy: useDetail(id, token, options) — string/null second arg with 3rd arg present
    // New:    useDetail(id, options?) — object/undefined second arg
    const isLegacy =
      typeof tokenOrOptions === "string" || (tokenOrOptions === null && maybeOptions !== undefined);

    if (isLegacy) {
      token = tokenOrOptions as string | null;
      options = maybeOptions ?? {};
    } else {
      const auth = resolveAuth();
      token = auth.token;
      options = (tokenOrOptions as DetailQueryOptions) ?? {};
      if (auth.organizationId && !options.organizationId) {
        options = { ...options, organizationId: auth.organizationId };
      }
    }

    const { organizationId, params: queryParams, request: requestOpts, ...restOptions } = options;

    const detailKey = KEYS.scopedDetail(id || "", organizationId ?? null);
    const fullDetailKey = queryParams ? [...detailKey, queryParams] : detailKey;

    // Lazy placeholder: when a parent `useList` (or `useInfiniteList`) already
    // has this entity in cache, show that subset instantly while the detail
    // GET runs in the background. `placeholderData` is the canonical TanStack
    // pattern for this — it does NOT persist to the detail cache (no
    // pollution), `staleTime` doesn't apply to it (the GET always fires), and
    // consumers can dim the preview via `isPlaceholderData` until the rich
    // detail payload resolves.
    const queryClient = useQueryClient();
    const listPlaceholder = useCallback(
      () => (id ? findItemInListCache<T>(queryClient, KEYS.lists(), id, idField) : undefined),
      [queryClient, id],
    );

    const detailResult = useDetailQuery<T>({
      queryKey: fullDetailKey,
      queryFn: ({ signal }) =>
        api.getById({
          id: id ?? "",
          token,
          organizationId,
          params: queryParams,
          options: { signal, ...requestOpts },
        }),
      enabled: computeEnabled(token, restOptions, !!id),
      options: {
        staleTime: restOptions.staleTime ?? config.staleTime,
        gcTime: restOptions.gcTime ?? config.gcTime,
        refetchOnWindowFocus: restOptions.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: restOptions.structuralSharing ?? config.structuralSharing,
        refetchInterval: restOptions.refetchInterval,
        refetchIntervalInBackground: restOptions.refetchIntervalInBackground,
      },
      select: restOptions.select,
      placeholderData: listPlaceholder,
    });

    // Pseudo-normalization: when this detail GET resolves with fresh data,
    // shallow-merge the new fields into every list cache containing this id.
    // Keeps list views in sync without an extra refetch. See `syncDetailToLists`
    // JSDoc in cache.ts for the rationale + scope. Skipped while the value is
    // a placeholder so we don't fan-out the list-shape preview back to lists
    // (would be a no-op shallow merge but burns CPU per render).
    useEffect(() => {
      if (!detailResult.item || detailResult.isPlaceholderData) return;
      syncDetailToLists(
        queryClient,
        KEYS.lists(),
        detailResult.item as unknown as Record<string, unknown>,
        idField ? { idField } : {},
      );
    }, [detailResult.item, detailResult.isPlaceholderData, queryClient]);

    return detailResult;
  }

  // ========== useSuspenseList / useSuspenseDetail ==========
  // Suspense variants for Suspense / streaming-SSR routes. Auth/orgId are
  // auto-resolved (same as the new-signature useList/useDetail). They always
  // fetch and suspend — no `enabled` gate, no list→detail placeholder preview.

  function useSuspenseList(
    params: Record<string, unknown> = {},
    options: Omit<ListQueryOptions<T>, "enabled"> = {},
  ): ListQueryResult<T> {
    const auth = resolveAuth();
    const token = auth.token;
    let resolvedParams = params;
    if (auth.organizationId && !resolvedParams.organizationId) {
      resolvedParams = { ...resolvedParams, organizationId: auth.organizationId };
    }
    const { organizationId, ...restParams } = resolvedParams;
    const scope = options._scope || (organizationId ? "tenant" : "super-admin");
    const { request: requestOpts, ...queryOpts } = options;

    return useSuspenseListQuery<T>({
      queryKey: KEYS.scopedList(scope, { organizationId, ...restParams }),
      queryFn: ({ signal }) =>
        api.getAll({
          token,
          organizationId: organizationId as string | null,
          params: restParams,
          options: { signal, ...requestOpts },
        }),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
        refetchOnWindowFocus: queryOpts.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: queryOpts.structuralSharing ?? config.structuralSharing,
        // `??` so an explicit per-call `false` still disables polling — a
        // `||` here would let the resource default override it.
        refetchInterval: queryOpts.refetchInterval ?? config.refetchInterval,
        refetchIntervalInBackground:
          queryOpts.refetchIntervalInBackground ?? config.refetchIntervalInBackground,
      },
      select: queryOpts.select,
    });
  }

  function useSuspenseDetail(
    id: string,
    options: Omit<DetailQueryOptions<T>, "enabled"> = {},
  ): DetailQueryResult<T> {
    const auth = resolveAuth();
    const token = auth.token;
    let opts = options;
    if (auth.organizationId && !opts.organizationId) {
      opts = { ...opts, organizationId: auth.organizationId };
    }
    const { organizationId, params: queryParams, request: requestOpts, ...restOptions } = opts;

    const detailKey = KEYS.scopedDetail(id, organizationId ?? null);
    const fullDetailKey = queryParams ? [...detailKey, queryParams] : detailKey;

    const queryClient = useQueryClient();
    const detailResult = useSuspenseDetailQuery<T>({
      queryKey: fullDetailKey,
      queryFn: ({ signal }) =>
        api.getById({
          id,
          token,
          organizationId,
          params: queryParams,
          options: { signal, ...requestOpts },
        }),
      options: {
        staleTime: restOptions.staleTime ?? config.staleTime,
        gcTime: restOptions.gcTime ?? config.gcTime,
        refetchOnWindowFocus: restOptions.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: restOptions.structuralSharing ?? config.structuralSharing,
        refetchInterval: restOptions.refetchInterval,
        refetchIntervalInBackground: restOptions.refetchIntervalInBackground,
      },
      select: restOptions.select,
    });

    // Same detail → list fan-out as `useDetail` so list views stay in sync.
    useEffect(() => {
      if (!detailResult.item) return;
      syncDetailToLists(
        queryClient,
        KEYS.lists(),
        detailResult.item as unknown as Record<string, unknown>,
        idField ? { idField } : {},
      );
    }, [detailResult.item, queryClient]);

    return detailResult;
  }

  // ========== useActions ==========

  function useActions(): CrudActions<T, TCreate, TUpdate> {
    const queryClient = useQueryClient();
    const silentRef = useRef(false);
    const shouldToast = useCallback(() => !silentRef.current, []);
    // Temp id per mutate() call, keyed on the variables object TanStack
    // threads through onMutate → onSuccess — lets `reconcile` find the
    // exact optimistic placeholder this call inserted, even with several
    // concurrent creates in flight.
    const tempIdsRef = useRef(new WeakMap<object, string>());

    const createMutation = useOptimisticMutation({
      mutationFn: ({ token, organizationId, data }: MutationParams<TCreate>) =>
        api.create({ token, organizationId, data }),
      queryClient,
      // Snapshot + settle-invalidate lists AND every aggregation — dashboards
      // derive from the underlying data, so any CRUD write may shift their rows.
      queryKeys: [KEYS.lists(), KEYS.aggregations()],
      mutationKey: WRITE_MUTATION_KEY,
      shouldToast,
      optimisticUpdate: (oldData, variables, qKey) => {
        // Only LIST caches receive the placeholder. Aggregation caches share
        // the snapshot/invalidation lifecycle but their `{ rows }` payload is
        // computed server-side — injecting an item would corrupt them.
        if (qKey[1] !== "list") return oldData;
        const { data } = variables;
        let tempId = tempIdsRef.current.get(variables);
        if (!tempId) {
          tempId = resolveItemId(data) ?? `temp-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
          tempIdsRef.current.set(variables, tempId);
        }
        const optimisticItem = {
          ...(data as object),
          _optimistic: true,
          [idField ?? (resolveItemId(data) ? "id" : "_id")]: tempId,
        };
        return prependToListCache(oldData, optimisticItem);
      },
      // Runs on success BEFORE invalidation: swap the temp placeholder for
      // the server document in place (no flicker, real id immediately usable
      // for navigation), and seed the detail cache so a follow-up detail view
      // renders without a fetch.
      reconcile: (raw, variables) => {
        const serverDoc = extractItem<T>(raw);
        if (!serverDoc || typeof serverDoc !== "object") return;
        const tempId = tempIdsRef.current.get(variables);
        if (tempId) {
          for (const [qKey, qData] of queryClient.getQueriesData({ queryKey: KEYS.lists() })) {
            const next = replaceItemInListCache(
              qData,
              tempId,
              serverDoc,
              idField ? { idField } : {},
            );
            if (next !== qData) queryClient.setQueryData(qKey, next);
          }
        }
        const realId = resolveItemId(serverDoc);
        if (realId) queryClient.setQueryData(KEYS.detail(realId), serverDoc);
      },
      onSuccess: (raw, variables) => {
        callbacks.onCreate?.onSuccess?.(
          extractItem<T>(raw) as T,
          { data: variables.data },
          undefined,
        );
      },
      onError: (error, variables) => {
        callbacks.onCreate?.onError?.(error, { data: variables.data }, undefined);
      },
      onSettled: (raw, error, variables) => {
        callbacks.onCreate?.onSettled?.(
          raw ? (extractItem<T>(raw) as T) : undefined,
          error,
          { data: variables.data },
          undefined,
        );
      },
      messages: { success: config.messages.createSuccess, error: config.messages.createError },
      toastHandler: instanceToast,
    });

    const updateMutation = useOptimisticMutation({
      mutationFn: ({ token, organizationId, id, data }: UpdateParams<TUpdate>) =>
        api.update({ token, organizationId, id, data }),
      queryClient,
      queryKeys: [KEYS.lists(), KEYS.details(), KEYS.aggregations()],
      mutationKey: WRITE_MUTATION_KEY,
      shouldToast,
      // One key-aware updater covers every snapshotted cache family:
      //   detail caches of THIS id (bare + scoped + parameterized) → raw-doc
      //     merge (arc 2.13+ detail caches hold the doc directly, no
      //     `{ data }` envelope);
      //   list caches (flat + infinite pages) → per-item merge;
      //   aggregations / other ids → untouched.
      optimisticUpdate: (oldData, { id, data }, qKey) => {
        if (qKey[1] === "detail") {
          if (qKey[2] !== id || !oldData || typeof oldData !== "object") return oldData;
          return { ...(oldData as object), ...(data as object) };
        }
        if (qKey[1] !== "list") return oldData;
        return updateListCache(oldData, (arr: unknown[]) =>
          (arr || []).map((item) =>
            resolveItemId(item) === id ? { ...(item as object), ...(data as object) } : item,
          ),
        );
      },
      // Server truth lands before the settled refetch: replace the item in
      // every list + detail cache with the authoritative response document.
      reconcile: (raw, { id }) => {
        const serverDoc = extractItem<T>(raw);
        if (!serverDoc || typeof serverDoc !== "object") return;
        for (const [qKey, qData] of queryClient.getQueriesData({ queryKey: KEYS.detail(id) })) {
          if (qData) queryClient.setQueryData(qKey, serverDoc);
        }
        for (const [qKey, qData] of queryClient.getQueriesData({ queryKey: KEYS.lists() })) {
          const next = replaceItemInListCache(qData, id, serverDoc, idField ? { idField } : {});
          if (next !== qData) queryClient.setQueryData(qKey, next);
        }
      },
      onSuccess: (raw, { id, data: updateData }) => {
        callbacks.onUpdate?.onSuccess?.(
          extractItem<T>(raw) as T,
          { id, data: updateData },
          undefined,
        );
      },
      onError: (error, { id, data }) => {
        callbacks.onUpdate?.onError?.(error, { id, data }, undefined);
      },
      onSettled: (raw, error, { id, data: updateData }) => {
        callbacks.onUpdate?.onSettled?.(
          raw ? (extractItem<T>(raw) as T) : undefined,
          error,
          { id, data: updateData },
          undefined,
        );
      },
      messages: { success: config.messages.updateSuccess, error: config.messages.updateError },
      toastHandler: instanceToast,
    });

    const deleteMutation = useOptimisticMutation({
      mutationFn: ({ token, organizationId, id }: DeleteParams) =>
        api.delete({ token, organizationId, id }),
      queryClient,
      queryKeys: [KEYS.lists(), KEYS.aggregations()],
      mutationKey: WRITE_MUTATION_KEY,
      shouldToast,
      optimisticUpdate: (oldData, { id }, qKey) => {
        if (qKey[1] !== "list") return oldData;
        return updateListCache(oldData, (arr: unknown[]) =>
          (arr || []).filter((item) => resolveItemId(item) !== id),
        );
      },
      onSuccess: (data, { id }) => {
        // Remove detail cache after successful delete
        queryClient.removeQueries({ queryKey: KEYS.detail(id) });
        callbacks.onDelete?.onSuccess?.(data, { id }, undefined);
      },
      onError: (error, { id }) => {
        callbacks.onDelete?.onError?.(error, { id }, undefined);
      },
      onSettled: (data, error, { id }) => {
        callbacks.onDelete?.onSettled?.(data, error, { id }, undefined);
      },
      messages: { success: config.messages.deleteSuccess, error: config.messages.deleteError },
      toastHandler: instanceToast,
    });

    const restoreMutation = useMutationWithTransition<unknown, DeleteParams>({
      mutationFn: ({ token, organizationId, id }) => {
        if (!api.restore) {
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a restore method`),
          );
        }
        return api.restore({ token, organizationId, id });
      },
      invalidateQueries: [KEYS.lists(), KEYS.custom("deleted"), KEYS.aggregations()],
      shouldToast,
      messages: {
        success: `${singular} restored successfully`,
        error: `Failed to restore ${singular.toLowerCase()}`,
      },
      toastHandler: instanceToast,
    });

    const resolveActionAuth = useCallback(
      <P extends { token?: string | null; organizationId?: string | null }>(params: P): P => {
        const auth = resolveAuth();
        return {
          ...params,
          token: params.token ?? auth.token,
          organizationId: params.organizationId ?? auth.organizationId,
        };
      },
      [],
    );

    const create = useCallback(
      async (params: MutationParams<TCreate>, options?: CallOptions<T>): Promise<T> => {
        silentRef.current = options?.silent ?? false;
        try {
          const raw = await createMutation.mutateAsync(resolveActionAuth(params));
          const entity = extractItem<T>(raw) as T;
          options?.onSuccess?.(entity);
          options?.onSettled?.(entity, null);
          return entity;
        } catch (error) {
          options?.onError?.(error as Error);
          options?.onSettled?.(undefined, error as Error);
          throw error;
        } finally {
          silentRef.current = false;
        }
      },
      [createMutation, resolveActionAuth],
    );

    const update = useCallback(
      async (params: UpdateParams<TUpdate>, options?: CallOptions<T>): Promise<T> => {
        silentRef.current = options?.silent ?? false;
        try {
          const raw = await enqueueWrite(params.id, () =>
            updateMutation.mutateAsync(resolveActionAuth(params)),
          );
          const entity = extractItem<T>(raw) as T;
          options?.onSuccess?.(entity);
          options?.onSettled?.(entity, null);
          return entity;
        } catch (error) {
          options?.onError?.(error as Error);
          options?.onSettled?.(undefined, error as Error);
          throw error;
        } finally {
          silentRef.current = false;
        }
      },
      [updateMutation, resolveActionAuth],
    );

    const remove = useCallback(
      async (params: DeleteParams, options?: CallOptions): Promise<unknown> => {
        silentRef.current = options?.silent ?? false;
        try {
          const result = await enqueueWrite(params.id, () =>
            deleteMutation.mutateAsync(resolveActionAuth(params)),
          );
          options?.onSuccess?.(result);
          options?.onSettled?.(result, null);
          return result;
        } catch (error) {
          options?.onError?.(error as Error);
          options?.onSettled?.(undefined, error as Error);
          throw error;
        } finally {
          silentRef.current = false;
        }
      },
      [deleteMutation, resolveActionAuth],
    );

    const restore = useCallback(
      async (params: DeleteParams, options?: CallOptions<T>): Promise<T> => {
        silentRef.current = options?.silent ?? false;
        try {
          const raw = await enqueueWrite(params.id, () =>
            restoreMutation.mutateAsync(resolveActionAuth(params)),
          );
          const entity = extractItem<T>(raw) as T;
          options?.onSuccess?.(entity);
          options?.onSettled?.(entity, null);
          return entity;
        } catch (error) {
          options?.onError?.(error as Error);
          options?.onSettled?.(undefined, error as Error);
          throw error;
        } finally {
          silentRef.current = false;
        }
      },
      [restoreMutation, resolveActionAuth],
    );

    return {
      create,
      update,
      remove,
      restore,
      isCreating: createMutation.isPending,
      isUpdating: updateMutation.isPending,
      isDeleting: deleteMutation.isPending,
      isRestoring: restoreMutation.isPending,
      isMutating:
        createMutation.isPending ||
        updateMutation.isPending ||
        deleteMutation.isPending ||
        restoreMutation.isPending,
    };
  }

  // ========== useInfiniteList ==========

  function useInfiniteList(
    tokenOrParams?: string | null | Record<string, unknown>,
    paramsOrOptions?: Record<string, unknown> | InfiniteListQueryOptions,
    maybeOptions?: InfiniteListQueryOptions,
  ): InfiniteListQueryResult<T> {
    let token: string | null;
    let params: Record<string, unknown>;
    let options: InfiniteListQueryOptions;

    const isLegacy =
      typeof tokenOrParams === "string" || (tokenOrParams === null && maybeOptions !== undefined);

    if (isLegacy) {
      token = tokenOrParams as string | null;
      params = (paramsOrOptions as Record<string, unknown>) ?? {};
      options = maybeOptions ?? {};
    } else {
      const auth = resolveAuth();
      token = auth.token;
      params = (tokenOrParams as Record<string, unknown>) ?? {};
      options = (paramsOrOptions as InfiniteListQueryOptions) ?? {};
      if (auth.organizationId && !params.organizationId) {
        params = { ...params, organizationId: auth.organizationId };
      }
    }

    const { organizationId, ...restParams } = params;
    const scope = options._scope || (organizationId ? "tenant" : "super-admin");
    const { request: requestOpts, ...queryOpts } = options;

    return useInfiniteListQuery<T>({
      // Same org-normalized key as useList (see withOrgParams) + 'infinite'.
      queryKey: [
        ...KEYS.scopedList(
          scope,
          withOrgParams(organizationId as string | null | undefined, restParams),
        ),
        "infinite",
      ],
      queryFn: ({ pageParam, signal }) => {
        const paginationParams =
          typeof pageParam === "string" ? { after: pageParam } : { page: pageParam as number };

        return api.getAll({
          token,
          organizationId: organizationId as string | null,
          params: { ...restParams, ...paginationParams },
          options: { signal, ...requestOpts },
        });
      },
      enabled: computeEnabled(token, queryOpts),
      initialPageParam: restParams.after ? restParams.after : 1,
      getNextPageParam: (lastPage) => {
        const page = lastPage as PaginatedResult<T>;
        if (isKeysetPagination(page)) {
          return page.hasMore ? page.next : undefined;
        }
        if (isOffsetPagination(page)) {
          return page.hasNext ? page.page + 1 : undefined;
        }
        const p = page as unknown as Record<string, unknown>;
        if (typeof p.hasNext === "boolean" && typeof p.page === "number") {
          return p.hasNext ? (p.page as number) + 1 : undefined;
        }
        return undefined;
      },
      // Required when maxPages is set — enables backward re-fetching on scroll-back
      getPreviousPageParam:
        queryOpts.maxPages != null
          ? (firstPage) => {
              const page = firstPage as PaginatedResult<T>;
              if (isOffsetPagination(page)) {
                return page.hasPrev ? page.page - 1 : undefined;
              }
              const p = page as unknown as Record<string, unknown>;
              if (typeof p.hasPrev === "boolean" && typeof p.page === "number") {
                return p.hasPrev ? (p.page as number) - 1 : undefined;
              }
              return undefined;
            }
          : undefined,
      maxPages: queryOpts.maxPages,
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
        refetchOnWindowFocus: queryOpts.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: queryOpts.structuralSharing ?? config.structuralSharing,
        // `??` so an explicit per-call `false` still disables polling — a
        // `||` here would let the resource default override it.
        refetchInterval: queryOpts.refetchInterval ?? config.refetchInterval,
        refetchIntervalInBackground:
          queryOpts.refetchIntervalInBackground ?? config.refetchIntervalInBackground,
      },
    });
    // No list → detail sync (same reasoning as `useList` — see note there).
  }

  // ========== useUpload ==========

  function useUpload(options?: {
    invalidateQueries?: QueryKey[];
    messages?: MutationMessages;
    onSuccess?: (data: unknown) => void;
    onError?: (error: Error) => void;
    onSettled?: (data: unknown | undefined, error: Error | null) => void;
  }) {
    return useMutationWithTransition<unknown, { data: FormData; id?: string; path?: string }>({
      mutationFn: ({ data, id, path }) => {
        if (!api.upload) {
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define an upload method`),
          );
        }
        const auth = resolveAuth();
        return api.upload({
          token: auth.token,
          organizationId: auth.organizationId,
          data,
          id,
          path,
        });
      },
      invalidateQueries: options?.invalidateQueries ?? [KEYS.lists()],
      onSuccess: (data) => options?.onSuccess?.(data),
      onError: (error) => options?.onError?.(error),
      onSettled: (data, error) => options?.onSettled?.(data, error),
      messages: options?.messages ?? {
        success: `${singular} uploaded successfully`,
        error: `Failed to upload ${singular.toLowerCase()}`,
      },
      toastHandler: instanceToast,
    });
  }

  // ========== useCustomMutation ==========

  function useCustomMutation<TData = unknown, TVariables = unknown>(mutationConfig: {
    mutationFn: (variables: TVariables) => Promise<TData>;
    invalidateQueries?: QueryKey[];
    messages?: MutationMessages<TData, TVariables>;
    onSuccess?: (data: TData, variables: TVariables) => void;
    onError?: (error: Error, variables: TVariables) => void;
    onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables) => void;
  }) {
    return useMutationWithTransition<TData, TVariables>({
      mutationFn: mutationConfig.mutationFn,
      invalidateQueries: mutationConfig.invalidateQueries ?? [KEYS.lists()],
      onSuccess: mutationConfig.onSuccess,
      onError: mutationConfig.onError,
      onSettled: mutationConfig.onSettled,
      messages: mutationConfig.messages,
      toastHandler: instanceToast,
    });
  }

  // ========== useDeleted (soft delete preset) ==========

  function useDeleted(
    params?: Record<string, unknown>,
    options?: ListQueryOptions<T>,
  ): ListQueryResult<T> {
    const auth = resolveAuth();
    const token = auth.token;
    const mergedParams = params ?? {};
    const organizationId = (mergedParams.organizationId as string | null) ?? auth.organizationId;
    const { organizationId: _, ...restParams } = mergedParams;
    const { request: requestOpts, ...queryOpts } = options ?? {};

    return useListQuery<T>({
      queryKey: KEYS.custom("deleted", withOrgParams(organizationId, restParams)),
      queryFn: ({ signal }) => {
        if (!api.getDeleted)
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a getDeleted method`),
          );
        return api.getDeleted({
          token,
          organizationId,
          params: restParams,
          options: { signal, ...requestOpts },
        });
      },
      enabled: computeEnabled(token, queryOpts, !!api.getDeleted),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
      },
      select: queryOpts.select,
    });
  }

  // ========== useCount (arc list dispatch verb `?_count=true`) ==========

  function useCount(
    params?: Record<string, unknown>,
    options?: { enabled?: boolean; staleTime?: number; gcTime?: number },
  ): UseQueryResult<number, Error> {
    const auth = resolveAuth();
    const mergedParams = params ?? {};
    const organizationId = (mergedParams.organizationId as string | null) ?? auth.organizationId;
    const { organizationId: _, ...restParams } = mergedParams;

    return useQuery<number, Error>({
      queryKey: KEYS.custom("count", withOrgParams(organizationId, restParams)),
      queryFn: () => api.count({ token: auth.token, organizationId, params: restParams }),
      enabled: options?.enabled ?? true,
      staleTime: options?.staleTime ?? config.staleTime,
      gcTime: options?.gcTime ?? config.gcTime,
    });
  }

  // ========== useDetailBySlug ==========

  function useDetailBySlug(
    slug: string | null,
    options?: DetailQueryOptions<T>,
  ): DetailQueryResult<T> {
    const auth = resolveAuth();
    const token = auth.token;
    const resolvedOptions = options ?? {};
    const organizationId = resolvedOptions.organizationId ?? auth.organizationId;
    const { params: queryParams, request: requestOpts, ...restOptions } = resolvedOptions;

    // Match useDetail's DX: derive an instant preview from any list cache that
    // already contains this slug. Resolves by the `slug` field on each item.
    const queryClient = useQueryClient();
    const listPlaceholder = useCallback(
      () => (slug ? findItemInListCache<T>(queryClient, KEYS.lists(), slug, "slug") : undefined),
      [queryClient, slug],
    );

    const slugResult = useDetailQuery<T>({
      queryKey: queryParams ? KEYS.custom("slug", slug, queryParams) : KEYS.custom("slug", slug),
      queryFn: ({ signal }) => {
        if (!api.getBySlug)
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a getBySlug method`),
          );
        return api.getBySlug({
          slug: slug ?? "",
          token,
          organizationId,
          params: queryParams,
          options: { signal, ...requestOpts },
        });
      },
      enabled: computeEnabled(token, restOptions, !!api.getBySlug && !!slug),
      options: {
        staleTime: restOptions.staleTime ?? config.staleTime,
        gcTime: restOptions.gcTime ?? config.gcTime,
        refetchOnWindowFocus: restOptions.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: restOptions.structuralSharing ?? config.structuralSharing,
      },
      select: restOptions.select,
      placeholderData: listPlaceholder,
    });

    // Same pseudo-normalization as `useDetail` — propagate the fresh doc to
    // any list cache that contains it. Slugs match by the `slug` field, but
    // we ALSO fan out by the doc's primary id so that an `_id`-keyed list
    // cache picks up the update too.
    useEffect(() => {
      if (!slugResult.item || slugResult.isPlaceholderData) return;
      syncDetailToLists(
        queryClient,
        KEYS.lists(),
        slugResult.item as unknown as Record<string, unknown>,
        idField ? { idField } : {},
      );
    }, [slugResult.item, slugResult.isPlaceholderData, queryClient]);

    return slugResult;
  }

  // ========== useTree ==========

  function useTree(
    params?: Record<string, unknown>,
    options?: ListQueryOptions<T>,
  ): ListQueryResult<T> {
    const auth = resolveAuth();
    const token = auth.token;
    const mergedParams = params ?? {};
    const organizationId = (mergedParams.organizationId as string | null) ?? auth.organizationId;
    const { organizationId: _, ...restParams } = mergedParams;
    const { request: requestOpts, ...queryOpts } = options ?? {};

    return useListQuery<T>({
      // Org-normalized (withOrgParams): `{organizationId: null}` here used to
      // hash differently from the prefetcher's omitted field — SSR-prefetched
      // trees never hydrated for org-less (public storefront) visitors.
      queryKey: KEYS.custom("tree", withOrgParams(organizationId, restParams)),
      queryFn: ({ signal }) => {
        if (!api.getTree)
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a getTree method`),
          );
        return api.getTree({
          token,
          organizationId,
          params: restParams,
          options: { signal, ...requestOpts },
        });
      },
      enabled: computeEnabled(token, queryOpts, !!api.getTree),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
      },
      select: queryOpts.select,
    });
  }

  // ========== useChildren ==========

  function useChildren(
    parentId: string | null,
    params?: Record<string, unknown>,
    options?: ListQueryOptions<T>,
  ): ListQueryResult<T> {
    const auth = resolveAuth();
    const token = auth.token;
    const mergedParams = params ?? {};
    const organizationId = (mergedParams.organizationId as string | null) ?? auth.organizationId;
    const { organizationId: _, ...restParams } = mergedParams;
    const { request: requestOpts, ...queryOpts } = options ?? {};

    return useListQuery<T>({
      queryKey: KEYS.custom("children", parentId, withOrgParams(organizationId, restParams)),
      queryFn: ({ signal }) => {
        if (!api.getChildren)
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a getChildren method`),
          );
        return api.getChildren({
          token,
          organizationId,
          parentId: parentId ?? "",
          params: restParams,
          options: { signal, ...requestOpts },
        });
      },
      enabled: computeEnabled(token, queryOpts, !!api.getChildren && !!parentId),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
      },
      select: queryOpts.select,
    });
  }

  // ========== useBulkActions ==========

  function useBulkActions(): BulkActions<T, TCreate> {
    const queryClient = useQueryClient();

    const bulkCreateMutation = useMutationWithTransition<
      unknown,
      { data: TCreate[]; token?: string | null; organizationId?: string | null }
    >({
      mutationFn: (vars) => {
        if (!api.bulkCreate) {
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a bulkCreate method`),
          );
        }
        const auth = resolveAuth();
        return api.bulkCreate({
          token: vars.token ?? auth.token,
          organizationId: vars.organizationId ?? auth.organizationId,
          data: vars.data,
        });
      },
      invalidateQueries: [KEYS.lists(), KEYS.aggregations()],
      // Seed detail caches from the returned documents BEFORE lists refetch —
      // a grid that navigates straight into a just-created row renders from
      // cache instead of fetching. Detail caches are NOT invalidated (the
      // seeded docs ARE the server truth); only lists + aggregations refetch.
      onSuccess: (raw) => {
        const created = (raw as { data?: T[] } | null)?.data;
        if (!Array.isArray(created)) return;
        for (const doc of created) {
          const id = resolveItemId(doc);
          if (id) queryClient.setQueryData(KEYS.detail(id), doc);
        }
      },
      messages: {
        success: `${pluralName} created successfully`,
        error: `Failed to create ${(pluralName).toLowerCase()}`,
      },
      toastHandler: instanceToast,
    });

    const bulkUpdateMutation = useMutationWithTransition<
      unknown,
      {
        filter: Record<string, unknown>;
        data: Partial<T>;
        token?: string | null;
        organizationId?: string | null;
      }
    >({
      mutationFn: (vars) => {
        if (!api.bulkUpdate) {
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a bulkUpdate method`),
          );
        }
        const auth = resolveAuth();
        return api.bulkUpdate({
          token: vars.token ?? auth.token,
          organizationId: vars.organizationId ?? auth.organizationId,
          filter: vars.filter,
          data: vars.data as Parameters<NonNullable<typeof api.bulkUpdate>>[0]["data"],
        });
      },
      invalidateQueries: [KEYS.lists(), KEYS.details(), KEYS.aggregations()],
      // Partial-success awareness: when the server reports zero modified rows
      // (filter matched nothing, or values were already current), skip the
      // full lists+details+aggregations refetch — nothing changed.
      shouldInvalidate: (raw) => {
        const r = raw as { modifiedCount?: number; upsertedCount?: number } | null;
        if (!r || typeof r.modifiedCount !== "number") return true;
        return r.modifiedCount > 0 || (r.upsertedCount ?? 0) > 0;
      },
      messages: {
        success: `${pluralName} updated successfully`,
        error: `Failed to update ${(pluralName).toLowerCase()}`,
      },
      toastHandler: instanceToast,
    });

    const bulkDeleteMutation = useMutationWithTransition<
      unknown,
      { filter: Record<string, unknown>; token?: string | null; organizationId?: string | null }
    >({
      mutationFn: (vars) => {
        if (!api.bulkDelete) {
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a bulkDelete method`),
          );
        }
        const auth = resolveAuth();
        return api.bulkDelete({
          token: vars.token ?? auth.token,
          organizationId: vars.organizationId ?? auth.organizationId,
          filter: vars.filter,
        });
      },
      invalidateQueries: [KEYS.lists(), KEYS.aggregations()],
      // Same partial-success rule as bulkUpdate: zero deletions = no refetch.
      shouldInvalidate: (raw) => {
        const r = raw as { deletedCount?: number } | null;
        if (!r || typeof r.deletedCount !== "number") return true;
        return r.deletedCount > 0;
      },
      messages: {
        success: `${pluralName} deleted successfully`,
        error: `Failed to delete ${(pluralName).toLowerCase()}`,
      },
      toastHandler: instanceToast,
    });

    return {
      bulkCreate: async (params, options) => {
        const raw = await bulkCreateMutation.mutateAsync(params);
        const items = ((raw as { data?: T[] })?.data ?? []) as T[];
        options?.onSuccess?.(items);
        return items;
      },
      bulkUpdate: async (params, options) => {
        const result = await bulkUpdateMutation.mutateAsync(params);
        options?.onSuccess?.(result);
        return result;
      },
      bulkRemove: async (params, options) => {
        const result = await bulkDeleteMutation.mutateAsync(params);
        options?.onSuccess?.(result);
        return result;
      },
      isBulkCreating: bulkCreateMutation.isPending,
      isBulkUpdating: bulkUpdateMutation.isPending,
      isBulkDeleting: bulkDeleteMutation.isPending,
    };
  }

  // ========== useAction (unified action router, arc v2.8+) ==========

  function useAction<
    TResult = T,
    TBody extends Record<string, unknown> = Record<string, unknown>,
  >(options?: {
    invalidateQueries?: QueryKey[];
    action?: string;
    messages?: MutationMessages<TResult, { id: string; action?: string; data?: TBody }>;
    onSuccess?: (data: TResult, variables: { id: string; action: string; data?: TBody }) => void;
    onError?: (error: Error, variables: { id: string; action: string; data?: TBody }) => void;
    onSettled?: (
      data: TResult | undefined,
      error: Error | null,
      variables: { id: string; action: string; data?: TBody },
    ) => void;
  }) {
    const queryClient = useQueryClient();

    return useMutationWithTransition<TResult, { id: string; action?: string; data?: TBody }>({
      mutationFn: (vars) => {
        if (!api.dispatchAction) {
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a dispatchAction method`),
          );
        }
        const action = vars.action ?? options?.action;
        if (!action) {
          return Promise.reject(
            new Error(
              `[arc-next] useAction: action name required (pass via mutate({ action }) or factory options)`,
            ),
          );
        }
        const auth = resolveAuth();
        return api.dispatchAction<TResult, TBody>({
          token: auth.token,
          organizationId: auth.organizationId,
          id: vars.id,
          action,
          data: vars.data,
        });
      },
      // Default: invalidate the resource's lists + the specific detail so the action's
      // state mutation propagates without each consumer having to wire it.
      invalidateQueries: options?.invalidateQueries ?? [KEYS.lists(), KEYS.details()],
      // Pass typed variables (with action resolved) through to user callbacks.
      onSuccess: (data, vars) => {
        const action = vars.action ?? options?.action ?? "";
        // Also invalidate the specific detail in case `details()` filter doesn't catch it.
        if (vars.id) {
          queryClient.invalidateQueries({ queryKey: KEYS.detail(vars.id) });
        }
        options?.onSuccess?.(data, { id: vars.id, action, data: vars.data });
      },
      onError: (error, vars) => {
        const action = vars.action ?? options?.action ?? "";
        options?.onError?.(error, { id: vars.id, action, data: vars.data });
      },
      onSettled: (data, error, vars) => {
        const action = vars.action ?? options?.action ?? "";
        options?.onSettled?.(data, error, { id: vars.id, action, data: vars.data });
      },
      messages: options?.messages,
      toastHandler: instanceToast,
    });
  }

  // ========== useSearchEngine / useSearchSimilar / useEmbed (search preset, arc v2.9+) ==========

  function useSearchEngine<
    TResult = T,
    TBody extends Record<string, unknown> = Record<string, unknown>,
  >(options?: {
    path?: string;
    messages?: MutationMessages<
      TResult[] | PaginatedResult<TResult>,
      { query?: string; body?: TBody }
    >;
    invalidateQueries?: QueryKey[];
  }) {
    return useMutationWithTransition<
      TResult[] | PaginatedResult<TResult>,
      { query?: string; body?: TBody }
    >({
      mutationFn: (vars) => {
        if (!api.searchEngine) {
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a searchEngine method`),
          );
        }
        const auth = resolveAuth();
        return api.searchEngine<TResult, TBody>({
          token: auth.token,
          organizationId: auth.organizationId,
          query: vars.query,
          body: vars.body,
          path: options?.path,
        });
      },
      invalidateQueries: options?.invalidateQueries ?? [],
      messages: options?.messages,
      toastHandler: instanceToast,
    });
  }

  function useSearchSimilar<
    TResult = T,
    TBody extends Record<string, unknown> = Record<string, unknown>,
  >(options?: {
    path?: string;
    messages?: MutationMessages<
      TResult[] | PaginatedResult<TResult>,
      { query?: string; vector?: number[]; body?: TBody }
    >;
    invalidateQueries?: QueryKey[];
  }) {
    return useMutationWithTransition<
      TResult[] | PaginatedResult<TResult>,
      { query?: string; vector?: number[]; body?: TBody }
    >({
      mutationFn: (vars) => {
        if (!api.searchSimilar) {
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define a searchSimilar method`),
          );
        }
        const auth = resolveAuth();
        return api.searchSimilar<TResult, TBody>({
          token: auth.token,
          organizationId: auth.organizationId,
          query: vars.query,
          vector: vars.vector,
          body: vars.body,
          path: options?.path,
        });
      },
      invalidateQueries: options?.invalidateQueries ?? [],
      messages: options?.messages,
      toastHandler: instanceToast,
    });
  }

  function useEmbed(options?: {
    path?: string;
    messages?: MutationMessages;
    invalidateQueries?: QueryKey[];
  }) {
    return useMutationWithTransition<
      unknown,
      { input: string | string[]; body?: Record<string, unknown> }
    >({
      mutationFn: (vars) => {
        if (!api.embed) {
          return Promise.reject(
            new Error(`[arc-next] "${entityKey}" api does not define an embed method`),
          );
        }
        const auth = resolveAuth();
        return api.embed({
          token: auth.token,
          organizationId: auth.organizationId,
          input: vars.input,
          body: vars.body,
          path: options?.path,
        });
      },
      invalidateQueries: options?.invalidateQueries ?? [],
      messages: options?.messages,
      toastHandler: instanceToast,
    });
  }

  // ========== useAggregation (arc 2.13+ declarative aggregations) ==========

  function useAggregation<TRow extends AggRow = AggRow, TData = AggResult<TRow>>(
    args: {
      name: string;
      filter?: Record<string, unknown>;
    } & AggregationQueryOptions<TRow, TData>,
  ): UseQueryResult<TData> {
    const {
      name,
      filter,
      public: isPublic,
      enabled = true,
      staleTime = config.staleTime,
      gcTime = config.gcTime,
      // Aggregations are usually expensive — default to NOT refetching on
      // window focus even when the factory's CRUD default is `true`. Callers
      // who want it can opt back in per-call.
      refetchOnWindowFocus = false,
      refetchInterval,
      refetchIntervalInBackground,
      select,
      request,
      placeholderData,
    } = args;

    const auth = resolveAuth();
    // Tenant-scoped key — same shape as `scopedList` so multi-tenant hosts
    // never accidentally cross-cache aggregation rows across orgs.
    const filterKey = auth.organizationId
      ? { _org: auth.organizationId, ...(filter ?? {}) }
      : (filter ?? {});

    return useQuery<AggResult<TRow>, Error, TData>({
      queryKey: KEYS.aggregation(name, filterKey),
      queryFn: () => {
        if (!api.aggregate) {
          return Promise.reject(
            new Error(
              `[arc-next] "${entityKey}" api does not define an aggregate method (requires arc 2.13+)`,
            ),
          );
        }
        return api.aggregate<TRow>({
          name,
          filter,
          token: auth.token,
          organizationId: auth.organizationId,
          ...(request ? { options: request } : {}),
        });
      },
      enabled:
        !!name &&
        !!api.aggregate &&
        createEnabledRule(
          auth.token,
          { public: isPublic, enabled },
          resolveAuthMode(),
          resolveHasStaticAuth(),
        ),
      staleTime,
      gcTime,
      refetchOnWindowFocus,
      ...(select ? { select } : {}),
      ...(refetchInterval !== undefined ? { refetchInterval } : {}),
      ...(refetchIntervalInBackground !== undefined ? { refetchIntervalInBackground } : {}),
      ...(placeholderData !== undefined ? { placeholderData } : {}),
    });
  }

  // ========== useResourceSync (real-time auto-invalidation) ==========

  /**
   * Subscribe to live `<resource>.<operation>` broadcasts from arc and
   * auto-invalidate this entity's TanStack Query cache.
   *
   * - `source: 'ws'` (default) → arc's `websocketPlugin` at `/ws`. Sends a
   *   `{ type: 'subscribe', resource }` handshake on connect.
   * - `source: 'sse'` → arc's `ssePlugin` at `/events/stream`. Auto-derives
   *   patterns from the resource name.
   *
   * Both transports invalidate `KEYS.lists()` on `<resource>.created` and
   * `<resource>.deleted`, and `KEYS.detail(id)` (prefix-matches scoped /
   * parameterized variants) on `<resource>.updated` / `.deleted`.
   */
  function useResourceSync(options?: {
    source?: "ws" | "sse";
    resource?: string;
    path?: string;
    enabled?: boolean;
    onEvent?: (event: { operation: CrudOperation; id?: string; data: unknown }) => void;
    onConnectionChange?: (connected: boolean) => void;
  }): { isConnected: boolean } {
    const queryClient = useQueryClient();
    const [isConnected, setIsConnected] = useState(false);

    const source = options?.source ?? "ws";
    const resource = options?.resource ?? entityKey;
    const enabled = options?.enabled ?? true;
    const path = options?.path;

    // Refs so callback churn doesn't reconnect.
    const onEventRef = useRef(options?.onEvent);
    onEventRef.current = options?.onEvent;
    const onConnRef = useRef(options?.onConnectionChange);
    onConnRef.current = options?.onConnectionChange;

    useEffect(() => {
      if (!enabled) return;

      // Drive cache invalidation from the parsed `<resource>.<operation>` type.
      // Handles both shapes arc broadcasts:
      //   1. WS: { type: 'todo.created', data: { resource, operation, data: doc, ... } }
      //   2. SSE: { type, resource, data: doc, timestamp } (CrudEvent shape)
      const handleBroadcast = (incomingType: string, payload: unknown): void => {
        // Type can be `<resource>.<operation>` or just `<operation>`.
        const dot = incomingType.lastIndexOf(".");
        const operation = (dot >= 0 ? incomingType.slice(dot + 1) : incomingType) as CrudOperation;
        if (operation !== "created" && operation !== "updated" && operation !== "deleted") return;

        // Unwrap WS broadcast envelope (`data.data` is the doc).
        let doc: unknown = payload;
        if (
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          "data" in (payload as Record<string, unknown>)
        ) {
          const inner = (payload as { data: unknown }).data;
          if (inner !== undefined) doc = inner;
        }

        const id =
          typeof doc === "object" && doc !== null
            ? (() => {
                const o = doc as Record<string, unknown>;
                const raw = idField ? o[idField] : (o._id ?? o.id);
                return raw != null ? String(raw) : undefined;
              })()
            : undefined;

        // Lists always invalidate — count/order can shift on any op.
        queryClient.invalidateQueries({ queryKey: KEYS.lists() });
        // Aggregations always invalidate too — dashboards derive from the
        // underlying data, so any broadcast may shift their rows.
        queryClient.invalidateQueries({ queryKey: KEYS.aggregations() });
        // Detail invalidates on update/delete (prefix-match scoped variants).
        if (id && (operation === "updated" || operation === "deleted")) {
          queryClient.invalidateQueries({ queryKey: KEYS.detail(id) });
        }

        onEventRef.current?.({ operation, id, data: doc });
      };

      if (source === "sse") {
        const handle = subscribeToEvents({
          resource,
          path,
          onConnectionChange: (c) => {
            setIsConnected(c);
            onConnRef.current?.(c);
          },
          onEvent: (event) => {
            handleBroadcast(event.type, event.data);
          },
        });
        return () => handle.close();
      }

      // WebSocket: subscribe to the resource channel; arc broadcasts
      // `<resource>.created|updated|deleted` after the handshake.
      const handle = connectWs({
        path,
        subscribe: [resource],
        // Arc sends `<resource>.<op>` types — pattern-filter to skip non-CRUD.
        patterns: [`${resource}.`],
        onConnectionChange: (c) => {
          setIsConnected(c);
          onConnRef.current?.(c);
        },
        onMessage: (message) => {
          handleBroadcast(message.type, message.data);
        },
      });
      return () => handle.close();
    }, [enabled, source, resource, path, queryClient]);

    return { isConnected };
  }

  // ========== useNavigation ==========

  // Resolve router hook once at factory time — stable identity for Rules of Hooks.
  const resolvedRouterHook: UseRouterHook =
    instanceNavigation ?? useRouterHook ?? (() => ({ push: () => {}, replace: () => {} }));

  function useNavigation(): NavigateFn<T> {
    const queryClient = useQueryClient();
    const router = resolvedRouterHook();

    return useCallback(
      (href: string, item: T, options: NavigationOptions = {}) => {
        const id = resolveItemId(item);
        if (id) {
          const auth = resolveAuth();
          const orgId = auth.organizationId;
          // Write the raw doc — matches arc 2.13+'s raw-payload wire shape and
          // the shape `useDetail` / prefetch / cache.setDetail all produce.
          // No `{ data: item }` envelope: the cache contract is "TDoc, not
          // `{ data: TDoc }`" across every write path.
          queryClient.setQueryData(KEYS.scopedDetail(id, orgId), item);
          // Also seed the bare key — `useDetail` from a public page (no
          // resolved org) reads the un-scoped key, so this keeps the
          // instant-detail UX consistent across scoped + un-scoped consumers.
          if (orgId) {
            queryClient.setQueryData(KEYS.detail(id), item);
          }
        }

        if (!router) return;

        const { scroll = true, replace = false } = options;
        if (replace) {
          router.replace(href, { scroll });
        } else {
          router.push(href, { scroll });
        }
      },
      [queryClient, router],
    );
  }

  return {
    KEYS,
    cache,
    useList,
    useDetail,
    useSuspenseList,
    useSuspenseDetail,
    useInfiniteList,
    useActions,
    useBulkActions,
    useCount,
    useDeleted,
    useDetailBySlug,
    useTree,
    useChildren,
    useUpload,
    useCustomMutation,
    useAction,
    useSearchEngine,
    useSearchSimilar,
    useEmbed,
    useAggregation,
    useResourceSync,
    useNavigation,
  };
}
