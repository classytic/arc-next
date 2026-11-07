"use client";

import { type ReadyFrame, type ResyncReason, STREAM_FRAMES } from "@classytic/repo-core/sync";
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
} from "../client/client.js";
import { useTabLeader } from "./tab-leader.js";

// ============================================================================
// URL builder (also exported for ad-hoc EventSource consumers)
// ============================================================================

/**
 * Build an authenticated SSE URL using the global client + auth singletons.
 *
 * Thin alias for {@link import('../client/client.js').buildStreamUrl} with the HTTP
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

  // --- Resumable, alarm-grade streams (all optional; none set = 0.19 behaviour) ---

  /**
   * Cursor to resume from on the FIRST connect (a cursor the app persisted, e.g. the last one it
   * applied before a reload). Sent as `Last-Event-ID` in header mode, or as `?<resumeQueryParam>=`
   * in query mode. Later connects always send the last id this subscription received (or the
   * cursor a `ready` / `resync` frame set).
   */
  resumeFrom?: string | null;
  /**
   * Query mode only (the native `EventSource`, which cannot send headers): send the resume cursor
   * as `?<param>=<cursor>`. arc's replay hub reads `lastEventId` by default. Unset: query mode
   * sends no cursor (0.19 behaviour). Header mode always uses `Last-Event-ID`.
   */
  resumeQueryParam?: string;
  /**
   * Liveness tick, with `Date.now()`: on open, on every frame, and on every received chunk
   * including heartbeat comments. Chunk-level ticks need a transport that reports them
   * (`FetchEventSource`, used by `streamAuth: 'header'`); the native `EventSource` hides
   * comments. May fire more than once per frame.
   */
  onActivity?: (at: number) => void;
  /**
   * Silence longer than this (no activity at all, heartbeats included) marks the stream `stale`,
   * closes it and reconnects with the resume cursor. Pair it with a server heartbeat shorter than
   * this, and with a transport that reports heartbeats (see `onActivity`). The native `EventSource`
   * does not: there only frames count, so a quiet stream cycles every `staleAfterMs` (a dev warning
   * says so); send heartbeats as a named event or use `streamAuth: 'header'`. Default: off.
   */
  staleAfterMs?: number;
  /**
   * Reconnect curve: `delay = min(maxMs, initialMs * factor^(attempt-1)) * (1 - jitter * random())`.
   * Defaults `initialMs: reconnectDelay`, `factor: 1.5`, `maxMs: 30000`, `jitter: 0` (the 0.19
   * curve). `jitter` (0..1) spreads a fleet reconnecting after one outage; `random` is injectable
   * for tests. A server `Retry-After` still wins. Invalid values fall back to the default
   * (`initialMs` / `maxMs` not a positive number) or are clamped (`factor` to >= 1, `jitter` to
   * 0..1), so a bad config cannot become a tight reconnect loop.
   */
  backoff?: StreamBackoff;
  /**
   * Named frames that END the subscription: the stream is closed, no reconnect is scheduled,
   * health becomes `revoked` and `onTerminal` runs. Default: `[STREAM_FRAMES.REVOKED]` once the
   * subscription opts into resume (see `onReady`), else `[]` (0.19). Pass `[]` to keep reconnecting
   * after `revoked`. `restart()` reconnects after re-authentication. Client-side only: the server
   * must still refuse a revoked client's reconnects.
   */
  terminalEvents?: string[];
  /**
   * HTTP statuses that end the subscription the same way (e.g. `[403]`), checked before auth
   * recovery. Read from the transport (`FetchEventSource`) or from the failure probe (native
   * `EventSource`). Default `[]`.
   */
  terminalStatuses?: number[];
  /** A terminal frame (`event`, parsed `data`) or status ended the subscription. */
  onTerminal?: (info: StreamTerminalInfo) => void;
  /**
   * Every `ready` frame (the first frame of a connection on an arc replay stream). `ready` and
   * `resync` frames are handled once the subscription opts into resume: any of `resumeFrom`
   * (`null` included), `resumeQueryParam`, `onReady` or `onResync`.
   */
  onReady?: (frame: ReadyFrame) => void;
  /**
   * Reload the snapshot, then keep applying frames: the server cannot replay the gap
   * (`resync`), or this is a fresh connection that resumed nothing (`'initial'`, from a `ready`
   * carrying a cursor when no cursor was sent). Once per server signal: an `initial` and a later
   * `resync` on the same connection each call it.
   */
  onResync?: (info: StreamResyncInfo) => void;
  /** Health changes (and reconnect-attempt changes). Read the full snapshot any time via `status()`. */
  onStatus?: (status: StreamStatus) => void;
  /**
   * When a connection counts as `live`. `"open"`: on the transport's `open` (the response
   * headers). `"ready"`: on the connection's `ready` frame, the point where a replay hub has joined
   * the connection to its log and replayed the gap; until then the health stays what it was
   * (`connecting`, or `offline` / `stale` on a reconnect) and `attempts` keeps counting, so a
   * screen never shows live while a drop would cost it the replay. Default: `"ready"` once the
   * subscription opts into resume (see `onReady`), else `"open"` (0.19). `"ready"` opts into resume
   * itself. Pass `"open"` for a resumable server that sends no `ready` frame.
   * `onConnectionChange` / `isConnected()` keep following the transport.
   */
  liveOn?: "open" | "ready";
  /**
   * With `liveOn: "ready"`: connections in a row that sent the same resume cursor, opened, and
   * ended before their `ready` frame (an error or a `stale` timeout) before the next connect sends
   * no cursor at all. The server then answers a fresh `ready`, which calls
   * `onResync({ reason: "initial" })` (reload the snapshot), so a cursor the server cannot serve
   * never keeps the stream down. Default 3; `0` turns it off. Ignored with `liveOn: "open"`.
   */
  maxResumeFailures?: number;
  /**
   * Exactly-once delivery by cursor order. With it, a data frame (a named event or `message`)
   * whose id compares at or below the last one delivered is a repeat and never reaches `onEvent`:
   * a server that delivers at least once (a replay from an older point after a reconnect, a frame
   * written twice) is applied once. The floor starts at `resumeFrom`, follows every delivered
   * frame, and is set (also downwards) by a `resync` and by a fresh `ready` cursor
   * (`onResync({ reason: "initial" })`), the points where the caller reloads its snapshot. Frames
   * with no id at all pass. The transport repeats the previous id on a frame without `id:`
   * (WHATWG), so on such a stream every data frame must carry its own id (arc's replay hub does).
   * Same comparator as arc's `createReplayHub({ compareCursors })`, e.g.
   * `(a, b) => (a < b ? -1 : a > b ? 1 : 0)` for fixed-width cursors. Default: off (0.19).
   */
  compareCursors?: (a: string, b: string) => number;
}

// ============================================================================
// Stream contract (owned by repo-core, shared with arc's replay hub)
// ============================================================================

// The control-frame names and payload types (`STREAM_FRAMES`, `ReadyFrame`, `ResyncReason`, ...) are
// owned by `@classytic/repo-core/sync`; import them from there. Control frames carry no `id:` and
// never reach `onEvent`.
/** Upper bound (ms) of the random wait before reconnecting on a `retry` frame. */
const RETRY_FRAME_JITTER_MS = 500;

/** {@link SubscribeToEventsOptions.backoff}. */
export interface StreamBackoff {
  initialMs?: number;
  factor?: number;
  maxMs?: number;
  /** 0..1: the share of each delay that is randomized away. Default 0. */
  jitter?: number;
  /** Default `Math.random`. */
  random?: () => number;
}

export interface StreamResyncInfo {
  cursor: string;
  reason: ResyncReason | "initial";
}

export interface StreamTerminalInfo {
  /** The terminal frame's name, when a frame ended the stream. */
  event?: string;
  /** Its `data`, JSON-parsed when it parses. */
  data?: unknown;
  /** The HTTP status, when a status ended the stream. */
  status?: number;
}

/**
 * `connecting` (first connect, a manual reconnect / restart, or a server `retry` frame) · `live` (open) · `stale` (silent
 * past `staleAfterMs`; reconnecting) · `offline` (failed; reconnecting on backoff, or out of
 * attempts) · `revoked` (a terminal frame or status) · `closed` (`close()`).
 */
export type StreamHealth = "connecting" | "live" | "stale" | "offline" | "revoked" | "closed";

export interface StreamStatus {
  health: StreamHealth;
  /** When `health` last changed (ms epoch). */
  since: number;
  /** The last activity seen (see `onActivity`), or `null`. */
  lastActivityAt: number | null;
  /** The cursor the next connect would resume from, or `null`. */
  lastEventId: string | null;
  /** Reconnect attempts since the stream was last live. */
  attempts: number;
  /** HTTP status of the last failure (`0` = no response, or >= 400), when known; cleared once live. */
  lastStatus?: number;
}

/** Handle returned by {@link subscribeToEvents}. Stable across reconnects. */
export interface SubscribeToEventsHandle {
  close: () => void;
  reconnect: () => void;
  isConnected: () => boolean;
  /** Current health snapshot. */
  status: () => StreamStatus;
  /** Reconnect after a terminal frame / status (`revoked`) or `close()`, resuming from the last cursor. */
  restart: () => void;
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
  /** `cursor`: the leader's resume cursor after this event, so a follower that takes over resumes. */
  | { kind: "event"; event: ArcServerEvent<TData>; cursor?: string | null }
  | { kind: "state"; connected: boolean }
  | { kind: "hello" }
  /** The leader's stream health, so a follower's alarm badge shows the shared socket's. */
  | { kind: "status"; status: StreamStatus }
  /**
   * Control frames: each follower runs its OWN `onReady` / `onResync` / `onTerminal` against its
   * own cache, so a resync reloads every tab's snapshot, not just the leader's.
   */
  | { kind: "control"; frame: "ready"; payload: ReadyFrame }
  | { kind: "control"; frame: "resync"; payload: StreamResyncInfo }
  | { kind: "control"; frame: "terminal"; payload: StreamTerminalInfo };

export interface EventStreamResult<TData = unknown> {
  isConnected: boolean;
  lastEvent: ArcServerEvent<TData> | null;
  eventCount: number;
  /**
   * Stream health (see {@link StreamStatus}). Updates on health and reconnect-attempt changes,
   * not per frame. A follower tab mirrors the leader's.
   */
  status: StreamStatus;
  close: () => void;
  reconnect: () => void;
}

const initialStatus = (enabled: boolean, resumeFrom: string | null | undefined): StreamStatus => ({
  health: enabled ? "connecting" : "closed",
  since: Date.now(),
  lastActivityAt: null,
  lastEventId: resumeFrom || null,
  attempts: 0,
});

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
  /** The probe's HTTP status, when it got a response (terminal-status checks). */
  status?: number;
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
    return {
      ...classifyStatus(res.status, retryOn403, res.headers),
      status: res.status,
    };
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
 *
 * The only module-level state in this file, and it holds a MODULE, never a
 * connection: every connection's sockets, listeners, timers and backoff live in
 * its own `subscribeToEvents` closure. A failed load is forgotten, so one
 * connection's chunk-load error cannot leave every later connection stuck on a
 * rejected promise.
 */
let fetchEventSourceCtor: EventSourceConstructor | undefined;
let fetchEventSourceLoad: Promise<EventSourceConstructor> | undefined;

function loadFetchEventSource(): Promise<EventSourceConstructor> {
  fetchEventSourceLoad ??= import("./sse-fetch.js").then(
    (m) => {
      fetchEventSourceCtor = m.FetchEventSource;
      return m.FetchEventSource;
    },
    (error: unknown) => {
      fetchEventSourceLoad = undefined;
      throw error;
    },
  );
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

/** Not a production build (gates developer warnings). */
function isDevBuild(): boolean {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.NODE_ENV !== "production"
  );
}

// ============================================================================
// Plain function — the source of truth (works in Node, tests, non-React UIs)
// ============================================================================

/**
 * Subscribe to an Arc SSE stream from any JS context (React, Node, Bun, tests).
 * Pure function — no React hook required. Returns a handle with `close()` /
 * `reconnect()` / `isConnected()` / `status()` / `restart()`.
 *
 * Reconnect uses exponential backoff (×1.5 per attempt, capped at 30s; see
 * `backoff` for jitter). Subscriptions persist across reconnect.
 *
 * Resumable streams (arc's replay hub): pass `resumeFrom` (a persisted cursor),
 * `onResync` (reload the snapshot), `staleAfterMs` (heartbeat watchdog),
 * `terminalEvents` and `onStatus`. Once the stream opts into resume
 * (`resumeFrom`, `resumeQueryParam`, `onReady` or `onResync`), the `ready` /
 * `resync` frames are handled and `revoked` is terminal by default; control
 * frames never reach `onEvent` unless listed in `eventTypes`.
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
    resumeQueryParam,
    staleAfterMs,
    backoff = {},
    terminalStatuses = [],
  } = options;

  let es: EventSourceLike | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** `compareCursors`: the last cursor delivered (or set by `resumeFrom` / `ready` / `resync`). */
  let deliveredCursor = options.resumeFrom ?? "";
  /** A data frame at or below the delivered cursor is a repeat; any other id becomes the floor. */
  const isRepeat = (id: string | null | undefined): boolean => {
    const compare = options.compareCursors;
    if (!compare || typeof id !== "string" || id === "") return false;
    if (deliveredCursor !== "" && compare(id, deliveredCursor) <= 0) return true;
    deliveredCursor = id;
    return false;
  };

  const dispatch = (parsed: ArcServerEvent<TData>) => {
    if (patterns.length > 0 && !patterns.includes(parsed.type)) {
      return;
    }
    options.onEvent?.(parsed);
  };

  /**
   * The cursor the next connection resumes from. Sent as `Last-Event-ID`
   * (header mode) or `?<resumeQueryParam>=` (query mode) so the server can
   * replay what was missed while disconnected.
   */
  let lastEventId = options.resumeFrom ?? "";
  /**
   * The id the CURRENT transport last reported. A transport repeats its last
   * id on every later frame (WHATWG: the id persists), so an id is only news
   * when it differs from this: otherwise a frame without `id:` would undo the
   * cursor a `ready` / `resync` frame just set.
   */
  let transportId = "";
  const noteEventId = (id: string | null | undefined): void => {
    // `""` is a transport that never saw an id on this connection (a parser not seeded with the
    // sent `Last-Event-ID`, react-native-sse): it must not erase the cursor.
    if (typeof id === "string" && id !== "" && id !== transportId) {
      transportId = id;
      lastEventId = id;
    }
  };
  /**
   * Pick up an id the transport saw without an event: an id-only frame (`id: <cursor>`, no data),
   * which arc's replay hub sends after entries this viewer was not shown. WHATWG moves the source's
   * last event ID without dispatching anything, so no listener runs; `FetchEventSource` exposes it
   * as `lastEventId` (the native `EventSource` does not, and keeps it only for its own reconnects).
   */
  const syncTransportId = (): void => {
    noteEventId((es as { lastEventId?: string | null } | null)?.lastEventId);
  };
  /**
   * The subscription speaks the resume contract, so `ready` / `resync` frames are handled. Off
   * when none of these is set: the listener set (and every cursor) stays exactly 0.19's.
   */
  const resumable =
    options.resumeFrom !== undefined ||
    resumeQueryParam !== undefined ||
    options.onReady !== undefined ||
    options.onResync !== undefined ||
    options.liveOn === "ready";
  const liveOnReady = (options.liveOn ?? (resumable ? "ready" : "open")) === "ready";
  const maxResumeFailures = liveOnReady ? (options.maxResumeFailures ?? 3) : 0;
  // Per connection: the transport opened / its `ready` arrived / the cursor it sent.
  let opened = false;
  let readySeen = false;
  let connCursor = "";
  // Connections in a row that sent `failedCursor` and ended before `ready`.
  let resumeFailures = 0;
  let failedCursor = "";
  /** `revoked` ends a stream that speaks the resume contract unless the caller says otherwise. */
  const terminalEvents: string[] =
    options.terminalEvents ?? (resumable ? [STREAM_FRAMES.REVOKED] : []);
  /** Whether this connection sent a resume cursor (decides what a `ready` frame means). */
  let sentCursor = false;
  /** Bumped per connect: a lazily-loaded transport must not open a superseded connection. */
  let connectSeq = 0;

  // --- health -------------------------------------------------------------
  let health: StreamHealth = "connecting";
  let healthSince = Date.now();
  let lastActivityAt: number | null = null;
  let lastStatus: number | undefined;
  let reported: { health: StreamHealth; attempts: number; lastStatus?: number } | null = null;

  const status = (): StreamStatus => {
    syncTransportId();
    return currentStatus();
  };
  const currentStatus = (): StreamStatus => ({
    health,
    since: healthSince,
    lastActivityAt,
    lastEventId: lastEventId || null,
    attempts: reconnectAttempts,
    ...(lastStatus !== undefined ? { lastStatus } : {}),
  });
  /** Report a change of health, attempts or failure status (not every frame). */
  const report = (): void => {
    if (
      reported &&
      reported.health === health &&
      reported.attempts === reconnectAttempts &&
      reported.lastStatus === lastStatus
    ) {
      return;
    }
    reported = { health, attempts: reconnectAttempts, lastStatus };
    options.onStatus?.(currentStatus());
  };
  const setHealth = (next: StreamHealth, failureStatus?: number): void => {
    if (next !== health) {
      health = next;
      healthSince = Date.now();
    }
    // A failure status only: a stream that ended normally (200) or a probe that got a 2xx is not one.
    if (failureStatus !== undefined && (failureStatus === 0 || failureStatus >= 400)) {
      lastStatus = failureStatus;
    }
    report();
  };

  const clearStaleTimer = (): void => {
    if (staleTimer) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
  };
  const clearTimers = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearStaleTimer();
  };
  const armStaleTimer = (): void => {
    if (!staleAfterMs || staleAfterMs <= 0) return;
    clearStaleTimer();
    staleTimer = setTimeout(onStale, staleAfterMs);
  };
  const touch = (): void => {
    lastActivityAt = Date.now();
    armStaleTimer();
    options.onActivity?.(lastActivityAt);
  };
  const closeTransport = (): void => {
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
    }
  };
  const markLive = (): void => {
    reconnectAttempts = 0;
    lastStatus = undefined;
    setHealth("live");
  };
  // A connection that opened with a resume cursor and ended before `ready`: after
  // `maxResumeFailures` in a row on one cursor, the next connect starts fresh (no cursor).
  // `transportId` keeps the dropped cursor, so re-reading the old transport cannot restore it.
  const noteEndBeforeReady = (): void => {
    if (!opened || readySeen || !sentCursor || maxResumeFailures <= 0) return;
    opened = false; // count each connection once
    resumeFailures = failedCursor === connCursor ? resumeFailures + 1 : 1;
    failedCursor = connCursor;
    if (resumeFailures >= maxResumeFailures && lastEventId === connCursor) {
      lastEventId = "";
      resumeFailures = 0;
    }
  };
  /** Silence past `staleAfterMs`: drop this connection and resume on a new one. */
  const onStale = (): void => {
    staleTimer = null;
    if (manualClose) return;
    connectSeq += 1; // a transport still loading must not open
    syncTransportId(); // resume after the last checkpoint, not the last data frame
    noteEndBeforeReady();
    closeTransport();
    es = null;
    const was = connected;
    connected = false;
    if (was) options.onConnectionChange?.(false);
    setHealth("stale");
    scheduleReconnect();
  };
  /** A terminal frame or status: close for good (until `restart()`). */
  const terminate = (info: StreamTerminalInfo): void => {
    manualClose = true;
    clearTimers();
    syncTransportId();
    closeTransport();
    es = null;
    const was = connected;
    connected = false;
    if (was) options.onConnectionChange?.(false);
    setHealth("revoked", info.status);
    options.onTerminal?.(info);
  };

  const parseData = (data: string | null | undefined): unknown => {
    try {
      return JSON.parse(data ?? "");
    } catch {
      return data;
    }
  };
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  const connect = (): void => {
    if (reconnectTimer) {
      // A manual reconnect supersedes a scheduled one.
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearStaleTimer();
    syncTransportId();
    closeTransport();
    manualClose = false;
    const seq = ++connectSeq;
    // A retry keeps reporting why it is retrying (offline / stale) until live.
    if (health !== "offline" && health !== "stale") setHealth("connecting");

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
    open(ES, streamAuth, !Impl);
  };

  /** `ready` / `resync` handling (§0 client rules). At most one `onResync` per connection. */
  const attachControlFrames = (transport: EventSourceLike): void => {
    transport.addEventListener(STREAM_FRAMES.READY, (event) => {
      if (es !== transport) return;
      noteEventId(event.lastEventId); // ids seen on other event types first
      touch();
      const frame = parseData(event.data);
      const ready = isRecord(frame)
        ? ({ ...frame, resumed: frame.resumed === true } as ReadyFrame)
        : null;
      // A fresh connection (no cursor sent) on a replayable stream: start from
      // the server's head, and load the snapshot it is the head of.
      const initial =
        ready && typeof ready.cursor === "string" && ready.cursor && !ready.resumed && !sentCursor
          ? ready.cursor
          : null;
      if (initial) {
        lastEventId = initial;
        deliveredCursor = initial;
      }
      if (liveOnReady && !readySeen) {
        readySeen = true;
        resumeFailures = 0;
        markLive(); // after the cursor moved, so the live status carries it
      }
      if (!ready) return;
      options.onReady?.(ready);
      if (initial) options.onResync?.({ cursor: initial, reason: "initial" });
    });
    transport.addEventListener(STREAM_FRAMES.RESYNC, (event) => {
      if (es !== transport) return;
      noteEventId(event.lastEventId);
      touch();
      const frame = parseData(event.data);
      if (!isRecord(frame) || typeof frame.cursor !== "string" || !frame.cursor) return;
      if (typeof frame.reason !== "string") return;
      lastEventId = frame.cursor;
      deliveredCursor = frame.cursor;
      options.onResync?.({ cursor: frame.cursor, reason: frame.reason as ResyncReason });
    });
    // The server asks for a fresh, re-authorized connection: reconnect now from the
    // current cursor. Not a failure, so no backoff step and no attempt is counted.
    // A `retry` before the connection went live goes through backoff instead, so a
    // server that answers every connect with `retry` cannot drive a tight loop.
    transport.addEventListener(STREAM_FRAMES.RETRY, (event) => {
      if (es !== transport || manualClose) return;
      noteEventId(event.lastEventId);
      connectSeq += 1; // the close that follows is expected: its `error` must not back off
      syncTransportId();
      clearTimers();
      closeTransport();
      es = null;
      const was = connected;
      connected = false;
      if (was) options.onConnectionChange?.(false);
      if (health !== "live") {
        setHealth("offline");
        scheduleReconnect();
        return;
      }
      setHealth("connecting");
      reconnectTimer = setTimeout(
        () => {
          reconnectTimer = null;
          connect();
        },
        RETRY_FRAME_JITTER_MS * (backoff.random ?? Math.random)(),
      );
    });
  };

  /** The stream URL, plus the resume cursor in query mode when `resumeQueryParam` is set. */
  const streamUrl = (cursor: string): string => {
    const base = buildUrl();
    if (!cursor || !resumeQueryParam) return base;
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}${encodeURIComponent(resumeQueryParam)}=${encodeURIComponent(cursor)}`;
  };

  /** `native`: the runtime's own `EventSource` (none injected), which never exposes comments. */
  const open = (
    ES: EventSourceConstructor,
    streamAuth: "query" | "header",
    native = false,
  ): void => {
    /** This connection's generation: async work it started must not act on a newer one. */
    const seq = connectSeq;
    if (native && staleAfterMs && staleAfterMs > 0 && !warnedNativeStale && isDevBuild()) {
      warnedNativeStale = true;
      console.warn(
        "[arc-next] subscribeToEvents({ staleAfterMs }) on the native EventSource: heartbeat " +
          "comments are invisible there, so a quiet stream is treated as stale every " +
          `${staleAfterMs} ms. Send heartbeats as a named event, or use streamAuth: 'header'.`,
      );
    }
    const credentials = withCredentials ?? getAuthMode() === "cookie";
    const cursor = lastEventId;
    sentCursor = cursor !== "" && (streamAuth === "header" || Boolean(resumeQueryParam));
    connCursor = cursor;
    opened = false;
    readySeen = false;
    // What this transport reports as its last id until the server sends a new one.
    transportId = streamAuth === "header" ? cursor : "";
    // Assigned right after construction; the callback only runs once the stream is open.
    let current: EventSourceLike | null = null;
    const onActivity = (): void => {
      if (current !== null && es === current) touch();
    };
    // Re-read per connect so a refreshed token is used on reconnect.
    current = new ES(
      streamAuth === "header" ? buildUrl() : streamUrl(cursor),
      streamAuth === "header"
        ? {
            withCredentials: credentials,
            headers: {
              ...arcAuthHeaders(),
              ...(cursor ? { "Last-Event-ID": cursor } : {}),
            },
            onActivity,
          }
        : { withCredentials: credentials, onActivity },
    );
    const transport = current;
    es = transport;
    armStaleTimer(); // a connection that never opens is as silent as one that stopped

    transport.addEventListener("open", () => {
      if (!liveOnReady) {
        // Else on `ready` (markLive).
        reconnectAttempts = 0;
        lastStatus = undefined;
      }
      sseAuthRetries = 0; // fresh budget — a future re-auth can recover again
      sseProbes = 0; // likewise: a later drop must be diagnosed, not sent straight to backoff
      connected = true;
      if (es === transport) opened = true;
      options.onConnectionChange?.(true);
      if (!liveOnReady) setHealth("live");
      if (es === transport) touch();
    });

    // Default `message` channel — bodies are JSON-encoded ArcServerEvent.
    transport.addEventListener("message", (event) => {
      noteEventId(event.lastEventId);
      if (es === transport) touch();
      if (isRepeat(event.lastEventId)) return;
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
      transport.addEventListener(eventType, (event) => {
        noteEventId(event.lastEventId);
        if (es === transport) touch();
        if (isRepeat(event.lastEventId)) return;
        const payload = parseData(event.data);
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

    // Control frames (§0 contract). Separate listeners: they never reach
    // `onEvent` unless the caller listed the name in `eventTypes` itself.
    if (resumable) attachControlFrames(transport);
    for (const name of new Set(terminalEvents)) {
      transport.addEventListener(name, (event) => {
        if (es !== transport) return;
        noteEventId(event.lastEventId);
        terminate({ event: name, data: parseData(event.data) });
      });
    }

    transport.addEventListener("error", (event) => {
      // A superseded connection (stale watchdog, reconnect, restart) is already closed and replaced.
      if (seq !== connectSeq) return;
      // Implementations that track it (FetchEventSource) also see ids on
      // event types this subscription does not listen to.
      noteEventId((transport as { lastEventId?: string | null }).lastEventId);
      noteEndBeforeReady();
      clearStaleTimer();
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
        if (terminalStatuses.includes(event.status)) {
          terminate({ status: event.status });
          return;
        }
        setHealth("offline", event.status);
        const { handler, retryOn403, maxAuthRetries } = _getAuthErrorHandler();
        const verdict = classifyStatus(event.status, retryOn403, event.headers);
        if (verdict.kind === "auth-failure" && handler) sseAuthRetries += 1;
        void handleVerdict(verdict, event.status, handler, maxAuthRetries, seq).catch(() => {
          if (!manualClose && seq === connectSeq) scheduleReconnect();
        });
        return;
      }
      setHealth("offline");

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
      // With terminal statuses the probe is the only way to see them here, so every failure is
      // probed (one request per backoff step): a 403 after a 502 must still end the stream.
      if (sseProbes < maxAuthRetries || terminalStatuses.length > 0) {
        sseProbes += 1;
        if (handler) sseAuthRetries += 1;
        probeConnectionFailure(
          buildUrl(),
          retryOn403,
          _getStreamConfig().streamAuth === "header" ? arcAuthHeaders() : {},
        )
          .then((verdict) => {
            if (manualClose || seq !== connectSeq) return;
            if (verdict.status !== undefined) {
              if (terminalStatuses.includes(verdict.status)) {
                terminate({ status: verdict.status });
                return;
              }
              setHealth("offline", verdict.status);
            }
            return handleVerdict(verdict, null, handler, maxAuthRetries, seq);
          })
          .catch(() => {
            // Probe itself failed (network down) — treat as transient and
            // fall back to backoff reconnect.
            if (!manualClose && seq === connectSeq) scheduleReconnect();
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
    seq: number,
  ): Promise<void> => {
    /** `close()`, `reconnect()`, `restart()` or the watchdog moved on while this was pending. */
    const superseded = (): boolean => manualClose || seq !== connectSeq;
    if (superseded()) return;
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
      if (superseded()) return;
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
    if (manualClose) return;
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts += 1;
      const delay = explicitDelayMs ?? backoffDelay(reconnectAttempts);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
      report();
    } else {
      // Out of attempts: not reconnecting any more, whatever the last failure was (`stale` too).
      setHealth("offline");
    }
  };

  /** `min(max, initial * factor^(n-1)) * (1 - jitter * random())`; the defaults are the 0.19 curve. */
  const backoffDelay = (attempt: number): number => {
    const positive = (v: number | undefined): v is number =>
      typeof v === "number" && Number.isFinite(v) && v > 0;
    // Invalid settings fall back or clamp: NaN, 0 or a shrinking factor would be a tight loop.
    const initialMs = positive(backoff.initialMs) ? backoff.initialMs : reconnectDelay;
    const factor =
      typeof backoff.factor === "number" && Number.isFinite(backoff.factor)
        ? Math.max(1, backoff.factor)
        : 1.5;
    const maxMs = positive(backoff.maxMs) ? backoff.maxMs : 30000;
    const rawJitter = backoff.jitter ?? 0;
    const jitter = Number.isFinite(rawJitter) ? Math.min(1, Math.max(0, rawJitter)) : 0;
    const base = Math.min(initialMs * factor ** (attempt - 1), maxMs);
    return jitter > 0 ? base * (1 - jitter * (backoff.random ?? Math.random)()) : base;
  };

  // Per-subscription auth-retry counter — reset on successful onopen so a
  // long-lived stream can recover from periodic re-auth multiple times.
  let sseAuthRetries = 0;
  /** Probes attempted for THIS subscription — bounds the extra fetch per failure. */
  let sseProbes = 0;
  /** One `staleAfterMs`-on-native-EventSource warning per subscription. */
  let warnedNativeStale = false;

  report();
  connect();

  const restart = (): void => {
    reconnectAttempts = 0;
    manualClose = false;
    if (health === "offline" || health === "stale") report();
    else setHealth("connecting");
    connect();
  };

  return {
    close: () => {
      manualClose = true;
      clearTimers();
      syncTransportId(); // `status().lastEventId` after close() is where a reopen resumes
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
      setHealth("closed");
    },
    reconnect: restart,
    isConnected: () => connected,
    status,
    restart,
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
  const [status, setStatus] = useState<StreamStatus>(() =>
    initialStatus(enabled, options.resumeFrom),
  );
  const statusRef = useRef(status);

  const handleRef = useRef<SubscribeToEventsHandle | null>(null);
  // Callbacks and first-connect inputs are read through refs: changing them must not reconnect.
  const onStatusRef = useRef(options.onStatus);
  onStatusRef.current = options.onStatus;
  const onReadyRef = useRef(options.onReady);
  onReadyRef.current = options.onReady;
  const onResyncRef = useRef(options.onResync);
  onResyncRef.current = options.onResync;
  const onTerminalRef = useRef(options.onTerminal);
  onTerminalRef.current = options.onTerminal;
  const onActivityRef = useRef(options.onActivity);
  onActivityRef.current = options.onActivity;
  const resumeFromRef = useRef(options.resumeFrom);
  resumeFromRef.current = options.resumeFrom;
  const backoffRef = useRef(options.backoff);
  backoffRef.current = options.backoff;
  const compareCursorsRef = useRef(options.compareCursors);
  compareCursorsRef.current = options.compareCursors;
  /** Turning repeat-dropping on or off changes delivery, so it is a dependency (the function is not). */
  const hasCompareCursors = options.compareCursors !== undefined;
  /** Opting into the resume contract changes the listener set, so it is a dependency. */
  const hasResumeFrom = options.resumeFrom !== undefined;
  const hasOnReady = options.onReady !== undefined;
  const hasOnResync = options.onResync !== undefined;
  const hasOnActivity = options.onActivity !== undefined;
  const { resumeQueryParam, staleAfterMs } = options;
  /**
   * The leader relays `ready` / `resync` whenever this stream speaks the resume contract, even
   * without its own callback for one: a follower may have it.
   */
  const { liveOn, maxResumeFailures } = options;
  const resumeOptIn =
    hasResumeFrom ||
    hasOnReady ||
    hasOnResync ||
    resumeQueryParam !== undefined ||
    liveOn === "ready";
  const terminalEventsKey = JSON.stringify(options.terminalEvents ?? null);
  const terminalStatusesKey = JSON.stringify(options.terminalStatuses ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: terminalEventsKey IS options.terminalEvents, content-stabilized
  const terminalEvents = useMemo(() => options.terminalEvents, [terminalEventsKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: terminalStatusesKey IS options.terminalStatuses, content-stabilized
  const terminalStatuses = useMemo(() => options.terminalStatuses, [terminalStatusesKey]);
  /** Applied the same way whether this tab's socket or the leader reported it. */
  const applyStatus = useCallback((next: StreamStatus) => {
    statusRef.current = next;
    setStatus(next);
    onStatusRef.current?.(next);
  }, []);
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
  /**
   * The last cursor this hook reached on this stream, from its own socket or the leader's relay.
   * An effect re-run (leadership change, `enabled` toggle, option change) resumes from it rather
   * than from the `resumeFrom` prop, which would replay applied events or force a resync. Keyed by
   * stream so a different resource or pattern set never inherits it.
   */
  const cursorKey = `${channelName}|${patternsKey}`;
  const cursorRef = useRef<{ key: string; value: string } | null>(null);
  const noteCursor = useCallback((key: string, value: string | null | undefined) => {
    if (typeof value === "string" && value !== "") cursorRef.current = { key, value };
  }, []);
  /**
   * A status with no cursor that is not live means the stream dropped it (`maxResumeFailures`): the
   * carried cursor is the bad one, so a re-run (leader handoff, `enabled` toggle) before the fresh
   * `ready` must not resume from it, nor from the `resumeFrom` prop. The empty value carries "start
   * fresh" until a real cursor replaces it.
   */
  const noteStatusCursor = useCallback(
    (key: string, next: StreamStatus) => {
      if (next.lastEventId === null && next.health !== "live") {
        cursorRef.current = { key, value: "" };
      } else noteCursor(key, next.lastEventId);
    },
    [noteCursor],
  );

  useEffect(() => {
    if (!enabled) {
      handleRef.current?.close();
      handleRef.current = null;
      // A follower has no socket to report `closed`: it would keep the leader's last health.
      if (statusRef.current.health !== "closed") {
        applyStatus({ ...statusRef.current, health: "closed", since: Date.now() });
      }
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
          noteCursor(cursorKey, msg.cursor);
          applyEvent(msg.event);
        } else if (msg?.kind === "state") {
          setIsConnected(msg.connected);
          onConnectionChangeRef.current?.(msg.connected);
        } else if (msg?.kind === "status") {
          noteStatusCursor(cursorKey, msg.status);
          applyStatus(msg.status);
        } else if (msg?.kind === "control") {
          if (msg.frame === "ready") onReadyRef.current?.(msg.payload);
          else if (msg.frame === "resync") {
            noteCursor(cursorKey, msg.payload.cursor);
            onResyncRef.current?.(msg.payload);
          } else if (msg.frame === "terminal") onTerminalRef.current?.(msg.payload);
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
        channel?.postMessage({
          kind: "status",
          status: statusRef.current,
        } satisfies TabMessage<TData>);
      };
    }

    // Resume where this hook last was on this stream; else the caller's cursor (first connect).
    const carried = cursorRef.current?.key === cursorKey ? cursorRef.current.value : undefined;
    const resumeFrom =
      resumeOptIn && carried !== undefined
        ? carried
        : hasResumeFrom
          ? resumeFromRef.current
          : undefined;
    let current: SubscribeToEventsHandle | null = null;
    /** The health last relayed, so letting go of a revoked stream does not read as offline. */
    let relayedHealth: StreamHealth | null = null;
    const handle = subscribeToEvents<TData>({
      url,
      resource,
      path,
      patterns,
      eventTypes,
      reconnectDelay: options.reconnectDelay,
      maxReconnectAttempts: options.maxReconnectAttempts,
      withCredentials: options.withCredentials,
      resumeFrom,
      resumeQueryParam,
      staleAfterMs,
      backoff: backoffRef.current,
      terminalEvents,
      terminalStatuses,
      liveOn,
      maxResumeFailures,
      compareCursors: hasCompareCursors
        ? (a, b) => (compareCursorsRef.current ?? (() => 1))(a, b)
        : undefined,
      onActivity: hasOnActivity ? (at) => onActivityRef.current?.(at) : undefined,
      onReady: resumeOptIn
        ? (frame) => {
            channel?.postMessage({
              kind: "control",
              frame: "ready",
              payload: frame,
            } satisfies TabMessage<TData>);
            onReadyRef.current?.(frame);
          }
        : undefined,
      onResync: resumeOptIn
        ? (info) => {
            channel?.postMessage({
              kind: "control",
              frame: "resync",
              payload: info,
            } satisfies TabMessage<TData>);
            onResyncRef.current?.(info);
          }
        : undefined,
      onTerminal: (info) => {
        channel?.postMessage({
          kind: "control",
          frame: "terminal",
          payload: info,
        } satisfies TabMessage<TData>);
        onTerminalRef.current?.(info);
      },
      onStatus: (next) => {
        if (resumeOptIn) noteStatusCursor(cursorKey, next);
        applyStatus(next);
        // `closed` is this tab letting go (unmount, demotion), not the stream's state: a
        // follower hears it as offline until the next leader reports. A revoked stream stays
        // revoked for followers.
        if (next.health === "closed" && relayedHealth === "revoked") return;
        const relayed: StreamStatus =
          next.health === "closed" ? { ...next, health: "offline" } : next;
        relayedHealth = relayed.health;
        channel?.postMessage({ kind: "status", status: relayed } satisfies TabMessage<TData>);
      },
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
        channel?.postMessage({
          kind: "event",
          event,
          cursor: current?.status().lastEventId ?? null,
        } satisfies TabMessage<TData>);
        applyEvent(event);
      },
    });
    current = handle;
    handleRef.current = handle;

    return () => {
      if (resumeOptIn) noteCursor(cursorKey, handle.status().lastEventId);
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
    applyStatus,
    hasResumeFrom,
    resumeOptIn,
    hasOnActivity,
    resumeQueryParam,
    staleAfterMs,
    terminalEvents,
    terminalStatuses,
    liveOn,
    maxResumeFailures,
    hasCompareCursors,
    cursorKey,
    noteCursor,
    noteStatusCursor,
  ]);

  return {
    isConnected,
    lastEvent,
    eventCount,
    status,
    close: () => handleRef.current?.close(),
    reconnect: () => handleRef.current?.reconnect(),
  };
}
