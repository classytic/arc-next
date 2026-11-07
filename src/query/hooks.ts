"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { UseRouterHook } from "../client/client.js";
import { createCrudContext } from "./crud-context.js";
import { createCrudPresets } from "./crud-presets.js";
import { createCrudReads } from "./crud-reads.js";
import type {
  CrudHooksConfig,
  CrudHooksReturn,
  NavigateFn,
  NavigationOptions,
} from "./crud-types.js";
import { createCrudWrites } from "./crud-writes.js";
import { createResourceSync } from "./resource-sync.js";

export type {
  AggregationQueryOptions,
  BulkActions,
  CallOptions,
  CrudActions,
  CrudApi,
  CrudHooksConfig,
  CrudHooksReturn,
  DeleteParams,
  MutationParams,
  NavigateFn,
  NavigationOptions,
  PendingWrite,
  UpdateParams,
} from "./crud-types.js";

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

/** Compose one resource's hooks while keeping policy and lifecycle ownership explicit. */
export function createCrudHooks<T, TCreate = Partial<T>, TUpdate = Partial<T>>(
  options: CrudHooksConfig<T, TCreate, TUpdate>,
): CrudHooksReturn<T, TCreate, TUpdate> {
  const context = createCrudContext(options);
  const { KEYS, queries, cache, instanceNavigation, resolveItemId, readContext } = context;
  const {
    useList,
    useDetail,
    useSuspenseList,
    useSuspenseDetail,
    useInfiniteList,
    useCursorPager,
    useDeleted,
    useCount,
    useDetailBySlug,
    useTree,
    useChildren,
    useAggregation,
  } = createCrudReads(context);
  const { useActions, usePendingWrites } = createCrudWrites(context, options.callbacks);
  const {
    useUpload,
    useCustomMutation,
    useBulkActions,
    useAction,
    useSearchEngine,
    useSearchSimilar,
    useEmbed,
  } = createCrudPresets(context);
  const useResourceSync = createResourceSync(context);
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
          // The raw doc (arc's wire shape, what `useDetail` / prefetch / `cache.setDetail` hold),
          // into the partition a default `useDetail(id)` reads, and no other: the item came from
          // a read made as this identity, so seeding another partition would leak it.
          queryClient.setQueryData(KEYS.detail(id, readContext({}, {}).partition), item);
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
    queries,
    cache,
    useList,
    useDetail,
    usePendingWrites,
    useSuspenseList,
    useSuspenseDetail,
    useInfiniteList,
    useCursorPager,
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
