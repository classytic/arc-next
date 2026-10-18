"use client";

import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  _getAuthErrorHandler,
  _getStreamConfig,
  _runAuthRecovery,
  ArcApiError,
  arcAuthHeaders,
  buildStreamUrl,
  CLIENT_ERROR_CODES,
  type EventSourceConstructor,
  type EventSourceLike,
  getAuthMode,
} from "./client.js";
import { useTabLeader } from "./tab-leader.js";

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
  return buildStreamUrl(path, params, "http");
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

export interface EventStreamOptions<TData = unknown> extends SubscribeToEventsOptions<TData> {
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
  /**
   * Hold ONE connection per browser rather than one per tab. Default: true.
   *
   * Browsers allow ~6 concurrent connections per origin on HTTP/1.1, so a
   * per-tab stream lets a user starve their own app with a handful of tabs, and
   * multiplies every reconnect against one server-side limit. The elected tab
   * connects and relays events and connection state over `BroadcastChannel`;
   * followers apply both without a socket.
   *
   * React-only — {@link subscribeToEvents} stays a plain per-caller connection,
   * because tab coordination is a browser lifecycle concern and that function is
   * the Node-capable core.
   *
   * Set false for a stream that must be per-tab.
   */
  shareAcrossTabs?: boolean;
}

/**
 * Cross-tab protocol.
 *
 * `isConnected` must mean "this tab is receiving events", not "this tab owns a
 * socket" — consumers gate polling on it (`refetchInterval: isConnected ? false
 * : …`), so a follower reporting `false` polls while live, and one assuming
 * `true` stops polling while the shared socket is down. Neither guess is safe,
 * so the leader states it and an arriving follower asks.
 */
type TabMessage<TData> =
  | { kind: "event"; event: ArcServerEvent<TData> }
  | { kind: "state"; connected: boolean }
  | { kind: "hello" };

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
/** `Retry-After` is delta-seconds or an HTTP-date. Unparseable ⇒ no opinion. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

interface ProbeResult {
  kind: "auth-failure" | "rate-limited" | "not-auth";
  /** Server-stated wait, when it gave one. */
  retryAfterMs?: number;
}

/**
 * Learn WHY the stream failed, since `EventSource` will not say.
 *
 * 429 matters as much as 401 and fails worse: a rate-limited stream that
 * reconnects on the backoff schedule spends a token per attempt, so the window
 * never drains and the client locks itself out indefinitely. The probe is a
 * plain `fetch`, so unlike the stream it can read both the status and
 * `Retry-After`.
 */
async function probeConnectionFailure(
  url: string,
  retryOn403: boolean,
  authHeaders: Record<string, string> = {},
): Promise<ProbeResult> {
  try {
    let res = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      headers: authHeaders,
    });
    // Some SSE servers (Fastify's sse, Cloudflare) reject HEAD with 405.
    // Fall back to a single-byte GET so we still learn the auth status.
    if (res.status === 405) {
      res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { ...authHeaders, Range: "bytes=0-0" },
      });
    }
    if (res.status === 401) return { kind: "auth-failure" };
    if (retryOn403 && res.status === 403) return { kind: "auth-failure" };
    if (res.status === 429) {
      return {
        kind: "rate-limited",
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      };
    }
    return { kind: "not-auth" };
  } catch {
    // Network failure — not an auth issue, let backoff handle it.
    return { kind: "not-auth" };
  }
}

/**
 * Classify a failure from a status the EventSource implementation already
 * reported (the built-in `FetchEventSource` does), so no probe is needed.
 * `0` = no response at all (network/CORS) — transient, like the probe's catch.
 */
function classifyStatus(
  status: number,
  retryOn403: boolean,
  headers: { get(name: string): string | null } | undefined,
): ProbeResult {
  if (status === 401) return { kind: "auth-failure" };
  if (retryOn403 && status === 403) return { kind: "auth-failure" };
  if (status === 429) {
    return {
      kind: "rate-limited",
      retryAfterMs: parseRetryAfter(headers?.get("retry-after") ?? null),
    };
  }
  return { kind: "not-auth" };
}

// ============================================================================
// Built-in header-capable transport (lazy)
// ============================================================================

/**
 * Loaded on first use only — a dynamic import, so apps on the native
 * `EventSource` (query auth, or an injected implementation) never ship
 * `sse-fetch` in their `/sse` bundle.
 */
let fetchEventSourceCtor: EventSourceConstructor | undefined;
let fetchEventSourceLoad: Promise<EventSourceConstructor> | undefined;

function loadFetchEventSource(): Promise<EventSourceConstructor> {
  fetchEventSourceLoad ??= import("./sse-fetch.js").then((m) => {
    fetchEventSourceCtor = m.FetchEventSource;
    return m.FetchEventSource;
  });
  return fetchEventSourceLoad;
}

/**
 * Whether `FetchEventSource` can run here: streaming `fetch` + `TextDecoder` +
 * `AbortController`. React Native has `fetch` and (polyfilled) streams but its
 * `fetch` never streams a response body, so it is excluded by name and keeps
 * needing `react-native-sse`.
 */
function canStreamFetch(): boolean {
  if (typeof navigator !== "undefined" && navigator.product === "ReactNative") return false;
  return (
    typeof fetch === "function" &&
    typeof ReadableStream !== "undefined" &&
    typeof TextDecoder !== "undefined" &&
    typeof AbortController !== "undefined"
  );
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

  let es: EventSourceLike | null = null;
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
    const effectivePatterns = patterns.length > 0 ? patterns : resource ? [`${resource}.*`] : [];
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

  /**
   * Last event ID seen on this subscription. Sent as `Last-Event-ID` on the
   * next connection (header mode — the only mode whose transport can send it)
   * so the server can replay what was missed while disconnected.
   */
  let lastEventId = "";
  const noteEventId = (id: string | null | undefined): void => {
    if (typeof id === "string") lastEventId = id;
  };
  /** Bumped per connect: a lazily-loaded transport must not open a superseded connection. */
  let connectSeq = 0;

  const connect = (): void => {
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
    }
    manualClose = false;
    const seq = ++connectSeq;

    const { eventSource: Impl, streamAuth } = _getStreamConfig();
    if (streamAuth === "header" && !Impl) {
      if (!canStreamFetch()) {
        throw new Error(
          "[arc-next] configureClient({ streamAuth: 'header' }) requires an injected `eventSource` " +
            "that accepts headers on this runtime (e.g. react-native-sse on React Native, whose " +
            "fetch cannot stream). The native EventSource cannot send headers, and the SDK will " +
            "not move the token into the URL instead.",
        );
      }
      if (fetchEventSourceCtor) {
        open(fetchEventSourceCtor, streamAuth);
        return;
      }
      loadFetchEventSource().then(
        (FetchES) => {
          if (seq === connectSeq && !manualClose) open(FetchES, streamAuth);
        },
        () => {
          if (seq === connectSeq && !manualClose) scheduleReconnect();
        },
      );
      return;
    }
    const ES = Impl ?? (globalThis.EventSource as EventSourceConstructor | undefined);
    if (!ES) {
      throw new Error(
        "[arc-next] No EventSource in this runtime. Pass one via " +
          "configureClient({ eventSource }) (e.g. react-native-sse on React Native).",
      );
    }
    open(ES, streamAuth);
  };

  const open = (ES: EventSourceConstructor, streamAuth: "query" | "header"): void => {
    const credentials = withCredentials ?? getAuthMode() === "cookie";
    // Re-read per connect so a refreshed token is used on reconnect.
    const current = new ES(
      buildUrl(),
      streamAuth === "header"
        ? {
            withCredentials: credentials,
            headers: {
              ...arcAuthHeaders(),
              ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
            },
          }
        : { withCredentials: credentials },
    );
    es = current;

    current.addEventListener("open", () => {
      reconnectAttempts = 0;
      sseAuthRetries = 0; // fresh budget — a future re-auth can recover again
      sseProbes = 0; // likewise: a later drop must be diagnosed, not sent straight to backoff
      connected = true;
      options.onConnectionChange?.(true);
    });

    // Default `message` channel — bodies are JSON-encoded ArcServerEvent.
    current.addEventListener("message", (event) => {
      noteEventId(event.lastEventId);
      try {
        dispatch(JSON.parse(event.data ?? "") as ArcServerEvent<TData>);
      } catch {
        // Non-JSON event (heartbeat, etc.) — ignore
      }
    });

    // Named-event channels — Arc's ssePlugin writes `event: <type>\ndata: <json>`
    // frames, which the EventSource spec routes through addEventListener(type)
    // rather than onmessage. Match both flavors.
    for (const eventType of resolvedEventTypes) {
      current.addEventListener(eventType, (event) => {
        noteEventId(event.lastEventId);
        let payload: unknown;
        try {
          payload = JSON.parse(event.data ?? "");
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

    current.addEventListener("error", (event) => {
      // Implementations that track it (FetchEventSource) also see ids on
      // event types this subscription does not listen to.
      noteEventId((current as { lastEventId?: string | null }).lastEventId);
      try {
        es?.close();
      } catch {
        /* ignore */
      }
      connected = false;
      options.onConnectionChange?.(false);

      if (manualClose) return;

      // The transport already knows the HTTP status (FetchEventSource): decide
      // from it — no probe request, and the real status reaches onAuthError.
      if (typeof event?.status === "number") {
        const { handler, retryOn403, maxAuthRetries } = _getAuthErrorHandler();
        const verdict = classifyStatus(event.status, retryOn403, event.headers);
        if (verdict.kind === "auth-failure" && handler) sseAuthRetries += 1;
        void handleVerdict(verdict, event.status, handler, maxAuthRetries).catch(() =>
          scheduleReconnect(),
        );
        return;
      }

      // EventSource doesn't expose HTTP status codes — it just fires an
      // opaque `error` for any failure (network, 401, 403, 5xx, CORS). To
      // route 401/403 through the shared `onAuthError` recovery cycle we
      // do a pre-flight `fetch(...)` to the same URL: if it returns 401
      // (or 403 with `retryOn403`), hand off to recovery; on 'retry',
      // reopen the EventSource (which re-reads the auth params via
      // `buildSseUrl`); on 'skip', fall back to the normal reconnect-
      // with-backoff path so transient network errors still recover.
      /**
       * The probe runs whether or not an auth handler is registered.
       *
       * It was gated on `handler`, so a deployment with no `onAuthError` never
       * learned WHY the stream failed and fell straight to backoff — including
       * for 429, the one status where backing off on the wrong schedule is
       * self-defeating rather than merely slow.
       */
      const { handler, retryOn403, maxAuthRetries } = _getAuthErrorHandler();
      if (sseProbes < maxAuthRetries) {
        sseProbes += 1;
        if (handler) sseAuthRetries += 1;
        probeConnectionFailure(
          buildUrl(),
          retryOn403,
          _getStreamConfig().streamAuth === "header" ? arcAuthHeaders() : {},
        )
          .then((verdict) => handleVerdict(verdict, null, handler, maxAuthRetries))
          .catch(() => {
            // Probe itself failed (network down) — treat as transient and
            // fall back to backoff reconnect.
            scheduleReconnect();
          });
        return;
      }

      scheduleReconnect();
    });
  };

  /**
   * Act on a classified failure — from the probe (`status: null`) or from a
   * status the transport reported. One copy so the two paths cannot drift.
   */
  const handleVerdict = async (
    { kind, retryAfterMs }: ProbeResult,
    status: number | null,
    handler: ReturnType<typeof _getAuthErrorHandler>["handler"],
    maxAuthRetries: number,
  ): Promise<void> => {
    if (kind === "rate-limited") {
      /**
       * Honour the server's own number. Falling back to a full window
       * rather than the 3s-based curve: retrying inside the window
       * cannot succeed and each attempt refills the bucket.
       */
      scheduleReconnect(retryAfterMs ?? 60000);
      return;
    }
    if (kind === "auth-failure" && handler && sseAuthRetries <= maxAuthRetries) {
      const { decision } = await _runAuthRecovery(handler, {
        error: new ArcApiError(
          status === null ? "SSE pre-flight auth failure" : `SSE auth failure (HTTP ${status})`,
          {
            status: status ?? 401,
            statusText: "SSE auth failure",
            json: { code: CLIENT_ERROR_CODES.SSE_UNAUTHORIZED },
            endpoint: ssePath,
            method: "GET",
          },
        ),
        request: { method: "GET", endpoint: ssePath },
        attempt: sseAuthRetries,
      });
      if (decision === "retry") {
        reconnectAttempts = 0;
        connect();
        return;
      }
    }
    // 'not-auth' or 'skip' → backoff reconnect as before.
    scheduleReconnect();
  };

  /**
   * Standard backoff-reconnect — shared between non-auth errors and skipped
   * recoveries. `explicitDelayMs` overrides the curve when the SERVER stated a
   * wait (`Retry-After`); its number beats any local guess.
   */
  const scheduleReconnect = (explicitDelayMs?: number): void => {
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts += 1;
      const delay =
        explicitDelayMs ?? Math.min(reconnectDelay * 1.5 ** (reconnectAttempts - 1), 30000);
      reconnectTimer = setTimeout(connect, delay);
    }
  };

  // Per-subscription auth-retry counter — reset on successful onopen so a
  // long-lived stream can recover from periodic re-auth multiple times.
  let sseAuthRetries = 0;
  /** Probes attempted for THIS subscription — bounds the extra fetch per failure. */
  let sseProbes = 0;

  connect();

  return {
    close: () => {
      manualClose = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
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
    shareAcrossTabs = true,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: patternsKey IS options.patterns, content-stabilized so inline arrays don't re-run effects
  const patterns = useMemo(() => options.patterns, [patternsKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: eventTypesKey IS options.eventTypes, content-stabilized
  const eventTypes = useMemo(() => options.eventTypes, [eventTypesKey]);

  /**
   * The single place an event is applied, whether it arrived over this tab's
   * socket or was relayed by the leader. Two copies would drift.
   */
  const applyEvent = useCallback(
    (event: ArcServerEvent<TData>) => {
      if (trackLastEvent) setLastEvent(event);
      if (trackEventCount) setEventCount((n) => n + 1);
      onEventRef.current?.(event);
      for (const key of invalidateKeysRef.current) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    [queryClient, trackLastEvent, trackEventCount],
  );

  /**
   * Stream identity shared by every tab pointing at it — the election key and
   * the channel name. Derived from the ENDPOINT, not the built URL, so a
   * per-tab token or org param cannot split one stream into several elections.
   */
  const channelName = `arc-next.sse.${resource ?? path ?? url ?? "/events/stream"}`;
  /**
   * Sharing needs a relay. Without `BroadcastChannel` (React Native, old
   * webviews) a follower could never receive anything, so every instance
   * behaves as `shareAcrossTabs: false` and holds its own connection.
   */
  const coordinated = shareAcrossTabs && typeof BroadcastChannel !== "undefined";
  const isLeaderTab = useTabLeader({ key: channelName, enabled: enabled && coordinated });
  const connectedRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      handleRef.current?.close();
      handleRef.current = null;
      return;
    }

    /**
     * FOLLOWER — no socket. It mirrors the leader's events and connection
     * state, so its cache, badge and polling decision stay correct at zero
     * connection cost.
     */
    if (coordinated && !isLeaderTab) {
      handleRef.current?.close();
      handleRef.current = null;

      const channel = new BroadcastChannel(channelName);
      channel.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as TabMessage<TData>;
        if (msg?.kind === "event") {
          applyEvent(msg.event);
        } else if (msg?.kind === "state") {
          setIsConnected(msg.connected);
          onConnectionChangeRef.current?.(msg.connected);
        }
      };
      // Ask rather than assume. Until the leader answers, this tab stays
      // disconnected — the safe direction if no leader is listening at all.
      channel.postMessage({ kind: "hello" } satisfies TabMessage<TData>);

      return () => {
        channel.close();
        setIsConnected(false);
      };
    }

    // LEADER — owns the socket and answers followers.
    let channel: BroadcastChannel | null = null;
    if (coordinated) {
      channel = new BroadcastChannel(channelName);
      // BroadcastChannel never echoes to the sender, so this only serves others.
      channel.onmessage = (ev: MessageEvent) => {
        if ((ev.data as TabMessage<TData>)?.kind !== "hello") return;
        channel?.postMessage({
          kind: "state",
          connected: connectedRef.current,
        } satisfies TabMessage<TData>);
      };
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
        connectedRef.current = c;
        setIsConnected(c);
        onConnectionChangeRef.current?.(c);
        // Followers must flip with the shared socket — especially to `false`,
        // or they stop polling while nothing is delivering.
        channel?.postMessage({ kind: "state", connected: c } satisfies TabMessage<TData>);
      },
      onEvent: (event) => {
        // Relayed UNFILTERED: each tab applies its own `patterns`, which need
        // not match this one's.
        channel?.postMessage({ kind: "event", event } satisfies TabMessage<TData>);
        applyEvent(event);
      },
    });
    handleRef.current = handle;

    return () => {
      handle.close();
      handleRef.current = null;
      // Losing leadership runs this cleanup; the channel must go with the
      // socket or a demoted tab keeps answering `hello` for a stream it no
      // longer owns.
      channel?.close();
      channel = null;
      connectedRef.current = false;
    };
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
    coordinated,
    isLeaderTab,
    channelName,
    applyEvent,
  ]);

  return {
    isConnected,
    lastEvent,
    eventCount,
    close: () => handleRef.current?.close(),
    reconnect: () => handleRef.current?.reconnect(),
  };
}
