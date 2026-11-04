# Realtime, uploads, React Native

Client-only modules: `/sse` `/ws` `/upload` `/tab-leader`. `/sse-fetch` is server-safe.

## SSE

```ts
useEventStream({ resource: "agents", invalidateQueries: [KEYS.lists()] });   // agents.created/updated/deleted
useEventStream({ eventTypes: ["job.phase", "job.done"], onEvent });          // named frames
const url = buildSseUrl("/jobs/stream", { jobId });                          // ad-hoc EventSource
```

arc writes named `event:` frames; the hook listens on both named channels and `message`. Streams share one connection across tabs (`shareAcrossTabs`, leader election in `useTabLeader`) when `BroadcastChannel` exists.

### Keep the token out of the URL

```ts
configureClient({ baseUrl: API_URL, streamAuth: "header" });
```

Browser: the built-in `FetchEventSource` (`/sse-fetch`, loaded on first use) sends `Authorization`, `x-organization-id` and `Last-Event-ID` as headers. It never reconnects itself; `subscribeToEvents` owns backoff, auth recovery and 429 `Retry-After`. Its `error` event carries the HTTP `status`. The server must accept `Authorization` on the stream route and allow those headers in CORS. Use it directly:

```ts
const es = new FetchEventSource(url, { headers: arcAuthHeaders(), lastEventId });
es.addEventListener("job.progress", (e) => render(JSON.parse(e.data!)));
```

`createSseParser` is the incremental WHATWG parser behind it. Its `onActivity` handler, and `FetchEventSource`'s `onActivity` init option, fire per received chunk, heartbeat comments included.

### Resumable alarm-grade streams

For a stream served by arc's replay hub (`@classytic/arc/utils`). Frame names come from `@classytic/repo-core/sync` (`STREAM_FRAMES`, not re-exported here) = `ready`, `resync`, `revoked`, `retry`. `retry` on a live stream: reconnect from the cursor after a 0-500 ms jitter (no backoff, health `connecting`); before live it backs off.

```ts
const sub = subscribeToEvents({
  url: `${API_URL}/alerts/stream`,
  eventTypes: ["alert"],
  resumeFrom: store.cursor,                      // persisted cursor, or null
  onEvent: (e) => store.apply(e),                // e.id is the cursor
  onResync: ({ cursor }) => store.reload(cursor), // 'initial' | server reason
  staleAfterMs: 45_000,                          // server heartbeat every 20 s
  backoff: { jitter: 0.5 },
  terminalStatuses: [403],                       // `revoked` frame: terminal by default
  onTerminal: () => session.end(),
  onStatus: (s) => badge.set(s.health),          // connecting live stale offline revoked closed
});
sub.status(); sub.restart();                     // restart after re-authentication
```

- Resume cursor: `Last-Event-ID` in header mode; in query mode only with `resumeQueryParam: "lastEventId"`.
- `ready` and `resync` never reach `onEvent`. They are handled once the stream opts into resume (`resumeFrom`, `resumeQueryParam`, `onReady` or `onResync`).
- `onResync` runs once per server signal: `initial` on a fresh connection (no cursor sent), or the server reason (`cursor_expired`, `gap_too_large`, `cursor_invalid`). Reload the snapshot, then keep applying frames. A frame without `id:` never clears the cursor; an id-only frame (no data, sent after entries this viewer cannot see) moves it in header mode.
- `terminalEvents` defaults to `[STREAM_FRAMES.REVOKED]` once the stream opts into resume (`[]` opts out). The server must still refuse a revoked client.
- Health is `live` on the connection's `ready` frame once the stream opts into resume (`liveOn: "ready"`), not on the response headers; `liveOn: "open"` restores live-on-open for a server without `ready`. `maxResumeFailures` (default 3): that many drops before `ready` on one cursor and the next connect sends no cursor (fresh `ready`, `onResync` `initial`).
- `compareCursors: (a, b) => (a < b ? -1 : a > b ? 1 : 0)` (arc's replay hub comparator): a data frame whose id is at or below the last delivered one is a repeat and never reaches `onEvent`, so an at-least-once replay applies once. The floor starts at `resumeFrom` and is reset by `resync` / a fresh `ready`. Every data frame must carry its own id.
- `staleAfterMs` counts heartbeats only on a transport that reports them (`FetchEventSource`, used by `streamAuth: "header"`). The native `EventSource` hides comments, so a quiet stream cycles every `staleAfterMs` there (dev warning).
- Backoff: `min(maxMs, initialMs * factor^(n-1)) * (1 - jitter * random())`; defaults 3000, 1.5, 30000, 0. A `Retry-After` still wins.
- `useEventStream` takes the same options and returns `status`. The leader tab relays status, control frames and its cursor, so each follower runs its own `onResync` and a tab taking over resumes where the leader was. An effect re-run resumes from the hook's last cursor, not the `resumeFrom` prop.

## WebSocket

```ts
const { isConnected, send, subscribe, unsubscribe } = useWebSocket({
  subscribe: ["todo"], invalidateQueries: [KEYS.lists()], patterns: ["todo.", "order.completed"],
  heartbeatInterval: 30_000,
});
```

Subscriptions persist across reconnects: always go through `subscribe()`, not raw `send()`. `buildWsUrl` rewrites `http(s)` to `ws(s)`; set `baseUrl` first. `connectWs` is the non-React form.

## Uploads

CRUD multipart: `api.upload({ data: formData })` or `useUpload()`. With progress, use the XHR pipeline:

```ts
const { upload, progress, isUploading, cancel } = useUploadWithProgress<{ url: string }, { file: File }>({
  url: "/api/media/upload",
  buildFormData: ({ file }) => { const fd = new FormData(); fd.append("file", file); return fd; },
  invalidateQueries: [KEYS.lists()],
});
```

`uploadWithProgress({ url, formData, onProgress, signal })` is the Promise form. Auth, `ArcApiError` parsing, `Idempotency-Key`, `x-arc-scope` and `Accept-Version` carry over; `retry`, `beforeRequest` and `afterResponse` do not (pass trace headers via `headers`). Presigned storage PUTs carry no bearer token and bypass the client.

## React Native

Core surface works under React Native globals (`/client` `/api` `/query` `/query-options` `/hooks` `/mutation` `/sse` `/auth-token`).

```ts
import "react-native-get-random-values";          // Idempotency-Key source
import RNEventSource from "react-native-sse";
configureClient({ baseUrl: API_URL, eventSource: RNEventSource, streamAuth: "header" });
```

- `streamAuth: "header"` without an injected `eventSource` throws; RN `fetch` cannot stream.
- Never set `cache: "no-store"`: whatwg-fetch appends `?_=<ts>` and arc rejects unknown query keys with 400.
- Not covered: XHR upload progress and `/field-encryption` (needs Web Crypto `subtle`).
