"use client";

import { useQuery, useQueryClient, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptimisticMutation, useMutationWithTransition } from "./mutation.js";
import type { MutationMessages } from "./mutation.js";
import {
  useListQuery,
  useDetailQuery,
  useInfiniteListQuery,
} from "./query.js";
import type {
  ListQueryOptions,
  DetailQueryOptions,
  ListQueryResult,
  DetailQueryResult,
  InfiniteListQueryOptions,
  InfiniteListQueryResult,
  RequestPassthrough,
} from "./query.js";
// Utilities live in the server-safe cache module — import directly so this
// hook layer doesn't accidentally take a dependency on a client-marked path.
import {
  updateListCache,
  getItemId,
  createQueryKeys,
  createCacheUtils,
  DEFAULT_QUERY_CONFIG,
  extractItem,
} from "./cache.js";
import type { PaginatedResult } from "@classytic/repo-core/pagination";
import type { QueryKeys, CacheUtils } from "./cache.js";
import {
  isOffsetPagination,
  isKeysetPagination,
} from "./api.js";
import type { AggResult, AggRow, BaseApi } from "./api.js";
import type { SoftDeleteMethods } from "./presets/soft-delete.js";
import type { BulkMethods } from "./presets/bulk.js";
import type { SlugLookupMethods } from "./presets/slug.js";
import type { TreeMethods } from "./presets/tree.js";
import type { SearchPresetMethods } from "./presets/search.js";
import type { MutationCallbacks, TransitionMutationReturn } from "./mutation.js";
import { getAuthMode, getClientAuthContext } from "./client.js";
import type { ArcClient, ToastHandler, UseRouterHook } from "./client.js";
import { subscribeToEvents, type CrudOperation } from "./sse.js";
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
  'getAll' | 'getById' | 'create' | 'update' | 'delete'
> & {
  upload?: BaseApi<T, TCreate, TUpdate>['upload'];
  dispatchAction?: BaseApi<T, TCreate, TUpdate>['dispatchAction'];
  invokeRoute?: BaseApi<T, TCreate, TUpdate>['invokeRoute'];
  /** Declared aggregations (arc 2.13+). Always available on BaseApi. */
  aggregate?: BaseApi<T, TCreate, TUpdate>['aggregate'];
} & Partial<SoftDeleteMethods<T>>
  & Partial<BulkMethods<T, TCreate, TUpdate>>
  & Partial<SlugLookupMethods<T>>
  & Partial<TreeMethods<T>>
  & Partial<SearchPresetMethods<T>>;

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
  placeholderData?: AggResult<TRow> | ((prev: AggResult<TRow> | undefined) => AggResult<TRow> | undefined);
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
  bulkCreate: (params: { data: TCreate[]; token?: string | null; organizationId?: string | null }, options?: CallOptions<T[]>) => Promise<T[]>;
  bulkUpdate: (params: { filter: Record<string, unknown>; data: Partial<T>; token?: string | null; organizationId?: string | null }, options?: CallOptions) => Promise<unknown>;
  bulkRemove: (params: { filter: Record<string, unknown>; token?: string | null; organizationId?: string | null }, options?: CallOptions) => Promise<unknown>;
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
    (token: string | null, params?: Record<string, unknown>, options?: ListQueryOptions<T>): ListQueryResult<T>;
  };
  useDetail: {
    /** New signature — auto-injects token from configureAuth() context */
    (id: string | null, options?: DetailQueryOptions<T>): DetailQueryResult<T>;
    /** Legacy signature — explicit token */
    (id: string | null, token: string | null, options?: DetailQueryOptions<T>): DetailQueryResult<T>;
  };
  useInfiniteList: {
    /** New signature — auto-injects token/orgId from configureAuth() context */
    (params?: Record<string, unknown>, options?: InfiniteListQueryOptions): InfiniteListQueryResult<T>;
    /** Legacy signature — explicit token */
    (token: string | null, params?: Record<string, unknown>, options?: InfiniteListQueryOptions): InfiniteListQueryResult<T>;
  };
  useActions: () => CrudActions<T, TCreate, TUpdate>;
  useBulkActions: () => BulkActions<T, TCreate>;
  useDeleted: (params?: Record<string, unknown>, options?: ListQueryOptions<T>) => ListQueryResult<T>;
  useDetailBySlug: (slug: string | null, options?: DetailQueryOptions<T>) => DetailQueryResult<T>;
  useTree: (params?: Record<string, unknown>, options?: ListQueryOptions<T>) => ListQueryResult<T>;
  useChildren: (parentId: string | null, params?: Record<string, unknown>, options?: ListQueryOptions<T>) => ListQueryResult<T>;
  /**
   * Mutation against arc's unified action router (`POST /:id/action`).
   * Server discriminates on `body.action`. Use for state transitions
   * (approve/cancel/dispatch) instead of bespoke routes.
   */
  useAction: <TResult = T, TBody extends Record<string, unknown> = Record<string, unknown>>(options?: {
    invalidateQueries?: QueryKey[];
    /** Default action name. Can be overridden per-call via `mutate({ action })`. */
    action?: string;
    messages?: MutationMessages;
    onSuccess?: (data: TResult, variables: { id: string; action: string; data?: TBody }) => void;
    onError?: (error: Error, variables: { id: string; action: string; data?: TBody }) => void;
    onSettled?: (data: TResult | undefined, error: Error | null, variables: { id: string; action: string; data?: TBody }) => void;
  }) => TransitionMutationReturn<TResult, { id: string; action?: string; data?: TBody }>;
  /** Mutation against the search-preset POST `/search` route. */
  useSearchEngine: <TResult = T, TBody extends Record<string, unknown> = Record<string, unknown>>(options?: {
    path?: string;
    messages?: MutationMessages;
    invalidateQueries?: QueryKey[];
  }) => TransitionMutationReturn<unknown, { query?: string; body?: TBody }>;
  /** Mutation against the search-preset POST `/search-similar` route. */
  useSearchSimilar: <TResult = T, TBody extends Record<string, unknown> = Record<string, unknown>>(options?: {
    path?: string;
    messages?: MutationMessages;
    invalidateQueries?: QueryKey[];
  }) => TransitionMutationReturn<unknown, { query?: string; vector?: number[]; body?: TBody }>;
  /** Mutation against the search-preset POST `/embed` route. */
  useEmbed: (options?: {
    path?: string;
    messages?: MutationMessages;
    invalidateQueries?: QueryKey[];
  }) => TransitionMutationReturn<unknown, { input: string | string[]; body?: Record<string, unknown> }>;
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
  useAggregation: <TRow extends AggRow = AggRow, TData = AggResult<TRow>>(args: {
    name: string;
    filter?: Record<string, unknown>;
  } & AggregationQueryOptions<TRow, TData>) => UseQueryResult<TData>;
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
    messages?: MutationMessages;
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
    source?: 'ws' | 'sse';
    /** Override resource name. Defaults to the factory's `entityKey`. */
    resource?: string;
    /** Override path (default: `/ws` or `/events/stream`). */
    path?: string;
    /** Whether the connection is active. Default: true. */
    enabled?: boolean;
    /** Per-event hook fired AFTER cache invalidation. */
    onEvent?: (event: { operation: 'created' | 'updated' | 'deleted'; id?: string; data: unknown }) => void;
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
  authMode: 'bearer' | 'cookie' | 'header' = getAuthMode(),
  hasStaticAuth = false,
): boolean {
  // Cookie auth or public: always enabled
  if (authMode === 'cookie' || options.public) {
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

  /** Whether auth is provided via static config (headers, internalApiKey, per-client auth) — no token needed for enablement */
  const hasStaticAuth = !!(
    client?.config?.defaultHeaders ||
    client?.config?.internalApiKey ||
    client?.auth
  );

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
    const isLegacy = typeof tokenOrParams === 'string' || (tokenOrParams === null && maybeOptions !== undefined);

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
      queryKey: KEYS.scopedList(scope, { organizationId, ...restParams }),
      queryFn: ({ signal }) => api.getAll({ token, organizationId: organizationId as string | null, params: restParams, options: { signal, ...requestOpts } }),
      enabled: createEnabledRule(token, queryOpts, resolveAuthMode(), hasStaticAuth),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
        refetchOnWindowFocus: queryOpts.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: queryOpts.structuralSharing ?? config.structuralSharing,
        refetchInterval: queryOpts.refetchInterval,
        refetchIntervalInBackground: queryOpts.refetchIntervalInBackground,
      },
      prefillDetailCache: queryOpts.prefillDetailCache ?? true,
      detailKeyBuilder: (id) => KEYS.scopedDetail(id, (organizationId as string | null) ?? null),
      itemIdResolver: resolveItemId,
      select: queryOpts.select,
    });
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
    const isLegacy = typeof tokenOrOptions === 'string' || (tokenOrOptions === null && maybeOptions !== undefined);

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

    return useDetailQuery<T>({
      queryKey: fullDetailKey,
      queryFn: ({ signal }) => api.getById({ id: id!, token, organizationId, params: queryParams, options: { signal, ...requestOpts } }),
      enabled: !!id && createEnabledRule(token, restOptions, resolveAuthMode(), hasStaticAuth),
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
  }

  // ========== useActions ==========

  function useActions(): CrudActions<T, TCreate, TUpdate> {
    const queryClient = useQueryClient();
    const silentRef = useRef(false);
    const shouldToast = useCallback(() => !silentRef.current, []);

    const createMutation = useOptimisticMutation({
      mutationFn: ({ token, organizationId, data }: MutationParams<TCreate>) =>
        api.create({ token, organizationId, data }),
      queryClient,
      // Invalidate lists + every aggregation — dashboards derive from the
      // underlying data, so any CRUD write may shift their rows.
      queryKeys: [KEYS.lists(), KEYS.aggregations()],
      shouldToast,
      optimisticUpdate: (oldData, { data }) => {
        const optimisticItem = {
          ...(data as object),
          _optimistic: true,
          [idField ?? (resolveItemId(data) ? "id" : "_id")]: resolveItemId(data) ?? `temp-${Date.now()}`,
        };
        return updateListCache(oldData, (arr: unknown[]) => [optimisticItem, ...(arr || [])]);
      },
      onSuccess: (raw, variables) => {
        callbacks.onCreate?.onSuccess?.(extractItem<T>(raw) as T, { data: variables.data }, undefined);
      },
      onError: (error, variables) => {
        callbacks.onCreate?.onError?.(error, { data: variables.data }, undefined);
      },
      onSettled: (raw, error, variables) => {
        callbacks.onCreate?.onSettled?.(raw ? extractItem<T>(raw) as T : undefined, error, { data: variables.data }, undefined);
      },
      messages: { success: config.messages.createSuccess, error: config.messages.createError },
      toastHandler: instanceToast,
    });

    const updateMutation = useOptimisticMutation({
      mutationFn: ({ token, organizationId, id, data }: UpdateParams<TUpdate>) =>
        api.update({ token, organizationId, id, data }),
      queryClient,
      queryKeys: [KEYS.lists(), KEYS.details(), KEYS.aggregations()],
      shouldToast,
      optimisticUpdate: (oldData, { id, data }) => {
        const updated = updateListCache(oldData, (arr: unknown[]) =>
          (arr || []).map((item) => (resolveItemId(item) === id ? { ...(item as object), ...(data as object) } : item))
        );
        // Optimistic write to all matching detail queries (bare + scoped + parameterized)
        const detailUpdater = (current: unknown) =>
          current ? { ...(current as object), data: { ...((current as { data?: object }).data || {}), ...(data as object) } } : current;

        queryClient.getQueriesData({ queryKey: KEYS.detail(id) }).forEach(([qKey, qData]) => {
          if (qData) queryClient.setQueryData(qKey, detailUpdater);
        });
        return updated;
      },
      onSuccess: (raw, { id, data: updateData }) => {
        // Prefix-match invalidates bare + scoped + parameterized detail keys
        queryClient.invalidateQueries({ queryKey: KEYS.detail(id) });
        callbacks.onUpdate?.onSuccess?.(extractItem<T>(raw) as T, { id, data: updateData }, undefined);
      },
      onError: (error, { id, data }) => {
        callbacks.onUpdate?.onError?.(error, { id, data }, undefined);
      },
      onSettled: (raw, error, { id, data: updateData }) => {
        callbacks.onUpdate?.onSettled?.(raw ? extractItem<T>(raw) as T : undefined, error, { id, data: updateData }, undefined);
      },
      messages: { success: config.messages.updateSuccess, error: config.messages.updateError },
      toastHandler: instanceToast,
    });

    const deleteMutation = useOptimisticMutation({
      mutationFn: ({ token, organizationId, id }: DeleteParams) => api.delete({ token, organizationId, id }),
      queryClient,
      queryKeys: [KEYS.lists(), KEYS.aggregations()],
      shouldToast,
      optimisticUpdate: (oldData, { id }) => {
        return updateListCache(oldData, (arr: unknown[]) => (arr || []).filter((item) => resolveItemId(item) !== id));
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
          return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a restore method`));
        }
        return api.restore({ token, organizationId, id });
      },
      invalidateQueries: [KEYS.lists(), KEYS.custom('deleted'), KEYS.aggregations()],
      shouldToast,
      messages: {
        success: `${singular} restored successfully`,
        error: `Failed to restore ${singular.toLowerCase()}`,
      },
      toastHandler: instanceToast,
    });

    const resolveActionAuth = useCallback(<P extends { token?: string | null; organizationId?: string | null }>(params: P): P => {
      const auth = resolveAuth();
      return {
        ...params,
        token: params.token ?? auth.token,
        organizationId: params.organizationId ?? auth.organizationId,
      };
    }, []);

    const create = useCallback(async (params: MutationParams<TCreate>, options?: CallOptions<T>): Promise<T> => {
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
    }, [createMutation, resolveActionAuth]);

    const update = useCallback(async (params: UpdateParams<TUpdate>, options?: CallOptions<T>): Promise<T> => {
      silentRef.current = options?.silent ?? false;
      try {
        const raw = await updateMutation.mutateAsync(resolveActionAuth(params));
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
    }, [updateMutation, resolveActionAuth]);

    const remove = useCallback(async (params: DeleteParams, options?: CallOptions): Promise<unknown> => {
      silentRef.current = options?.silent ?? false;
      try {
        const result = await deleteMutation.mutateAsync(resolveActionAuth(params));
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
    }, [deleteMutation, resolveActionAuth]);

    const restore = useCallback(async (params: DeleteParams, options?: CallOptions<T>): Promise<T> => {
      silentRef.current = options?.silent ?? false;
      try {
        const raw = await restoreMutation.mutateAsync(resolveActionAuth(params));
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
    }, [restoreMutation, resolveActionAuth]);

    return {
      create,
      update,
      remove,
      restore,
      isCreating: createMutation.isPending,
      isUpdating: updateMutation.isPending,
      isDeleting: deleteMutation.isPending,
      isRestoring: restoreMutation.isPending,
      isMutating: createMutation.isPending || updateMutation.isPending || deleteMutation.isPending || restoreMutation.isPending,
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

    const isLegacy = typeof tokenOrParams === 'string' || (tokenOrParams === null && maybeOptions !== undefined);

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
      queryKey: [...KEYS.scopedList(scope, { organizationId, ...restParams }), 'infinite'],
      queryFn: ({ pageParam, signal }) => {
        const paginationParams = typeof pageParam === 'string'
          ? { after: pageParam }
          : { page: pageParam as number };

        return api.getAll({
          token,
          organizationId: organizationId as string | null,
          params: { ...restParams, ...paginationParams },
          options: { signal, ...requestOpts },
        });
      },
      enabled: createEnabledRule(token, queryOpts, resolveAuthMode(), hasStaticAuth),
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
        if (typeof p.hasNext === 'boolean' && typeof p.page === 'number') {
          return p.hasNext ? (p.page as number) + 1 : undefined;
        }
        return undefined;
      },
      // Required when maxPages is set — enables backward re-fetching on scroll-back
      getPreviousPageParam: queryOpts.maxPages != null ? (firstPage) => {
        const page = firstPage as PaginatedResult<T>;
        if (isOffsetPagination(page)) {
          return page.hasPrev ? page.page - 1 : undefined;
        }
        const p = page as unknown as Record<string, unknown>;
        if (typeof p.hasPrev === 'boolean' && typeof p.page === 'number') {
          return p.hasPrev ? (p.page as number) - 1 : undefined;
        }
        return undefined;
      } : undefined,
      maxPages: queryOpts.maxPages,
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
        refetchOnWindowFocus: queryOpts.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: queryOpts.structuralSharing ?? config.structuralSharing,
        refetchInterval: queryOpts.refetchInterval,
        refetchIntervalInBackground: queryOpts.refetchIntervalInBackground,
      },
    });
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
          return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define an upload method`));
        }
        const auth = resolveAuth();
        return api.upload({ token: auth.token, organizationId: auth.organizationId, data, id, path });
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
    messages?: MutationMessages;
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
      queryKey: KEYS.custom('deleted', { organizationId, ...restParams }),
      queryFn: ({ signal }) => {
        if (!api.getDeleted) return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a getDeleted method`));
        return api.getDeleted({ token, organizationId, params: restParams, options: { signal, ...requestOpts } });
      },
      enabled: !!api.getDeleted && createEnabledRule(token, queryOpts, resolveAuthMode(), hasStaticAuth),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
      },
      select: queryOpts.select,
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

    return useDetailQuery<T>({
      queryKey: queryParams ? KEYS.custom('slug', slug, queryParams) : KEYS.custom('slug', slug),
      queryFn: ({ signal }) => {
        if (!api.getBySlug) return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a getBySlug method`));
        return api.getBySlug({ slug: slug!, token, organizationId, params: queryParams, options: { signal, ...requestOpts } });
      },
      enabled: !!api.getBySlug && !!slug && createEnabledRule(token, restOptions, resolveAuthMode(), hasStaticAuth),
      options: {
        staleTime: restOptions.staleTime ?? config.staleTime,
        gcTime: restOptions.gcTime ?? config.gcTime,
        refetchOnWindowFocus: restOptions.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: restOptions.structuralSharing ?? config.structuralSharing,
      },
      select: restOptions.select,
    });
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
      queryKey: KEYS.custom('tree', { organizationId, ...restParams }),
      queryFn: ({ signal }) => {
        if (!api.getTree) return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a getTree method`));
        return api.getTree({ token, organizationId, params: restParams, options: { signal, ...requestOpts } });
      },
      enabled: !!api.getTree && createEnabledRule(token, queryOpts, resolveAuthMode(), hasStaticAuth),
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
      queryKey: KEYS.custom('children', parentId, { organizationId, ...restParams }),
      queryFn: ({ signal }) => {
        if (!api.getChildren) return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a getChildren method`));
        return api.getChildren({ token, organizationId, parentId: parentId!, params: restParams, options: { signal, ...requestOpts } });
      },
      enabled: !!api.getChildren && !!parentId && createEnabledRule(token, queryOpts, resolveAuthMode(), hasStaticAuth),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
      },
      prefillDetailCache: queryOpts.prefillDetailCache ?? true,
      detailKeyBuilder: (id) => KEYS.scopedDetail(id, (organizationId as string | null) ?? null),
      itemIdResolver: resolveItemId,
      select: queryOpts.select,
    });
  }

  // ========== useBulkActions ==========

  function useBulkActions(): BulkActions<T, TCreate> {
    const bulkCreateMutation = useMutationWithTransition<unknown, { data: TCreate[]; token?: string | null; organizationId?: string | null }>({
      mutationFn: (vars) => {
        if (!api.bulkCreate) {
          return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a bulkCreate method`));
        }
        const auth = resolveAuth();
        return api.bulkCreate({
          token: vars.token ?? auth.token,
          organizationId: vars.organizationId ?? auth.organizationId,
          data: vars.data,
        });
      },
      invalidateQueries: [KEYS.lists(), KEYS.aggregations()],
      messages: {
        success: `${pluralName} created successfully`,
        error: `Failed to create ${(pluralName).toLowerCase()}`,
      },
      toastHandler: instanceToast,
    });

    const bulkUpdateMutation = useMutationWithTransition<unknown, { filter: Record<string, unknown>; data: Partial<T>; token?: string | null; organizationId?: string | null }>({
      mutationFn: (vars) => {
        if (!api.bulkUpdate) {
          return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a bulkUpdate method`));
        }
        const auth = resolveAuth();
        return api.bulkUpdate({
          token: vars.token ?? auth.token,
          organizationId: vars.organizationId ?? auth.organizationId,
          filter: vars.filter,
          data: vars.data as Parameters<NonNullable<typeof api.bulkUpdate>>[0]['data'],
        });
      },
      invalidateQueries: [KEYS.lists(), KEYS.details(), KEYS.aggregations()],
      messages: {
        success: `${pluralName} updated successfully`,
        error: `Failed to update ${(pluralName).toLowerCase()}`,
      },
      toastHandler: instanceToast,
    });

    const bulkDeleteMutation = useMutationWithTransition<unknown, { filter: Record<string, unknown>; token?: string | null; organizationId?: string | null }>({
      mutationFn: (vars) => {
        if (!api.bulkDelete) {
          return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a bulkDelete method`));
        }
        const auth = resolveAuth();
        return api.bulkDelete({
          token: vars.token ?? auth.token,
          organizationId: vars.organizationId ?? auth.organizationId,
          filter: vars.filter,
        });
      },
      invalidateQueries: [KEYS.lists(), KEYS.aggregations()],
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

  function useAction<TResult = T, TBody extends Record<string, unknown> = Record<string, unknown>>(options?: {
    invalidateQueries?: QueryKey[];
    action?: string;
    messages?: MutationMessages;
    onSuccess?: (data: TResult, variables: { id: string; action: string; data?: TBody }) => void;
    onError?: (error: Error, variables: { id: string; action: string; data?: TBody }) => void;
    onSettled?: (data: TResult | undefined, error: Error | null, variables: { id: string; action: string; data?: TBody }) => void;
  }) {
    const queryClient = useQueryClient();

    return useMutationWithTransition<TResult, { id: string; action?: string; data?: TBody }>({
      mutationFn: (vars) => {
        if (!api.dispatchAction) {
          return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a dispatchAction method`));
        }
        const action = vars.action ?? options?.action;
        if (!action) {
          return Promise.reject(new Error(`[arc-next] useAction: action name required (pass via mutate({ action }) or factory options)`));
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
        const action = vars.action ?? options?.action ?? '';
        // Also invalidate the specific detail in case `details()` filter doesn't catch it.
        if (vars.id) {
          queryClient.invalidateQueries({ queryKey: KEYS.detail(vars.id) });
        }
        options?.onSuccess?.(data, { id: vars.id, action, data: vars.data });
      },
      onError: (error, vars) => {
        const action = vars.action ?? options?.action ?? '';
        options?.onError?.(error, { id: vars.id, action, data: vars.data });
      },
      onSettled: (data, error, vars) => {
        const action = vars.action ?? options?.action ?? '';
        options?.onSettled?.(data, error, { id: vars.id, action, data: vars.data });
      },
      messages: options?.messages,
      toastHandler: instanceToast,
    });
  }

  // ========== useSearchEngine / useSearchSimilar / useEmbed (search preset, arc v2.9+) ==========

  function useSearchEngine<TResult = T, TBody extends Record<string, unknown> = Record<string, unknown>>(options?: {
    path?: string;
    messages?: MutationMessages;
    invalidateQueries?: QueryKey[];
  }) {
    return useMutationWithTransition<unknown, { query?: string; body?: TBody }>({
      mutationFn: (vars) => {
        if (!api.searchEngine) {
          return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a searchEngine method`));
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

  function useSearchSimilar<TResult = T, TBody extends Record<string, unknown> = Record<string, unknown>>(options?: {
    path?: string;
    messages?: MutationMessages;
    invalidateQueries?: QueryKey[];
  }) {
    return useMutationWithTransition<unknown, { query?: string; vector?: number[]; body?: TBody }>({
      mutationFn: (vars) => {
        if (!api.searchSimilar) {
          return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define a searchSimilar method`));
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
    return useMutationWithTransition<unknown, { input: string | string[]; body?: Record<string, unknown> }>({
      mutationFn: (vars) => {
        if (!api.embed) {
          return Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define an embed method`));
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

  function useAggregation<TRow extends AggRow = AggRow, TData = AggResult<TRow>>(args: {
    name: string;
    filter?: Record<string, unknown>;
  } & AggregationQueryOptions<TRow, TData>): UseQueryResult<TData> {
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
            new Error(`[arc-next] "${entityKey}" api does not define an aggregate method (requires arc 2.13+)`),
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
        createEnabledRule(auth.token, { public: isPublic, enabled }, resolveAuthMode(), hasStaticAuth),
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
    source?: 'ws' | 'sse';
    resource?: string;
    path?: string;
    enabled?: boolean;
    onEvent?: (event: { operation: CrudOperation; id?: string; data: unknown }) => void;
    onConnectionChange?: (connected: boolean) => void;
  }): { isConnected: boolean } {
    const queryClient = useQueryClient();
    const [isConnected, setIsConnected] = useState(false);

    const source = options?.source ?? 'ws';
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
        const dot = incomingType.lastIndexOf('.');
        const operation = (dot >= 0 ? incomingType.slice(dot + 1) : incomingType) as CrudOperation;
        if (operation !== 'created' && operation !== 'updated' && operation !== 'deleted') return;

        // Unwrap WS broadcast envelope (`data.data` is the doc).
        let doc: unknown = payload;
        if (
          payload && typeof payload === 'object' && !Array.isArray(payload) &&
          'data' in (payload as Record<string, unknown>)
        ) {
          const inner = (payload as { data: unknown }).data;
          if (inner !== undefined) doc = inner;
        }

        const id = typeof doc === 'object' && doc !== null
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
        if (id && (operation === 'updated' || operation === 'deleted')) {
          queryClient.invalidateQueries({ queryKey: KEYS.detail(id) });
        }

        onEventRef.current?.({ operation, id, data: doc });
      };

      if (source === 'sse') {
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
  const resolvedRouterHook: UseRouterHook = instanceNavigation
    ?? useRouterHook
    ?? (() => ({ push: () => {}, replace: () => {} }));

  function useNavigation(): NavigateFn<T> {
    const queryClient = useQueryClient();
    const router = resolvedRouterHook();

    return useCallback(
      (href: string, item: T, options: NavigationOptions = {}) => {
        const id = resolveItemId(item);
        if (id) {
          const auth = resolveAuth();
          const orgId = auth.organizationId;
          // Write to scoped key (matches useDetail's cache key)
          queryClient.setQueryData(KEYS.scopedDetail(id, orgId), { data: item });
          // Also write bare key as fallback (matches non-scoped useDetail, navigation from public pages)
          if (orgId) {
            queryClient.setQueryData(KEYS.detail(id), { data: item });
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
      [queryClient, router]
    );
  }

  return {
    KEYS,
    cache,
    useList,
    useDetail,
    useInfiniteList,
    useActions,
    useBulkActions,
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
