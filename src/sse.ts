"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  ArcApiError,
  getAuthMode,
  buildStreamUrl,
  _getAuthErrorHandler,
  _runAuthRecovery,
} from "./client.js";

// ============================================================================
// URL builder (also exported for ad-hoc EventSource consumers)
// ============================================================================

/**
 * Build an authenticated SSE URL using the global client + auth singletons.
 *
 * Thin alias for {@link import('./client.js').buildStreamUrl} with the HTTP
 * protocol — kept as a named export so SSE consumers don't have to think about
 * the `protocol` arg.
 *
 * @example
 * const es = new EventSource(buildSseUrl('/jobs/stream', { jobId }), {
 *   withCredentials: getAuthMode() === 'cookie',
 * });
 */
export function buildSseUrl(
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): string {
  return buildStreamUrl(path, params, 'http');
}

// ============================================================================
// Types
// ============================================================================

/**
 * Generic Arc server event envelope.
 *
 * Defaults to `unknown` payload — narrow with the generic when you control
 * the broadcast shape (`ArcServerEvent<Todo>`). For the canonical CRUD shape,
 * use {@link CrudEvent} which constrains `type` to `<resource>.<operation>`
 * and `operation` to the three lifecycle verbs.
 */
export interface ArcServerEvent<TData = unknown> {
  type: string;
  resource: string;
  data: TData;
  timestamp: string;
  id?: string;
}

/** Lifecycle operations Arc emits on every CRUD broadcast. */
export type CrudOperation = "created" | "updated" | "deleted";

/**
 * Typed CRUD event narrowed to Arc's `<resource>.<operation>` envelope.
 *
 * Arc auto-emits this shape from `BaseController` for every list/get/create/
 * update/delete. Pass `<TDoc>` so SSE/WS callbacks get inference for free:
 *
 * ```ts
 * subscribeToEvents<CrudEvent<Todo>>({
 *   resource: 'todo',
 *   onEvent: (e) => console.log(e.operation, e.data.title),
 * });
 * ```
 */
export interface CrudEvent<TDoc = unknown> extends ArcServerEvent<TDoc> {
  /** Always `<resource>.<operation>` (e.g. `'todo.created'`). */
  type: string;
  operation: CrudOperation;
}

export interface SubscribeToEventsOptions<TData = unknown> {
  /** Full SSE endpoint URL. When set, overrides `path` and `baseUrl`. */
  url?: string;
  /** Resource name for auto pattern filtering + named-event derivation. */
  resource?: string;
  /** Endpoint path (default: `/events/stream`). */
  path?: string;
  /** Event patterns to listen for (e.g. `['todo.*']`). Empty → all events. */
  patterns?: string[];
  /**
   * Named SSE event types to subscribe to via `addEventListener`.
   * Falls back to `patterns` (literal entries) or `[<resource>.created|updated|deleted]`.
   * Pass `[]` to opt out of named-event subscription entirely.
   */
  eventTypes?: string[];
  /** Per-event callback. */
  onEvent?: (event: ArcServerEvent<TData>) => void;
  /** Connection-state callback. */
  onConnectionChange?: (connected: boolean) => void;
  /** Reconnect delay in ms. Default: 3000. */
  reconnectDelay?: number;
  /** Maximum reconnect attempts. Default: Infinity. */
  maxReconnectAttempts?: number;
  /** Whether to include credentials (cookies). Derived from authMode when not set. */
  withCredentials?: boolean;
}

/** Handle returned by {@link subscribeToEvents}. Stable across reconnects. */
export interface SubscribeToEventsHandle {
  close: () => void;
  reconnect: () => void;
  isConnected: () => boolean;
}

export interface EventStreamOptions<TData = unknown>
  extends SubscribeToEventsOptions<TData> {
  /** Query keys to invalidate when any matching event arrives. */
  invalidateQueries?: QueryKey[];
  /** Whether the stream is active. Default: true. */
  enabled?: boolean;
  /**
   * Whether to track `lastEvent` in React state. Default: true.
   *
   * Set to `false` for high-volume streams (telemetry, live tickers) where
   * the consumer uses `onEvent` for fire-and-forget handling and never reads
   * `result.lastEvent`. Each inbound frame skips a `setState` call,
   * eliminating per-event re-renders.
   */
  trackLastEvent?: boolean;
  /**
   * Whether to track `eventCount` in React state. Default: true.
   *
   * Same trade-off as `trackLastEvent`: skip the counter `setState` for
   * high-volume streams that don't read it.
   */
  trackEventCount?: boolean;
}

export interface EventStreamResult<TData = unknown> {
  isConnected: boolean;
  lastEvent: ArcServerEvent<TData> | null;
  eventCount: number;
  close: () => void;
  reconnect: () => void;
}

// ============================================================================
// Pre-flight probe — distinguishes auth failures from transient errors
// ============================================================================

/**
 * Send a minimal HEAD/GET probe to the SSE URL to classify an EventSource
 * failure as either an auth failure (401, or 403 when `retryOn403`) or
 * something transient (network, 5xx, CORS). EventSource itself doesn't
 * expose status codes — this is the only cross-browser way to route SSE
 * close events through `onAuthError`.
 *
 * The probe uses HEAD when supported (cheaper); falls back to GET with
 * `Range: bytes=0-0` for servers that 405 on HEAD. Either way, the body
 * is never read — only the status code matters.
 */
async function probeForAuthFailure(
  url: string,
  retryOn403: boolean,
): Promise<'auth-failure' | 'not-auth'> {
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      credentials: 'include',
    });
    // Some SSE servers (Fastify's sse, Cloudflare) reject HEAD with 405.
    // Fall back to a single-byte GET so we still learn the auth status.
    if (res.status === 405) {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Range: 'bytes=0-0' },
      });
    }
    if (res.status === 401) return 'auth-failure';
    if (retryOn403 && res.status === 403) return 'auth-failure';
    return 'not-auth';
  } catch {
    // Network failure — not an auth issue, let backoff handle it.
    return 'not-auth';
  }
}

// ============================================================================
// Plain function — the source of truth (works in Node, tests, non-React UIs)
// ============================================================================

/**
 * Subscribe to an Arc SSE stream from any JS context (React, Node, Bun, tests).
 * Pure function — no React hook required. Returns a handle with `close()` /
 * `reconnect()` / `isConnected()`.
 *
 * Reconnect uses exponential backoff (×1.5 per attempt, capped at 30s).
 * Subscriptions persist across reconnect.
 *
 * @example
 * const sub = subscribeToEvents<CrudEvent<Todo>>({
 *   resource: 'todo',
 *   onEvent: (e) => console.log(e.operation, e.data.title),
 * });
 * // ...later
 * sub.close();
 */
export function subscribeToEvents<TData = unknown>(
  options: SubscribeToEventsOptions<TData>,
): SubscribeToEventsHandle {
  const {
    url,
    resource,
    path: ssePath = "/events/stream",
    patterns = [],
    reconnectDelay = 3000,
    maxReconnectAttempts = Infinity,
    withCredentials,
  } = options;

  let es: EventSource | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let manualClose = false;
  let connected = false;

  // Resolve named-event subscriptions (Arc's ssePlugin uses `event:` frames).
  const resolvedEventTypes: string[] =
    options.eventTypes !== undefined
      ? options.eventTypes
      : patterns.length > 0
        ? patterns.filter((p) => !p.includes("*"))
        : resource
          ? [`${resource}.created`, `${resource}.updated`, `${resource}.deleted`]
          : [];

  const buildUrl = (): string => {
    if (url) return url;
    const effectivePatterns =
      patterns.length > 0 ? patterns : resource ? [`${resource}.*`] : [];
    const params: Record<string, string> = {};
    if (effectivePatterns.length > 0) {
      params.patterns = effectivePatterns.join(",");
    }
    return buildSseUrl(ssePath, params);
  };

  const dispatch = (parsed: ArcServerEvent<TData>) => {
    if (patterns.length > 0 && !patterns.includes(parsed.type)) {
      return;
    }
    options.onEvent?.(parsed);
  };

  const connect = (): void => {
    if (es) {
      try { es.close(); } catch { /* ignore */ }
    }
    manualClose = false;

    const credentials = withCredentials ?? getAuthMode() === "cookie";
    es = new EventSource(buildUrl(), { withCredentials: credentials });

    es.onopen = () => {
      reconnectAttempts = 0;
      sseAuthRetries = 0; // fresh budget — a future re-auth can recover again
      connected = true;
      options.onConnectionChange?.(true);
    };

    // Default `message` channel — bodies are JSON-encoded ArcServerEvent.
    es.onmessage = (event) => {
      try {
        dispatch(JSON.parse(event.data) as ArcServerEvent<TData>);
      } catch {
        // Non-JSON event (heartbeat, etc.) — ignore
      }
    };

    // Named-event channels — Arc's ssePlugin writes `event: <type>\ndata: <json>`
    // frames, which the EventSource spec routes through addEventListener(type)
    // rather than onmessage. Match both flavors.
    for (const eventType of resolvedEventTypes) {
      es.addEventListener(eventType, (event: MessageEvent) => {
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          payload = event.data;
        }
        const isShaped =
          typeof payload === "object" &&
          payload !== null &&
          "type" in (payload as Record<string, unknown>) &&
          "data" in (payload as Record<string, unknown>);

        const parsed: ArcServerEvent<TData> = isShaped
          ? (payload as ArcServerEvent<TData>)
          : {
              type: eventType,
              resource: resource ?? eventType.split(".")[0] ?? "",
              data: payload as TData,
              timestamp: new Date().toISOString(),
              ...(event.lastEventId ? { id: event.lastEventId } : {}),
            };

        dispatch(parsed);
      });
    }

    es.onerror = () => {
      try { es?.close(); } catch { /* ignore */ }
      connected = false;
      options.onConnectionChange?.(false);

      if (manualClose) return;

      // EventSource doesn't expose HTTP status codes — it just fires an
      // opaque `error` for any failure (network, 401, 403, 5xx, CORS). To
      // route 401/403 through the shared `onAuthError` recovery cycle we
      // do a pre-flight `fetch(...)` to the same URL: if it returns 401
      // (or 403 with `retryOn403`), hand off to recovery; on 'retry',
      // reopen the EventSource (which re-reads the auth params via
      // `buildSseUrl`); on 'skip', fall back to the normal reconnect-
      // with-backoff path so transient network errors still recover.
      const { handler, retryOn403, maxAuthRetries } = _getAuthErrorHandler();
      if (handler && sseAuthRetries < maxAuthRetries) {
        sseAuthRetries += 1;
        probeForAuthFailure(buildUrl(), retryOn403)
          .then(async (status) => {
            if (status === 'auth-failure') {
              const { decision } = await _runAuthRecovery(handler, {
                error: new ArcApiError('SSE pre-flight auth failure', {
                  status: 401,
                  statusText: 'SSE auth failure',
                  json: { code: 'arc.sse.unauthorized' },
                  endpoint: ssePath,
                  method: 'GET',
                }),
                request: { method: 'GET', endpoint: ssePath },
                attempt: sseAuthRetries,
              });
              if (decision === 'retry') {
                reconnectAttempts = 0;
                connect();
                return;
              }
            }
            // 'not-auth' or 'skip' → backoff reconnect as before.
            scheduleReconnect();
          })
          .catch(() => {
            // Probe itself failed (network down) — treat as transient and
            // fall back to backoff reconnect.
            scheduleReconnect();
          });
        return;
      }

      scheduleReconnect();
    };
  };

  /** Standard backoff-reconnect — shared between non-auth errors and skipped recoveries. */
  const scheduleReconnect = (): void => {
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts += 1;
      const delay = Math.min(
        reconnectDelay * Math.pow(1.5, reconnectAttempts - 1),
        30000,
      );
      reconnectTimer = setTimeout(connect, delay);
    }
  };

  // Per-subscription auth-retry counter — reset on successful onopen so a
  // long-lived stream can recover from periodic re-auth multiple times.
  let sseAuthRetries = 0;

  connect();

  return {
    close: () => {
      manualClose = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es) {
        try { es.close(); } catch { /* ignore */ }
        es = null;
      }
      connected = false;
      options.onConnectionChange?.(false);
    },
    reconnect: () => {
      reconnectAttempts = 0;
      manualClose = false;
      connect();
    },
    isConnected: () => connected,
  };
}

// ============================================================================
// React hook — thin wrapper over subscribeToEvents()
// ============================================================================

/**
 * Subscribe to Arc server-sent events for real-time cache invalidation.
 *
 * Uses the browser's native `EventSource` for automatic reconnection
 * and efficient server-push. Events trigger query invalidation so TanStack Query
 * refetches affected data automatically.
 *
 * Internally delegates to {@link subscribeToEvents} — for non-React contexts
 * (Node, tests, plain JS) call that directly.
 *
 * @example
 * const { isConnected } = useEventStream<CrudEvent<Todo>>({
 *   resource: 'todo',
 *   invalidateQueries: [todoKeys.lists()],
 * });
 */
export function useEventStream<TData = unknown>(
  options: EventStreamOptions<TData>,
): EventStreamResult<TData> {
  const {
    url,
    resource,
    path,
    enabled = true,
    trackLastEvent = true,
    trackEventCount = true,
  } = options;

  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<ArcServerEvent<TData> | null>(null);
  const [eventCount, setEventCount] = useState(0);

  const handleRef = useRef<SubscribeToEventsHandle | null>(null);
  const onEventRef = useRef(options.onEvent);
  onEventRef.current = options.onEvent;
  const onConnectionChangeRef = useRef(options.onConnectionChange);
  onConnectionChangeRef.current = options.onConnectionChange;
  const invalidateKeysRef = useRef(options.invalidateQueries ?? []);
  invalidateKeysRef.current = options.invalidateQueries ?? [];

  // Stabilize array deps by content so inline `[...]` doesn't re-run effects.
  const patternsKey = JSON.stringify(options.patterns ?? null);
  const eventTypesKey = JSON.stringify(options.eventTypes ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const patterns = useMemo(() => options.patterns, [patternsKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const eventTypes = useMemo(() => options.eventTypes, [eventTypesKey]);

  useEffect(() => {
    if (!enabled) {
      handleRef.current?.close();
      handleRef.current = null;
      return;
    }

    const handle = subscribeToEvents<TData>({
      url,
      resource,
      path,
      patterns,
      eventTypes,
      reconnectDelay: options.reconnectDelay,
      maxReconnectAttempts: options.maxReconnectAttempts,
      withCredentials: options.withCredentials,
      onConnectionChange: (c) => {
        setIsConnected(c);
        onConnectionChangeRef.current?.(c);
      },
      onEvent: (event) => {
        if (trackLastEvent) setLastEvent(event);
        if (trackEventCount) setEventCount((n) => n + 1);
        onEventRef.current?.(event);
        for (const key of invalidateKeysRef.current) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      },
    });
    handleRef.current = handle;

    return () => {
      handle.close();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    url,
    resource,
    path,
    patterns,
    eventTypes,
    options.reconnectDelay,
    options.maxReconnectAttempts,
    options.withCredentials,
    trackLastEvent,
    trackEventCount,
    queryClient,
  ]);

  return {
    isConnected,
    lastEvent,
    eventCount,
    close: () => handleRef.current?.close(),
    reconnect: () => handleRef.current?.reconnect(),
  };
}
