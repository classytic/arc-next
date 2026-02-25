"use client";

import { useMutation, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useTransition } from "react";
import { isArcApiError } from "./client.js";
import type { ToastHandler } from "./client.js";

// Re-export for backward compatibility
export type { ToastHandler } from "./client.js";

// ============================================================================
// Types
// ============================================================================

export interface MutationMessages {
  success?: string | ((data: unknown, variables: unknown) => string);
  error?: string | ((error: Error, variables: unknown) => string);
}

export interface MutationCallbacks<TData, TVariables, TContext = unknown> {
  onMutate?: (variables: TVariables) => TContext | Promise<TContext>;
  onSuccess?: (data: TData, variables: TVariables, context: TContext) => void | Promise<void>;
  onError?: (error: Error, variables: TVariables, context: TContext) => void | Promise<void>;
  onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables, context: TContext) => void | Promise<void>;
}

// ============================================================================
// Toast Configuration
// ============================================================================

let toastHandler: ToastHandler = {
  success: (msg) => console.log("[Success]", msg),
  error: (msg) => console.error("[Error]", msg),
};

/**
 * Configure toast handler. Call once at app init.
 *
 * @example
 * import { toast } from "sonner";
 * configureToast({ success: toast.success, error: toast.error });
 */
export function configureToast(handler: ToastHandler): void {
  toastHandler = handler;
}

function showToast(
  type: "success" | "error",
  messages: MutationMessages | undefined,
  data: unknown,
  variables: unknown,
  error?: Error,
  handler?: ToastHandler,
) {
  const activeHandler = handler ?? toastHandler;

  if (type === "success") {
    const msg = messages?.success;
    if (!msg) return;

    const text = typeof msg === "function" ? msg(data, variables) : msg;
    activeHandler.success(text);
  } else {
    const msg = messages?.error;
    let defaultMsg = error?.message || "An error occurred";
    if (isArcApiError(error) && error.fieldErrors) {
      const fields = Object.entries(error.fieldErrors);
      if (fields.length > 0) {
        defaultMsg = fields.map(([k, v]) => `${k}: ${v}`).join(', ');
      }
    }
    const text = typeof msg === "function"
      ? msg(error as Error, variables)
      : msg || defaultMsg;

    activeHandler.error(text);
  }
}

// ============================================================================
// Mutation with React 19 Transitions
// ============================================================================

export interface TransitionMutationConfig<TData, TVariables> {
  mutationFn: (variables: TVariables) => Promise<TData>;
  invalidateQueries?: QueryKey[];
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
  onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables) => void;
  messages?: MutationMessages;
  useTransition?: boolean;
  showToast?: boolean;
  toastHandler?: ToastHandler;
}

export function useMutationWithTransition<TData, TVariables>(config: TransitionMutationConfig<TData, TVariables>) {
  const {
    mutationFn,
    invalidateQueries = [],
    onSuccess,
    onError,
    onSettled,
    messages,
    useTransition: withTransition = true,
    showToast: toast = true,
    toastHandler: instanceToast,
  } = config;

  const queryClient = useQueryClient();
  const [isTransitioning, startTransition] = useTransition();

  const mutation = useMutation({
    mutationFn,

    onSuccess: (data, variables) => {
      const invalidate = () => {
        invalidateQueries.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
      };

      if (withTransition && invalidateQueries.length > 0) {
        startTransition(invalidate);
      } else {
        invalidate();
      }

      if (toast) showToast("success", messages, data, variables, undefined, instanceToast);
      onSuccess?.(data, variables);
    },

    onError: (error, variables) => {
      if (toast) showToast("error", messages, null, variables, error as Error, instanceToast);
      onError?.(error as Error, variables);
    },

    onSettled: (data, error, variables) => {
      onSettled?.(data, error as Error | null, variables);
    },
  });

  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending || isTransitioning,
    isSuccess: mutation.isSuccess,
    isError: mutation.isError,
    error: mutation.error as Error | null,
    data: mutation.data,
    reset: mutation.reset,
  };
}

// ============================================================================
// Mutation with Optimistic Updates
// ============================================================================

export interface OptimisticMutationConfig<TData, TVariables> {
  mutationFn: (variables: TVariables) => Promise<TData>;
  queryKeys?: QueryKey[];
  optimisticUpdate?: (oldData: unknown, variables: TVariables) => unknown;
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
  onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables) => void;
  messages?: MutationMessages;
  showToast?: boolean;
  toastHandler?: ToastHandler;
}

export function useMutationWithOptimistic<TData, TVariables>(config: OptimisticMutationConfig<TData, TVariables>) {
  const {
    mutationFn,
    queryKeys = [],
    optimisticUpdate,
    onSuccess,
    onError,
    onSettled,
    messages,
    showToast: toast = true,
    toastHandler: instanceToast,
  } = config;

  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn,

    onMutate: async (variables) => {
      await Promise.all(queryKeys.map((key) => queryClient.cancelQueries({ queryKey: key })));

      const previous = queryKeys.map((key) => ({
        key,
        data: queryClient.getQueryData(key),
      }));

      if (optimisticUpdate) {
        queryKeys.forEach((key) => {
          queryClient.setQueryData(key, (old: unknown) => optimisticUpdate(old, variables));
        });
      }

      return { previous };
    },

    onSuccess: (data, variables) => {
      queryKeys.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
      if (toast) showToast("success", messages, data, variables, undefined, instanceToast);
      onSuccess?.(data, variables);
    },

    onError: (error, variables, context) => {
      const ctx = context as { previous?: Array<{ key: QueryKey; data: unknown }> };
      ctx?.previous?.forEach(({ key, data }) => queryClient.setQueryData(key, data));

      if (toast) showToast("error", messages, null, variables, error as Error, instanceToast);
      onError?.(error as Error, variables);
    },

    onSettled: (data, error, variables) => {
      onSettled?.(data, error as Error | null, variables);
    },
  });

  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    isError: mutation.isError,
    error: mutation.error as Error | null,
    data: mutation.data,
    reset: mutation.reset,
  };
}

// ============================================================================
// Optimistic Mutation for CRUD Factory (handles multiple matching queries)
// ============================================================================

export interface CreateOptimisticMutationConfig<TData, TVariables> {
  mutationFn: (variables: TVariables) => Promise<TData>;
  queryClient: QueryClient;
  queryKeys: QueryKey[];
  optimisticUpdate?: (oldData: unknown, variables: TVariables) => unknown;
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
  messages?: MutationMessages;
  toastHandler?: ToastHandler;
}

export function createOptimisticMutation<TData, TVariables>({
  mutationFn,
  queryClient,
  queryKeys,
  optimisticUpdate,
  onSuccess,
  onError,
  messages,
  toastHandler: instanceToast,
}: CreateOptimisticMutationConfig<TData, TVariables>) {
  return useMutation({
    mutationFn,

    onMutate: async (variables) => {
      await Promise.all(queryKeys.map((key) => queryClient.cancelQueries({ queryKey: key, exact: false })));

      const previous = queryKeys.map((key) => ({
        key,
        data: queryClient.getQueriesData({ queryKey: key }),
      }));

      if (optimisticUpdate) {
        queryKeys.forEach((key) => {
          queryClient.getQueriesData({ queryKey: key }).forEach(([qKey, qData]) => {
            queryClient.setQueryData(qKey, optimisticUpdate(qData, variables));
          });
        });
      }

      return { previous };
    },

    onSuccess: (data, variables) => {
      if (messages?.success) showToast("success", messages, data, variables, undefined, instanceToast);
      queryKeys.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
      onSuccess?.(data, variables);
    },

    onError: (error, variables, context) => {
      const ctx = context as { previous?: Array<{ key: QueryKey; data: Array<[QueryKey, unknown]> }> };
      ctx?.previous?.forEach(({ data }) => {
        data.forEach(([qKey, qData]) => queryClient.setQueryData(qKey, qData));
      });

      showToast("error", messages, null, variables, error as Error, instanceToast);
      onError?.(error as Error, variables);
    },
  });
}

// ============================================================================
// Query Config Presets
// ============================================================================

export const QUERY_CONFIGS = {
  realtime: { staleTime: 20_000, refetchInterval: 30_000 },
  frequent: { staleTime: 60_000 },
  stable: { staleTime: 300_000 },
  static: { staleTime: 600_000 },
} as const;
