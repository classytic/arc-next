"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { createOptimisticMutation } from "./mutation.js";
import {
  createListQuery,
  createDetailQuery,
  createInfiniteListQuery,
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
import type { MutationCallbacks } from "./mutation.js";
import { getAuthMode, getAuthContext } from "./client.js";
import type { ArcClient, ToastHandler, UseRouterHook } from "./client.js";

// Re-export UseRouterHook for backward compatibility
export type { UseRouterHook } from "./client.js";

// ============================================================================
// Types
// ============================================================================

export interface CrudApi<T, TCreate = Partial<T>, TUpdate = Partial<T>> {
  getAll: (options: {
    token?: string | null;
    organizationId?: string | null;
    params?: Record<string, unknown>;
    options?: { signal?: AbortSignal; [key: string]: unknown };
  }) => Promise<unknown>;

  getById: (options: {
    id: string;
    token?: string | null;
    organizationId?: string | null;
    options?: { signal?: AbortSignal; [key: string]: unknown };
  }) => Promise<unknown>;

  create: (options: {
    token?: string | null;
    organizationId?: string | null;
    data: TCreate;
  }) => Promise<unknown>;

  update: (options: {
    token?: string | null;
    organizationId?: string | null;
    id: string;
    data: TUpdate;
  }) => Promise<unknown>;

  delete: (options: {
    token?: string | null;
    organizationId?: string | null;
    id: string;
  }) => Promise<unknown>;
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
    (params?: Record<string, unknown>, options?: ListQueryOptions): ListQueryResult<T>;
    /** Legacy signature — explicit token */
    (token: string | null, params?: Record<string, unknown>, options?: ListQueryOptions): ListQueryResult<T>;
  };
  useDetail: {
    /** New signature — auto-injects token from configureAuth() context */
    (id: string | null, options?: DetailQueryOptions): DetailQueryResult<T>;
    /** Legacy signature — explicit token */
    (id: string | null, token: string | null, options?: DetailQueryOptions): DetailQueryResult<T>;
  };
  useInfiniteList: {
    /** New signature — auto-injects token/orgId from configureAuth() context */
    (params?: Record<string, unknown>, options?: InfiniteListQueryOptions): InfiniteListQueryResult<T>;
    /** Legacy signature — explicit token */
    (token: string | null, params?: Record<string, unknown>, options?: InfiniteListQueryOptions): InfiniteListQueryResult<T>;
  };
  useActions: () => CrudActions<T, TCreate, TUpdate>;
  useNavigation: () => NavigateFn<T>;
}

// ============================================================================
// Navigation Configuration (Global)
// ============================================================================

let useRouterHook: UseRouterHook | null = null;

/**
 * Configure the router hook for useNavigation. Call once at app init.
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

    return createListQuery<T>({
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

    const { organizationId, request: requestOpts, ...restOptions } = options;

    return createDetailQuery<T>({
      queryKey: KEYS.detail(id || ""),
      queryFn: ({ signal }) => api.getById({ id: id!, token, organizationId, options: { signal, ...requestOpts } }),
      enabled: !!id && createEnabledRule(token, restOptions),
      options: {
        staleTime: restOptions.staleTime ?? config.staleTime,
        gcTime: restOptions.gcTime ?? config.gcTime,
        structuralSharing: restOptions.structuralSharing ?? config.structuralSharing,
        refetchInterval: restOptions.refetchInterval,
        refetchIntervalInBackground: restOptions.refetchIntervalInBackground,
      },
    });
  }

  // ========== useActions ==========

  function useActions(): CrudActions<T, TCreate, TUpdate> {
    const queryClient = useQueryClient();

    const createMutation = createOptimisticMutation({
      mutationFn: ({ token, organizationId, data }: MutationParams<TCreate>) =>
        api.create({ token, organizationId, data }),
      queryClient,
      queryKeys: [KEYS.lists()],
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
      messages: { success: config.messages.createSuccess, error: config.messages.createError },
      toastHandler: instanceToast,
    });

    const updateMutation = createOptimisticMutation({
      mutationFn: ({ token, organizationId, id, data }: UpdateParams<TUpdate>) =>
        api.update({ token, organizationId, id, data }),
      queryClient,
      queryKeys: [KEYS.lists()],
      optimisticUpdate: (oldData, { id, data }) => {
        const updated = updateListCache(oldData, (arr: unknown[]) =>
          (arr || []).map((item) => (getItemId(item) === id ? { ...(item as object), ...(data as object) } : item))
        );
        queryClient.setQueryData(KEYS.detail(id), (current: unknown) =>
          current ? { ...(current as object), data: { ...((current as { data?: object }).data || {}), ...(data as object) } } : current
        );
        return updated;
      },
      onSuccess: (data, { id }) => {
        queryClient.invalidateQueries({ queryKey: KEYS.detail(id) });
        callbacks.onUpdate?.onSuccess?.(data as T, { id, data: {} as TUpdate }, undefined);
      },
      onError: (error, { id, data }) => {
        callbacks.onUpdate?.onError?.(error, { id, data }, undefined);
      },
      messages: { success: config.messages.updateSuccess, error: config.messages.updateError },
      toastHandler: instanceToast,
    });

    const deleteMutation = createOptimisticMutation({
      mutationFn: ({ token, organizationId, id }: DeleteParams) => api.delete({ token, organizationId, id }),
      queryClient,
      queryKeys: [KEYS.lists()],
      optimisticUpdate: (oldData, { id }) => {
        queryClient.removeQueries({ queryKey: KEYS.detail(id) });
        return updateListCache(oldData, (arr: unknown[]) => (arr || []).filter((item) => getItemId(item) !== id));
      },
      onSuccess: (data, { id }) => {
        callbacks.onDelete?.onSuccess?.(data, { id }, undefined);
      },
      onError: (error, { id }) => {
        callbacks.onDelete?.onError?.(error, { id }, undefined);
      },
      messages: { success: config.messages.deleteSuccess, error: config.messages.deleteError },
      toastHandler: instanceToast,
    });

    const resolveAuth = <P extends { token?: string | null; organizationId?: string | null }>(params: P): P => {
      const auth = getAuthContext();
      return {
        ...params,
        token: params.token ?? auth.token,
        organizationId: params.organizationId ?? auth.organizationId,
      };
    };

    const create = async (params: MutationParams<TCreate>, options?: CallOptions<T>): Promise<T> => {
      try {
        const result = await createMutation.mutateAsync(resolveAuth(params));
        options?.onSuccess?.(result as T);
        return result as T;
      } catch (error) {
        options?.onError?.(error as Error);
        throw error;
      }
    };

    const update = async (params: UpdateParams<TUpdate>, options?: CallOptions<T>): Promise<T> => {
      try {
        const result = await updateMutation.mutateAsync(resolveAuth(params));
        options?.onSuccess?.(result as T);
        return result as T;
      } catch (error) {
        options?.onError?.(error as Error);
        throw error;
      }
    };

    const remove = async (params: DeleteParams, options?: CallOptions): Promise<unknown> => {
      try {
        const result = await deleteMutation.mutateAsync(resolveAuth(params));
        options?.onSuccess?.(result);
        return result;
      } catch (error) {
        options?.onError?.(error as Error);
        throw error;
      }
    };

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

    return createInfiniteListQuery<T>({
      queryKey: [...KEYS.scopedList(scope, { organizationId, ...restParams }), 'infinite'],
      queryFn: ({ signal, pageParam }) => {
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
      },
    });
  }

  // ========== useNavigation ==========

  function useNavigation(): NavigateFn<T> {
    const queryClient = useQueryClient();
    const activeRouterHook = instanceNavigation ?? useRouterHook;
    const router = activeRouterHook?.();

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
    useNavigation,
  };
}
