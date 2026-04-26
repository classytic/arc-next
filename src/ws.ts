"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { buildStreamUrl } from "./client.js";

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

    ws.onclose = () => {
      connected = false;
      options.onConnectionChange?.(false);

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      if (manualClose) return;

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
