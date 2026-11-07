"use client";

// Optional resource operations: bulk writes, uploads, actions and search.

import type { PaginatedResult } from "@classytic/repo-core/pagination";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import type { CrudContext } from "./crud-context.js";
import type { ActionRequestOptions, BulkActions } from "./crud-types.js";
import type { MutationMessages } from "./mutation.js";
import { useMutationWithTransition } from "./mutation.js";
export function createCrudPresets<T, TCreate, TUpdate>({
  api,
  entityKey,
  singular,
  pluralName,
  KEYS,
  resolveAuth,
  pick,
  resolveItemId,
  writePartition,
  instanceToast,
}: Pick<
  CrudContext<T, TCreate, TUpdate>,
  | "api"
  | "entityKey"
  | "singular"
  | "pluralName"
  | "KEYS"
  | "resolveAuth"
  | "pick"
  | "resolveItemId"
  | "writePartition"
  | "instanceToast"
>) {
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
          token: pick(vars.token, auth.token),
          organizationId: pick(vars.organizationId, auth.organizationId),
          data: vars.data,
        });
      },
      invalidateQueries: [KEYS.lists(), KEYS.counts(), KEYS.aggregations()],
      // Seed detail caches from the returned documents BEFORE lists refetch —
      // a grid that navigates straight into a just-created row renders from
      // cache instead of fetching. Detail caches are NOT invalidated (the
      // seeded docs ARE the server truth); lists, counts and aggregations refetch.
      onSuccess: (raw, vars) => {
        const created = (raw as { data?: T[] } | null)?.data;
        if (!Array.isArray(created)) return;
        // Into the writer's partition only (the identity the docs were returned to).
        const partition = writePartition({
          organizationId: pick(vars.organizationId, resolveAuth().organizationId),
        });
        for (const doc of created) {
          const id = resolveItemId(doc);
          if (id) queryClient.setQueryData(KEYS.detail(id, partition), doc);
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
          token: pick(vars.token, auth.token),
          organizationId: pick(vars.organizationId, auth.organizationId),
          filter: vars.filter,
          data: vars.data as Parameters<NonNullable<typeof api.bulkUpdate>>[0]["data"],
        });
      },
      // A filter can match any record, so every detail may be stale (the one place that is true).
      invalidateQueries: [KEYS.lists(), KEYS.details(), KEYS.counts(), KEYS.aggregations()],
      // Partial-success awareness: when the server reports zero modified rows
      // (filter matched nothing, or values were already current), skip the
      // full lists/details/counts/aggregations refetch — nothing changed.
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
          token: pick(vars.token, auth.token),
          organizationId: pick(vars.organizationId, auth.organizationId),
          filter: vars.filter,
        });
      },
      invalidateQueries: [KEYS.lists(), KEYS.counts(), KEYS.aggregations()],
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

    return useMutationWithTransition<
      TResult,
      { id: string; action?: string; data?: TBody; options?: ActionRequestOptions }
    >({
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
          ...(vars.options ? { options: vars.options } : {}),
        });
      },
      // State transitions can change filtered lists, counts and aggregates.
      invalidateQueries: options?.invalidateQueries ?? [
        KEYS.lists(),
        KEYS.counts(),
        KEYS.aggregations(),
      ],
      // Pass typed variables (with action resolved) through to user callbacks.
      onSuccess: (data, vars) => {
        const action = vars.action ?? options?.action ?? "";
        // The acted-on record (every variant); other records are untouched.
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

  return {
    useUpload,
    useCustomMutation,
    useBulkActions,
    useAction,
    useSearchEngine,
    useSearchSimilar,
    useEmbed,
  };
}
