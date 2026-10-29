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

`createSseParser` is the incremental WHATWG parser behind it.

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
