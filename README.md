# @classytic/arc-next

[![Sponsor](https://img.shields.io/github/sponsors/classytic?style=flat-square&label=Sponsor&logo=GitHub&color=EA4AAA)](https://github.com/sponsors/classytic)

React + TanStack Query SDK for the Arc backend framework. Typed CRUD hooks, optimistic updates with rollback, multi-tenant cache scoping, pagination normalization, real-time SSE.

**Peers:** React 19+, TanStack React Query 5+

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

> **Targets:** React 19 browser apps + Next.js App Router. React Native is NOT officially supported — the fetch client may work, but SSE needs an `EventSource` polyfill, uploads depend on RN's XHR/FormData behavior, and field encryption needs Web Crypto. File an issue if you need an RN adapter.

`getToken` **must be synchronous** — cache async tokens out-of-band. Promise returns are dropped + warned in dev.

## Quick Start

```ts
import { createCrudApi } from "@classytic/arc-next/api";
import { createCrudHooks } from "@classytic/arc-next/hooks";
import { withSoftDelete } from "@classytic/arc-next/presets/soft-delete";
import { withBulk } from "@classytic/arc-next/presets/bulk";

interface Product { _id: string; name: string; price: number; }

// Compose only the presets your backend actually mounts.
// Vanilla `createCrudApi` ships CRUD + action + invokeRoute + upload only;
// add presets via factory wrappers (matches arc's server-side `presets: [...]`).
const productsApi = withBulk(withSoftDelete(
  createCrudApi<Product>("products", { basePath: "/api" }),
));

export const {
  KEYS, cache,
  useList, useDetail, useActions, useNavigation,
  useInfiniteList, useUpload, useCustomMutation,
  useDeleted, useBulkActions, useDetailBySlug, useTree, useChildren,
} = createCrudHooks<Product>({ api: productsApi, entityKey: "products", singular: "Product" });
```

```tsx
"use client";
function Products() {
  const { items, pagination, isLoading } = useList(null, { organizationId: orgId });
  const { create, update, remove, isCreating } = useActions();
  // ...
}
```

## Subpath Exports

| Import | Server-safe | Exports |
|---|:-:|---|
| `/client` | yes | `configureClient`, `configureAuth`, `createClient`, `createAuthAwareClient`, `handleApiRequest`, `ArcApiError`, `isArcApiError`, `isAbortError`, `isArcErrorCode`, `KNOWN_TOP_LEVEL_CODES`, `KNOWN_DETAILS_CODES`, `getAuthMode`, `getAuthContext`, `getBaseUrl`, `createQueryString` |
| `/api` | yes | `BaseApi`, `createCrudApi`, response types + type guards |
| `/cache` | yes | `createQueryKeys`, `createCacheUtils`, `extractItem`, `extractItems`, `getItemId`, `updateListCache`, `normalizePagination`, `QUERY_CONFIGS`, `DEFAULT_QUERY_CONFIG` — server-safe utilities for RSC prefetch + Server Component imports |
| `/query` | client | `useApiQuery`, `useListQuery`, `useDetailQuery`, `useInfiniteListQuery` — React hooks. Re-exports the cache utilities for back-compat, but new code should import server-safe utils from `/cache` directly |
| `/mutation` | client | `configureToast`, `useMutationWithTransition`, `useMutationWithOptimistic` |
| `/hooks` | client | `createCrudHooks`, `configureNavigation` (also default export) |
| `/query-client` | yes | `getQueryClient` (SSR-safe singleton) |
| `/prefetch` | yes | `createCrudPrefetcher`, `dehydrate` |
| `/sse` | client | `useEventStream`, `buildSseUrl`, `subscribeToEvents` |
| `/ws` | client | `useWebSocket`, `buildWsUrl`, `connectWs` |
| `/upload` | client | `useUploadWithProgress`, `uploadWithProgress` — XHR-based uploads with native progress events |
| `/presets/soft-delete` | yes | `withSoftDelete` — adds `getDeleted`, `restore` |
| `/presets/bulk` | yes | `withBulk` — adds `bulkCreate`, `bulkUpdate`, `bulkDelete` |
| `/presets/slug` | yes | `withSlugLookup` — adds `getBySlug` |
| `/presets/tree` | yes | `withTree` — adds `getTree`, `getChildren` |
| `/presets/search` | yes | `withSearchPreset` — adds `searchEngine`, `searchSimilar`, `embed` |

`sideEffects: false`. No barrel — every file is its own entry point.

## Core Hooks (from `createCrudHooks`)

```ts
const { items, pagination, isLoading, refetch } = useList(params, options);
const { item, isLoading, isPlaceholderData } = useDetail(id, options);
const { create, update, remove, isMutating } = useActions();
const { items, hasNextPage, fetchNextPage } = useInfiniteList(params);

await create({ data, organizationId }, { onSuccess: (item) => navigate(...) });
```

- All mutations are optimistic with automatic rollback on error.
- Cache keys auto-scope by `organizationId` when present.
- **List → detail handoff:** when a parent `useList` has the entity in cache,
  `useDetail` reads it via TanStack's `placeholderData` factory — instant
  preview, but the real detail GET still fires (rich payload swap, no
  cache pollution). Use `isPlaceholderData` to dim the preview while it
  resolves. See [CHANGELOG 0.7](./CHANGELOG.md#070) for why this replaced
  the old setQueryData-based prefill.
- **Detail → list pseudo-normalization:** after a `useDetail` GET resolves,
  arc-next shallow-merges the fresh fields into every list cache holding
  this id. The list view stays in sync without a refetch. Direction is
  one-way (detail → list, never the reverse) — see
  [CHANGELOG → "pseudo-normalization"](./CHANGELOG.md#070) for the
  rationale. For true entity-level normalization (one copy per id, field-
  level invalidation), use Apollo Client or Relay; arc-next stays in the
  REST + React Query niche.

`useList(token, params, options)` (legacy 3-arg form) still compiles —
both signatures are kept stable across the 0.x line.

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

The `useAction` hook (returned from `createCrudHooks`) wraps `api.dispatchAction()` with toast + invalidation. For custom GETs, compose `api.invokeRoute()` with `useApiQuery` — the response IS the data (no envelope since arc 2.13):

```ts
const { data } = useApiQuery({
  queryKey: ["todos", "stats"],
  queryFn: ({ signal }) => api.invokeRoute({ path: "/stats", options: { signal } }),
  freshness: "frequent",
});
```

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

## SSR Prefetch (Next.js App Router / Server Components)

`createCrudPrefetcher` plus `getQueryClient` give you the canonical TanStack Query × Next.js App Router pattern: per-request `QueryClient` on the server, prefetch on the route, hydrate into a `"use client"` child via `HydrationBoundary`.

```tsx
// app/products/page.tsx — Server Component (no "use client")
import { createCrudPrefetcher, dehydrate, HydrationBoundary } from "@classytic/arc-next/prefetch";
import { getQueryClient } from "@classytic/arc-next/query-client";
import { productsApi } from "@/api/products-api";
import { ProductsList } from "./products-list"; // "use client"

const prefetcher = createCrudPrefetcher(productsApi, "products");

export default async function ProductsPage() {
  const queryClient = getQueryClient();              // per-request on server
  await prefetcher.prefetchList(queryClient, { limit: 20 }, { token, organizationId });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ProductsList />
    </HydrationBoundary>
  );
}
```

Methods: `prefetchList`, `prefetchDetail`, `prefetchBySlug`, `prefetchDeleted`, `prefetchTree`, `prefetchInfiniteList`.

> `prefetchInfiniteList` seeds the `{ pages, pageParams }` cache shape `useInfiniteQuery` expects — a flat `prefetchQuery` won't match and the hook would re-fetch from scratch.

### Streaming with promise-pending dehydration (TanStack Query 5.40+)

`getQueryClient()` ships a default `dehydrate.shouldDehydrateQuery` that includes pending queries, so you can fire-and-forget prefetches inside Suspense boundaries:

```tsx
export default function ProductsPage() {
  const queryClient = getQueryClient();
  // No await — prefetch streams to client when ready
  prefetcher.prefetchList(queryClient, { limit: 20 });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <Suspense fallback={<ListSkeleton />}>
        <ProductsList />
      </Suspense>
    </HydrationBoundary>
  );
}
```

### Server-safe utilities

Pure helpers (`createQueryKeys`, `extractItem`, `updateListCache`, etc.) live in `@classytic/arc-next/cache` — no `"use client"` directive, so they're safe to import from Server Components for custom prefetch flows. The matching React hooks live in `/query`.

### Next.js 16 `cacheComponents` + `'use cache'`

TanStack Query manages a client-side cache; data fetched through arc-next hooks should NOT be wrapped in a Server Component's `'use cache'` directive (which would bake the hook output into the static render). Use `'use cache'` for non-arc Server Component fetches (e.g., direct DB queries, third-party APIs). The two layers compose cleanly because they target different cache tiers.

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

## Optimistic Updates — the guarantees (0.12+)

`useActions()` mutations uphold, in order:

1. **Cancel-before-write** — in-flight refetches for affected keys are cancelled before the snapshot, so a late response can't be captured as "previous" state.
2. **Every affected cache** — detail (bare + org-scoped + parameterized), flat lists, **infinite lists** (per-page; a create inserts into the first page only), while aggregation caches are never optimistically mutated (refetch-only).
3. **Exact rollback** — on failure every touched entry is restored to its snapshot; untouched entries are never rewritten.
4. **Temp-ID reconciliation** — `create` inserts a `_optimistic` placeholder with a `temp-…` id, then swaps it in place for the server document on success (and seeds `KEYS.detail(realId)`), so the row never flickers and the real id is immediately navigable.
5. **Per-record ordering** — sequential `update`/`remove`/`restore` calls to the same record are chained (call order = server order); different records stay parallel.
6. **Last-standing invalidation** — rapid sequential writes trigger ONE settled refetch (from the last pending write), so an early write's refetch can never overwrite a later write's optimistic state.
7. **Bulk partial success** — `bulkUpdate`/`bulkRemove` reporting zero changes skip invalidation entirely; `bulkCreate` seeds detail caches from the returned documents.

## Errors

```ts
import { isArcApiError, isAbortError, isArcErrorCode } from "@classytic/arc-next/client";

try { await api.create({ data, options: { signal } }); }
catch (err) {
  if (isAbortError(err)) return;       // user navigated away — silence
  if (isArcApiError(err)) {
    err.status;       // 422
    err.fieldErrors;  // { email: "already taken" } | null
    err.endpoint;     // '/api/products'
  }
  if (isArcErrorCode(err, 'DUPLICATE_KEY')) showRetryUI();
  if (isArcErrorCode(err, 'ORG_CONTEXT_REQUIRED')) promptOrgSelector();
}
```

`fieldErrors` reads three shapes: `{ errors: { field: msg } }`, `{ details: { errors: [{ field, message }] } }`, raw AJV `{ instancePath, message }`.

`KNOWN_TOP_LEVEL_CODES` and `KNOWN_DETAILS_CODES` are exported as `as const` arrays — useful for runtime iteration (i18n lookup, retry whitelist, code-mapped UI):

```ts
import { KNOWN_TOP_LEVEL_CODES } from "@classytic/arc-next/client";

const ERROR_MESSAGES = Object.fromEntries(
  KNOWN_TOP_LEVEL_CODES.map((code) => [code, t(`error.${code}`)])
);
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

## Cache & Keys

```ts
KEYS.detail(id);                        // ["products", "detail", id]
KEYS.scopedDetail(id, orgId);           // tenant-scoped variant

// Writes/reads the raw doc — no `{ data: TDoc }` envelope (0.7+). Matches
// what useDetail, prefetchDetail, and useNavigation all produce.
cache.setDetail(qc, id, data);
cache.getDetail(qc, id);                // TDoc | undefined
cache.invalidateDetail(qc, id);         // matches all scoped variants
cache.invalidateLists(qc);
```

## Custom Mutations

```ts
import { useMutationWithTransition } from "@classytic/arc-next/mutation";

const { mutateAsync: publish, isPending } = useMutationWithTransition({
  mutationFn: (id: string) => api.request("POST", `${api.baseUrl}/${id}/publish`),
  invalidateQueries: [productKeys.all],
  messages: { success: "Published!" },
});
```

`useMutationWithOptimistic` adds optimistic cache updates with rollback.

## Auth Modes

| Mode | When | Notes |
|---|---|---|
| `bearer` (default) | JWT / opaque token | `getToken()` returns the token |
| `cookie` | Better Auth, session cookies | No token needed; `credentials: 'include'` automatic |
| `header` | API keys (`x-api-key`, etc.) | Set `headerName` on `configureAuth` or `createClient` |

## License

MIT


## Trademark

The code is MIT-licensed. **"Classytic", "arc", and the logos are trademarks of
Classytic LLC** and are **not** licensed under MIT — see [TRADEMARK.md](TRADEMARK.md).
Forks must be renamed; the license covers the code, not the brand.
