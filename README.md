# @classytic/arc-next

[![Sponsor](https://img.shields.io/github/sponsors/classytic?style=flat-square&label=Sponsor&logo=GitHub&color=EA4AAA)](https://github.com/sponsors/classytic)

React + TanStack Query SDK for the Arc backend framework. Typed CRUD hooks, optimistic updates with rollback, multi-tenant cache scoping, pagination normalization, real-time SSE.

**Peers:** `react >=19.0.0`, `@tanstack/react-query >=5.102.0`, `@classytic/repo-core >=0.38.0`, optional `@tanstack/react-query-devtools >=5.102.0` (`./devtools`) and `jose >=4.8.1` (`./encryption` / `./field-encryption`). See [Peer ranges](#peer-ranges).

```bash
npm install @classytic/arc-next
```

## Type flow — use WIRE types for `T`

`createCrudApi<T>`'s generic should be the kernel/module's exported **wire type**
(plain JSON shape) — never a mongoose-flavored document type. Kernel → API →
frontend then stays one type flow with zero casts:

```ts
import type { OrderWire } from '@classytic/order/wire'; // plain JSON shape
const orders = createCrudApi<OrderWire>('orders');
```

Server-side counterpart: arc-* modules export their wire types per the
module-publishing convention.

## Setup

Call once at app init from a `"use client"` provider:

```ts
import { configureClient, configureAuth, createAuthAwareClient } from "@classytic/arc-next/client";
import { configureToast } from "@classytic/arc-next/mutation";
import { configureNavigation } from "@classytic/arc-next/hooks";

configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL!, authMode: "cookie" });
configureAuth({ getToken: () => session?.token ?? null, getOrgId: () => org?.id ?? null });
configureToast({ success: toast.success, error: toast.error });
configureNavigation(useRouter);
```

Without `configureToast`, mutation feedback is a silent no-op (0.12+) — the SDK never writes to your console; errors still reach `onError` / the rejected promise.

> **Targets:** React 19 browser apps, Next.js App Router (Server Components, streaming SSR, edge cache), and React Native / Expo for the core surface: see [Expo / React Native](#expo--react-native).

`getToken` **must be synchronous** — cache async tokens out-of-band. Promise returns are dropped + warned in dev.

## Quick Start

The whole minimal path: define the resource once, read it with hooks or with plain TanStack, and
prefetch it on the server. Everything else below is optional.

**1. Define the resource**: a server-safe module (api + option factories) and a hooks module
that only client components import:

```ts
// products.ts (server-safe)
import { createCrudApi } from "@classytic/arc-next/api";
import { createEntityQueries } from "@classytic/arc-next/query-options";

export interface Product { _id: string; name: string; price: number; }
export const productsApi = createCrudApi<Product>("products", { basePath: "/api" });
export const productQueries = createEntityQueries<Product>(productsApi, "products");

// products.hooks.ts (client components only)
import { createCrudHooks } from "@classytic/arc-next/hooks";
export const products = createCrudHooks<Product>({
  api: productsApi, entityKey: "products", singular: "Product",
}); // products.queries builds exactly productQueries' keys
```

**2. Read and write in a client component**, with the hooks or with native TanStack options
(`products.queries` are ordinary `queryOptions` / `mutationOptions` objects):

```tsx
"use client";
import { useMutation, useQuery } from "@tanstack/react-query";

function Products() {
  const { items, isLoading } = products.useList({ limit: 20 });
  const { update } = products.useActions();            // optimistic, rolls back on error
  const detail = useQuery(products.queries.detail(id)); // the same cache entry useDetail uses
  const save = useMutation(products.queries.update());
}
```

**3. Prefetch on the server** with the same option objects:

```tsx
import { HydrationBoundary, streamQueries } from "@classytic/arc-next/prefetch";
import { productQueries } from "./products";

export default function Page() {
  return (
    <HydrationBoundary state={streamQueries([productQueries.list({ limit: 20 }, { token })])}>
      <Products />
    </HydrationBoundary>
  );
}
```

The options also work with `useSuspenseQuery`, `queryClient.query(...)` and `queryClient.setQueryData(options.queryKey, ...)`.

Optional, when you need them: presets matching what the backend mounts
(`withBulk(withSoftDelete(createCrudApi(...)))`, [Presets](#presets--opt-in-methods)), optimistic
custom mutations ([Custom Mutations](#custom-mutations)), query islands and streaming
([SSR and streaming](#ssr-and-streaming-nextjs-app-router--server-components)), the edge cache
([Edge cache](#edge-cache-for-public-pages-edge-cache)), realtime ([SSE](#sse--real-time),
[WebSocket](#websocket--real-time--bidirectional)).

## Subpath Exports

| Import | Server-safe | Exports |
|---|:-:|---|
| `/client` | yes | `configureClient`, `configureAuth`, `createClient`, `createAuthAwareClient`, `handleApiRequest`, `ArcApiError`, `isArcApiError`, `isAbortError`, `isArcErrorCode`, `isPreconditionFailed`, `KNOWN_ARC_ERROR_CODES`, `CLIENT_ERROR_CODES`, `getAuthMode`, `getAuthContext`, `getBaseUrl`, `createQueryString` |
| `/api` | yes | `BaseApi`, `createCrudApi`, response types + type guards |
| `/cache` | yes | `createQueryKeys`, `createCacheUtils`, `invalidateForChange`, `resourceTags`, `arcTag`, `changeTags`, `extractItem`, `extractItems`, `getItemId`, `updateListCache`, `normalizePagination`, `QUERY_CONFIGS`, `DEFAULT_QUERY_CONFIG` |
| `/query-options` | yes | `createEntityQueries`: the per-resource `queryOptions` / `infiniteQueryOptions` / `mutationOptions` factories every hook is built from, custom routes included (`route`, `routeMutation`) |
| `/query` | client | `useApiQuery`, `useListQuery`, `useDetailQuery`, `useInfiniteListQuery`, `useCursorPager` |
| `/query-island` | client | `createQueryIsland`: server-rendered React Query section that loads React Query only when it activates |
| `/mutation` | client | `configureToast`, `useMutationWithTransition`, `useOptimisticMutation` |
| `/hooks` | client | `createCrudHooks`, `configureNavigation` (also default export) |
| `/query-client` | yes | `getQueryClient` (browser singleton, new per server call), `makeQueryClient` (per request) |
| `/prefetch` | yes | `streamQueries`, `prefetchQueries`, `dehydrate`, `HydrationBoundary` |
| `/devtools` | client | `QueryDevtools`: TanStack devtools loaded only when `enabled` (optional peer) |
| `/edge-cache` | server | `edgePageHeaders`, `reservedSegments`, `edgeRouteMatcher`, `createEdgePurger`, `edgeCacheControl` |
| `/edge-cache/cloudflare` | server | `cloudflareEdge`, `cloudflareEdgeFromEnv`, `purgeEdgeHost`, `CLOUDFLARE_CDN_CACHE_CONTROL` |
| `/react-native` | RN | `setupReactNative({ appState, netInfo })` |
| `/server` | yes | `createRequestClient`, `forwardRequestHeaders` — call arc as the signed-in user from Server Components / Route Handlers / Server Actions |
| `/events` | yes | `onArcChange`, `ArcChangeEvent` — every successful write, for server-cache invalidation |
| `/auth-gate` | yes | `queryAuthEnabled`, `authGate` — the generated hooks' enable rule, for hand-written `useQuery` |
| `/sse` | client | `useEventStream`, `buildSseUrl`, `subscribeToEvents` |
| `/ws` | client | `useWebSocket`, `buildWsUrl`, `connectWs` |
| `/upload` | client | `useUploadWithProgress`, `uploadWithProgress` — XHR-based uploads with native progress events |
| `/presets/soft-delete` | yes | `withSoftDelete` — adds `getDeleted`, `restore` |
| `/presets/bulk` | yes | `withBulk` — adds `bulkCreate`, `bulkUpdate`, `bulkDelete` |
| `/presets/slug` | yes | `withSlugLookup` — adds `getBySlug` |
| `/presets/tree` | yes | `withTree` — adds `getTree`, `getChildren` |
| `/presets/search` | yes | `withSearchPreset` — adds `searchEngine`, `searchSimilar`, `embed` |

`sideEffects: false`. No barrel: every subpath is one entry module (source grouped by domain under `src/<domain>/`).

## Core Hooks (from `createCrudHooks`)

```ts
const { items, pagination, isLoading, refetch } = useList(params, options);
const { item, isLoading, isPlaceholderData } = useDetail(id, options);
const { create, update, remove, isMutating } = useActions();
const { items, hasNextPage, fetchNextPage } = useInfiniteList(params);
const { items, page, hasPrev, hasNext, prev, next } = useCursorPager(params); // one keyset page at a time

await create({ data, organizationId }, { onSuccess: (item) => navigate(...) });
```

- All mutations are optimistic with automatic rollback on error.
- **Tenant vs filter.** The tenant (`x-organization-id`) is the configured org or the read's
  `organizationId` option (`null` = no org header); it is resolved before the key is built and keyed
  in the identity partition (see Cache & Keys). `params` are the query string: an `organizationId`
  param is a filter, sent as-is, signed in or anonymous.
- **`keepPrevious`**: `useList` keeps the previous params' rows while new ones load (default on,
  `isPlaceholderData` flags it); `useInfiniteList` opts in with `{ keepPrevious: true }`.
- **`useCursorPager(params)`**: Previous / Next over a keyset list. Previous is instant (pages are held),
  Next past the last page fetches exactly one more, new params restart at page 1. Over a custom
  `useInfiniteQuery`, use the standalone `useCursorPager(query, resetKey)` from `/query`.
- **List → detail handoff:** when a parent `useList` has the entity in cache,
  `useDetail` (same partition only) reads it via TanStack's `placeholderData` factory — instant
  preview, but the real detail GET still fires (rich payload swap, no
  cache pollution). Use `isPlaceholderData` to dim the preview while it
  resolves. See [CHANGELOG 0.7](./CHANGELOG.md#070) for why this replaced
  the old setQueryData-based prefill.
- **Detail → list pseudo-normalization:** after a `useDetail` GET resolves,
  arc-next shallow-merges the fresh fields into every list cache of the same
  partition holding this id (never an anonymous or other-tenant list). The
  list view stays in sync without a refetch. Direction is
  one-way (detail → list, never the reverse) — see
  [CHANGELOG → "pseudo-normalization"](./CHANGELOG.md#070) for the
  rationale. For true entity-level normalization (one copy per id, field-
  level invalidation), use Apollo Client or Relay; arc-next stays in the
  REST + React Query niche.

Every read hook is a thin wrapper over `hooks.queries` (`createEntityQueries`): the same
`{ queryKey, queryFn }` a Server Component streams, so its cache always hydrates the hook.

```ts
const { queries } = createCrudHooks<Product>({ api: productsApi, entityKey: "products", singular: "Product" });
useQuery(queries.detail(id));                         // plain TanStack, data typed as Product
useSuspenseQuery(queries.list({ limit: 20 }));        // streaming SSR
useMutation(queries.update());                        // shares the CRUD write key
qc.setQueryData(queries.detail(id).queryKey, next);   // typed through the key
const pending = usePendingWrites();                   // in-flight writes (useMutationState)
```

Writes invalidate exactly what they can have changed (`invalidateForChange`): lists, counts and
aggregations, plus the written record's own detail; a delete drops that detail. Realtime sync
(`useResourceSync`) uses the same rule.

### Anonymous, CDN-cacheable reads (`auth: "omit"`)

arc's http-cache serves any credentialed request `private, no-store`. A signed-in visitor's
read of a PUBLIC endpoint (a catalogue) can be the same request as a guest's:

```ts
const catalog = createCrudApi<Course>("courses", { readAuth: "omit" }); // every GET anonymous
useList(params, { auth: "omit" });                                      // or per call
```

No Authorization, org header, API/internal key or cookie is sent (`credentials: "omit"`), a 401 never
triggers auth refresh, and the cache entry is kept apart from signed-in reads. **Use it only when the
endpoint answers the same for everyone**: never for drafts, owner-only fields or tenant rows.
Never the default.

### `useApiQuery` — non-CRUD reads

For reports, aggregates, RPC-style endpoints. Response IS the data — arc 2.13+ has no envelope:

```ts
import { useApiQuery } from "@classytic/arc-next/query";

const { data, isLoading } = useApiQuery<DashboardStats>({
  queryKey: ["dashboard", "stats"],
  queryFn: ({ signal }) => api.request("GET", "/dashboard/stats", { options: { signal } }),
  freshness: "realtime",  // 'realtime' | 'frequent' | 'stable' | 'static'
});
```

Pass a custom `select` to project a sub-field from the response.

## Actions & Custom Routes

Two escape hatches when CRUD isn't enough — both `BaseApi` methods, both routed through your configured client/auth:

```ts
// POST /:id/action — discriminator-style state transitions
// Named `dispatchAction` so consumer subclasses can keep their own `action()` method.
await api.dispatchAction({ id, action: "complete" });
await api.dispatchAction({ id, action: "prioritize", data: { priority: 7 } });

// Resource-relative custom routes (defineResource({ routes: [...] }))
const stats = await api.invokeRoute<{ data: { total: number } }>({
  method: "GET",
  path: "/stats",
});
import type { OffsetPaginationResult } from "@classytic/repo-core/pagination";

const recent = await api.invokeRoute<OffsetPaginationResult<Todo>>({
  method: "GET",
  path: "/recent",
  params: { limit: 5 },
});
```

The `useAction` hook (returned from `createCrudHooks`) wraps `api.dispatchAction()` with toast + invalidation. Custom routes get first-class option factories, keyed under `KEYS.routes()` (never hand-build their keys):

```ts
// GET /iam/me with the token but NO org header
const { data: me } = useQuery(iam.queries.route<Me>("/me", { organizationId: null, staleTime: 60_000 }));

// POST /orders/:id/approve, typed body, scoped invalidation on success
const approve = useMutation(orders.queries.routeMutation<Order, { note: string }>("/:id/approve", {
  invalidates: (order) => ({ op: "update", id: order._id }),   // or a key list: [orders.KEYS.routes()]
}));
approve.mutate({ pathParams: { id }, data: { note } });
```

`token` / `organizationId` on every api method, preset, hook and factory ctx follow one rule:
omitted = the configured default, `null` = deliberately none, a string = exactly that.
`api.invokeRoute({ path: "/me", organizationId: null })` sends the token and no org header.

## Presets — Opt-In Methods

Vanilla `createCrudApi(...)` ships only the always-on surface (CRUD + `action` + `invokeRoute` + `upload`). Backend presets — soft-delete, bulk, slug-lookup, tree, search — light up extra routes; the SDK mirrors that with **factory wrappers**, so autocomplete only shows what your resource actually exposes and unused code tree-shakes out of the bundle.

> No separate `search()` / `findBy()` methods — they hit the same `GET /` as `getAll()`. Pass operators directly via params: `getAll({ params: { 'title[contains]': q, 'priority[gte]': 5 } })`. Mongokit URL grammar handles all bracket operators including geo.

```ts
import { withSoftDelete } from "@classytic/arc-next/presets/soft-delete";
import { withBulk } from "@classytic/arc-next/presets/bulk";
import { withSlugLookup } from "@classytic/arc-next/presets/slug";
import { withTree } from "@classytic/arc-next/presets/tree";
import { withSearchPreset } from "@classytic/arc-next/presets/search";

// Stack only what the backend has registered
const todosApi = withBulk(withSoftDelete(createCrudApi<Todo>("todos")));
const placesApi = withSearchPreset(createCrudApi<Place>("places"));
const categoriesApi = withTree(withSlugLookup(createCrudApi<Category>("categories")));

// Only categoriesApi has getBySlug + getTree + getChildren in autocomplete.
// `placesApi.embed` won't show up. `todosApi.searchEngine` is a type error.
await todosApi.bulkCreate({ data: [{ title: "A" }, { title: "B" }] });
await placesApi.searchEngine({ query: "park", body: { topK: 10 } });
await categoriesApi.getBySlug({ slug: "engineering" });
```

| Preset | Adds methods | Backend route |
|---|---|---|
| `withSoftDelete` | `getDeleted`, `restore` | `softDelete` preset |
| `withBulk` | `bulkCreate`, `bulkUpdate`, `bulkDelete` | `bulk` preset |
| `withSlugLookup` | `getBySlug` | `slugLookup` preset |
| `withTree` | `getTree`, `getChildren` | `tree` preset |
| `withSearchPreset` | `searchEngine`, `searchSimilar`, `embed` | `searchPreset()` |

The hook variants (`useDeleted`, `useBulkActions`, `useDetailBySlug`, `useTree`, `useChildren`, `useSearchEngine`, `useSearchSimilar`, `useEmbed`) are returned from `createCrudHooks` and gracefully throw at call time when the api wasn't wrapped with the matching preset.

## Filter operators (mongokit URL grammar)

Pass any operator via bracket-key params — `prepareParams` keeps operator-keyed arrays as comma-joined tuples (no `[in]` rewriting), so you get the exact wire shape mongokit's `QueryParser` expects.

```ts
// Range / comparison
await api.getAll({ params: { 'priority[gte]': 5, 'price[between]': '10,100' } });

// Pattern matching
await api.getAll({ params: { 'title[contains]': 'urgent' } });

// IN list (auto-rewritten from plain array on plain field name)
await api.getAll({ params: { status: ['active', 'pending'] } });
//   → status[in]=active,pending

// Geo — coordinate tuples preserved as-is
await api.getAll({ params: { 'location[withinRadius]': [-73.98, 40.75, 5_000] } });
await api.getAll({ params: { 'location[near]': [-73.98, 40.75, 4_000] } });
await api.getAll({ params: { 'location[geoWithin]': [-74.02, 40.7, -73.93, 40.79] } });
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `contains`, `startsWith`, `endsWith`, `regex`, `like`, `exists`, `between`, `near`, `nearSphere`, `withinRadius`, `geoWithin`.

## SSE — Real-Time

```ts
import { useEventStream, buildSseUrl } from "@classytic/arc-next/sse";

useEventStream({
  resource: "agents",                     // auto-derives [agents.created, agents.updated, agents.deleted]
  invalidateQueries: [agentKeys.lists()], // refetch on every event
});

// Or explicit named events (Arc ssePlugin emits `event: <type>` frames):
useEventStream({
  eventTypes: ["sync-job.phase", "sync-job.completed"],
  onEvent: (event) => { /* ... */ },
});

// Build authenticated SSE URLs for ad-hoc EventSource consumers:
const url = buildSseUrl("/jobs/stream", { jobId });
```

### Keeping the token out of the stream URL (`streamAuth: 'header'`)

The native `EventSource` cannot send headers, so by default a bearer token rides in the URL
(`?token=`), where access logs and proxies keep it. Set `streamAuth: 'header'` and the stream
authenticates like every other request (`Authorization` / custom `headerName`, `x-organization-id`)
and the URL carries neither:

```ts
configureClient({ baseUrl: API_URL, streamAuth: "header" });
```

With no `eventSource` injected, the SDK uses its built-in `FetchEventSource`
(`@classytic/arc-next/sse-fetch`): an `EventSource` over streaming `fetch` with full WHATWG
parsing (`event` / multi-line `data` / `id` / `retry` / comments / CRLF), `addEventListener` +
`onopen` / `onmessage` / `onerror`, `readyState`, and `close()` aborting the request. It is
loaded with a dynamic import on first use, so apps on the native `EventSource` never ship it.

- **Reconnect** stays in `subscribeToEvents` (backoff, auth recovery, 429). `FetchEventSource`
  never reconnects by itself; on failure it goes `CLOSED` and fires `error`. The next connection
  sends `Last-Event-ID` (the last id the stream delivered), so a server that replays can resume.
- **The failure carries the HTTP status.** Its `error` event has `status` (`0` = no response) and
  the response `headers`, so a 401 reaches `onAuthError` with the real status and a 429 waits out
  `Retry-After` without the extra probe request the native `EventSource` needs.
- **Server**: accept `Authorization` on the stream route, and with CORS allow the `Authorization`,
  `x-organization-id` and `Last-Event-ID` request headers (the request is preflighted).
- **React Native**: its `fetch` does not stream response bodies, so keep injecting
  `react-native-sse` there (see [Expo / React Native](#expo--react-native)); without it, `streamAuth: 'header'`
  throws rather than fall back to `?token=`.

Use it directly anywhere you need an authenticated stream:

```ts
import { arcAuthHeaders } from "@classytic/arc-next/client";
import { FetchEventSource } from "@classytic/arc-next/sse-fetch";

const es = new FetchEventSource(url, { headers: arcAuthHeaders(), lastEventId });
es.addEventListener("job.progress", (e) => render(JSON.parse(e.data!)));
es.onerror = (e) => console.warn("stream failed", e.status); // then reconnect yourself
```

Pass `onActivity` in its init to hear every received chunk, heartbeat comments included
(`createSseParser` has the same `onActivity` handler).

### Resumable, alarm-grade streams

For a stream served by arc's replay hub (`@classytic/arc/utils`), where every data frame's `id:`
is a change-log cursor. The control frame names are owned by `@classytic/repo-core/sync` (import `STREAM_FRAMES` and the frame types from there): `STREAM_FRAMES` =
`{ READY: "ready", RESYNC: "resync", REVOKED: "revoked", RETRY: "retry" }`. On `retry` (the server
closing so the client is authorized afresh), a live stream reconnects from its cursor after a random
0-500 ms wait, with no backoff step or attempt counted, and health `connecting` meanwhile; a `retry`
before the stream went live takes the normal backoff.

```ts
import { subscribeToEvents } from "@classytic/arc-next/sse";

const sub = subscribeToEvents({
  url: `${API_URL}/alerts/stream`,
  eventTypes: ["alert"],
  resumeFrom: store.cursor,                        // a persisted cursor, or null: first connect only
  onEvent: (e) => store.apply(e),
  onResync: ({ cursor, reason }) => store.reload(cursor), // reason: 'initial' or the server's
  staleAfterMs: 45_000,                            // > the server heartbeat interval
  backoff: { jitter: 0.5 },                        // min(maxMs, initialMs * factor^(n-1)) * (1 - jitter * random())
  terminalStatuses: [403],                         // `revoked` is terminal by default here
  onTerminal: (info) => session.end(info),
  onStatus: (s) => badge.set(s.health),            // connecting | live | stale | offline | revoked | closed
});
sub.status();  // { health, since, lastActivityAt, lastEventId, attempts, lastStatus? }
sub.restart(); // reconnect after `revoked`, resuming from the last cursor
```

| Option | Behaviour |
|---|---|
| `resumeFrom` | Cursor for the first connect. Later connects send the last id received, or the cursor a `ready` / `resync` frame set. |
| `resumeQueryParam` | Query mode (native `EventSource`) only: send the cursor as `?<param>=` (arc's default param is `lastEventId`). Header mode always sends `Last-Event-ID`. |
| `onReady`, `onResync` | `ready` and `resync` never reach `onEvent`. A `ready` with a `cursor` and `resumed: false`, on a connection that sent no cursor, calls `onResync({ cursor, reason: "initial" })`; a `resync` calls `onResync({ cursor, reason })`. Once per server signal, so an `initial` and a later `resync` on one connection each call it. These frames are handled once the stream opts into resume (`resumeFrom`, `resumeQueryParam`, `onReady` or `onResync`). A frame without `id:` never clears the cursor. |
| `onActivity`, `staleAfterMs` | Liveness: open, every frame, every chunk. Silence past `staleAfterMs` marks the stream `stale`, closes it and reconnects with the cursor. Heartbeat comments count only on `FetchEventSource` (`streamAuth: "header"`); on the native `EventSource` a quiet stream cycles every `staleAfterMs` (a dev warning says so). |
| `backoff` | `{ initialMs, factor, maxMs, jitter, random }`; defaults `reconnectDelay`, 1.5, 30000, 0 (the earlier curve). Invalid values fall back or clamp (`factor` >= 1, `jitter` 0..1). `Retry-After` still wins. |
| `terminalEvents`, `terminalStatuses`, `onTerminal` | End the subscription: no reconnect, health `revoked`. `terminalEvents` defaults to `[STREAM_FRAMES.REVOKED]` once the stream opts into resume, else `[]`; pass `[]` to opt out. Statuses default to `[]` and are checked before auth recovery; on the native `EventSource` every failure is probed while any are set. Client-side only: the server must still refuse a revoked client. |
| `liveOn`, `maxResumeFailures` | When a connection counts as `live`: `"ready"` (default once the stream opts into resume) waits for the connection's `ready` frame, so the health stays `connecting` (or `offline` / `stale` on a reconnect) while the server joins the log and replays the gap; `"open"` (default otherwise, 0.19) goes live on the response headers. `liveOn: "ready"` opts into resume itself; pass `"open"` for a resumable server that sends no `ready`. After `maxResumeFailures` (default 3, `0` off) connections in a row that sent one cursor and ended before `ready`, the next connect sends no cursor, so the fresh `ready` calls `onResync({ reason: "initial" })`. `onConnectionChange` keeps following the transport. |
| `compareCursors` | `(a, b) => number`, arc's replay-hub comparator. A data frame whose id compares at or below the last delivered one is a repeat and never reaches `onEvent` (exactly-once over at-least-once delivery). The floor starts at `resumeFrom` and is set by `resync` and a fresh `ready`. Every data frame must carry its own id. Default off. |
| `onStatus` | Health and reconnect-attempt changes; `status()` reads the snapshot any time. Out of attempts reads `offline`. `lastStatus` is a failure status only (`0` or >= 400). `onConnectionChange` is unchanged. |

`useEventStream` takes the same options and returns `status`. With `shareAcrossTabs`, the leader
relays status and the `ready` / `resync` / terminal frames, so each follower runs its own
`onResync` against its own cache. An effect re-run (leader handoff, `enabled` toggle, option change)
resumes from the last cursor the hook reached on that stream, relayed ones included, not from the
`resumeFrom` prop; a revoked stream stays `revoked` for followers when the leader lets go.

## WebSocket — Real-Time + Bidirectional

```ts
import { useWebSocket, buildWsUrl } from "@classytic/arc-next/ws";

const { isConnected, lastMessage, send, subscribe, unsubscribe } = useWebSocket({
  subscribe: ["todo"],                      // sends {type:'subscribe', resource:'todo'} on open
  invalidateQueries: [todoKeys.lists()],    // refetch on every broadcast
  patterns: ["todo.", "order.completed"],   // filter — prefix match (`x.`) or exact
  onMessage: (msg) => console.log(msg.type, msg.data),
  heartbeatInterval: 30_000,                // optional app-level ping
});

// Send any JSON payload — returns false if not connected
send({ type: "chat.message", text: "hi" });

// Build the URL for a raw WebSocket consumer (Node, worker, etc.)
const url = buildWsUrl("/ws", { roomId: "r-1" });
```

Subscriptions persist across reconnects — anything passed in `subscribe` (or via `subscribe()`) is auto-resent after the socket re-opens.

## Uploads with Progress

`fetch()` lacks a cross-browser upload-progress API, so arc-next ships a separate XHR-based pipeline at `/upload`. Same auth + error envelope as the fetch path:

```ts
import { useUploadWithProgress } from "@classytic/arc-next/upload";

const { upload, progress, isUploading, cancel, error } = useUploadWithProgress<
  { url: string },
  { file: File; folder?: string }
>({
  url: "/api/v1/media/upload",
  buildFormData: ({ file, folder }) => {
    const fd = new FormData();
    if (folder) fd.append("folder", folder);
    fd.append("file", file);
    return fd;
  },
  invalidateQueries: [mediaKeys.lists()],
  messages: { success: "Uploaded" },
});

// Bind progress.percent to a <ProgressBar /> — every tick re-renders.
```

For non-React consumers, `uploadWithProgress({ url, formData, onProgress, signal })` returns a Promise.

> **Divergence from the fetch path:** `ClientConfig.retry`, `beforeRequest`, and `afterResponse` do **not** propagate to uploads. Re-trying multi-MB bodies is rarely wanted (re-encoding cost, duplicate-write risk) and bridging XHR progress into the fetch interceptor pipeline would conflict with the upload-progress contract. Trace/correlation headers, latency loggers, and other interceptor logic must be passed explicitly via the `headers` option (or the `headers` factory on `useUploadWithProgress`). Auth, error parsing, `Idempotency-Key`, `x-arc-scope`, and `Accept-Version` all DO carry over.

## Request headers

Headers merge case-insensitively (`X-Organization-Id` and `x-organization-id` are one header,
never sent twice), in three layers, later wins:

1. **Client defaults**: `defaultHeaders`, `internalApiKey`, `apiVersion`, the JSON `Content-Type`,
   and the configured `getToken` / `getOrgId` (injected only when no header names them).
2. **Per-call headers**: the api's `headers`, then the call's `headerOptions` (factory `ctx.headers`,
   hook `request.headerOptions`).
3. **Explicit per-call options**: `organizationId` (`null` removes a header tenant), `token`,
   `idempotencyKey`, `elevated`.

Cache keys resolve the tenant with the same order, so the key names what the server receives.

## Multi-Client

Each `createClient` call is independent — its own `baseUrl`, auth, headers:

```ts
import { createClient } from "@classytic/arc-next/client";

const analytics = createClient({
  baseUrl: "https://analytics.example.com",
  authMode: "header",
  getToken: () => env.ANALYTICS_KEY,
  headerName: "x-api-key",
});

const eventsApi = createCrudApi("events", { client: analytics });
```

For consumer SDKs that just need to bridge the global auth singleton:

```ts
import { createAuthAwareClient } from "@classytic/arc-next/client";

const api = createCrudApi("products", { client: createAuthAwareClient() });
```

## SSR and streaming (Next.js App Router / Server Components)

The option factories are the one source of keys, so what a Server Component seeds is exactly what
the client hook reads. `./prefetch` does the per-request part in one call: a NEW `QueryClient` per
request (never the browser singleton), the queries started, the state dehydrated.

```tsx
// app/courses/page.tsx (Server Component)
import { headers } from "next/headers";
import { HydrationBoundary, streamQueries } from "@classytic/arc-next/prefetch";
import { forwardRequestHeaders } from "@classytic/arc-next/server";
import { courseQueries } from "@/api/courses"; // createEntityQueries(coursesApi, "courses") or hooks.queries

export default async function CoursesPage() {
  const state = streamQueries([
    courseQueries.list({ limit: 20 }, { auth: "omit" }),                       // public, CDN-cacheable
    courseQueries.count({}, { headers: forwardRequestHeaders(await headers()) }), // as the signed-in user
  ]);
  return (
    <HydrationBoundary state={state}>
      <Suspense fallback={<Shelf />}>
        <CourseList /> {/* "use client": useSuspenseList({ limit: 20 }, { auth: "omit" }) */}
      </Suspense>
    </HydrationBoundary>
  );
}
```

- **`streamQueries`** does not await: pending queries are dehydrated with their promises, and a
  client `useSuspenseList` / `useSuspenseDetail` / `useSuspenseQuery` with the same key suspends on
  the streamed promise, so the content still renders on the server as it resolves (with a plain
  `useQuery` the data arrives on the client instead).
- **`prefetchQueries`** awaits every query first: complete HTML, no Suspense boundary needed. A
  failed query is left out and the client fetches it.
- Infinite lists (`queries.infiniteList`) are seeded in the `{ pages, pageParams }` shape.
- `makeQueryClient()` (`./query-client`) is the same per-request client for custom flows
  (`queryClient.query(options)` / `infiniteQuery(options)`, then `dehydrate`).

#### Query islands: React Query off a public page's first-load JS

The server renders the real content into the HTML from `prefetchQueries` / `streamQueries`; the
browser keeps that HTML untouched, without downloading React Query, until the island activates
(`when`: `"idle"` default, `"visible"`, `"interaction"`).

```tsx
// course-list.island.ts
"use client";
import { createQueryIsland } from "@classytic/arc-next/query-island";
export const CourseListIsland = createQueryIsland(() => import("./course-list"));

// app/courses/page.tsx (Server Component)
const state = await prefetchQueries([courses.list({ limit: 20 }, { auth: "omit" })]);
return <CourseListIsland state={state} props={{ limit: 20 }} when="visible" />;
```

Create islands in a `"use client"` file with a dynamic `import()` (that import is the split point).
It only pays off when nothing else on the page imports React Query (a root-layout
`QueryClientProvider` puts it back in first-load JS). Islands share the browser `getQueryClient()`,
or the provider above them if there is one. A click before the island hydrates is dropped by React
(links still navigate), so prefer `"visible"` or `"idle"` when the first click must count. On a
client-side navigation the island loads at once behind `fallback`. The wrapper is a
`display: contents` `<div>`, so it cannot sit directly inside a `<ul>` or a table.

### Calling arc directly on the server (`/server`)

For a Route Handler, Server Action, or a Server Component that needs the data itself (not just a
warm cache), build a client for THIS request:

```ts
import { headers } from "next/headers";
import { createCrudApi } from "@classytic/arc-next/api";
import { createRequestClient } from "@classytic/arc-next/server";

const arc = createRequestClient({ baseUrl: process.env.API_URL!, headers: await headers() });
const orders = await createCrudApi<Order>("orders", { client: arc }).getAll();
```

It forwards `cookie`, `authorization`, `x-organization-id`, `accept-language` and the trace
headers (`x-request-id`, `traceparent`, `tracestate`), never hop-by-hop headers such as `host` or
`content-length`, which break the proxied call. Build it per request and never cache it: it
carries one user's identity. `x-forwarded-for` is opt-in (`forward: [...FORWARDED_REQUEST_HEADERS,
'x-forwarded-for']`) because arc should only believe it when its `trustProxy` names the Next
server. Works with any `Headers`-like source (React Router loaders, Hono, plain `Request`).

### Server caches: one tag rule, invalidated on the write

arc's http-cache tags cacheable responses `<resource>` and `<resource>:<id>` and purges them on
writes. arc-next names tags by the SAME rule (`resourceTags`, pinned by tests), so the API's CDN and
a Next host's data cache speak one vocabulary:

1. **Tag the read**: `arcTag('lessons')` is `"arc:lessons"`, `arcTag('lessons', id)` is
   `"arc:lessons:<id>"` (the `arc:` prefix keeps them apart from the host's own Next tags; strip it
   and it is arc's CDN tag), `arcTag('lessons', undefined, { by: 'course', id })` a scoped collection.
   Pass them as `next: { tags }` (request option or factory `ctx`).
2. **Invalidate on the write**: `onArcChange` (`/events`) reports every successful create, update,
   delete and restore with the document before the write (`previous`); `changeTags(event)` lists
   the tags it makes stale.

```ts
// app/actions/revalidate.ts
'use server';
import { revalidateTag } from 'next/cache';
export async function revalidateArc(tags: string[]) { for (const t of tags) revalidateTag(t, 'max'); }

// app/providers.tsx ('use client'), once for the whole app
onArcChange((event) => revalidateArc(changeTags(event)));
```

A listener's failure is logged and never fails the write. Several instances behind a load balancer
need a shared server cache (a Next.js `cacheHandler` backed by Redis or similar).

### Edge cache for public pages (`/edge-cache`)

Keep pages that are the same for every visitor at the CDN, and empty the edge after an edit or a
deploy. Only an EXPLICIT route list is cached; a dynamic first segment must exclude the app's
reserved segments or `edgePageHeaders` throws, so `/:creator` can never match `/dashboard`.

```ts
// next.config.ts
import path from "node:path";
import { edgePageHeaders, reservedSegments } from "@classytic/arc-next/edge-cache";
import { CLOUDFLARE_CDN_CACHE_CONTROL } from "@classytic/arc-next/edge-cache/cloudflare";

async headers() {
  return edgePageHeaders({
    routes: ["/", "/courses/:path*", "/:creator", "/:creator/courses/:slug"],
    policy: { maxAge: 3600, staleWhileRevalidate: 86_400 },
    header: CLOUDFLARE_CDN_CACHE_CONTROL,       // default: the standard CDN-Cache-Control
    reserved: await reservedSegments(path.join(process.cwd(), "app")),
  });
}

// lib/edge.ts (server): coalesced purge after edits, after()-friendly, never throws
export const edge = createEdgePurger({ provider: cloudflareEdgeFromEnv(), coalesceMs: 5000 });
// in a server action, after revalidateTag(...)
after(() => edge.purge({ hosts: [new URL(SITE_URL).hostname] }));

```

Once the new build is live, empty the edge for your host from CI (no script to write):

```bash
npx arc-next-edge purge --host example.com --env-file .env.production
```

It reads `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` from the environment; each `--env-file`
(repeatable, parsed with Node's `util.parseEnv`, Node 20.12+) only fills keys that are unset, so a CI
secret is never overridden by a file. The token is never printed; exit code 0 on success, 1 on
failure or a usage error; `--host` can repeat. In code, the same purge is `purgeEdgeHost({ host })`.

`edgeRouteMatcher(rules.map((r) => r.source))` answers "would the edge keep this URL?" for a host's
own tests. Credentials (`CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_PURGE_TOKEN`: a token with only Zone >
Cache Purge) stay on the server; without them the purger does nothing and the edge copy expires.

### Hand-written queries and seeded lists

- **`queryAuthEnabled({ enabled })`** (`/auth-gate`) is the generated hooks' enable rule for a query
  you write with `useQuery` directly. Pass `user: true` for an endpoint that answers for the
  signed-in user (`/mine`): a static `internalApiKey` identifies the app, not a person.
- **`useList(params, { initialData, initialDataUpdatedAt })`** (and `useDetail`) seeds the cache
  with the response a Server Component already fetched for exactly those params. `streamQueries`
  + `HydrationBoundary` is the route when the server read goes through arc-next itself.

### Next.js 16 `cacheComponents` + `'use cache'`

TanStack Query manages a client-side cache; data fetched through arc-next hooks should NOT be wrapped in a Server Component's `'use cache'` directive (which would bake the hook output into the static render). Use `'use cache'` for non-arc Server Component fetches. The two layers target different cache tiers.

## Request-Scoped Server Clients (0.12+)

`configureClient` / `configureAuth` set module singletons — correct for the browser, wrong for servers where concurrent requests would share state. On the server, build a **request-scoped** client instead. The SDK never imports `next` or reads cookies itself: your framework code reads the request, the SDK gets plain values.

```ts
// app/orders/page.tsx (Server Component) — host reads cookies, SDK stays framework-free
import { cookies } from 'next/headers';
import { createServerClient } from '@classytic/arc-next/client';
import { createCrudApi } from '@classytic/arc-next/api';

export default async function OrdersPage() {
  const client = createServerClient({
    baseUrl: process.env.API_URL!,
    token: (await cookies()).get('session')?.value ?? null,
    organizationId: null,
  });
  const orders = createCrudApi<Order>('orders', { client });
  const page = await orders.getAll({
    options: { next: { revalidate: 60, tags: ['orders'] } },  // Next fetch-cache passthrough
  });
  // render...
}
```

`next: { tags, revalidate }` and `cache:` are typed pass-throughs to `fetch` — inert on non-Next runtimes, no `next` peer dependency.

## Guarantees

Each line is pinned by the named test (`tests/` mirrors `src/`).

| Guarantee | Proven by |
|---|---|
| **Cache partitioning.** Every resource key carries `{ auth, organizationId, scope }`: anonymous vs signed in, the tenant the request actually sends (resolved before the key: client `getOrgId`, `configureAuth`, a forwarded `x-organization-id`), and an explicit scope. Two tenants, two clients or an anonymous and a signed-in read never share an entry. | `tests/query/cache.test.tsx` "every key kind x every partition is a distinct entry"; `tests/query/query-options.test.ts` "identity partition: resolved before the key is built" |
| **`auth` is the same everywhere.** Omitted, `"inherit"` and `"omit"` reach the wire, the key and the credentials mode identically from a hook, an option factory and a direct api call. | `tests/query/crud-reads.test.tsx` "auth: hooks, option factories and the transport agree" |
| **Detail to list, list to detail.** A fresh detail merges only into lists of its own partition; a detail previews only a list row of its own partition; a list never writes a detail cache. | `tests/query/cache.test.tsx` "useDetail sync and placeholders stay inside the read's partition" |
| **Optimistic writes.** Cancel before snapshot, the writer's partition only (its lists, infinite first page for creates, its detail variants), exact rollback, temp id swapped in place for the server doc, last-standing invalidation, bulk with zero changes skips invalidation. | `tests/query/crud-mutations.test.tsx` "optimistic guarantees" and "partition: a write touches only caches read as the same identity" |
| **Ordering, idempotency, versions.** Writes to one record in one tenant run in call order, each sent as whoever submitted it (a tenant or session switch never re-targets or blocks a queued write); one `Idempotency-Key` per logical request survives retries; `update` sends `If-Match` from the version the writer last saw. | `tests/query/crud-mutations.test.tsx` "write queue: identity captured at submit, one queue per tenant", "write ordering", "optimistic concurrency (If-Match)"; `tests/client/request.test.ts` "idempotency keys" |
| **Headers reach the server once.** Header names merge case-insensitively (defaults < per-call headers < explicit options) and the key's tenant is the one the server receives. | `tests/client/request-headers.node.test.ts` (a real `node:http` server) |
| **Invalidation is one rule.** A local write and a realtime event invalidate the same caches (lists, counts, aggregations, the record's own detail) in every partition, each refetching as its own identity. | `tests/query/cache.test.tsx` "invalidateForChange (scoped, never the whole resource)"; `tests/realtime/resource-sync.test.tsx` "useResourceSync (WS source)", "(SSE source)" |
| **Server requests never share state.** `makeQueryClient` / server `getQueryClient` are per call; `createRequestClient` carries only its own request's identity. | `tests/query/prefetch.ssr.test.ts` "per-request clients"; `tests/server/server.node.test.ts` "two requests never share identity" |
| **Platform boundaries.** Server-safe subpaths never import client-only modules; React Native subpaths never reach DOM, Next or Node-only code; public pages at the edge never match an app route. | `npm run check:server-import`, `npm run check:rn-boundary`, `tests/platform/react-native.native.test.ts`, `tests/edge-cache/edge-cache.node.test.ts` |
| **Retry.** `makeQueryClient({ retry })` means what TanStack means; a quota 429 never retries. | `tests/query/query-client.test.ts` "retry (TanStack retryer semantics, quota 429s excluded)" |

Not keyed on purpose: the token. A user switch inside one tenant keeps the partition, so clear the
client on sign-out (`queryClient.clear()`).

## Errors

```ts
import {
  isAbortError, isArcApiError, isArcErrorCode, isDuplicateKeyError, isPreconditionFailed,
} from "@classytic/arc-next/client";

try { await api.create({ data, options: { signal } }); }
catch (err) {
  if (isAbortError(err)) return;       // user navigated away — silence
  if (isArcApiError(err)) {
    err.status;       // 400
    err.code;         // 'arc.validation_error'
    err.fieldErrors;  // { email: "already taken" } | null
  }
  if (isDuplicateKeyError(err)) showRetryUI();
  if (isArcErrorCode(err, 'ORG_CONTEXT_REQUIRED')) promptOrgSelector();
}
```

`fieldErrors` maps arc's `details: [{ path, code, message }]` to `{ [path]: message }` — body
validation, missing multipart files and duplicate keys all arrive in that shape. Legacy shapes
(`errors: { field: msg }`, AJV `instancePath`) are read as a fallback for non-arc backends.

Putting them on the form is the form library's job, not this SDK's — with react-hook-form, use
formkit's `applyServerErrors(form, err.fieldErrors)` (fluid's `SchemaForm` does it for you via
`serverErrors={toFieldErrors(err)}`); any other library is one loop over `err.fieldErrors` calling
its own `setError(path, message)`. Dot-paths (`lines.0.quantity`) land on nested fields.

`KNOWN_ARC_ERROR_CODES` is every code a client can see, spread from `@classytic/repo-core/errors`
(the catalog arc emits from) — never a hand-copied list:

```ts
import { KNOWN_ARC_ERROR_CODES } from "@classytic/arc-next/client";

const ERROR_MESSAGES = Object.fromEntries(
  KNOWN_ARC_ERROR_CODES.map((code) => [code, t(`error.${code}`)])
);
```

### Optimistic concurrency (`If-Match`)

For a resource declared with `concurrency: { versionField }` on the server, name the field once —
or take it from arc's resource manifest (`buildResourceManifest(resource)` / the registry), which
publishes `versionField` and `idField` so neither is typed twice:

```ts
export const ordersApi = createCrudApi<Order>("orders", { versionField: "__v" });
```

or, from a manifest generated on the server
(`writeFileSync('orders.manifest.json', JSON.stringify(buildResourceManifest(orders)))`):

```ts
import m from "./orders.manifest.json";

// `prefix` ("/orders") is the URL segment; `name` ("order") is the resource's name.
export const ordersApi = createCrudApi<Order>(m.prefix.replace(/^\//, ""), {
  versionField: m.versionField,
});
export const orders = createCrudHooks({
  api: ordersApi,
  entityKey: m.name,
  singular: m.displayName,
  idField: m.idField,
});
```

`useActions().update` then sends `If-Match: "<version>"`, and a write based on a stale read is
refused `412` instead of silently overwriting a change made in between. The version is the one
the **edit** was based on: an explicit `version`, else `data.__v` (a form that round-trips the
document it loaded), else the cached document.

```ts
try {
  await update({ id, data: form.values });            // form.values carries __v
} catch (err) {
  if (isPreconditionFailed(err)) {
    // The record was already refetched. Offer a reload, or "save anyway":
    await update({ id, data: form.values, version: null });
  }
}
```

## Retry + Interceptors

Network resilience for mutations + direct `handleApiRequest` calls (TanStack Query already retries reads). Off by default — opt in via `configureClient`:

```ts
configureClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL!,
  timeoutMs: 15_000,                   // per-attempt request timeout; hung fetches fail
                                       // with a RETRYABLE TimeoutError. Default: disabled.
                                       // Per-request override: options.timeoutMs (0 disables).
  retry: {
    attempts: 3,                       // 1 initial + 2 retries; default off
    backoff: 'exponential',            // 'exponential' | 'linear' | (attempt) => ms
    jitter: 'full',                    // randomize delays in [0, computed] — anti-stampede. Default 'none'.
    // retryOn: [502, 503, 504],       // optional whitelist; default = network failures + 5xx, never 4xx, never AbortError
  },
  // 429/503 responses with a Retry-After header override computed backoff —
  // the parsed value is also exposed as ArcApiError.retryAfterMs.
  // Mutate outgoing requests (per attempt — retries re-run this)
  beforeRequest: (ctx) => ({
    ...ctx,
    headers: { ...ctx.headers, 'x-correlation-id': crypto.randomUUID() },
  }),
  // Inspect / transform successful responses (4xx/5xx throw before this)
  afterResponse: (ctx) => {
    console.log(`[arc] ${ctx.method} ${ctx.endpoint} ${ctx.status} ${ctx.durationMs}ms`);
    return ctx;
  },
});
```

Interceptors are async-supported and compose with retry — `beforeRequest` re-runs each attempt (so a refreshed token mid-flight is picked up). Aborting via `AbortSignal` cancels both the pending fetch AND any in-flight backoff sleep.

## `arcFetch` — one-line authenticated fetch for non-hook contexts (0.7+)

When you need to hit an arc endpoint from outside a hook — event handler, service worker, server action, custom MDX submit, background poll — `arcFetch` collapses the auth/org/content-type/error/parse boilerplate into one call:

```ts
import { arc } from "@classytic/arc-next/client";

// Before — 15 lines of header dance + error parse + JSON parse:
//   const { token } = getAuthContext();
//   if (!token) throw ...
//   const res = await fetch(`${apiBaseUrl()}/api/statements`, {
//     method: "POST",
//     headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ... },
//     body: JSON.stringify(statements),
//   });
//   if (!res.ok) throw ...
//   return await res.json();
//
// After:
const result = await arc.post<{ ok: boolean }>("/api/statements", statements);
```

Auto-injects `Authorization` (or your `headerName` for `authMode: "header"`), `x-organization-id`, `x-internal-api-key`, `Idempotency-Key`, `x-arc-scope`, and `Content-Type: application/json` (only for plain object/array bodies). Composes with everything else — `retry`, `onAuthError`, `beforeRequest`, `afterResponse`.

**Method shorthands:**

```ts
arc.get<T>(path, opts?)
arc.post<T>(path, body?, opts?)
arc.put<T>(path, body?, opts?)
arc.patch<T>(path, body?, opts?)
arc.delete<T>(path, opts?)

// Or call arcFetch directly for full RequestInit control:
arcFetch<T>(path, { method, body, headers, signal, elevated, idempotencyKey, revalidate, tags, cache, client })
```

**Body sniffing.** `FormData`, `Blob`, `URLSearchParams`, `ArrayBuffer`, `ReadableStream`, and `string` pass through unchanged — caller controls `Content-Type` for those. Plain objects and arrays get `JSON.stringify`d and the JSON content-type header.

**Protected headers.** `Authorization`, `x-organization-id`, `x-internal-api-key`, and the custom header for `authMode: "header"` cannot be overridden by `options.headers`. A caller can't accidentally strip the bearer token by spreading their own header map. Non-auth headers (`X-Trace-Id`, `Accept-Version`, etc.) pass through normally.

**Error handling.** Non-2xx throws `ArcApiError` with parsed body, status, endpoint, method — same contract as the CRUD hooks. Use `isArcApiError(err)` + `err.code` to discriminate.

**Escape hatch.** When you need full `Response` control (rare — streaming downloads, custom redirect logic), use plain `fetch` with `arcAuthHeaders()`:

```ts
import { arcAuthHeaders, getAuthMode } from "@classytic/arc-next/client";

const res = await fetch(url, {
  headers: { ...arcAuthHeaders(), "X-Custom": "1" },
  credentials: getAuthMode() === "cookie" ? "include" : "same-origin",
});
```

## Auth Recovery (0.7+) — 401 → refresh → retry

When a session token expires mid-page, the SDK transparently refreshes and retries — no flash of unauthenticated UI, no manual reload. Wire it once at app boot:

```ts
import { configureAuth, createAuthRefreshHandler } from "@classytic/arc-next/client";
import { authClient } from "@/lib/auth-client";

configureAuth({
  getToken: () => authClient.getSession().data?.session.token ?? null,
  onAuthError: createAuthRefreshHandler({
    refresh: async () => {
      // Whatever your auth lib calls to mint a fresh access token.
      const { data } = await authClient.getSession({ disableCookieCache: true });
      return data?.session.token ?? null; // null → session truly expired; original 401 surfaces
    },
  }),
});
```

Every `useList`, `useDetail`, `useActions`, and any code path going through `createAuthAwareClient()` or `createClient(...)` now survives token expiry transparently. Apps that don't wire `onAuthError` see the original behavior (401 surfaces immediately).

**Concurrent-refresh dedup.** When N requests hit 401 at the same time, the handler fires **once**. All N concurrent callers await the same refresh promise and retry with the token it produces — no stampeding the refresh endpoint under burst auth-expiry.

**Tuning knobs.**

```ts
configureAuth({
  // ...
  onAuthError,
  retryOn403: true,    // also recover from 403 (default: 401 only)
  maxAuthRetries: 1,   // cap per individual request (default: 1; prevents loops)
});
```

**Custom handler.** Bypass `createAuthRefreshHandler` if you need full control over the recovery cycle:

```ts
configureAuth({
  onAuthError: async ({ error, request, attempt, setToken }) => {
    if (error.code === "session.revoked") return "skip"; // route to /login
    const fresh = await myRefreshFn();
    if (!fresh) return "skip";
    setToken(fresh);
    return "retry";
  },
});
```

The handler receives the full `ArcApiError`, the failing request descriptor, the 1-indexed attempt counter, and a `setToken(value)` callback that supplies the refreshed token for the retry. Throwing from the handler short-circuits — the thrown error propagates instead of the 401.

**Transport coverage.** Auth recovery fires across every transport arc-next exposes:

| Transport | Trigger | Mechanism |
|---|---|---|
| Fetch (CRUD hooks, `arcFetch`, `handleApiRequest`) | 401 / 403 response | Inline retry in `executeRequest` |
| XHR upload (`uploadWithProgress`, `useUploadWithProgress`) | 401 / 403 response | Outer retry loop in `upload.ts` |
| WebSocket | close code `1008` / `3401` / `4001` / `4401` | `ws.onclose` handler routes through recovery, reconnect with refreshed token |
| SSE (`subscribeToEvents`, `useEventStream`) | `EventSource` error | Pre-flight `fetch` probe classifies as auth-failure → recovery → reopen |

All four transports share **one** dedup'd refresh promise — concurrent failures across mixed transports (5 in-flight uploads + 3 WebSocket reconnects + 10 fetch calls, all 401 at once) collapse to a single `onAuthError` call.

**Session-state 403s (opt-in).** Some 403s mean the session's state changed, not "you may not do this": a second factor became required after a deploy, a password must be rotated. Without a hook, a tab left open shows that 403 as an error until reload. `onSessionChange` routes the 403s your predicate matches to a handler with the same contract as `onAuthError`:

```ts
configureAuth({
  getToken,
  onAuthError,
  onSessionChange: {
    match: (error) => error.code === "auth.second_factor_required", // only 403s are offered
    handler: async ({ setToken }) => {
      const token = await openStepUpDialog(); // null when the user cancels
      if (!token) return "skip";               // the 403 surfaces
      setToken(token);
      return "retry";
    },
  },
});
```

Concurrent matched 403s share one handler call (one dialog, not N), kept apart from the 401 refresh. A matched 403 goes here even with `retryOn403: true`; unmatched 403s keep the existing path. `maxAuthRetries` caps it per request, counted apart from 401s, so a refresh followed by a step-up on the same request both run. It covers the JSON client (CRUD hooks, `arcFetch`, `handleApiRequest`, actions); uploads and streams keep 401 recovery only. `initSDK({ onSessionChange })` (`./sdk/init`) passes it through.

## Cache & Keys

Every resource key carries an **identity partition** `P = { auth, organizationId, scope }` (always
all three fields, `null` for none): who the read was sent as. The option factories resolve it
before building the key from what the request will carry (the api client's `getOrgId`,
`configureAuth`, a forwarded `x-organization-id` header, `readAuth`) and send exactly that tenant,
so two tenants, two clients, or an anonymous and a signed-in read never share an entry. Detail →
list sync, list placeholders, optimistic writes and their reconciliation stay inside one
partition; invalidation still reaches every partition (each refetches as its own identity).

```ts
const P = queries.partition();          // the partition a default read uses (ctx optional)
KEYS.list(params, P);                   // ["products", "list", P, params]
KEYS.lists(P);                          // exact prefix of that partition's lists
KEYS.detail(id);                        // ["products", "detail", id]: prefix of every variant
KEYS.detail(id, { ...P, params });      // ["products", "detail", id, P, params?]
KEYS.count(params, P); KEYS.slug(slug, P); KEYS.aggregation(name, filter, P); KEYS.write();
KEYS.routes(); KEYS.route("/stats", params, P); // custom-route reads

// Detail caches hold the raw doc (no envelope), as useDetail and streamQueries write it.
cache.setDetail(qc, id, doc, P);        // omitted P: the default partition (signed in, no tenant)
cache.getDetail(qc, id, P);
cache.invalidateDetail(qc, id);         // every variant of the record
cache.invalidateForChange(qc, { op: "update", id }); // what one write makes stale
```

What every key guarantees, and what is deliberately not keyed: [Guarantees](#guarantees).

## Custom Mutations

```ts
import { useMutationWithTransition } from "@classytic/arc-next/mutation";

const { mutateAsync: publish, isPending } = useMutationWithTransition({
  mutationFn: (id: string) => api.request("POST", `${api.baseUrl}/${id}/publish`),
  invalidateQueries: [productKeys.all],
  messages: { success: "Published!" },
});
```

`useOptimisticMutation` adds key-aware optimistic cache updates with rollback; for a CRUD write prefer `useMutation(hooks.queries.update())` (shares the resource's write key, so `usePendingWrites` sees it), and for a custom route `useMutation(hooks.queries.routeMutation(path, { invalidates }))`.

## Auth Modes

| Mode | When | Notes |
|---|---|---|
| `bearer` (default) | JWT / opaque token | `getToken()` returns the token |
| `cookie` | Better Auth, session cookies | No token needed; `credentials: 'include'` automatic |
| `header` | API keys (`x-api-key`, etc.) | Set `headerName` on `configureAuth` or `createClient` |

### Social sign-in (`/auth-social`, `/google-one-tap`)

Client half of arc's `socialAuth()` plugin for bearer-token apps. The API never puts the session in a redirect URL: it lands the browser on your callback page with a one-time `#handoff=<code>`, and only the tab holding the matching verifier can exchange it.

```ts
// sign-in button
import { startSocialSignIn } from "@classytic/arc-next/auth-social";
await startSocialSignIn(authClient, { provider: "google", next: searchParams.get("next"), appOrigin: location.origin });

// app/auth/callback/page.tsx (client component, in an effect)
const result = await completeSocialSignIn(authClient, tokens);
if (result.ok) router.replace(result.next); else router.replace(`/sign-in?error=${encodeURIComponent(result.error.code)}`);

// app/sign-in/page.tsx (Server Component)
const providers = await fetchSocialProviders(AUTH_URL, { next: { revalidate: 300 } });
const error = readSocialError(await searchParams); // intent "cancelled": show nothing
```

- `next` passes `safeNextPath`: only same-origin paths; `//host`, `/\host`, schemes and control characters become `/`.
- `completeSocialSignIn` fails with intent `expired-retry` when the fragment is missing, the verifier is gone (another tab, older than 10 minutes, already used) or the server answers `HANDOFF_INVALID`.
- `setLastAuthMethod("password")` after a password sign-in; social and One Tap record theirs. `getLastAuthMethod()` returns `null` on the server. Storage is injectable: `startSocialSignIn(..., { storage })`, `completeSocialSignIn(..., { storage, methodStorage })`, `setLastAuthMethod(method, storage)`, `loadLastAuthMethod(storage)` (async stores included).
- `useGoogleOneTap({ clientId, enabled: !session, authClient, tokens, onSignedIn })` posts `{ idToken, nonce }` to `/one-tap/callback` (Better Auth's `oneTap()` plugin). CSP: allow `https://accounts.google.com` in `connect-src` and `frame-src`, `https://accounts.google.com/gsi/style` in `style-src`, and add `GOOGLE_ONE_TAP_POLICY` to `trustedTypesPolicies`.

## Expo / React Native

React Native-facing subpaths (checked by `npm run check:rn-boundary`: none reaches a DOM, Next or Node-only module) are `.`, `/client`, `/api`, `/cache`, `/query`, `/query-options`, `/query-client`, `/mutation`, `/hooks`, `/events`, `/auth-gate`, `/auth-token`, `/auth-social`, `/sse`, `/ws`, `/upload`, `/encryption`, `/field-encryption`, `/presets/*` and `/react-native`. Web or Next only: `/edge-cache*`, `/csp`, `/service-worker`, `/google-one-tap`, `/auth-proxy`, `/devtools`, `/server`. Tests: the `native` Vitest project loads them with no DOM globals at all; `tests/platform/react-native-globals.test.tsx` runs hooks under React Native's globals.

```ts
// App.tsx, once
import "react-native-get-random-values";           // crypto.getRandomValues, for Idempotency-Key
import { AppState } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import RNEventSource from "react-native-sse";
import * as SecureStore from "expo-secure-store";
import { configureAuth, configureClient } from "@classytic/arc-next/client";
import { createTokenStore } from "@classytic/arc-next/auth-token";
import { setupReactNative } from "@classytic/arc-next/react-native";

setupReactNative({ appState: AppState, netInfo: NetInfo }); // refetch on foreground, pause offline
const tokens = createTokenStore(
  { getItem: SecureStore.getItemAsync, setItem: SecureStore.setItemAsync, removeItem: SecureStore.deleteItemAsync },
  "session",
);
await tokens.load();
configureClient({ baseUrl: API_URL, eventSource: RNEventSource, streamAuth: "header" });
configureAuth({ getToken: () => tokens.get(), getOrgId: () => orgId });
```

- **Lifecycle and network.** `setupReactNative` points TanStack's `focusManager` at `AppState` and `onlineManager` at NetInfo (both injected; arc-next imports neither). `getQueryClient()` defaults queries to `networkMode: "offlineFirst"`: the first fetch always runs, retries pause offline; mutations pause offline and resume.
- **Google sign-in.** On a device it is the ID-token flow, not the redirect handoff: `signInWithIdToken(authClient, tokens, { provider: "google", idToken, nonce, methodStorage })` (`/auth-social`) sends `signIn.social({ provider, idToken: { token, nonce } })`, stores the bearer token and the method, and maps refusals to UI intents. Never throws.
- **Persistence (optional).** Survive restarts with TanStack's persister: `PersistQueryClientProvider` (`@tanstack/react-query-persist-client`) + `createAsyncStoragePersister({ storage: AsyncStorage })` (`@tanstack/query-async-storage-persister`). Persist reads only; do not persist anything `auth: "omit"` would not show to a guest unless the device is single-user.
- **SSE.** RN's `fetch` cannot stream: inject `eventSource` (e.g. `react-native-sse`); with `streamAuth: 'header'` token and org travel as headers, never in the URL, and without an injected `eventSource` it throws instead of falling back to `?token=`. Without `BroadcastChannel`, `useEventStream` holds its own connection. WebSockets (`/ws`) work as is.
- **fetch and credentials.** `ClientConfig.fetch` is injectable. RN has no cookie jar to rely on: use bearer mode; `credentials` is ignored there.
- **Ids.** Idempotency keys come from `crypto.randomUUID` when present, otherwise `crypto.getRandomValues`. With neither, minting throws rather than fall back to `Math.random`.
- **Caching.** Do not set `no-store` / `no-cache` on React Native: whatwg-fetch turns those GETs into `?_=<timestamp>`, which arc's strict query validation rejects with 400.
- **Not covered:** upload progress (XHR) varies by RN version; `/field-encryption` needs Web Crypto `subtle`.

## Portal bootstrap and SDK core (Unreleased)

Generic building blocks for a Next.js app on an arc API. The host supplies every origin, name and schema; nothing is hard-coded. Server-safe unless marked `"use client"`.

| Subpath | What |
|---|---|
| `/runtime` | `definePublicEnv({ globalName, read })`: runtime settings. The server reads `process.env` through your typed `read`; the root layout writes `publicEnvScript()` (nonce'd, `<` escaped); the browser reads `window[globalName]`. Also `trimSlash`, `csv`, `serializeForScript`. |
| `/csp` | `contentSecurityPolicy({ nonce, apiOrigin, storageOrigin, mapOrigins, embedOrigins, frameSrc, extra, dev })` (nonce + `strict-dynamic`, Trusted Types in production; `frameSrc: "none"` for an app that frames nothing, or an array replacing the built-in frame list; `connect-src blob:` via `extra`), `TRUSTED_TYPES_DEFAULT_POLICY`, `originOf` / `originsOf` / `hostOrigins`, and `createProxy({ NextResponse, policy, requestHeaders })` for Next's `proxy.ts` (`requestHeaders` sets forwarded request headers, `null` deletes one; it cannot override `x-nonce` or the CSP; incoming headers pass through, so set or delete every trust hint you read). No `next` import: you pass `NextResponse`. |
| `/auth-proxy` | `createAuthProxy({ upstream, internalUpstream })` returns `GET/POST/PUT/PATCH/DELETE` route handlers that reverse-proxy an auth service same-origin: hop-by-hop headers filtered, every `set-cookie` kept, `redirect: "manual"`, a 502 JSON body when the upstream is down. |
| `/service-worker` | `useServiceWorker({ url, scope, checkEveryMs, enabled })` registers a worker (`updateViaCache: "none"`) and returns `{ updateReady, applyUpdate }`: a new worker installs and WAITS, the page offers the reload, and `applyUpdate()` posts `SKIP_WAITING_MESSAGE` (`{ type: "SKIP_WAITING" }`; your worker answers with `self.skipWaiting()`) and reloads once it controls the page. Checks for a newer worker when the page becomes visible again and every `checkEveryMs`. Framework-free: `watchServiceWorker`, `applyServiceWorkerUpdate`. What the worker caches is yours. `"use client"`. |
| `/sdk/transport` | `SdkConfig`, `createIsolatedClient`, `resolveTransport`, `bareCollectionPath` (no trailing slash on a collection route). |
| `/sdk/init` | `initSDK(config)`: one boot call for client, auth, toast (message keys resolved at display time), navigation, messages. `"use client"`. |
| `/sdk/messages` | Message KEYS instead of English: `registerCrudMessages`, `configureMessages(resolver, { keyPrefix })`, `listMessageKeys`, `resolveToastText`, `localizeToastHandler`. The resolver context carries the server `code` and `details` of a refused request. |
| `/sdk/actions` | `defineCommitAction`, `defineAction`, `defineRouteAction`, `runAction`, `runRouteAction`: one typed descriptor per verb (method, path, body, params, message keys). |
| `/sdk/hooks` | `useResourceAction`, `useRouteAction`, `useQuietRouteAction`, `useRouteQuery`, `useRouteList` (`enabled`, `placeholderData`), `toastCrudSuccess`. Composes `createCrudHooks` bundles. `"use client"`. |
| `/sdk/resource` | `defineSdkResource`, `keyRoot`, `invalidateRoots`: route, cache key root, names and permission in one definition. |
| `/sdk/download` | `createDownloader` / `streamDownload` / `saveDownload`: streamed file download, token in a header, filename from `content-disposition`, `truncated` from a configurable header. |
| `/sdk/errors`, `/sdk/error-capture`, `/sdk/route`, `/sdk/localized` | `errorCode` / `errorStatus` / `errorDetails` / `mapError` / `SdkRequestError`; the refused-response ring behind the message context; `enc` / `compact` / `fetchAllPages`; `localized` / `localizedName`. |

```ts
// proxy.ts
import { NextResponse } from "next/server";
import { contentSecurityPolicy, createProxy } from "@classytic/arc-next/csp";
import { publicEnv } from "@/lib/env"; // definePublicEnv(...)

export const proxy = createProxy({
  NextResponse,
  policy: ({ nonce, dev }) =>
    contentSecurityPolicy({ nonce, dev, apiOrigin: publicEnv.apiUrl, storageOrigin: publicEnv.storageOrigin }),
});

// app/api/auth/[...path]/route.ts
import { createAuthProxy } from "@classytic/arc-next/auth-proxy";

export const { DELETE, GET, PATCH, POST, PUT } = createAuthProxy({
  upstream: () => publicEnv.apiUrl,
  internalUpstream: () => process.env.API_INTERNAL_URL,
});
```

## Peer ranges

Each peer floor is the lowest version the code needs, not the version used in development:

| Peer | Floor | Why this version |
|---|---|---|
| `react` | `19.0.0` | No React API newer than 19.0 is used. Works with React 19.2 (Expo SDK 55 / React Native 0.83). |
| `@tanstack/react-query` | `5.102.0` | `queryClient.query()` / `infiniteQuery()` (`./prefetch`), and `environmentManager` (5.91). Developed against 5.107. |
| `@tanstack/react-query-devtools` (optional) | `5.102.0` | Only `./devtools` imports it, lazily. |
| `@classytic/repo-core` | `0.38.0` | `./sync` stream frames (0.21) and the wire contract (`pagination`, `query-parser` `formatQuery`, `errors`, `repository`). |
| `jose` (optional) | `4.8.1` | First release whose types resolve under `moduleResolution: NodeNext`. |

The floors are tested, not asserted. `npm run check:peer-floors` copies the repo into a temp dir,
installs every peer at its exact floor (plus `react-dom` and `@types/react*` matching the react
floor), and runs `typecheck`, `typecheck:tests`, `test`, `build` and `check:fixtures` there. It needs
the npm registry (or a warm npm cache), so it is not part of `npm test` or `prepublishOnly`. CI runs
it on every push (`peer-minimums` job); run it locally as a release step before `npm run release`.
A floor moves up only when this check fails at the old floor, with the reason in the CHANGELOG.

Developing this package needs Node `^22.22.2 || ^24.15.0 || >=26` (`engines`; the locked vitest,
tsdown and jsdom need it, and `.npmrc` sets `engine-strict`). CI runs `npm run gate`, the same script
`prepublishOnly` runs, on Node 22 and the latest LTS, after `npm run lint:query:install`.

## License

MIT


## Trademark

The code is MIT-licensed. **"Classytic", "arc", and the logos are trademarks of
Classytic LLC** and are **not** licensed under MIT — see [TRADEMARK.md](TRADEMARK.md).
Forks must be renamed; the license covers the code, not the brand.
