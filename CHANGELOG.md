# Changelog

## 0.10.0

### Fixed — SSR hydration: `organizationId: null` no longer splits the cache

TanStack's `hashKey` keeps `null` values in the hash but drops `undefined`.
Hooks that resolved `organizationId: null` (unauthenticated / public storefront
callers) produced a DIFFERENT cache key from server prefetchers that omitted the
field entirely — silently defeating SSR hydration and causing a full client
refetch on every page load.

New `withOrgParams(organizationId, params)` helper (`cache.ts`) normalises the
key: when `organizationId` is nullish the field is OMITTED from the params
object rather than included as `null`. Applied across every read hook — `useList`,
`useInfiniteList`, `useDetail`, `useTree`, `useChildren`, `useBySlug`,
`useDeleted` — so hook keys and server-prefetch keys now match by construction.
Covered by `tests/key-parity.test.ts`.

### Added — `CrudHooksConfig.defaultPublic`

Declare a resource's read endpoints as public (`allowPublic` on the arc server)
once at hook-factory time instead of per call-site. When `defaultPublic: true`,
token-less reads are enabled by default — callers on unauthenticated pages (public
storefront product listings, category pages, brand pages) never need to remember
`{ public: true }` on every `useList`/`useDetail`. An explicit per-call `public`
or `enabled` still wins. Auth-gated resources (cart, orders, account) are
unaffected — `defaultPublic` is opt-in and defaults to `false`.

### Added — `@classytic/arc-next/query-options` subpath

Server-safe **queryOptions factory** following the TanStack v5 query-factory
convention. `createEntityQueries(api, entityKey)` returns `{ list, detail,
infiniteList, tree, children, bySlug }` helpers — each produces a
`{ queryKey, queryFn }` pair usable anywhere TanStack accepts options objects:

```ts
const products = createEntityQueries(productApi, 'products');

useQuery(products.list({ limit: 20 }))
useSuspenseQuery(products.detail('p1'))
queryClient.prefetchQuery(products.list({}, { token }))   // RSC prefetch
queryClient.ensureQueryData(products.detail('p1'))        // router loader
queryClient.setQueryData(products.detail('p1').queryKey, next)
```

Keys are built from the same primitives as `createCrudHooks` (`createQueryKeys`
+ `withOrgParams`), so a factory-seeded server cache always hydrates the
corresponding client hook — enforced by `tests/key-parity.test.ts`.

### Added — `@classytic/arc-next/field-encryption` subpath

Client-side decryption for arc's field-mode application-layer encryption
(`@classytic/arc/encryption` with `mode: 'fields'`). Field-mode responses stay
`application/json`; only the configured field values arrive as authenticated
`arc.v1.<kid>.<iv>.<ct>.<tag>` envelopes (AES-256-GCM). This subpath parses
and decrypts those envelopes via **Web Crypto** — zero dependencies, works in
Node 22+, Bun, Deno, and React Native.

**SECURITY — trusted runtimes only.** Field mode is symmetric: whoever holds
the key can decrypt every envelope ever produced. The key belongs in a Node BFF
or Server Component. This subpath must **never** be imported in a browser bundle.
For payloads a browser must decrypt, use `@classytic/arc-next/encryption` (JWE
asymmetric path). Fail-closed: unknown `kid`, tampered ciphertext, or a malformed
token throws — an encrypted field is never silently passed through.

## 0.9.1

### Fixed — `getTree` no longer paginates the hierarchy

The `withTree` preset's `getTree()` merged the API's list `defaultParams`
(`limit`/`page`) into the tree request "for parity with `getChildren`/`getAll`".
That's wrong by contract: a **tree is the full hierarchy, not a paginated list**.
At best it emitted a dead query string (`GET /:resource/tree?limit=10&page=1`);
at worst, a backend that *honours* `limit` on its tree route would silently
**truncate the hierarchy to the first page** — a latent data-loss footgun.

`getTree()` now passes only the caller's explicit `params` (e.g. a `depth` or
filter, if the resource supports one). `getChildren()` is a real paginated level
and is unchanged. **Behaviour change, not a signature change** — callers that
relied on pagination on the tree endpoint (they shouldn't have) must pass those
params explicitly now.

## 0.9.0

### Fixed — presets now COMPOSE (generic-preserving)

Each `withX(api)` previously returned `BaseApi<TDoc> & XMethods`, which widened
the input back to a bare `BaseApi` — so chaining presets, or composing a preset
over a subclass with custom methods, silently dropped every other method **at
the type level**. `withSearchPreset(withBulk(withSlugLookup(withSoftDelete(api))))`
typed as just `BaseApi & SearchPresetMethods`.

All five presets (`withSlugLookup`, `withSoftDelete`, `withBulk`, `withSearchPreset`,
`withTree`) are now generic over the API type:

```ts
export function withSlugLookup<TApi extends AnyBaseApi>(
  api: TApi,
): TApi & SlugLookupMethods<DocOf<TApi>>
```

So presets stack and the resource's own methods survive. New type helpers
exported from `@classytic/arc-next/api`: `AnyBaseApi`, `DocOf`, `CreateOf`,
`UpdateOf`. **Backward-compatible** — a single-preset call returns the same
shape it always did. Locked in by `tests/presets/compose.test.ts` +
`npm run typecheck:tests`.

### Added — first-class Next.js App Router fetch options

`RequestOptions` / `ApiRequestOptions` / `ArcFetchOptions` now accept the
idiomatic `next: { revalidate, tags }` object — passed verbatim as
`fetch(url, { next })` — so a Next host can hand it 1:1 with what they'd give
`fetch`. The flattened `revalidate` / `tags` still work and are merged
(flattened `revalidate` wins; `tags` are unioned). `revalidate` now accepts
`false` (cache indefinitely). `cache` continues to pass through. Locked in by
`tests/next-fetch-options.test.ts`.

## 0.7.1

### Fixed — `createAuthAwareClient()` reads `configureClient()` lazily

Previous revisions snapshotted `getBaseUrl()` / `getAuthMode()` /
`isAutoIdempotency()` at construction time and froze the result. That
bit hard in real apps: `createAuthAwareClient()` typically runs at
module-load (top of `api.ts`), but `configureClient({ baseUrl })` runs
LATER inside a `'use client'` provider's `useState` initializer. The
frozen `baseUrl` was `''` → every request hit a relative URL → 404
cascade against the dev server / Vercel function origin instead of
the API.

Now: per-call `request` reads the latest global config every time.
Token rotation, `baseUrl` set-after-load, `authMode` flipped via
reconfigure — all pick up automatically. The only fields that
snapshot are overrides explicitly passed in (an opt-in "I want a
different transport" signal).

Lock-in: `tests/lazy-baseUrl.test.ts`.

### Changed — query internals follow the same lazy-config rule

`src/query.ts` reaches for the resolved client at call time so query
keys / fetcher functions honour the latest `baseUrl` and auth fields
without relying on the closure captured at hook construction. No public
API change.

## 0.7.0

Fixes a real-world "`useDetail` never fires a GET" bug and the silent disable
of every protected query when the app authenticates via a global API key.
Adopts the canonical TanStack `placeholderData` pattern for list→detail
handoff (no more cache pollution, no more clobber loops). Promotes the
async-`getToken` signal from `console.warn` to a stack-traced `console.error`
so the misuse can't ship to production unnoticed.

### Breaking — cache envelope removed

The detail cache now stores **raw documents** matching arc 2.13+'s wire
shape, not the legacy `{ data: TDoc }` envelope. Every internal write path
converges on the same shape: `useDetail` queryFn, `prefetchDetail`,
`cache.setDetail` / `setScopedDetail`, and `useNavigation` all write `TDoc`.

**You don't need to change anything if you only consume `useDetail().item`,
`useDetailBySlug().item`, or `cache.getDetail()` — those continue to return
the raw doc as before** (the bug was that `useDetail` already returned the
envelope-shaped value via the identity `extractItem`, so consumers were
already coding against `TDoc`-or-`{ data: TDoc }` ambiguity).

You **do** need to update code that reads cache directly via the bare
`queryClient.getQueryData(KEYS.detail(id))` and expected the envelope:

```diff
- const cached = qc.getQueryData(KEYS.detail(id)) as { data: TDoc } | undefined;
- const item = cached?.data;
+ const item = qc.getQueryData<TDoc>(KEYS.detail(id));
```

### Breaking — `useList` no longer prefills the detail cache

The old setQueryData-based prefill ran inside a `useEffect` with an unstable
`detailKeyBuilder` dependency, which (1) blocked the real detail GET from
firing because of the default 5min `staleTime`, (2) wrote a wrong-shape
envelope that didn't match real GET responses, and (3) re-ran on every
list render, silently clobbering successful detail-fetch results with the
stale list payload. The fix is on the read side: `useDetail` /
`useDetailBySlug` now read list cache via `placeholderData`. Consumers see
an instant list-shaped preview, the real detail GET always fires, and the
cache stays clean.

- `ListQueryOptions.prefillDetailCache` is now a no-op (kept for compile-time
  back-compat; safe to remove from caller code).
- `useListQuery` no longer accepts `prefillDetailCache`, `detailKeyBuilder`,
  or `itemIdResolver` — these were the plumbing for the old broken prefill.

### Added — `isPlaceholderData` on `DetailQueryResult`

Use to dim or label the instant preview while the real GET resolves:

```tsx
const { item, isPlaceholderData } = useDetail(id);
return <article aria-busy={isPlaceholderData}>{item?.title}</article>;
```

### Added — `findItemInListCache`

```ts
import { findItemInListCache } from '@classytic/arc-next/query';
```

Exported helper that walks every `[entity, 'list', ...]` cache entry
(including infinite-query `pages` arrays) and returns the first matching
item by id. `useDetail` uses it internally as a `placeholderData` factory;
exported in case you need it for custom hooks.

### Fixed — `hasStaticAuth` now reads global `configureClient` too

Previously only inspected per-client config. An app authenticating via a
global `internalApiKey` or `defaultHeaders` saw every protected query stuck
in a permanently-disabled state. Added `hasGlobalStaticAuth()` to
`@classytic/arc-next/client` and OR'd it into the enable rule.

### Fixed — async `getToken` failure is now loud

`configureAuth({ getToken: async () => ... })` is a misuse — tokens MUST
resolve synchronously. Before 0.7 the dropped Promise produced a single
`console.warn` then silently disabled every authenticated query
(`isLoading: false, item: null` — indistinguishable from a clean empty
state). 0.7 logs a real `Error` instance via `console.error` so dev tools
surface a stack trace pointing at the offending `configureAuth` site.

### Added — 401 → refresh → retry interceptor

Lazy auth recovery wired into the SDK transport. When the backend returns
401 (or 403, with `retryOn403: true`), the optional `onAuthError` handler
fires, refreshes the token via your auth library, and arc-next replays
the request transparently. Default off — apps that don't wire it see
401s surface immediately as before, no behavior change.

```ts
import { configureAuth, createAuthRefreshHandler } from '@classytic/arc-next/client';

configureAuth({
  getToken: () => authClient.getSession().data?.session.token ?? null,
  onAuthError: createAuthRefreshHandler({
    refresh: async () => {
      const { data } = await authClient.getSession({ disableCookieCache: true });
      return data?.session.token ?? null; // null → truly expired; original 401 surfaces
    },
  }),
});
```

**Concurrent dedup.** When N requests hit 401 simultaneously, the handler
fires **once**; every concurrent caller awaits the same refresh promise
and retries with the token it produces. No stampeding the refresh
endpoint under burst auth-expiry. Verified end-to-end against a live JWT
backend with 5 concurrent expired-token requests → 1 refresh call.

**Cross-transport coverage.** Auth recovery fires across every transport
arc-next exposes — concurrent failures across mixed transports collapse
to a single `onAuthError` call (shared dedup):

| Transport | Trigger | Mechanism |
|---|---|---|
| Fetch (CRUD hooks, `arcFetch`, `handleApiRequest`) | 401 / 403 | Outer retry loop in `executeRequest` |
| XHR upload (`uploadWithProgress`) | 401 / 403 | Outer retry loop in `upload.ts` |
| WebSocket | close code `1008` / `3401` / `4001` / `4401` | `ws.onclose` → recovery → reconnect with refreshed token |
| SSE (`subscribeToEvents`) | `EventSource.onerror` | Pre-flight `fetch` probe → recovery → reopen |

Tuning knobs:
- `retryOn403: boolean` — also recover from 403 (default: 401 only)
- `maxAuthRetries: number` — cap per individual request (default: 1)
- `createAuthRefreshHandler({ onRefreshError: 'throw' })` — propagate
  refresh-fn errors instead of skipping back to the original 401

Types: `AuthErrorContext`, `AuthErrorHandler` exported from
`@classytic/arc-next/client`.

### Added — `arcFetch` + `arc.{get,post,patch,delete}` helpers

One-line authenticated fetch for non-hook contexts (event handlers,
service workers, server actions, custom MDX submits) — collapses the
5-concern boilerplate (auth header, org header, content-type, error
throw, JSON parse) into one call. Composes with `onAuthError`, the 5xx
retry loop, and the `beforeRequest`/`afterResponse` interceptors —
nothing has to be rewired.

```ts
import { arc } from '@classytic/arc-next/client';

// Before: 15 lines (manual headers, manual error parse, manual JSON)
// After:
const result = await arc.post<{ ok: boolean }>('/api/statements', statements);
```

Body sniffing handles `FormData`, `Blob`, `ArrayBuffer`,
`URLSearchParams`, `ReadableStream`, and `string` (passed through —
caller-controlled `Content-Type`); plain objects and arrays are
auto-`JSON.stringify`'d with `application/type: application/json`.

Protected headers — `Authorization`, `x-organization-id`,
`x-internal-api-key`, custom `headerName` for header-auth mode — cannot
be overridden by `options.headers`. A caller can't accidentally strip
auth by passing a custom header map.

Escape hatch for the rare full-control case:
```ts
import { arcAuthHeaders } from '@classytic/arc-next/client';
const res = await fetch(url, { headers: { ...arcAuthHeaders(), 'X-Custom': '1' } });
```

### Added — pseudo-normalization via `syncDetailToLists`

After a fresh `useDetail` (or `useDetailBySlug`) GET resolves, arc-next
walks every list cache that contains the item and shallow-merges the
new field values in-place. The list view picks up the latest values
without needing a refetch, and stays consistent with whatever the
detail page just rendered.

```ts
import { syncDetailToLists, createQueryKeys } from '@classytic/arc-next/cache';

// Most consumers never call this directly — it's wired by default into
// `useDetail` / `useDetailBySlug`. Exposed for custom hooks + tests.
// Vocabulary note: `item` matches the rest of arc-next's consumer API
// (`useDetail().item`, `useList().items`, `extractItem`, `getItemId`,
// `findItemInListCache`). The backend-facing `TDoc` generic in
// `BaseApi<TDoc>` / `Repository<TDoc>` is the same entity at the type
// layer — `item` is the runtime noun.
syncDetailToLists(queryClient, KEYS.lists(), freshItem, { idField: 'sku' });
```

**Design notes (load-bearing):**

- **Direction is one-way: detail → list, never the reverse.** List
  payloads are typically a SUBSET of detail (apps trim fields with
  `select=...` for list perf), so a list → detail merge would overwrite
  rich detail-cache values with the trimmed list versions. Mutations
  still propagate from lists to detail via `useActions.update`'s
  existing fan-out — that path is safe because mutation data is
  authoritative.
- **Shallow-merge preserves the receiver's key set.** Detail-only fields
  (populated relations, full body) never bleed into list caches —
  list-cache entries stay LEAN. No memory bloat.
- **Never creates new cache entries.** Only updates entries that already
  exist. (Creating new entries was the 0.6 prefill bug that this entire
  release was originally diagnosing.)
- **Skipped during placeholder render.** When `useDetail` shows a list-
  cache placeholder via `placeholderData`, we don't re-fan-out the
  placeholder back to lists — would be a no-op merge but burns CPU.

**Memory + CPU profile:**

- Memory cost: zero new entries; merge preserves entry sizes.
- CPU cost: O(L × M) per detail fetch, where L = matching list caches
  and M = average items per list. For typical apps (5–10 caches × 50–500
  items), <1ms. For 10k-row admin tables, ~5ms — still well below a frame.
- This is **pseudo-normalization, not the real thing**: copies still exist
  in memory, GC is still per-query. For Apollo/Relay-style entity
  normalization (one copy per entity ID, field-level invalidation, GC
  by reference count), use Apollo Client or Relay. arc-next stays
  opinionated about its niche: REST + React Query with a tiny runtime
  and zero codegen.

### Fixed — `updateListCache` short-circuits on no-op updaters

When an `optimisticUpdate` updater returns the same `items` array
reference (the canonical "I didn't actually change anything" signal),
`updateListCache` now returns the original wrapper unchanged instead of
allocating a fresh outer object. Eliminates spurious `setQueryData`
writes + the re-render cascade they trigger. Required for
`syncDetailToLists` to accurately report "did anything change".

### Fixed — `Authorization` no longer sent in `authMode: 'cookie'`

The fetch path used to add `Authorization: Bearer <token>` even when
`authMode` was `'cookie'` — redundant with the cookie, and tripped
servers (Better Auth's session validator among them) that strictly
enforce one auth mechanism per request. Aligned with `upload.ts` and
`arcAuthHeaders()` which already skipped the header in cookie mode.

### Fixed — WebSocket reconnect cascade

Closing the previous socket inside `connect()` (during a reconnect) fired
its `onclose` handler, which scheduled another reconnect — creating two
sockets per reconnect cycle. The cascade resolved in the browser because
sockets transition `CONNECTING → OPEN` fast enough to win the race, but
was visible on slower networks and in tests. Now nulls `onclose`/`onerror`
/`onmessage`/`onopen` before closing the old socket so the cascade is
structurally impossible.

### Bumped peer — TanStack Query

```diff
- "@tanstack/react-query": ">=5.0.0"
+ "@tanstack/react-query": ">=5.62.0"
```

Anchors `isPlaceholderData` semantics and the lazy `placeholderData`
factory form.

## 0.6.0

Targets Arc 2.12.x. Aligns pagination response shapes with `@classytic/repo-core/pagination` — server (arc 2.12 `fastifyAdapter` via `toCanonicalList()`) and client (arc-next typed responses) now share **one** declaration, eliminating the `method` discriminant drift that bit during the cross-package review.

### Breaking — pagination response types

Removed from `@classytic/arc-next/api`:
- `OffsetPaginationResponse<T>`
- `KeysetPaginationResponse<T>`
- `AggregatePaginationResponse<T>`
- `PaginatedResponse<T>`

These were re-declared in `src/api.ts` with subtle name/field divergence from arc's server-side equivalents. They now live in **`@classytic/repo-core/pagination`** — the same module arc's server emits these envelopes through. Server and client narrow on the same union; the `method` discriminant cannot drift.

#### Migration

```diff
- import type {
-   OffsetPaginationResponse,
-   KeysetPaginationResponse,
-   AggregatePaginationResponse,
-   PaginatedResponse,
- } from '@classytic/arc-next/api';
+ import type {
+   OffsetPaginationResponse,
+   KeysetPaginationResponse,
+   AggregatePaginationResponse,
+   PaginatedResponse,
+ } from '@classytic/repo-core/pagination';
```

Field shapes on the offset / keyset / aggregate branches are unchanged. The repo-core union additionally includes a `BareListResponse<T>` branch (`{ success: true; docs: T[] }`) for endpoints that don't paginate — predicates (`isOffsetPagination`, `isKeysetPagination`, `isAggregatePagination`) still ship from `@classytic/arc-next/api` and handle the new branch via `'method' in response &&` guards.

### Added — `@classytic/repo-core` peer dependency

```jsonc
"peerDependencies": {
  "@classytic/repo-core": ">=0.3.0",
  // ...
}
```

Hosts must install `@classytic/repo-core` alongside arc-next. (npm 7+ auto-installs peer deps; explicit on older clients.) Same model as `react` / `@tanstack/react-query`.

### Why the alignment matters

Before 0.6.0 / arc 2.12.0, three pagination-shape layers drifted across the org: arc-next's local response types, arc's inline server flatten (which silently dropped the `method` field), and mongokit's local result types. Repo-core 0.3.0 ships the canonical types and a `toCanonicalList()` runtime normaliser that arc's `fastifyAdapter` now routes every paginated response through — server and client narrow on the matching union by construction.

## 0.5.0

Targets Arc 2.11.x. Closes the surface gaps for the action router, search preset, and mongokit-style geo queries.

### New Features

- **Geo + range operators in `FilterOperator`** — `near`, `nearSphere`, `geoWithin`, `withinRadius`, `between`. Coordinate-list values (`[lng, lat, maxDistanceMeters]`, `[minLng, minLat, maxLng, maxLat]`, `[from, to]`) round-trip through `prepareParams` / `findBy` as comma-joined strings instead of being rewritten to `[in]`. Matches mongokit's URL grammar and works against any backend that accepts that grammar (mongokit native, sqlitekit-spatialite friendly).
- **`api.dispatchAction({ id, action, data })`** — POSTs to arc's unified action router (`POST /:id/action`) with `{ action, ...data }` body. Server discriminates on `body.action` and applies per-action permissions (arc v2.8+). Named `dispatchAction` (not `action`) so consumer SDKs can keep their own `action()` methods on subclasses without inheritance collisions — `action` is a common verb on state-machine resources.
- **`useAction()` hook** — typed mutation companion to `api.dispatchAction()`. Default-invalidates `lists()` + `details()` + the specific detail key; default action name on factory + per-call override via `mutate({ action })`.
- **`api.searchEngine()` / `api.searchSimilar()` / `api.embed()`** — POST routes mounted by `searchPreset()` (arc v2.9+). Distinct from `api.search()` which is the legacy GET-against-list. Custom `path` overrides supported per-call. Auto-wires from mongokit's `elasticSearchPlugin` / `vectorPlugin` when wired into `searchPreset({ repository })`.
- **`useSearchEngine()` / `useSearchSimilar()` / `useEmbed()` hooks** — mutation companions for the search preset routes.
- **`elevated: true` shorthand** — sends `x-arc-scope: platform` to trigger arc's elevated-scope upgrade (arc v2.9+). Configurable on `ClientConfig` (every request) or per-request via `RequestOptions.elevated` (which can override the client-level setting with `false` to suppress).

### Real-time additions

- **`subscribeToEvents()` plain function** — non-hook SSE client. Works in Node, Bun, tests, and non-React UIs. Returns a stable handle: `{ close, reconnect, isConnected }`. Auto-reconnect with ×1.5 exponential backoff (capped 30s), pattern filtering, named-event subscription via `addEventListener`. The `useEventStream()` hook now delegates to this — same wire behavior, smaller hook.
- **`connectWs()` plain function** — non-hook WebSocket client mirroring `subscribeToEvents()`. Returns `{ send, subscribe, unsubscribe, on, close, reconnect, isConnected }`. The `on(eventType, handler)` API registers per-type listeners alongside the global `onMessage` callback (use `'*'` for wildcard); returns an unsubscribe function. Subscriptions persist across reconnects. The `useWebSocket()` hook delegates to this.
- **`CrudEvent<TDoc>` generic type** — narrowed envelope for arc's `<resource>.<operation>` broadcasts. `CrudEvent<Todo>` types `data: Todo` and `operation: 'created' | 'updated' | 'deleted'`. `ArcServerEvent<TData>` is now generic (was `data: unknown`); `ArcWsMessage<TData>` was already generic. Pass through `subscribeToEvents<CrudEvent<Todo>>(...)` / `connectWs<CrudEvent<Todo>>(...)` for inference.
- **`useResourceSync()` hook on `createCrudHooks`** — turnkey "real-time by default" wiring. `useResourceSync({ source: 'ws' })` (or `'sse'`) subscribes to `<entityKey>` and auto-invalidates `KEYS.lists()` on every CRUD broadcast plus `KEYS.detail(id)` on `updated` / `deleted`. Honors the factory's `idField` so custom-id resources (`'sku'`, `'slug'`) resolve correctly. Optional `onEvent({ operation, id, data })` callback; `enabled: false` to opt out.
- **`getToastHandler()` companion to `configureToast()`** — returns the currently-configured `ToastHandler` (or the console-based default before `configureToast()` is called). Lets domain code outside the react-query lifecycle fire ad-hoc success/error toasts using the same handler the SDK uses internally — consumer SDKs no longer need to keep a parallel cache of the handler.

### Typed arc error codes

- **`ArcApiError.code` + `ArcApiError.detailsCode` getters** — surface arc's response codes from both slots of the wire envelope. `code` reads top-level `json.code` (set by arc's `errorHandlerPlugin` for thrown errors → `BAD_REQUEST` / `VALIDATION_ERROR` / `DUPLICATE_KEY` / etc.). `detailsCode` reads `json.details.code` (the canonical slot for controller-emitted business codes — `ORG_CONTEXT_REQUIRED`, `OWNERSHIP_DENIED`, `MIXED_UPDATE_SHAPE`, `ALL_FIELDS_STRIPPED`, `BEFORE_RESTORE_HOOK_ERROR`). Open-ended `string & {}` types so custom `errorMappers` codes still satisfy the union.
- **`isArcErrorCode(error, code)` predicate** — generic check that matches whichever slot the code lives in. Saves call sites from having to know whether arc emitted the code at the root or under `details`.
- **Specific predicates** — `isOrgContextRequiredError(error)` (the bulk-preset + orgGuard safety code — hosts hitting this need to call `configureAuth({ getOrgId })`), `isValidationError(error)`, `isDuplicateKeyError(error)`. All narrow `unknown → ArcApiError` for fluent guards.

### Upload with real progress events

- **`uploadWithProgress()` plain function** ([`./upload`](./src/upload.ts)) — XHR-based file upload with native `xhr.upload.onprogress` events. Returns a Promise that resolves with the parsed body or rejects with `ArcApiError` on non-2xx (same envelope as the fetch path — `code` / `detailsCode` / `fieldErrors` getters all work). Reuses arc-next's auth pipeline (`getClientAuthContext`), the same `Authorization` / `x-api-key` / cookie-mode `withCredentials` decisions, plus `elevated` / `idempotencyKey` / per-request headers / per-client config. Supports `responseType: 'json' | 'text' | 'blob'`. AbortSignal-driven cancellation, signal `reason` preserved verbatim. Closes the gap left by `useUpload()` (fetch-based, no progress).
- **`useUploadWithProgress()` React hook** — TanStack-Query-flavored mutation companion. Tracks `progress` as React state (every progress tick re-renders), exposes `{ upload, progress, isUploading, isPending, isSuccess, isError, data, error, cancel, reset }`. Auto-invalidates `invalidateQueries` on success, fires `messages.success` / `messages.error` through the configured `getToastHandler()`, supports dynamic `url` / `headers` / `idempotencyKey` / `elevated` callbacks that receive the call's vars. Last-call-wins semantics: starting a new upload while one is in-flight cancels the previous (matches `useMutation` behavior). New `./upload` subpath export.

Why XHR and not fetch+ReadableStream: as of 2026, Safari and Firefox still don't ship the `fetch()` + ReadableStream upload-body combination consumers need. XHR's `upload.onprogress` is universal. The hook surface is identical to what consumers would write on top of axios — no caveats per browser.

### Wire-shape bug fixes

- **`withBulk.bulkCreate()` now sends `{ items: data }` body** — arc's bulk handler (`POST /:resource/bulk`) reads `req.body.items`. Pre-fix, the SDK sent the raw array, which arc rejected with `400 Bulk create requires a non-empty items array` — masking the genuine `403 ORG_CONTEXT_REQUIRED` tenant-scope errors hosts actually need to see. The bulk integration test in `arc-next-test-api/tests/v050-error-codes-integration.test.ts` locks the corrected wire shape.
- **`ArcApiError.message` reads `json.error` first, then `json.message`** — arc's `errorHandlerPlugin` and `IControllerResponse` both emit `{ error: <human msg> }`, but the SDK was only reading `json.message`, falling back to bare `statusText` ("Forbidden", "Bad Request"). Now `message` carries arc's actual message ("Organization context required to bulk-create resources").

### Tests

- 7 new unit tests in `tests/v050.test.ts` covering `code` / `detailsCode` getters, `isArcErrorCode` cross-slot matching, and the four specific predicates.
- 3 new integration tests in `arc-next-test-api/tests/v050-error-codes-integration.test.ts` driving real bulk + 404 calls against arc 2.11.x — locks the controller-path wire convention (codes at `details.code`, not top-level `code`) and verifies `isOrgContextRequiredError(error)` fires on the bulk safety path.
- 31 new unit tests in `tests/upload.test.tsx` covering `uploadWithProgress()` (open/send/headers, progress events, abort with + without reason, ArcApiError on non-2xx, network/timeout failure, auth-mode parity bearer/cookie/header, explicit-token override + null-suppression, elevated, idempotencyKey, custom + Content-Type-stripping headers, absolute-URL passthrough, json/text/blob response types) and `useUploadWithProgress()` (data + isSuccess flow, progress mirror, query invalidation, error capture, cancel(), last-call-wins overlap, reset(), dynamic url/headers/idempotencyKey/elevated functions, toast handler integration).

### Tests

- 26 new unit tests in `tests/v050.test.ts` covering geo operators, action router, search preset, fieldErrors shape compatibility, and the `elevated` header.
- 29 new unit tests in `tests/v050-realtime.test.tsx` covering `subscribeToEvents()`, `connectWs()` (including `.on()` per-type listeners and wildcard catch-all), `useResourceSync()` invalidation behavior across WS + SSE transports, custom-`idField` propagation, and the `CrudEvent<TDoc>` compile-time generic.
- 16 new integration tests in `arc-next-test-api/tests/v050-integration.test.ts` covering action router (`complete` / `archive` / `prioritize`), search preset (`POST /search` regex backend, `searchSimilar` vector stub, `embed` deterministic stub), and live geo queries against a `2dsphere`-indexed `Place` resource (`[near]` distance sort, `[withinRadius]` 4 km radius, `[geoWithin]` bounding box, invalid-coord drop).
- 5 new integration tests in `arc-next-test-api/tests/v050-realtime-integration.test.ts` driving `connectWs()` against a real `websocketPlugin` — subscribe handshake, broadcast on create, `.on(eventType)` listeners + `off()` detach, `'*'` wildcard, `close()` idempotence, `send()` after-OPEN.

### Breaking Bug Fixes

- **`ArcApiError.fieldErrors` reads arc's actual error shape**. Pre-v0.5.0 the getter only read `json.errors` as `Record<string, string>`, but arc's `errorHandler` plugin emits `{ details: { errors: [{ field, message, keyword }] } }` (Fastify AJV pass-through) — so `fieldErrors` was effectively always `null` for real validation failures. v0.5.0 reads three shapes: legacy `{ errors: { field: msg } }` record form, arc's `details.errors[]` array form (`field` / `message`), and raw AJV `instancePath` / `params.missingProperty` form. Behavior change for callers who relied on the always-null result; matches the documented contract.

### Repo-core peer dep — declined

We considered adding `@classytic/repo-core` as a (type-only) peer dep to share `OffsetPaginationResult` / `KeysetPaginationResult` / `HttpError` shapes. We didn't:

- arc-next is a browser SDK; repo-core ships server primitives (hook engine, Filter IR, query parser, cache adapter) that are useless on the frontend.
- The HTTP envelope arc-next consumes is a strict superset of repo-core's pagination shape (adds `success: boolean`). arc-next's `OffsetPaginationResponse` / `KeysetPaginationResponse` / `AggregatePaginationResponse` types stay wire-correct without inheriting from repo-core.
- arc-next's `FilterOperator` union is intentionally larger than repo-core's URL grammar (`near` / `withinRadius` / `geoWithin` are mongokit conventions, not in repo-core). Centralizing on repo-core's grammar would force a regression for mongokit-backed consumers.

## 0.4.1

### Breaking Bug Fixes (from 0.4.0)

- **token optional in all mutation methods** — `create`, `update`, `delete`, `upload`, `request`, `restore`, `bulkCreate/Update/Delete` now default `token = null` (was required, inconsistent with query methods)
- **SSE `reconnect()` resets `manualCloseRef`** — `close()` → `reconnect()` now properly re-enables auto-reconnect on errors
- **Legacy hook signature detection fixed** — `useList(null)` now correctly uses new signature (auto-inject token); legacy requires 3 args: `useList(null, params, options)`
- **Non-JSON error responses capture body** — HTML/text error bodies (502 CDN pages, plain text) now captured in `ArcApiError.json.rawBody` instead of being silently null
- **Blob fallback error context preserved** — response parsing errors no longer silently swallowed
- Restored `BlobResponse` and `TextResponse` types
- Removed deprecated aliases (`createOptimisticMutation`, `createListQuery`, `createDetailQuery`, `createInfiniteListQuery`)

### New Features

- **Per-client auth** — `createClient({ getToken, getOrgId, headerName })` for multi-backend apps with different auth (bearer + API key side by side)
- **`getClientAuthContext(client?)`** — resolve auth for a specific client, falls back to global

## 0.4.0

### Features

- **`authMode: 'header'`** — custom header auth (x-api-key, x-admin-key) with configurable `headerName`
- **`apiVersion`** — sends `Accept-Version` header for Arc versioning plugin
- **`autoIdempotency`** — retry-safe `Idempotency-Key` generation at mutation level
- **`idField`** on `createCrudHooks` — custom ID field for cache keys and optimistic updates
- **`useDeleted`** — list soft-deleted items (softDelete preset)
- **`restore()`** on `useActions` — restore soft-deleted items
- **`useBulkActions`** — `bulkCreate`, `bulkUpdate`, `bulkRemove` (bulk preset)
- **`useDetailBySlug`** — fetch by slug (slugLookup preset)
- **`useTree` / `useChildren`** — hierarchical data (tree preset)
- **`useFindBy`** — query by field with filter operator
- **`useEventStream`** — SSE real-time with auto-reconnect, pattern filtering, query invalidation (`./sse`)
- **`maxPages`** on `useInfiniteList` — page eviction with automatic `getPreviousPageParam`
- **Filter operators** — added `like`, `exists`, `size`, `type`
- **Lookup params** — `QueryParams.lookup` for database-agnostic joins
- **SSR prefetch** — `prefetchBySlug`, `prefetchDeleted`, `prefetchTree`
- **Biome + Knip config** — linting and dead code detection

### Improvements

- `QUERY_CONFIGS` moved from mutation.ts to query.ts (re-exported for compat)
- SSR safety warnings on `configureClient`/`configureAuth` server calls
- Preset hooks never throw before React hooks (safe conditional rendering)
- `prefetch.ts` uses shared `createQueryKeys` (no duplicate key logic)
- `useBulkActions` reads auth context fresh per mutation (no stale closures)
- SSE uses refs for `patterns`/`invalidateQueries` (no reconnect storm)
- Removed dead `BlobResponse`/`TextResponse` types and unused `headers` SSE option
- `./package.json` subpath export added

### Dependencies

- Peer deps: `>=5.0.0` TanStack Query, `>=19.0.0` React
- TypeScript 6.0.2, tsdown 0.21.7, vitest 4.1.4, react 19.2.5

## 0.3.1

### Bug Fixes

- **hooks (HIGH)**: `useActions().create()` and `update()` now return the extracted entity `T`, not the raw `ApiResponse<T>`. Previously `{ success, data: T }` was cast to `T` — lying to consumers. Now uses `extractItem()` to unwrap. Factory-level `onSuccess`/`onSettled` callbacks also receive the extracted entity.
- **hooks (TYPE)**: `CrudApi` type changed from manual interface to `Pick<BaseApi, ...>` — types derived from source of truth. **Fixes compile error** where `createCrudApi()` result was not assignable to `CrudApi` (TypeScript contravariance on `Record<string, unknown>` params).
- **hooks (TYPE)**: `CrudApi` generic defaults aligned with `CrudHooksConfig` — both default `TCreate`/`TUpdate` to `Partial<T>`. Previously `CrudApi` defaulted to `unknown`.
- **api (MEDIUM)**: `defaultParams` are now merged into `getAll`, `search`, and `findBy` requests. Previously `config.defaultParams` was stored but never applied — consumers relying on `defaultParams: { limit: 25 }` got wrong queries.
- **hooks (MEDIUM)**: Multi-client `authMode` now respected. `createEnabledRule` reads auth mode lazily from `client?.config?.authMode` falling back to global `getAuthMode()`. Previously a secondary cookie-mode client would have queries disabled because the hook only checked the global bearer mode.
- **prefetch (MEDIUM)**: `prefetchDetail` now accepts `params` option (`select`, `populate`) and uses extended query key `[entity, "detail", id, params]` matching `useDetail`'s key shape. Previously only prefetched bare `[entity, "detail", id]` — hydration missed for parameterized detail queries.
- **query**: `extractItem` exported for use in hooks (was private).
- **hooks**: `useInfiniteList` pageParam cast from `unknown` to `number` — surfaced by stricter types.

### Design Decisions

- **Detail keys NOT tenant-scoped**: `_id` is globally unique in MongoDB. Backend enforces tenant isolation via middleware (`orgScoped`, permissions). Frontend cache uses simple `[entity, "detail", id]` — no `organizationId` in the key. This avoids hardcoding a specific tenant field name (`organizationId` vs `workspaceId` vs `teamId`) and keeps the cache API simple.
- **Auth mode resolved lazily**: `resolveAuthMode()` is a function (not captured at factory time) so global `configureClient({ authMode })` changes take effect immediately, while per-client overrides still work.

### Tests

- 366 tests (up from 348):
  - `create()`/`update()` return extracted entity, not raw ApiResponse (3 tests)
  - Detail keys use simple `[entity, "detail", id]` (2 tests)
  - `defaultParams` merge into `getAll`/`search`/`findBy` (4 tests)
  - Multi-client cookie auth mode enables queries (1 test)
  - `prefetchDetail` with `params` (2 tests)
  - Type-compatibility compile-time guards (5 tests)

## 0.3.0 (unpublished — superseded by 0.3.1)

### Breaking Changes

- **client**: `credentials` is no longer hardcoded to `'include'`. Bearer auth (default) now uses `'same-origin'`. Cookie auth uses `'include'`. Explicit `credentials` field added to `ClientConfig` for full control.

### Features

- **client**: Added `credentials` option to `configureClient()` and `createClient()` — supports `'include'`, `'same-origin'`, `'omit'`
- **query**: `normalizePagination` now handles keyset pagination responses (`hasMore`, `next` cursor) — previously returned `null` for keyset responses
- **query**: `PaginationData` now includes `method` field (`'offset' | 'keyset' | 'aggregate' | null`) and `next` cursor
- **query**: `extractItems` falls back to first top-level array when well-known keys not found — `{ products: [...] }`, `{ users: [...] }` now work without configuration
- **query**: `extractItem` accepts primitive `data` values (strings, numbers) — action route responses now extracted correctly
- **query**: `updateListCache` uses same flexible key detection — optimistic updates work on custom response shapes
- **hooks**: `DetailQueryOptions` now supports `refetchOnWindowFocus`
- **hooks**: `InfiniteListQueryOptions` now supports `refetchInterval` and `refetchIntervalInBackground`
- **hooks**: `useDetail` forwards `refetchOnWindowFocus` to TanStack Query
- **hooks**: `useInfiniteList` forwards `refetchInterval` and `refetchIntervalInBackground` to TanStack Query
- **package**: Added root export `"."` in package.json exports — bare `import from '@classytic/arc-next'` now works

### Bug Fixes

- **hooks**: `useNavigation` hook identity stabilized — router hook resolved at factory time instead of per-render, fixing Rules of Hooks violation risk
- **hooks**: `useUpload` no longer throws during render when `api.upload` is undefined — error deferred to mutation call time
- **hooks**: `useSearch` now picks up `params.token` for consistency with other hooks
- **query-client**: `getQueryClient()` warns when overrides are passed to subsequent calls (browser singleton ignores them)
- **mutation**: Removed unnecessary backward-compat re-export of `ToastHandler` from mutation module
- **hooks**: Removed unnecessary backward-compat re-export of `UseRouterHook` from hooks module

### Build

- **tsdown**: Replaced deprecated `external` with `deps.neverBundle`
- **tsdown**: Sourcemaps fully disabled — `dts: { sourcemap: false }`, no `.js.map` or `.d.ts.map` in dist
- **tsconfig**: Removed `declaration`, `declarationMap`, `sourceMap` (no-ops with `noEmit: true` — tsdown owns output config)
- **package**: Tarball reduced from 52.8 KB → 25.3 KB (17 files, zero sourcemaps)
- **deps**: TanStack React Query updated from 5.90.21 → 5.95.2

### Documentation

- Added SSR safety warnings to all `configure*()` function JSDoc
- Added `CLAUDE.md` for development context

### Tests

- 348 tests (up from 303) covering:
  - Credentials policy: bearer/cookie/explicit/omit/createClient (6 tests)
  - Query client overrides: applied, ignored+warned, no-warn, singleton (5 tests)
  - Flexible response extraction: custom keys, plain arrays, well-known precedence (5 tests)
  - Arc backend shapes: offset/keyset/aggregate pagination, detail, delete, action (11 tests)
  - Polling config: refetchInterval, refetchOnWindowFocus, refetchIntervalInBackground across useList/useDetail/useInfiniteList (13 tests)
  - QUERY_CONFIGS presets integration with hooks (2 tests)
  - useUpload mutation-time error, useNavigation factory-resolved hook (3 tests)

## 0.2.1

### Bug Fixes (Critical)

- **hooks**: Update mutation now includes detail cache in rollback snapshot — previously, optimistic detail updates were lost on error
- **hooks**: Delete mutation clears detail cache in `onSuccess` instead of optimistic phase — prevents data loss on rollback
- **hooks**: `useNavigation` always calls router hook unconditionally with noop fallback — fixes Rules of Hooks violation when no router configured
- **client**: `AbortError`, `TypeError`, and other native Error subclasses are now preserved through the request handler — previously swallowed by generic `Error` wrapping

### Improvements

- **hooks**: Renamed internal hook functions to follow React naming convention:
  - `createListQuery` → `useListQuery` (deprecated alias kept)
  - `createDetailQuery` → `useDetailQuery` (deprecated alias kept)
  - `createInfiniteListQuery` → `useInfiniteListQuery` (deprecated alias kept)
  - `createOptimisticMutation` → `useOptimisticMutation` (deprecated alias kept)
- **hooks**: `CrudApi` interface generics now thread through return types for better type safety
- **query**: `items` and `pagination` in list queries memoized with `useMemo` — prevents unnecessary `useEffect` runs on every render
- **hooks**: `useActions` wraps `create`/`update`/`remove` in `useCallback` for stable refs

### Build

- Updated tsdown from 0.20.3 to 0.21.4

### Tests

- Added 9 new tests (294 → 303 total) covering:
  - Detail cache rollback on update mutation failure
  - `useNavigation` noop safety when no router configured
  - `useActions` function shape validation
  - Deprecated aliases (`createListQuery` = `useListQuery`, etc.)
  - AbortError/TypeError preservation through request handler
  - Non-Error throw wrapping

## 0.1.3 (unreleased)

### Bug Fixes

- **client**: `BaseApi.config.headers` (e.g., `x-arc-scope: platform`) are now merged into every HTTP request — previously stored but never sent
- **query**: `updateListCache` rewritten to handle all 4 array formats (`docs[]`, `data[]`, `items[]`, `results[]`) plus raw arrays, with correct `total`/`totalDocs` delta tracking

### Tests

- Added 78 new tests across all modules (165 → 243 total)
  - `mutation.test.ts`: 1 → 26 tests (QUERY_CONFIGS, useMutationWithTransition, useMutationWithOptimistic)
  - `client.test.ts`: 34 → 53 tests (response types, error edge cases, getAuthMode, defaultHeaders)
  - `query.test.ts`: 30 → 53 tests (updateListCache edge cases, createQueryKeys, createCacheUtils, getItemId)
  - `hooks.test.tsx`: 42 → 53 tests (cookie auth mode, custom staleTime, useDetail params, useActions silent/invalidation)
  - `prefetch.test.ts`: 6 → 11 tests (token/org handling, cache key alignment, dehydrate)

### Documentation

- README rewritten to match SKILL.md — added configureAuth, cookie auth mode, prefetch subpath, config.headers, multi-client, ArcApiError, QUERY_CONFIGS, SSR Prefetch section

## 0.1.2 (2025-03-01)

### Features

- `configureAuth` — auto-inject token and organizationId into queries/mutations
- Cookie auth mode (`authMode: 'cookie'`) for Better Auth same-origin proxy
- `createCrudPrefetcher` + `dehydrate` for SSR prefetch in server components
- `createClient()` — multi-client support for multiple API backends
- `ArcApiError` class for structured error handling
- `QUERY_CONFIGS` presets — realtime, frequent, stable, static
- `config.headers` on `createCrudApi` for per-instance headers
- `useInfiniteList` hook for cursor-based infinite scrolling

## 1.0.0 (2025-02-24)

### Features

- `createCrudHooks` factory — generates `useList`, `useDetail`, `useActions`, `useInfiniteList`, and `useNavigation` from a single config
- `createCrudApi` — typed CRUD API client with cookie and bearer auth modes
- `configureClient` — global client configuration (baseUrl, authMode, token provider, org context)
- Optimistic updates with automatic rollback on mutation failure
- `getQueryClient` — SSR-safe singleton TanStack Query client
- `QUERY_CONFIGS` presets — realtime, frequent, stable, and static caching strategies
- Multi-tenant support with automatic `organizationId` injection
- Cache utilities — invalidate, set, get, remove per entity
