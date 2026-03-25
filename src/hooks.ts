"use client";

import { useQueryClient, useMutation, type QueryKey } from "@tanstack/react-query";
import { useCallback, useRef, useMemo } from "react";
import { useOptimisticMutation, useMutationWithTransition } from "./mutation.js";
import type { MutationMessages } from "./mutation.js";
import {
  useListQuery,
  useDetailQuery,
  useInfiniteListQuery,
  updateListCache,
  getItemId,
  createQueryKeys,
  createCacheUtils,
  DEFAULT_QUERY_CONFIG,
} from "./query.js";
import type {
  QueryKeys,
  CacheUtils,
  ListQueryOptions,
  DetailQueryOptions,
  ListQueryResult,
  DetailQueryResult,
  InfiniteListQueryOptions,
  InfiniteListQueryResult,
} from "./query.js";
import {
  isOffsetPagination,
  isKeysetPagination,
} from "./api.js";
import type { PaginatedResponse } from "./api.js";
import type { MutationCallbacks, TransitionMutationReturn } from "./mutation.js";
import { getAuthMode, getAuthContext } from "./client.js";
import type { ArcClient, ToastHandler, UseRouterHook } from "./client.js";

// ============================================================================
// Types
// ============================================================================

/**
 * CRUD API interface accepted by createCrudHooks.
 *
 * Parameters are loose (Record<string, unknown>) so BaseApi instances satisfy
 * this structurally without casts. Return types thread generics for type safety.
 */
export interface CrudApi<T = unknown, TCreate = unknown, TUpdate = unknown> {
  getAll: (options: Record<string, unknown>) => Promise<PaginatedResponse<T> | unknown>;
  getById: (options: Record<string, unknown>) => Promise<{ data?: T } | unknown>;
  create: (options: Record<string, unknown>) => Promise<{ data?: T } | unknown>;
  update: (options: Record<string, unknown>) => Promise<{ data?: T } | unknown>;
  delete: (options: Record<string, unknown>) => Promise<unknown>;
  upload?: (options: Record<string, unknown>) => Promise<unknown>;
  search?: (options: Record<string, unknown>) => Promise<PaginatedResponse<T> | unknown>;
}

export interface CrudHooksConfig<T, TCreate = Partial<T>, TUpdate = Partial<T>> {
  api: CrudApi<T, TCreate, TUpdate>;
  entityKey: string;
  singular: string;
  plural?: string;
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
  isCreating: boolean;
  isUpdating: boolean;
  isDeleting: boolean;
  isMutating: boolean;
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
  useUpload: (options?: {
    invalidateQueries?: QueryKey[];
    messages?: MutationMessages;
    onSuccess?: (data: unknown) => void;
    onError?: (error: Error) => void;
    onSettled?: (data: unknown | undefined, error: Error | null) => void;
  }) => TransitionMutationReturn<unknown, { data: FormData; id?: string; path?: string }>;
  useSearch: (query: string, params?: Record<string, unknown>, options?: ListQueryOptions<T>) => ListQueryResult<T>;
  useCustomMutation: <TData = unknown, TVariables = unknown>(config: {
    mutationFn: (variables: TVariables) => Promise<TData>;
    invalidateQueries?: QueryKey[];
    messages?: MutationMessages;
    onSuccess?: (data: TData, variables: TVariables) => void;
    onError?: (error: Error, variables: TVariables) => void;
    onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables) => void;
  }) => TransitionMutationReturn<TData, TVariables>;
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

function createEnabledRule(token: string | null, options: { public?: boolean; enabled?: boolean }): boolean {
  // Cookie-based auth: no token needed, queries always enabled (cookies sent via credentials: 'include')
  if (getAuthMode() === 'cookie' || options.public) {
    return options.enabled ?? true;
  }
  // Bearer token auth: require token to enable queries
  return options.enabled !== undefined ? options.enabled && !!token : !!token;
}

// ============================================================================
// Create CRUD Hooks Factory
// ============================================================================

export function createCrudHooks<T, TCreate = Partial<T>, TUpdate = Partial<T>>({
  api,
  entityKey,
  singular,
  defaults = {},
  callbacks = {},
  client,
}: CrudHooksConfig<T, TCreate, TUpdate>): CrudHooksReturn<T, TCreate, TUpdate> {
  const KEYS = createQueryKeys(entityKey);
  const cache = createCacheUtils<T>(KEYS);

  // Resolve toast handler: client instance → global
  const instanceToast: ToastHandler | undefined = client?.toast;
  // Resolve navigation hook: client instance → global
  const instanceNavigation: UseRouterHook | null = client?.navigation ?? null;

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

    // Detect which overload: first arg is string|null = legacy, object/undefined = new
    if (tokenOrParams === null || typeof tokenOrParams === 'string') {
      token = tokenOrParams;
      params = (paramsOrOptions as Record<string, unknown>) ?? {};
      options = maybeOptions ?? {};
    } else {
      const auth = getAuthContext();
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
      enabled: createEnabledRule(token, queryOpts),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
        refetchOnWindowFocus: queryOpts.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: queryOpts.structuralSharing ?? config.structuralSharing,
        refetchInterval: queryOpts.refetchInterval,
        refetchIntervalInBackground: queryOpts.refetchIntervalInBackground,
      },
      prefillDetailCache: queryOpts.prefillDetailCache ?? true,
      detailKeyBuilder: (id) => KEYS.detail(id),
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

    // Detect which overload: second arg is string|null = legacy, object/undefined = new
    if (tokenOrOptions === null || typeof tokenOrOptions === 'string') {
      token = tokenOrOptions;
      options = maybeOptions ?? {};
    } else {
      const auth = getAuthContext();
      token = auth.token;
      options = (tokenOrOptions as DetailQueryOptions) ?? {};
      if (auth.organizationId && !options.organizationId) {
        options = { ...options, organizationId: auth.organizationId };
      }
    }

    const { organizationId, params: queryParams, request: requestOpts, ...restOptions } = options;

    return useDetailQuery<T>({
      queryKey: queryParams ? [...KEYS.detail(id || ""), queryParams] : KEYS.detail(id || ""),
      queryFn: ({ signal }) => api.getById({ id: id!, token, organizationId, params: queryParams, options: { signal, ...requestOpts } }),
      enabled: !!id && createEnabledRule(token, restOptions),
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
      queryKeys: [KEYS.lists()],
      shouldToast,
      optimisticUpdate: (oldData, { data }) => {
        const optimisticItem = {
          ...(data as object),
          _optimistic: true,
          [getItemId(data) ? "id" : "_id"]: getItemId(data) ?? `temp-${Date.now()}`,
        };
        return updateListCache(oldData, (arr: unknown[]) => [optimisticItem, ...(arr || [])]);
      },
      onSuccess: (data, variables) => {
        callbacks.onCreate?.onSuccess?.(data as T, { data: variables.data }, undefined);
      },
      onError: (error, variables) => {
        callbacks.onCreate?.onError?.(error, { data: variables.data }, undefined);
      },
      onSettled: (data, error, variables) => {
        callbacks.onCreate?.onSettled?.(data as T | undefined, error, { data: variables.data }, undefined);
      },
      messages: { success: config.messages.createSuccess, error: config.messages.createError },
      toastHandler: instanceToast,
    });

    const updateMutation = useOptimisticMutation({
      mutationFn: ({ token, organizationId, id, data }: UpdateParams<TUpdate>) =>
        api.update({ token, organizationId, id, data }),
      queryClient,
      queryKeys: [KEYS.lists(), KEYS.details()],
      shouldToast,
      optimisticUpdate: (oldData, { id, data }) => {
        const updated = updateListCache(oldData, (arr: unknown[]) =>
          (arr || []).map((item) => (getItemId(item) === id ? { ...(item as object), ...(data as object) } : item))
        );
        queryClient.setQueryData(KEYS.detail(id), (current: unknown) =>
          current ? { ...(current as object), data: { ...((current as { data?: object }).data || {}), ...(data as object) } } : current
        );
        return updated;
      },
      onSuccess: (data, { id, data: updateData }) => {
        queryClient.invalidateQueries({ queryKey: KEYS.detail(id) });
        callbacks.onUpdate?.onSuccess?.(data as T, { id, data: updateData }, undefined);
      },
      onError: (error, { id, data }) => {
        callbacks.onUpdate?.onError?.(error, { id, data }, undefined);
      },
      onSettled: (data, error, { id, data: updateData }) => {
        callbacks.onUpdate?.onSettled?.(data as T | undefined, error, { id, data: updateData }, undefined);
      },
      messages: { success: config.messages.updateSuccess, error: config.messages.updateError },
      toastHandler: instanceToast,
    });

    const deleteMutation = useOptimisticMutation({
      mutationFn: ({ token, organizationId, id }: DeleteParams) => api.delete({ token, organizationId, id }),
      queryClient,
      queryKeys: [KEYS.lists()],
      shouldToast,
      optimisticUpdate: (oldData, { id }) => {
        return updateListCache(oldData, (arr: unknown[]) => (arr || []).filter((item) => getItemId(item) !== id));
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

    const resolveAuth = useCallback(<P extends { token?: string | null; organizationId?: string | null }>(params: P): P => {
      const auth = getAuthContext();
      return {
        ...params,
        token: params.token ?? auth.token,
        organizationId: params.organizationId ?? auth.organizationId,
      };
    }, []);

    const create = useCallback(async (params: MutationParams<TCreate>, options?: CallOptions<T>): Promise<T> => {
      silentRef.current = options?.silent ?? false;
      try {
        const result = await createMutation.mutateAsync(resolveAuth(params));
        options?.onSuccess?.(result as T);
        options?.onSettled?.(result as T, null);
        return result as T;
      } catch (error) {
        options?.onError?.(error as Error);
        options?.onSettled?.(undefined, error as Error);
        throw error;
      } finally {
        silentRef.current = false;
      }
    }, [createMutation, resolveAuth]);

    const update = useCallback(async (params: UpdateParams<TUpdate>, options?: CallOptions<T>): Promise<T> => {
      silentRef.current = options?.silent ?? false;
      try {
        const result = await updateMutation.mutateAsync(resolveAuth(params));
        options?.onSuccess?.(result as T);
        options?.onSettled?.(result as T, null);
        return result as T;
      } catch (error) {
        options?.onError?.(error as Error);
        options?.onSettled?.(undefined, error as Error);
        throw error;
      } finally {
        silentRef.current = false;
      }
    }, [updateMutation, resolveAuth]);

    const remove = useCallback(async (params: DeleteParams, options?: CallOptions): Promise<unknown> => {
      silentRef.current = options?.silent ?? false;
      try {
        const result = await deleteMutation.mutateAsync(resolveAuth(params));
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
    }, [deleteMutation, resolveAuth]);

    return {
      create,
      update,
      remove,
      isCreating: createMutation.isPending,
      isUpdating: updateMutation.isPending,
      isDeleting: deleteMutation.isPending,
      isMutating: createMutation.isPending || updateMutation.isPending || deleteMutation.isPending,
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

    if (tokenOrParams === null || typeof tokenOrParams === 'string') {
      token = tokenOrParams;
      params = (paramsOrOptions as Record<string, unknown>) ?? {};
      options = maybeOptions ?? {};
    } else {
      const auth = getAuthContext();
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
          : { page: pageParam };

        return api.getAll({
          token,
          organizationId: organizationId as string | null,
          params: { ...restParams, ...paginationParams },
          options: { signal, ...requestOpts },
        });
      },
      enabled: createEnabledRule(token, queryOpts),
      initialPageParam: restParams.after ? restParams.after : 1,
      getNextPageParam: (lastPage) => {
        const page = lastPage as PaginatedResponse<T>;
        if (isKeysetPagination(page)) {
          return page.hasMore ? page.next : undefined;
        }
        if (isOffsetPagination(page)) {
          return page.hasNext ? page.page + 1 : undefined;
        }
        // Fallback: check common pagination fields
        const p = page as unknown as Record<string, unknown>;
        if (typeof p.hasNext === 'boolean' && typeof p.page === 'number') {
          return p.hasNext ? (p.page as number) + 1 : undefined;
        }
        return undefined;
      },
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
        const auth = getAuthContext();
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

  // ========== useSearch ==========

  function useSearch(
    query: string,
    params?: Record<string, unknown>,
    options?: ListQueryOptions<T>,
  ): ListQueryResult<T> {
    if (!api.search) {
      throw new Error(`[arc-next] "${entityKey}" api does not define a search method`);
    }

    const searchApi = api.search;
    const auth = getAuthContext();
    const token = params?.token as string | null ?? auth.token;
    const organizationId = params?.organizationId as string | null ?? auth.organizationId;
    const { organizationId: _, token: _t, ...restParams } = params ?? {};
    const searchParams = { q: query, ...restParams };
    const { request: requestOpts, ...queryOpts } = options ?? {};

    // Include organizationId in query key when present to isolate per-tenant search cache
    const searchKeyParams = organizationId
      ? { organizationId, ...searchParams }
      : searchParams;

    return useListQuery<T>({
      queryKey: [...KEYS.lists(), 'search', searchKeyParams],
      queryFn: ({ signal }) => searchApi({
        token,
        organizationId,
        params: searchParams,
        options: { signal, ...requestOpts },
      }),
      enabled: query.length > 0 && createEnabledRule(token, queryOpts),
      options: {
        staleTime: queryOpts.staleTime ?? config.staleTime,
        gcTime: queryOpts.gcTime ?? config.gcTime,
      },
      select: queryOpts.select,
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
        const id = getItemId(item);
        if (id) {
          queryClient.setQueryData(KEYS.detail(id), { data: item });
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
    useUpload,
    useSearch,
    useCustomMutation,
    useNavigation,
  };
}
