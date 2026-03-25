# Changelog

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
