"use client";

// CRUD write lifecycle. Queues and settled changes are owned by one resource factory.
import {
  type MutationFunction,
  type QueryClient,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { KeyPartition } from "./cache.js";
import {
  type CacheChange,
  extractItem,
  invalidateForChange,
  prependToListCache,
  replaceItemInListCache,
  updateListCache,
} from "./cache.js";
import type { CrudContext } from "./crud-context.js";
import type {
  CallOptions,
  CrudActions,
  CrudHooksConfig,
  DeleteParams,
  MutationParams,
  PendingWrite,
  UpdateParams,
} from "./crud-types.js";
import { emitArcChange } from "./events.js";
import { useMutationWithTransition, useOptimisticMutation } from "./mutation.js";
import { findItemInListCache } from "./query.js";
import type { ArcMutationMeta } from "./query-options.js";

/** The parts of a factory's `mutationOptions` the optimistic CRUD mutations reuse. */
function arcWrite<TData, TVariables>(o: {
  mutationFn?: MutationFunction<TData, TVariables>;
  mutationKey?: readonly unknown[];
  meta?: Record<string, unknown>;
}) {
  return {
    mutationFn: o.mutationFn as MutationFunction<TData, TVariables>,
    ...(o.mutationKey ? { mutationKey: o.mutationKey } : {}),
    ...(o.meta ? { meta: o.meta } : {}),
  };
}

export function createCrudWrites<T, TCreate, TUpdate>(
  {
    api,
    entityKey,
    singular,
    idField,
    queries,
    KEYS,
    config,
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
    | "idField"
    | "queries"
    | "KEYS"
    | "config"
    | "resolveAuth"
    | "pick"
    | "resolveItemId"
    | "writePartition"
    | "instanceToast"
  >,
  callbacks: NonNullable<CrudHooksConfig<T, TCreate, TUpdate>["callbacks"]> = {},
) {
  /**
   * Writes settled since the last invalidation. Last-standing invalidation (above) fires once
   * for a burst of writes; draining this queue then refreshes every record the burst touched,
   * through the one change rule (`invalidateForChange`) realtime sync uses too.
   */
  const settledChanges: CacheChange[] = [];
  const invalidateSettled = (queryClient: QueryClient) => {
    const changes = settledChanges.splice(0);
    if (changes.length === 0) changes.push({ op: "create" });
    for (const change of changes)
      void invalidateForChange(queryClient, KEYS, change, config.invalidates);
  };

  /**
   * Per-record write ordering. `update`/`remove`/`restore` calls against the
   * SAME record in the SAME partition (tenant) are chained (call order = server
   * application order = cache application order); other records, and the same
   * record in another tenant, stay fully parallel. A failed write does not block
   * the next one: each link runs regardless of the previous outcome.
   * Factory-scoped (one resource), so every component shares one chain per record.
   * Callers resolve the write's identity BEFORE enqueueing: a queued write is
   * sent as whoever submitted it, even if the session or tenant changes meanwhile.
   */
  const writeChains = new Map<string, Promise<unknown>>();
  function enqueueWrite<R>(
    partition: KeyPartition,
    recordId: string,
    run: () => Promise<R>,
  ): Promise<R> {
    const chain = JSON.stringify([
      partition.auth,
      partition.organizationId,
      partition.scope,
      recordId,
    ]);
    const prev = writeChains.get(chain) ?? Promise.resolve();
    const result = prev.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    writeChains.set(chain, tail);
    tail.then(() => {
      if (writeChains.get(chain) === tail) writeChains.delete(chain);
    });
    return result;
  }

  /**
   * The `If-Match` version for an update: explicit `version` (`null` = none) →
   * `data[versionField]` → the cached document (detail, else a list row).
   * `undefined` when the api has no `versionField`.
   */
  function resolveVersion(
    queryClient: QueryClient,
    params: UpdateParams<TUpdate>,
    partition: KeyPartition,
  ): number | null | undefined {
    if (params.version !== undefined) return params.version;
    const versionOf = api.versionOf?.bind(api);
    if (!versionOf) return undefined;
    const fromData = versionOf(params.data);
    if (fromData !== undefined) return fromData;
    const details = KEYS.detail(params.id, partition);
    for (const [, doc] of queryClient.getQueriesData({ queryKey: details })) {
      const v = versionOf(doc);
      if (v !== undefined) return v;
    }
    return versionOf(findItemInListCache(queryClient, KEYS.lists(partition), params.id, idField));
  }

  /** The document as the writer last saw it (its partition's detail, else a list row), or `null`. */
  function cachedDocument(queryClient: QueryClient, id: string, partition: KeyPartition): T | null {
    for (const [, doc] of queryClient.getQueriesData({ queryKey: KEYS.detail(id, partition) })) {
      const found = extractItem<T>(doc);
      if (found) return found;
    }
    const row = findItemInListCache(queryClient, KEYS.lists(partition), id, idField);
    return (row as T | undefined) ?? null;
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
      ...arcWrite(queries.create()),
      queryClient,
      // Snapshot set (rolled back on error): the writer's own lists only. What goes stale (every
      // partition, refetched as its own identity) is the change rule's call.
      queryKeys: (vars) => [KEYS.lists(writePartition(vars))],
      invalidate: () => invalidateSettled(queryClient),
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
        const partition = writePartition(variables);
        const tempId = tempIdsRef.current.get(variables);
        if (tempId) {
          const lists = KEYS.lists(partition);
          for (const [qKey, qData] of queryClient.getQueriesData({ queryKey: lists })) {
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
        if (realId) queryClient.setQueryData(KEYS.detail(realId, partition), serverDoc);
      },
      onSuccess: (raw, variables) => {
        settledChanges.push({ op: "create" });
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
      ...arcWrite(queries.update()),
      queryClient,
      // The writer's partition only: its lists, and this record's details (every params variant).
      queryKeys: (vars) => {
        const partition = writePartition(vars);
        return [KEYS.lists(partition), KEYS.detail(vars.id, partition)];
      },
      invalidate: () => invalidateSettled(queryClient),
      shouldToast,
      // One key-aware updater covers every snapshotted cache family:
      //   detail caches of THIS id (every params variant) → raw-doc merge
      //     (arc 2.13+ detail caches hold the doc directly, no `{ data }` envelope);
      //   list caches (flat + infinite pages) → per-item merge.
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
      // Server truth lands before the settled refetch: replace the item in the
      // writer's list + detail caches with the authoritative response document.
      reconcile: (raw, vars) => {
        const { id } = vars;
        const serverDoc = extractItem<T>(raw);
        if (!serverDoc || typeof serverDoc !== "object") return;
        const partition = writePartition(vars);
        const details = KEYS.detail(id, partition);
        for (const [qKey, qData] of queryClient.getQueriesData({ queryKey: details })) {
          if (qData) queryClient.setQueryData(qKey, serverDoc);
        }
        const lists = KEYS.lists(partition);
        for (const [qKey, qData] of queryClient.getQueriesData({ queryKey: lists })) {
          const next = replaceItemInListCache(qData, id, serverDoc, idField ? { idField } : {});
          if (next !== qData) queryClient.setQueryData(qKey, next);
        }
      },
      onSuccess: (raw, { id, data: updateData }) => {
        settledChanges.push({ op: "update", id });
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
      ...arcWrite(queries.remove()),
      queryClient,
      queryKeys: (vars) => [KEYS.lists(writePartition(vars))],
      invalidate: () => invalidateSettled(queryClient),
      shouldToast,
      optimisticUpdate: (oldData, { id }, qKey) => {
        if (qKey[1] !== "list") return oldData;
        return updateListCache(oldData, (arr: unknown[]) =>
          (arr || []).filter((item) => resolveItemId(item) !== id),
        );
      },
      onSuccess: (data, { id }) => {
        // The change rule drops the deleted record's detail (every variant) on settle.
        settledChanges.push({ op: "delete", id });
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
      invalidateQueries: [
        KEYS.lists(),
        KEYS.deleted().slice(0, 2),
        KEYS.counts(),
        KEYS.aggregations(),
      ],
      onSuccess: (_raw, { id }) => {
        void queryClient.invalidateQueries({ queryKey: KEYS.detail(id) });
      },
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
          token: pick(params.token, auth.token),
          organizationId: pick(params.organizationId, auth.organizationId),
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
          const createdId = resolveItemId(entity);
          if (createdId)
            emitArcChange({
              entity: entityKey,
              op: "create",
              id: createdId,
              item: entity,
              previous: null,
            });
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
          let previous: T | null = null;
          // Who the write is sent as: resolved at submit, never inside the queue.
          const vars = resolveActionAuth(params);
          const partition = writePartition(vars);
          // The version is resolved INSIDE the per-record chain: a second update to the
          // same record reads the version the first one's reconcile just cached.
          const raw = await enqueueWrite(partition, params.id, () => {
            previous = cachedDocument(queryClient, params.id, partition);
            return updateMutation.mutateAsync({
              ...vars,
              version: resolveVersion(queryClient, params, partition),
            });
          });
          const entity = extractItem<T>(raw) as T;
          emitArcChange({ entity: entityKey, op: "update", id: params.id, item: entity, previous });
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
      [updateMutation, resolveActionAuth, queryClient],
    );

    const remove = useCallback(
      async (params: DeleteParams, options?: CallOptions): Promise<unknown> => {
        silentRef.current = options?.silent ?? false;
        try {
          let previous: T | null = null;
          const vars = resolveActionAuth(params);
          const partition = writePartition(vars);
          const result = await enqueueWrite(partition, params.id, () => {
            // Read before the optimistic update removes it from every list: after a delete this is
            // the only record of the document (and of its parent, for a listener that needs it).
            previous = cachedDocument(queryClient, params.id, partition);
            return deleteMutation.mutateAsync(vars);
          });
          emitArcChange({ entity: entityKey, op: "delete", id: params.id, item: null, previous });
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
      [deleteMutation, resolveActionAuth, queryClient],
    );

    const restore = useCallback(
      async (params: DeleteParams, options?: CallOptions<T>): Promise<T> => {
        silentRef.current = options?.silent ?? false;
        try {
          const vars = resolveActionAuth(params);
          const raw = await enqueueWrite(writePartition(vars), params.id, () =>
            restoreMutation.mutateAsync(vars),
          );
          const entity = extractItem<T>(raw) as T;
          emitArcChange({
            entity: entityKey,
            op: "restore",
            id: params.id,
            item: entity,
            previous: null,
          });
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

  // ========== usePendingWrites ==========

  function usePendingWrites(): PendingWrite<TCreate, TUpdate>[] {
    return useMutationState({
      filters: { mutationKey: KEYS.write(), status: "pending" },
      select: (mutation) =>
        ({
          op: (mutation.options.meta as ArcMutationMeta | undefined)?.arc.op ?? "update",
          variables: mutation.state.variables,
          submittedAt: mutation.state.submittedAt,
        }) as PendingWrite<TCreate, TUpdate>,
    });
  }

  return { useActions, usePendingWrites };
}
