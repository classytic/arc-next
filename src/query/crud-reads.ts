"use client";

// Read hooks over the shared option factories, including partition-aware placeholders and sync.

import {
  hashKey,
  type QueryFunction,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import type { AggResult, AggRow } from "../client/api.js";
import type { RequestAuth } from "../client/client.js";
import { syncDetailToLists } from "./cache.js";
import type { CrudContext } from "./crud-context.js";
import type { AggregationQueryOptions } from "./crud-types.js";
import type {
  AnyQueryFunction,
  CursorPager,
  DetailQueryOptions,
  DetailQueryResult,
  InfiniteListQueryOptions,
  InfiniteListQueryResult,
  ListQueryOptions,
  ListQueryResult,
} from "./query.js";
import {
  findItemInListCache,
  useCursorPager,
  useDetailQuery,
  useInfiniteListQuery,
  useListQuery,
  useSuspenseDetailQuery,
  useSuspenseListQuery,
} from "./query.js";
import { previousPageParam } from "./query-options.js";
export function createCrudReads<T, TCreate, TUpdate>({
  api,
  idField,
  queries,
  KEYS,
  config,
  readContext,
  readEnabled,
  listFreshness,
  seed,
}: Pick<
  CrudContext<T, TCreate, TUpdate>,
  | "api"
  | "idField"
  | "queries"
  | "KEYS"
  | "config"
  | "readContext"
  | "readEnabled"
  | "listFreshness"
  | "seed"
>) {
  // ========== useList ==========

  function useList(
    params: Record<string, unknown> = {},
    options: ListQueryOptions = {},
  ): ListQueryResult<T> {
    const read = readContext(params, options);
    const o = queries.list(read.params, read.ctx);
    return useListQuery<T>({
      queryKey: o.queryKey,
      queryFn: o.queryFn as AnyQueryFunction,
      enabled: readEnabled(read.token, options),
      options: { ...listFreshness(options), ...seed(options) },
      select: options.select,
      keepPrevious: options.keepPrevious,
    });
    // No list → detail sync: list payloads are often trimmed (`select=...`), so merging them
    // into a detail cache would overwrite richer data. Detail → list runs in `useDetail`.
  }

  // ========== useDetail ==========

  function useDetail(id: string | null, options: DetailQueryOptions = {}): DetailQueryResult<T> {
    const { params: queryParams, ...rest } = options;
    const read = readContext({}, rest);
    const o = queries.detail(id ?? "", {
      ...read.ctx,
      ...(queryParams ? { params: queryParams } : {}),
    });

    // Lazy placeholder: a list of the SAME partition already holding this entity shows it at once
    // while the detail GET runs (`isPlaceholderData`), without writing into the detail cache.
    const queryClient = useQueryClient();
    const { auth, organizationId, scope } = read.partition;
    const listPlaceholder = useCallback(
      () =>
        id
          ? findItemInListCache<T>(
              queryClient,
              KEYS.lists({ auth, organizationId, scope }),
              id,
              idField,
            )
          : undefined,
      [queryClient, id, auth, organizationId, scope],
    );

    const detailResult = useDetailQuery<T>({
      queryKey: o.queryKey,
      queryFn: o.queryFn as AnyQueryFunction,
      enabled: readEnabled(read.token, rest, !!id),
      options: {
        staleTime: rest.staleTime ?? config.staleTime,
        gcTime: rest.gcTime ?? config.gcTime,
        refetchOnWindowFocus: rest.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: rest.structuralSharing ?? config.structuralSharing,
        refetchInterval: rest.refetchInterval,
        refetchIntervalInBackground: rest.refetchIntervalInBackground,
        ...seed(rest),
      },
      select: rest.select,
      placeholderData: listPlaceholder,
    });

    // Pseudo-normalization: a fresh detail shallow-merges into every list of its own partition
    // holding it (never into a list read as another identity).
    useEffect(() => {
      if (!detailResult.item || detailResult.isPlaceholderData) return;
      syncDetailToLists(
        queryClient,
        KEYS.lists({ auth, organizationId, scope }),
        detailResult.item as unknown as Record<string, unknown>,
        idField ? { idField } : {},
      );
    }, [
      detailResult.item,
      detailResult.isPlaceholderData,
      queryClient,
      auth,
      organizationId,
      scope,
    ]);

    return detailResult;
  }

  // ========== useSuspenseList / useSuspenseDetail ==========
  // For Suspense / streaming SSR: always fetch and suspend (a streamed server promise resolves
  // them during SSR). No `enabled` gate and no list→detail placeholder (TanStack forbids both).

  function useSuspenseList(
    params: Record<string, unknown> = {},
    options: Omit<ListQueryOptions, "enabled"> = {},
  ): ListQueryResult<T> {
    const read = readContext(params, options);
    const o = queries.list(read.params, read.ctx);
    return useSuspenseListQuery<T>({
      queryKey: o.queryKey,
      queryFn: o.queryFn as AnyQueryFunction,
      options: listFreshness(options),
      select: options.select,
    });
  }

  function useSuspenseDetail(
    id: string,
    options: Omit<DetailQueryOptions, "enabled"> = {},
  ): DetailQueryResult<T> {
    const { params: queryParams, ...rest } = options;
    const read = readContext({}, rest);
    const o = queries.detail(id, { ...read.ctx, ...(queryParams ? { params: queryParams } : {}) });

    const queryClient = useQueryClient();
    const detailResult = useSuspenseDetailQuery<T>({
      queryKey: o.queryKey,
      queryFn: o.queryFn as AnyQueryFunction,
      options: {
        staleTime: rest.staleTime ?? config.staleTime,
        gcTime: rest.gcTime ?? config.gcTime,
        refetchOnWindowFocus: rest.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: rest.structuralSharing ?? config.structuralSharing,
        refetchInterval: rest.refetchInterval,
        refetchIntervalInBackground: rest.refetchIntervalInBackground,
      },
      select: rest.select,
    });

    const { auth, organizationId, scope } = read.partition;
    useEffect(() => {
      if (!detailResult.item) return;
      syncDetailToLists(
        queryClient,
        KEYS.lists({ auth, organizationId, scope }),
        detailResult.item as unknown as Record<string, unknown>,
        idField ? { idField } : {},
      );
    }, [detailResult.item, queryClient, auth, organizationId, scope]);

    return detailResult;
  }

  // ========== useInfiniteList ==========

  function useInfiniteList(
    params: Record<string, unknown> = {},
    options: InfiniteListQueryOptions = {},
  ): InfiniteListQueryResult<T> {
    const read = readContext(params, options);
    const o = queries.infiniteList(read.params, read.ctx);
    return useInfiniteListQuery<T>({
      queryKey: o.queryKey,
      queryFn: o.queryFn as AnyQueryFunction,
      enabled: readEnabled(read.token, options),
      initialPageParam: o.initialPageParam,
      getNextPageParam: o.getNextPageParam as (lastPage: unknown) => unknown,
      // Needed only with maxPages: evicted offset pages are fetched again on scroll-back.
      getPreviousPageParam: options.maxPages != null ? previousPageParam : undefined,
      maxPages: options.maxPages,
      keepPrevious: options.keepPrevious,
      options: listFreshness(options),
    });
  }

  // ========== useCursorPager ==========

  function useResourceCursorPager(
    params: Record<string, unknown> = {},
    options: Omit<InfiniteListQueryOptions, "maxPages"> = {},
  ): CursorPager<T> {
    const list = useInfiniteList(params, { keepPrevious: true, ...options });
    // The list's identity is its key (params, tenant, scope, auth): a new one starts at page 1.
    const read = readContext(params, options);
    const resetKey = hashKey(queries.infiniteList(read.params, read.ctx).queryKey);
    return useCursorPager<T>(list, resetKey);
  }

  // ========== useDeleted (soft delete preset) ==========

  function useDeleted(
    params: Record<string, unknown> = {},
    options: ListQueryOptions = {},
  ): ListQueryResult<T> {
    const read = readContext(params, options);
    const o = queries.deleted(read.params, read.ctx);
    return useListQuery<T>({
      queryKey: o.queryKey,
      queryFn: o.queryFn as AnyQueryFunction,
      enabled: readEnabled(read.token, options, !!api.getDeleted),
      options: {
        staleTime: options.staleTime ?? config.staleTime,
        gcTime: options.gcTime ?? config.gcTime,
      },
      select: options.select,
      keepPrevious: options.keepPrevious,
    });
  }

  // ========== useCount (arc list dispatch verb `?_count=true`) ==========

  function useCount(
    params: Record<string, unknown> = {},
    options: {
      enabled?: boolean;
      public?: boolean;
      auth?: RequestAuth;
      staleTime?: number;
      gcTime?: number;
    } = {},
  ): UseQueryResult<number, Error> {
    const read = readContext(params, options);
    return useQuery({
      ...queries.count(read.params, read.ctx),
      // Same auth gate as every other read: a token-less bearer client must not fire a count
      // that can only 401.
      enabled: readEnabled(read.token, options),
      staleTime: options.staleTime ?? config.staleTime,
      gcTime: options.gcTime ?? config.gcTime,
    });
  }

  // ========== useDetailBySlug ==========

  function useDetailBySlug(
    slug: string | null,
    options: DetailQueryOptions = {},
  ): DetailQueryResult<T> {
    const { params: queryParams, ...rest } = options;
    const read = readContext({}, rest);
    const o = queries.bySlug(slug ?? "", {
      ...read.ctx,
      ...(queryParams ? { params: queryParams } : {}),
    });

    // Instant preview from a list of the same partition holding this slug (the `slug` field).
    const queryClient = useQueryClient();
    const { auth, organizationId, scope } = read.partition;
    const listPlaceholder = useCallback(
      () =>
        slug
          ? findItemInListCache<T>(
              queryClient,
              KEYS.lists({ auth, organizationId, scope }),
              slug,
              "slug",
            )
          : undefined,
      [queryClient, slug, auth, organizationId, scope],
    );

    const slugResult = useDetailQuery<T>({
      queryKey: o.queryKey,
      queryFn: o.queryFn as AnyQueryFunction,
      enabled: readEnabled(read.token, rest, !!api.getBySlug && !!slug),
      options: {
        staleTime: rest.staleTime ?? config.staleTime,
        gcTime: rest.gcTime ?? config.gcTime,
        refetchOnWindowFocus: rest.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
        structuralSharing: rest.structuralSharing ?? config.structuralSharing,
      },
      select: rest.select,
      placeholderData: listPlaceholder,
    });

    // Same detail → list fan-out as `useDetail` (own partition), matched by the doc's primary id.
    useEffect(() => {
      if (!slugResult.item || slugResult.isPlaceholderData) return;
      syncDetailToLists(
        queryClient,
        KEYS.lists({ auth, organizationId, scope }),
        slugResult.item as unknown as Record<string, unknown>,
        idField ? { idField } : {},
      );
    }, [slugResult.item, slugResult.isPlaceholderData, queryClient, auth, organizationId, scope]);

    return slugResult;
  }

  // ========== useTree ==========

  function useTree(
    params: Record<string, unknown> = {},
    options: ListQueryOptions = {},
  ): ListQueryResult<T> {
    const read = readContext(params, options);
    const o = queries.tree(read.params, read.ctx);
    return useListQuery<T>({
      queryKey: o.queryKey,
      queryFn: o.queryFn as AnyQueryFunction,
      enabled: readEnabled(read.token, options, !!api.getTree),
      options: {
        staleTime: options.staleTime ?? config.staleTime,
        gcTime: options.gcTime ?? config.gcTime,
      },
      select: options.select,
      keepPrevious: options.keepPrevious,
    });
  }

  // ========== useChildren ==========

  function useChildren(
    parentId: string | null,
    params: Record<string, unknown> = {},
    options: ListQueryOptions = {},
  ): ListQueryResult<T> {
    const read = readContext(params, options);
    const o = queries.children(parentId ?? "", read.params, read.ctx);
    return useListQuery<T>({
      queryKey: o.queryKey,
      queryFn: o.queryFn as AnyQueryFunction,
      enabled: readEnabled(read.token, options, !!api.getChildren && !!parentId),
      options: {
        staleTime: options.staleTime ?? config.staleTime,
        gcTime: options.gcTime ?? config.gcTime,
      },
      select: options.select,
      keepPrevious: options.keepPrevious,
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
      auth,
      enabled = true,
      staleTime = config.staleTime,
      gcTime = config.gcTime,
      // Aggregations are usually expensive: no refetch on focus unless asked per call.
      refetchOnWindowFocus = false,
      refetchInterval,
      refetchIntervalInBackground,
      select,
      request,
      placeholderData,
    } = args;

    const read = readContext({}, { request, auth });
    // Tenant-scoped key, so multi-tenant hosts never cross-cache rows across orgs.
    const o = queries.aggregation<TRow>(name, filter, read.ctx);
    return useQuery<AggResult<TRow>, Error, TData>({
      ...(o as Pick<typeof o, "queryKey"> & { queryFn: QueryFunction<AggResult<TRow>> }),
      enabled:
        !!name && !!api.aggregate && readEnabled(read.token, { public: isPublic, enabled, auth }),
      staleTime,
      gcTime,
      refetchOnWindowFocus,
      ...(select ? { select } : {}),
      ...(refetchInterval !== undefined ? { refetchInterval } : {}),
      ...(refetchIntervalInBackground !== undefined ? { refetchIntervalInBackground } : {}),
      ...(placeholderData !== undefined ? { placeholderData } : {}),
    });
  }

  return {
    useList,
    useDetail,
    useSuspenseList,
    useSuspenseDetail,
    useInfiniteList,
    useCursorPager: useResourceCursorPager,
    useDeleted,
    useCount,
    useDetailBySlug,
    useTree,
    useChildren,
    useAggregation,
  };
}
