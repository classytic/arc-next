"use client";

// Resource subscription lifecycle; both transports use the shared cache invalidation rule.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { CrudOperation } from "../realtime/sse.js";
import type { QueryKeys } from "./cache.js";
import { invalidateForChange } from "./cache.js";

interface ResourceSyncConfig {
  entityKey: string;
  idField?: string;
  KEYS: QueryKeys;
}

export function createResourceSync({ entityKey, idField, KEYS }: ResourceSyncConfig) {
  // ========== useResourceSync (real-time auto-invalidation) ==========

  /**
   * Subscribe to live `<resource>.<operation>` broadcasts from arc and
   * auto-invalidate this entity's TanStack Query cache.
   *
   * - `source: 'ws'` (default) → arc's `websocketPlugin` at `/ws`. Sends a
   *   `{ type: 'subscribe', resource }` handshake on connect. The WS client (`./ws`) is loaded
   *   on first use, like SSE.
   * - `source: 'sse'` → arc's `ssePlugin` at `/events/stream`. Auto-derives
   *   patterns from the resource name. The SSE client (`./sse`) is loaded on
   *   first use, so it connects a module load after mount.
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
    // Rethrows a failed lazy SSE start during render, so it reaches an error boundary as before.
    const [, setStartError] = useState<undefined>();

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

        // The same change rule a local write uses: lists, counts, aggregations; the record's
        // own detail on update; a deleted record's detail is dropped.
        const op =
          operation === "created" ? "create" : operation === "updated" ? "update" : "delete";
        void invalidateForChange(queryClient, KEYS, { op, id });

        onEventRef.current?.({ operation, id, data: doc });
      };

      const onConnectionChange = (c: boolean) => {
        setIsConnected(c);
        onConnRef.current?.(c);
      };
      // Both transports load on first use, so `.` ships neither realtime client.
      // A hook unmounted before its client loaded never connects.
      let handle: { close(): void } | null = null;
      let active = true;
      const connect: Promise<() => { close(): void }> =
        source === "sse"
          ? import("../realtime/sse.js").then(
              ({ subscribeToEvents }) =>
                () =>
                  subscribeToEvents({
                    resource,
                    path,
                    onConnectionChange,
                    onEvent: (event) => handleBroadcast(event.type, event.data),
                  }),
            )
          : // WebSocket: subscribe to the resource channel; arc broadcasts
            // `<resource>.created|updated|deleted` after the handshake.
            import("../realtime/ws.js").then(
              ({ connectWs }) =>
                () =>
                  connectWs({
                    path,
                    subscribe: [resource],
                    // Arc sends `<resource>.<op>` types: pattern-filter to skip non-CRUD.
                    patterns: [`${resource}.`],
                    onConnectionChange,
                    onMessage: (message) => handleBroadcast(message.type, message.data),
                  }),
            );
      connect
        .then((open) => {
          if (active) handle = open();
        })
        .catch((error: unknown) => {
          if (active)
            setStartError(() => {
              throw error;
            });
        });
      return () => {
        active = false;
        handle?.close();
      };
    }, [enabled, source, resource, path, queryClient]);

    return { isConnected };
  }

  return useResourceSync;
}
