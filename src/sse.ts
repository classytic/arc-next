"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { getAuthContext, getAuthMode } from "./client.js";

// ============================================================================
// Types
// ============================================================================

export interface ArcServerEvent {
  type: string;
  resource: string;
  data: unknown;
  timestamp: string;
  id?: string;
}

export interface EventStreamOptions {
  /** SSE endpoint URL (absolute or relative to baseUrl). Default: `/{basePath}/{resource}/events/stream` */
  url?: string;
  /** Resource name used for the default endpoint path and event filtering. */
  resource?: string;
  /** Base path for the events endpoint. Default: '/api/v1' */
  basePath?: string;
  /** Event patterns to listen for (e.g., ['agents.created', 'agents.updated']). When empty, all events are received. */
  patterns?: string[];
  /** Query keys to invalidate when any event is received. */
  invalidateQueries?: QueryKey[];
  /** Callback for each event. */
  onEvent?: (event: ArcServerEvent) => void;
  /** Callback for connection state changes. */
  onConnectionChange?: (connected: boolean) => void;
  /** Whether the stream is enabled. Default: true */
  enabled?: boolean;
  /** Reconnect delay in ms. Default: 3000 */
  reconnectDelay?: number;
  /** Maximum reconnect attempts before giving up. Default: Infinity */
  maxReconnectAttempts?: number;
  /** Whether to include credentials (cookies). Derived from authMode when not set. */
  withCredentials?: boolean;
}

export interface EventStreamResult {
  /** Whether the EventSource is currently connected. */
  isConnected: boolean;
  /** The most recently received event. */
  lastEvent: ArcServerEvent | null;
  /** Number of events received since connection. */
  eventCount: number;
  /** Close the connection manually. */
  close: () => void;
  /** Reconnect after a manual close. */
  reconnect: () => void;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Subscribe to Arc server-sent events for real-time cache invalidation.
 *
 * Uses the browser's native `EventSource` API for automatic reconnection
 * and efficient server-push. Events trigger query invalidation so TanStack Query
 * refetches affected data automatically.
 *
 * @example
 * const { isConnected } = useEventStream({
 *   resource: 'agents',
 *   invalidateQueries: [agentKeys.lists()],
 * });
 */
export function useEventStream(options: EventStreamOptions): EventStreamResult {
  const {
    url,
    resource,
    basePath = "/api/v1",
    enabled = true,
    reconnectDelay = 3000,
    maxReconnectAttempts = Infinity,
    withCredentials,
  } = options;

  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<ArcServerEvent | null>(null);
  const [eventCount, setEventCount] = useState(0);

  const esRef = useRef<EventSource | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualCloseRef = useRef(false);

  // Stable refs for values that change without triggering reconnect
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;
  const onConnectionChangeRef = useRef(options.onConnectionChange);
  onConnectionChangeRef.current = options.onConnectionChange;
  const patternsRef = useRef(options.patterns ?? []);
  patternsRef.current = options.patterns ?? [];
  const invalidateKeysRef = useRef(options.invalidateQueries ?? []);
  invalidateKeysRef.current = options.invalidateQueries ?? [];

  const buildUrl = useCallback(() => {
    if (url) return url;
    if (!resource) throw new Error("[arc-next] useEventStream requires either `url` or `resource`");

    // Read auth fresh on every connect (not stale from closure)
    const auth = getAuthContext();
    const params = new URLSearchParams();

    const patterns = patternsRef.current;
    if (patterns.length > 0) {
      params.set("patterns", patterns.join(","));
    }
    if (auth.organizationId) {
      params.set("organizationId", auth.organizationId);
    }
    if (auth.token) {
      params.set("token", auth.token);
    }

    const qs = params.toString();
    const base = `${basePath}/${resource}/events/stream`;
    return qs ? `${base}?${qs}` : base;
  }, [url, resource, basePath]);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    manualCloseRef.current = false;
    const eventUrl = buildUrl();

    const authMode = getAuthMode();
    const credentials = withCredentials ?? authMode === "cookie";

    const es = new EventSource(eventUrl, { withCredentials: credentials });
    esRef.current = es;

    es.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setIsConnected(true);
      onConnectionChangeRef.current?.(true);
    };

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as ArcServerEvent;

        // Filter by patterns if specified (read from ref, not closure)
        const patterns = patternsRef.current;
        if (patterns.length > 0 && !patterns.includes(parsed.type)) {
          return;
        }

        setLastEvent(parsed);
        setEventCount((c) => c + 1);
        onEventRef.current?.(parsed);

        // Invalidate queries on event (read from ref, not closure)
        const keys = invalidateKeysRef.current;
        for (const key of keys) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      } catch {
        // Non-JSON event (heartbeat, etc.) — ignore
      }
    };

    es.onerror = () => {
      es.close();
      setIsConnected(false);
      onConnectionChangeRef.current?.(false);

      if (manualCloseRef.current) return;

      // Auto-reconnect with backoff
      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        reconnectAttemptsRef.current += 1;
        const delay = Math.min(
          reconnectDelay * Math.pow(1.5, reconnectAttemptsRef.current - 1),
          30000,
        );
        reconnectTimerRef.current = setTimeout(connect, delay);
      }
    };
  }, [buildUrl, queryClient, withCredentials, reconnectDelay, maxReconnectAttempts]);

  const close = useCallback(() => {
    manualCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setIsConnected(false);
    onConnectionChangeRef.current?.(false);
  }, []);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    if (!enabled) {
      close();
      return;
    }

    connect();

    return () => {
      manualCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [enabled, connect, close]);

  return { isConnected, lastEvent, eventCount, close, reconnect };
}
