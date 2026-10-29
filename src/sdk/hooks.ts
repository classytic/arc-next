"use client";

/**
 * Hook half of the action descriptors, plus the one query helper for custom-route reads. Composes
 * `createCrudHooks` bundles (`useAction`, `useCustomMutation`, `KEYS.custom`) and the shared auth
 * gate; adds no transport of its own.
 *
 * - `useResourceAction(hooks, descriptor)`: binds an action-router verb to a resource's
 *   `createCrudHooks` bundle. Name, payload, result and message keys come FROM the descriptor; the
 *   mutation takes flat vars (`{ id, ...input }`). arc-next invalidates `KEYS.lists()` + `KEYS.detail(id)`.
 * - `useRouteAction(hooks, api, descriptor)`: the same for a custom-route verb. Invalidates the
 *   resource root by default.
 * - `useQuietRouteAction(api, descriptor)`: a custom-route verb with no toast at all.
 * - `useRouteQuery(hooks, key, fn)`: a custom-route read. The cache key is ALWAYS
 *   `hooks.KEYS.custom(...)`; there is no other way to build one here.
 * - `useRouteList(hooks, query, load, defaults, options)`: a paged/filtered route list over
 *   `useRouteQuery` with the one list key (`['list', query]`) and the caller-facing `ListHookOptions`
 *   (`enabled`, `placeholderData`) every list hook shares.
 */

import {
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { queryAuthEnabled } from "../auth-gate.js";
import { getToastHandler } from "../mutation.js";
import {
  type ActionBody,
  type ActionDescriptor,
  type RouteActionDescriptor,
  type RouteApi,
  runRouteAction,
} from "./actions.js";
import { type CrudOperation, crudSuccessText } from "./messages.js";
import type { KeyRoot } from "./resource.js";

/** The slice of a `createCrudHooks` bundle `useResourceAction` needs (structural). */
export interface ActionHooksLike {
  useAction: <TResult, TBody extends Record<string, unknown>>(config: {
    action: string;
    messages?: { success?: string; error?: string };
    invalidateQueries?: QueryKey[];
    onSuccess?: (data: TResult, variables: { id: string; action: string; data?: TBody }) => void;
  }) => {
    mutate: (vars: { id: string; data?: TBody }) => void;
    mutateAsync: (vars: { id: string; data?: TBody }) => Promise<TResult>;
    isPending: boolean;
    isError: boolean;
    error: Error | null;
  };
}

export interface UseResourceActionOptions<TResult> {
  /** Cross-domain cache invalidation and side effects on success. */
  onSuccess?: (data: TResult) => void;
  /** Replace arc-next's default invalidation (lists, details, counts). */
  invalidateQueries?: QueryKey[];
}

// biome-ignore lint/suspicious/noConfusingVoidType: a no-payload verb is typed `void`
export function useResourceAction<TInput extends ActionBody | void, TResult>(
  hooks: ActionHooksLike,
  descriptor: Pick<ActionDescriptor<TInput, TResult>, "verb" | "messages">,
  options: UseResourceActionOptions<TResult> = {},
) {
  const mut = hooks.useAction<TResult, TInput & Record<string, unknown>>({
    action: descriptor.verb,
    messages: descriptor.messages,
    ...(options.invalidateQueries ? { invalidateQueries: options.invalidateQueries } : {}),
    ...(options.onSuccess ? { onSuccess: (data) => options.onSuccess?.(data) } : {}),
  });

  type Vars = TInput extends void ? { id: string } : { id: string } & TInput;
  const split = (vars: Vars) => {
    const { id, ...rest } = vars as { id: string } & Record<string, unknown>;
    return {
      id,
      ...(Object.keys(rest).length > 0 ? { data: rest as TInput & Record<string, unknown> } : {}),
    };
  };
  return {
    isPending: mut.isPending,
    isError: mut.isError,
    error: mut.error,
    mutate: (vars: Vars) => mut.mutate(split(vars)),
    mutateAsync: (vars: Vars): Promise<TResult> => mut.mutateAsync(split(vars)),
  };
}

/** The slice of a `createCrudHooks` bundle the route helpers need (structural). */
export interface RouteHooksLike {
  KEYS: {
    all: string[];
    custom: (key: string, ...args: unknown[]) => QueryKey;
  };
  useCustomMutation: <TData, TVariables>(config: {
    mutationFn: (variables: TVariables) => Promise<TData>;
    invalidateQueries?: QueryKey[];
    messages?: { success?: string; error?: string };
    onSuccess?: (data: TData, variables: TVariables) => void;
  }) => {
    mutate: (vars: TVariables) => void;
    mutateAsync: (vars: TVariables) => Promise<TData>;
    isPending: boolean;
    isError: boolean;
    error: Error | null;
  };
}

export interface UseRouteActionOptions<TInput, TResult> {
  onSuccess?: (data: TResult, input: TInput) => void;
  /** Default: the resource root (`hooks.KEYS.all`). */
  invalidateQueries?: QueryKey[];
}

export function useRouteAction<TInput, TResult, TRaw = TResult>(
  hooks: RouteHooksLike,
  api: RouteApi,
  descriptor: RouteActionDescriptor<TInput, TResult, TRaw>,
  options: UseRouteActionOptions<TInput, TResult> = {},
) {
  return hooks.useCustomMutation<TResult, TInput>({
    mutationFn: (input) => runRouteAction(api, descriptor, input),
    invalidateQueries: options.invalidateQueries ?? [hooks.KEYS.all],
    messages: descriptor.messages,
    ...(options.onSuccess
      ? { onSuccess: (data: TResult, input: TInput) => options.onSuccess?.(data, input) }
      : {}),
  });
}

export interface RouteQueryOptions<TData> {
  /** The caller's own gate (a missing id); combined with the auth rule. */
  enabled?: boolean;
  /** The endpoint is public: no token needed. */
  public?: boolean;
  /** The endpoint answers for the signed-in user (`/mine`): needs that user's token. */
  user?: boolean;
  staleTime?: number;
  gcTime?: number;
  retry?: boolean | number;
  refetchOnWindowFocus?: boolean;
  refetchOnReconnect?: boolean;
  /** Rows to show while a new key loads (`keepPreviousData` for paging: no table flicker). */
  placeholderData?: UseQueryOptions<TData, Error>["placeholderData"];
  refetchInterval?:
    | number
    | false
    | ((query: { state: { data: TData | undefined } }) => number | false | undefined);
}

/**
 * A custom-route read. `key` is `[name, ...args]`; the cache key is `hooks.KEYS.custom(name, ...args)`,
 * so every key in the sdk shares its resource root.
 */
export function useRouteQuery<TData>(
  hooks: Pick<RouteHooksLike, "KEYS">,
  key: readonly [string, ...unknown[]],
  fn: (context: { signal: AbortSignal }) => Promise<TData>,
  options: RouteQueryOptions<TData> = {},
): UseQueryResult<TData, Error> {
  const [name, ...args] = key;
  const { enabled, public: isPublic, user, refetchInterval, ...rest } = options;
  return useQuery<TData, Error>({
    queryKey: hooks.KEYS.custom(name, ...args),
    queryFn: ({ signal }) => fn({ signal }),
    enabled: queryAuthEnabled({
      ...(enabled !== undefined ? { enabled } : {}),
      ...(isPublic !== undefined ? { public: isPublic } : {}),
      ...(user !== undefined ? { user } : {}),
    }),
    ...rest,
    ...(refetchInterval !== undefined
      ? {
          refetchInterval:
            typeof refetchInterval === "function"
              ? (query) => refetchInterval(query as { state: { data: TData | undefined } })
              : refetchInterval,
        }
      : {}),
  });
}

/** What every list hook lets its caller set. */
export interface ListHookOptions<TData> {
  /** Hold the request (a filter still being chosen, a role that may not read it). */
  enabled?: boolean;
  /** `keepPreviousData` while paging, so the table keeps its rows until the next page lands. */
  placeholderData?: RouteQueryOptions<TData>["placeholderData"];
}

/**
 * A route list read: the cache key is `hooks.KEYS.custom('list', query)`. `defaults` are the list's
 * own gates (`user`, `retry`); the caller's `options` can only add `enabled` and `placeholderData`.
 */
export function useRouteList<TQuery, TData>(
  hooks: Pick<RouteHooksLike, "KEYS">,
  query: TQuery,
  load: (query: TQuery, context: { signal: AbortSignal }) => Promise<TData>,
  defaults: RouteQueryOptions<TData> = {},
  options: ListHookOptions<TData> = {},
): UseQueryResult<TData, Error> {
  return useRouteQuery(hooks, ["list", query], (context) => load(query, context), {
    ...defaults,
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    ...(options.placeholderData !== undefined ? { placeholderData: options.placeholderData } : {}),
  });
}

export interface UseQuietRouteActionOptions<TInput, TResult> {
  onSuccess?: (data: TResult, input: TInput) => void;
  /** Default: no invalidation (a quiet verb usually writes the cache itself). */
  invalidate?: QueryKey[];
}

/**
 * A custom-route verb with NO toast, success or error (autosave, progress pings, polling-style
 * writes). Plain TanStack mutation: arc-next's mutation hooks always toast errors.
 */
export function useQuietRouteAction<TInput, TResult, TRaw = TResult>(
  api: RouteApi,
  descriptor: RouteActionDescriptor<TInput, TResult, TRaw>,
  options: UseQuietRouteActionOptions<TInput, TResult> = {},
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TInput>({
    mutationFn: (input) => runRouteAction(api, descriptor, input),
    onSuccess: async (data, input) => {
      await Promise.all(
        (options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      options.onSuccess?.(data, input);
    },
  });
}

/**
 * Success-only toast. The CRUD mutations toast their own success AND failure; a create/edit sheet
 * that shows a refusal inline (`silent: true`) still wants the resource's standard success line.
 * This is that line, from the same message keys the hooks use, through the host's resolver. A no-op
 * for a routes-only resource.
 */
export function toastCrudSuccess(
  resource: { readonly keyRoot: KeyRoot },
  operation: CrudOperation,
): void {
  const text = crudSuccessText(resource.keyRoot[0], operation);
  if (text) getToastHandler().success(text);
}
