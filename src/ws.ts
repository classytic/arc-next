"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  ArcApiError,
  buildStreamUrl,
  _getAuthErrorHandler,
  _runAuthRecovery,
} from "./client.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Inbound message shape from Arc's `websocketPlugin` broadcasts.
 *
 * Arc auto-broadcasts CRUD events for resources listed in
 * `websocketPlugin({ resources: [...] })` as:
 *   `{ type: '<resource>.<op>', data: { resource, operation, data: doc, timestamp }, meta }`
 *
 * Custom messages from your handlers can have any shape — typed as `unknown` data.
 */
export interface ArcWsMessage<TData = unknown> {
  type: string;
  data?: TData;
  meta?: Record<string, unknown>;
}

/**
 * Subscribe-frame shape Arc's `websocketPlugin` accepts.
 * Wire format (per backend tests): `{ type: 'subscribe', resource: '<resource>' }`.
 * Backend also accepts `channel` as alias.
 */
export interface ArcSubscribeFrame {
  type: 'subscribe' | 'unsubscribe';
  resource?: string;
  channel?: string;
  /** Free-form additional fields the backend may use (token, filters, etc.). */
  [key: string]: unknown;
}

export interface ConnectWsOptions<TData = unknown> {
  /** Full ws/wss URL. When set, overrides `path` and `baseUrl`. */
  url?: string;
  /** WS path relative to baseUrl (default: `/ws`). Auto-converts http(s)→ws(s). */
  path?: string;
  /**
   * Resources to subscribe to on connect — sends `{type:'subscribe', resource: <name>}`
   * for each. Auto-resubscribes after reconnect.
   */
  subscribe?: string[];
  /**
   * Message types to listen for. When omitted, all messages reach `onMessage`.
   * Pattern matches the type prefix when ending with a dot
   * (e.g. `'todo.'` matches `'todo.created'`), otherwise exact match.
   */
  patterns?: string[];
  /** Callback per inbound message (after pattern filtering). */
  onMessage?: (message: ArcWsMessage<TData>) => void;
  /** Connection-state callback. */
  onConnectionChange?: (connected: boolean) => void;
  /** Reconnect delay in ms. Default: 3000 (capped at 30000 with backoff). */
  reconnectDelay?: number;
  /** Max reconnect attempts. Default: Infinity. */
  maxReconnectAttempts?: number;
  /**
   * Application-level heartbeat interval in ms. When > 0, sends `{type:'ping'}`
   * every N ms so the backend can detect dead clients. Default: 0 (disabled).
   */
  heartbeatInterval?: number;
  /** WebSocket subprotocols (some auth schemes pass tokens here). */
  protocols?: string | string[];
}

/** Per-type listener handle returned by {@link ConnectWsHandle.on}. Call to remove. */
export type WsOffHandle = () => void;

/**
 * Imperative handle returned by {@link connectWs}. Stable across reconnects.
 *
 * Use `on(eventType, handler)` to register an additional per-type listener
 * alongside the global `onMessage` callback. Returns an unsubscribe function.
 */
export interface ConnectWsHandle<TData = unknown> {
  /** True when the WS is OPEN. */
  isConnected: () => boolean;
  /** Send any JSON-serializable payload. Returns false if not connected. */
  send: (payload: unknown) => boolean;
  /** Subscribe to a resource. Persists across reconnects. */
  subscribe: (resource: string) => void;
  /** Unsubscribe from a resource. */
  unsubscribe: (resource: string) => void;
  /**
   * Listen for messages whose type matches `eventType` exactly. Use `'*'` for
   * a catch-all listener. Returns an unsubscribe function.
   */
  on: (eventType: string, handler: (message: ArcWsMessage<TData>) => void) => WsOffHandle;
  /** Close manually (no auto-reconnect after this). */
  close: () => void;
  /** Reopen after a manual close. */
  reconnect: () => void;
}

export interface WebSocketOptions<TData = unknown>
  extends ConnectWsOptions<TData> {
  /** Query keys to invalidate when any matching message is received. */
  invalidateQueries?: QueryKey[];
  /** Whether the socket is active. Default: true. */
  enabled?: boolean;
  /**
   * Whether to track `lastMessage` in React state. Default: true.
   *
   * Set to `false` for high-volume streams (chat, telemetry) where the consumer
   * uses `onMessage` for fire-and-forget handling and never reads
   * `result.lastMessage`. Each inbound frame skips a `setState` call,
   * eliminating per-message re-renders.
   */
  trackLastMessage?: boolean;
  /**
   * Whether to track `messageCount` in React state. Default: true.
   *
   * Same trade-off as `trackLastMessage`: skip the counter `setState` for
   * high-volume streams that don't read it.
   */
  trackMessageCount?: boolean;
}

export interface WebSocketResult<TData = unknown> {
  isConnected: boolean;
  lastMessage: ArcWsMessage<TData> | null;
  messageCount: number;
  send: (payload: unknown) => boolean;
  subscribe: (resource: string) => void;
  unsubscribe: (resource: string) => void;
  close: () => void;
  reconnect: () => void;
}

// ============================================================================
// URL builder (also exported for ad-hoc WebSocket consumers)
// ============================================================================

/**
 * Build an authenticated WebSocket URL using the global client + auth singletons.
 *
 * Thin alias for {@link import('./client.js').buildStreamUrl} with the WS
 * protocol — rewrites `http(s)://` → `ws(s)://` and attaches the same auth
 * params SSE uses, so the two transports stay in lock-step.
 *
 * @example
 * const socket = new WebSocket(buildWsUrl('/ws'));
 */
export function buildWsUrl(
  path: string = '/ws',
  params: Record<string, string | number | boolean | null | undefined> = {},
): string {
  return buildStreamUrl(path, params, 'ws');
}

// ============================================================================
// Plain function — the source of truth (works in Node, tests, non-React UIs)
// ============================================================================

/**
 * Connect to an Arc WebSocket channel from any JS context (React, Node, Bun, tests).
 * Pure function — no React hook required. Returns a handle with `send()`,
 * `subscribe()`, `on()`, `close()`, `reconnect()`, `isConnected()`.
 *
 * Reconnect uses exponential backoff (×1.5 per attempt, capped at 30s).
 * Subscriptions persist across reconnect.
 *
 * @example
 * const ws = connectWs<CrudEvent<Todo>>({
 *   subscribe: ['todo'],
 *   onMessage: (m) => console.log(m.type, m.data),
 * });
 *
 * const off = ws.on('todo.created', (m) => console.log('new todo:', m.data));
 * // ...later
 * off();
 * ws.close();
 */
export function connectWs<TData = unknown>(
  options: ConnectWsOptions<TData> = {},
): ConnectWsHandle<TData> {
  const {
    url,
    path = '/ws',
    reconnectDelay = 3000,
    maxReconnectAttempts = Infinity,
    heartbeatInterval = 0,
    protocols,
    patterns = [],
  } = options;

  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let manualClose = false;
  let connected = false;

  const subscriptions = new Set<string>(options.subscribe ?? []);
  // Per-type listeners registered via on(). '*' is the catch-all bucket.
  const listeners = new Map<string, Set<(m: ArcWsMessage<TData>) => void>>();

  const matchesPattern = (type: string): boolean => {
    if (patterns.length === 0) return true;
    return patterns.some((p) => (p.endsWith('.') ? type.startsWith(p) : type === p));
  };

  const sendRaw = (payload: unknown): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  };

  const dispatch = (message: ArcWsMessage<TData>): void => {
    if (!matchesPattern(message.type)) return;
    options.onMessage?.(message);
    // Per-type listeners + global wildcard.
    const exact = listeners.get(message.type);
    if (exact) for (const fn of exact) fn(message);
    const wildcard = listeners.get('*');
    if (wildcard) for (const fn of wildcard) fn(message);
  };

  const connect = (): void => {
    if (ws) {
      // Detach the previous socket's onclose BEFORE we close it from our side
      // — otherwise the old handler fires and schedules another reconnect,
      // which then closes again, etc. Pre-existing bug that didn't bite
      // because real browser WebSockets transition CONNECTING→OPEN fast
      // enough that the cascade resolves on the first successful open. With
      // a slower / non-auto-opening environment (tests, throttled networks)
      // the cascade compounds. Nulling the handler is the canonical fix.
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try { ws.close(); } catch { /* ignore */ }
    }
    // Defensive: clear any heartbeat from the previous socket BEFORE the new
    // `onopen` fires. Browsers dispatch `onclose` async, so a manual reconnect()
    // can race the prior socket's cleanup and end up with two intervals.
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    manualClose = false;

    const wsUrl = url ?? buildWsUrl(path);
    ws = protocols !== undefined ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);

    ws.onopen = () => {
      reconnectAttempts = 0;
      wsAuthRetries = 0; // fresh budget — a future re-auth can recover again
      connected = true;
      options.onConnectionChange?.(true);

      // Replay subscriptions after every (re)connect.
      for (const resource of subscriptions) {
        sendRaw({ type: 'subscribe', resource } as ArcSubscribeFrame);
      }

      if (heartbeatInterval > 0) {
        heartbeatTimer = setInterval(() => {
          sendRaw({ type: 'ping' });
        }, heartbeatInterval);
      }
    };

    ws.onmessage = (event) => {
      let parsed: ArcWsMessage<TData>;
      try {
        parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        // Non-JSON frame (text/binary) — synthesize a wrapper.
        parsed = { type: 'message', data: event.data as TData };
      }
      dispatch(parsed);
    };

    ws.onerror = () => {
      // Browser fires `error` then `close` — let onclose handle reconnect.
    };

    ws.onclose = (event: CloseEvent) => {
      connected = false;
      options.onConnectionChange?.(false);

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      if (manualClose) return;

      // Auth-recoverable close codes:
      //   1008 — RFC 6455 "Policy Violation" (servers use this for auth fail)
      //   3401 / 4401 — community convention "WebSocket 401" in 3000-4999 ranges
      //   4001 — common in older Socket.io-flavored servers
      // When detected, hand off to the shared `onAuthError` recovery cycle
      // (same dedup as the fetch path — concurrent socket reconnects collapse
      // to one refresh). On 'retry', we reconnect immediately with the fresh
      // token in the URL; on 'skip', we surface the close and stop reconnecting.
      const { handler, maxAuthRetries } = _getAuthErrorHandler();
      const isAuthClose =
        event.code === 1008 ||
        event.code === 3401 ||
        event.code === 4001 ||
        event.code === 4401;

      if (handler && isAuthClose && wsAuthRetries < maxAuthRetries) {
        wsAuthRetries += 1;
        const synthError = new ArcApiError(
          event.reason || `WebSocket closed with auth code ${event.code}`,
          {
            status: 401,
            statusText: 'WebSocket auth failure',
            json: { code: 'arc.websocket.unauthorized', wsCloseCode: event.code, reason: event.reason },
            endpoint: url ?? path,
            method: 'GET',
          },
        );
        _runAuthRecovery(handler, {
          error: synthError,
          request: { method: 'GET', endpoint: url ?? path },
          attempt: wsAuthRetries,
        })
          .then(({ decision }) => {
            if (decision === 'retry') {
              // Reset reconnectAttempts so we don't apply backoff to the
              // recovery — the refresh already took its own time.
              reconnectAttempts = 0;
              connect();
            }
            // 'skip' → no reconnect; consumer sees connection stay down.
          })
          .catch(() => {
            // Handler threw — surface via the connection-state callback;
            // no reconnect (the throw is a signal that recovery is impossible).
          });
        return;
      }

      // Non-auth close OR no recovery handler wired OR cap hit — fall back
      // to the existing reconnect-with-backoff behavior.
      if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts += 1;
        const delay = Math.min(
          reconnectDelay * Math.pow(1.5, reconnectAttempts - 1),
          30000,
        );
        reconnectTimer = setTimeout(connect, delay);
      }
    };
  };

  // Per-socket auth-retry counter. Reset on every successful onopen so a
  // long-lived socket that experiences periodic re-auth doesn't permanently
  // exhaust its recovery budget.
  let wsAuthRetries = 0;

  connect();

  return {
    isConnected: () => connected,
    send: sendRaw,
    subscribe: (resource) => {
      subscriptions.add(resource);
      if (ws?.readyState === WebSocket.OPEN) {
        sendRaw({ type: 'subscribe', resource } as ArcSubscribeFrame);
      }
    },
    unsubscribe: (resource) => {
      subscriptions.delete(resource);
      if (ws?.readyState === WebSocket.OPEN) {
        sendRaw({ type: 'unsubscribe', resource } as ArcSubscribeFrame);
      }
    },
    on: (eventType, handler) => {
      let bucket = listeners.get(eventType);
      if (!bucket) {
        bucket = new Set();
        listeners.set(eventType, bucket);
      }
      bucket.add(handler);
      return () => {
        bucket?.delete(handler);
        if (bucket && bucket.size === 0) listeners.delete(eventType);
      };
    },
    close: () => {
      manualClose = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
      connected = false;
      options.onConnectionChange?.(false);
    },
    reconnect: () => {
      reconnectAttempts = 0;
      manualClose = false;
      connect();
    },
  };
}

// ============================================================================
// React hook — thin wrapper over connectWs()
// ============================================================================

/**
 * Connect to an Arc WebSocket channel with auto-reconnect, subscription
 * persistence, and TanStack Query invalidation on inbound messages.
 *
 * Internally delegates to {@link connectWs} — for non-React contexts (Node,
 * tests, plain JS) call that directly.
 *
 * @example
 * const { isConnected, lastMessage } = useWebSocket<CrudEvent<Todo>>({
 *   subscribe: ['todo'],
 *   invalidateQueries: [todoKeys.lists()],
 * });
 */
export function useWebSocket<TData = unknown>(
  options: WebSocketOptions<TData>,
): WebSocketResult<TData> {
  const {
    url,
    path = '/ws',
    enabled = true,
    trackLastMessage = true,
    trackMessageCount = true,
  } = options;

  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<ArcWsMessage<TData> | null>(null);
  const [messageCount, setMessageCount] = useState(0);

  const handleRef = useRef<ConnectWsHandle<TData> | null>(null);
  const onMessageRef = useRef(options.onMessage);
  onMessageRef.current = options.onMessage;
  const onConnectionChangeRef = useRef(options.onConnectionChange);
  onConnectionChangeRef.current = options.onConnectionChange;
  const invalidateKeysRef = useRef(options.invalidateQueries ?? []);
  invalidateKeysRef.current = options.invalidateQueries ?? [];

  // Stabilize array deps by content
  const subscribeKey = JSON.stringify(options.subscribe ?? []);
  const patternsKey = JSON.stringify(options.patterns ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const subscribeArr = useMemo(() => options.subscribe ?? [], [subscribeKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const patternsArr = useMemo(() => options.patterns, [patternsKey]);

  useEffect(() => {
    if (!enabled) {
      handleRef.current?.close();
      handleRef.current = null;
      return;
    }

    const handle = connectWs<TData>({
      url,
      path,
      subscribe: subscribeArr,
      patterns: patternsArr,
      reconnectDelay: options.reconnectDelay,
      maxReconnectAttempts: options.maxReconnectAttempts,
      heartbeatInterval: options.heartbeatInterval,
      protocols: options.protocols,
      onConnectionChange: (c) => {
        setIsConnected(c);
        onConnectionChangeRef.current?.(c);
      },
      onMessage: (msg) => {
        if (trackLastMessage) setLastMessage(msg);
        if (trackMessageCount) setMessageCount((n) => n + 1);
        onMessageRef.current?.(msg);
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
    path,
    subscribeArr,
    patternsArr,
    options.reconnectDelay,
    options.maxReconnectAttempts,
    options.heartbeatInterval,
    options.protocols,
    trackLastMessage,
    trackMessageCount,
    queryClient,
  ]);

  const subscribe = useCallback((resource: string) => {
    handleRef.current?.subscribe(resource);
  }, []);
  const unsubscribe = useCallback((resource: string) => {
    handleRef.current?.unsubscribe(resource);
  }, []);
  const send = useCallback((payload: unknown) => {
    return handleRef.current?.send(payload) ?? false;
  }, []);
  const close = useCallback(() => handleRef.current?.close(), []);
  const reconnect = useCallback(() => handleRef.current?.reconnect(), []);

  return {
    isConnected,
    lastMessage,
    messageCount,
    send,
    subscribe,
    unsubscribe,
    close,
    reconnect,
  };
}
