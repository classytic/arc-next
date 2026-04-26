# @classytic/arc-next

React + TanStack Query SDK for the Arc backend framework. Typed CRUD hooks, optimistic updates with rollback, multi-tenant cache scoping, pagination normalization, real-time SSE.

**Peers:** React 19+, TanStack React Query 5+

```bash
npm install @classytic/arc-next
```

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
const { items, pagination, isLoading, refetch } = useList(token, params, options);
const { item, isLoading } = useDetail(id, token, options);
const { create, update, remove, isMutating } = useActions();
const { items, hasNextPage, fetchNextPage } = useInfiniteList(token, params);

await create({ data, organizationId }, { onSuccess: (item) => navigate(...) });
```

All mutations are optimistic with automatic rollback on error. Lists prefill the detail cache. Cache keys auto-scope by `organizationId` when present.

### `useApiQuery` — non-CRUD reads

For reports, aggregates, RPC-style endpoints. Auto-unwraps `{ success, data }`:

```ts
import { useApiQuery } from "@classytic/arc-next/query";

const { data, isLoading } = useApiQuery<ApiResponse<DashboardStats>>({
  queryKey: ["dashboard", "stats"],
  queryFn: ({ signal }) => api.request("GET", "/dashboard/stats", { options: { signal } }),
  freshness: "realtime",  // 'realtime' | 'frequent' | 'stable' | 'static'
});
```

Pass a custom `select` to override auto-unwrap.

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
const recent = await api.invokeRoute<PaginatedResponse<Todo>>({
  method: "GET",
  path: "/recent",
  params: { limit: 5 },
});
```

The `useAction` hook (returned from `createCrudHooks`) wraps `api.dispatchAction()` with toast + invalidation. For custom GETs, compose `api.invokeRoute()` with `useApiQuery` — it auto-unwraps the `{ success, data }` envelope:

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
  retry: {
    attempts: 3,                       // 1 initial + 2 retries; default off
    backoff: 'exponential',            // 'exponential' | 'linear' | (attempt) => ms
    // retryOn: [502, 503, 504],       // optional whitelist; default = network failures + 5xx, never 4xx, never AbortError
  },
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

## Cache & Keys

```ts
KEYS.detail(id);                        // ["products", "detail", id]
KEYS.scopedDetail(id, orgId);           // tenant-scoped variant

cache.setDetail(qc, id, data);
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
