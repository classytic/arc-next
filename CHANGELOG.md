# Changelog

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
