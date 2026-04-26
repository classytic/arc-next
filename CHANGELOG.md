# Changelog

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
