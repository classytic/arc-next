# @classytic/arc-next — Agent Development Guide

User-facing API docs live in [README.md](README.md). This file is for agents working on this package.

## Invoke the right skill for the work

| When working on... | Run |
|---|---|
| `useQuery` / `useMutation` / cache keys / invalidation | `/tanstack-query-best-practices` |
| New hooks, `use()`, Actions, `useTransition`, refs, server components | `/react-19` |
| `useMemo` / `useCallback` / re-render audits / list virtualization | `/react-performance-optimization` |
| Writing or refactoring vitest hook tests in `tests/` | `/react-testing-library` |
| TS generics, `Pick`/`Omit` discipline, type drift | `/typescript-best-practices` |
| Reviewing your own diff before commit | `/simplify` |
| Don't know what skill fits | `/find-skills` |

Always pull the relevant skill into context **before** writing code — these encode rules (`qk-array-structure`, `cache-invalidation`, `perf-select-transform`, etc.) that the project relies on.

## Project conventions (must follow)

- **No barrels.** Every file in `src/` is its own subpath export in `package.json`. Don't add an `index.ts`.
- **`sideEffects: false`.** Don't add side-effectful imports.
- **`"use client"` matters.** Client-only files: `query.ts`, `mutation.ts`, `hooks.ts`, `sse.ts`, `ws.ts`. Server-safe: `client.ts`, `api.ts`, `cache.ts`, `query-client.ts`, `prefetch.ts`, `presets/*.ts`. **Don't import client-only modules from server-safe ones** — Server Components see `"use client"` exports as client references and can't call them. If you find yourself wanting to call a pure utility from `prefetch.ts`, move it to `cache.ts` (no directive).
- **`configure*` are module singletons.** Setting them on the server leaks state across SSR requests. They warn on `typeof window === "undefined"` — preserve that.
- **`getToken` is sync-only.** Promise/thenable returns are dropped + warned via `readToken()`. Don't widen the type to `Promise<string | null>`.
- **`CrudApi` = `Pick<BaseApi, core>` ∪ `Partial<XxxMethods>` for each preset.** Never duplicate interfaces. When you add a CRUD-level method to `BaseApi`, add it to the `Pick` list in `hooks.ts`. When you add a method to a preset, add it to that preset's `XxxMethods` interface — the intersection in `hooks.ts` already pulls it through.
- **Preset wrappers use only the public BaseApi surface.** They mutate `api` via `Object.assign` and call back into `api.request()` for transport. Do NOT add private accessors for presets — keep `api.request()` as the only extension primitive so presets stay implementable from outside the package.
- **Preset methods MUST be `async`.** Throws inside object-literal methods are synchronous, but tests + callers expect Promise rejections. Always `async fnName(...)` in the `withXxx()` factory.
- **Strict envelope detector.** `useApiQuery` and `extractItem` require BOTH `success` AND `data` keys to unwrap. Don't loosen — chart payloads use `{ data, labels }` and must NOT be unwrapped.
- **No `search()` / `findBy()` methods.** Both are gone — they hit the same `GET /` as `getAll()`. Pass operators directly: `getAll({ params: { 'title[contains]': q, 'priority[gte]': 5 } })`. `prepareParams` recognizes any bracket-keyed array and keeps it comma-joined (no double `[in]` rewriting). DON'T add `findBy` / `search` back even as a sugar method — the API surface should match arc backend routes 1:1.
- **Permissive list detector.** `extractItems` / `updateListCache` check well-known keys (`docs`, `data`, `items`, `results`) then fall back to *any top-level array*. Keep this asymmetry — it's intentional.
- **Detail keys are unscoped.** `[entity, "detail", id]` because `_id` is globally unique. Use `KEYS.scopedDetail(id, orgId)` only when IDs aren't.
- **All headers conditional.** `Authorization` only when token truthy, `x-organization-id` only when orgId truthy.
- **SSE listens on both channels.** `useEventStream` subscribes via `addEventListener(<type>)` AND keeps `onmessage` — Arc's `ssePlugin` writes named frames; legacy paths still write JSON to `message`.
- **WS subscriptions persist across reconnects.** `useWebSocket` keeps an internal `Set<string>` of resource subscriptions; on every (re)open it replays `{type:'subscribe', resource}` frames. Don't bypass this — always go through `subscribe()` / `unsubscribe()` instead of raw `send()`.
- **`buildWsUrl` rewrites protocol.** `http(s)://` → `ws(s)://`. Make sure `configureClient.baseUrl` is set BEFORE building.
- **`useNavigation` captures router at factory time.** Call `configureNavigation(useRouter)` BEFORE `createCrudHooks()`, not after.
- **`upload.ts` is XHR, not fetch.** It's a separate transport for cross-browser progress events. **`ClientConfig.retry`, `beforeRequest`, and `afterResponse` do NOT propagate to uploads** — that's documented behavior, not a bug. Auth headers, `ArcApiError` parsing, `x-arc-scope`, `Idempotency-Key`, and `Accept-Version` all carry over. If you change interceptor behavior in `executeRequest`, do NOT also bridge it into `upload.ts` — uploads should stay isolated. Per-upload trace headers go through the `headers` option.

## Layout

```
src/
  client.ts       transport singletons + ArcApiError + createAuthAwareClient
  api.ts          BaseApi class + createCrudApi (CRUD + action + invokeRoute + upload only)
  query.ts        useListQuery, useDetailQuery, useInfiniteListQuery, useApiQuery
  mutation.ts     useMutationWithTransition, useMutationWithOptimistic, configureToast
  hooks.ts        createCrudHooks (composition layer)
  query-client.ts getQueryClient (SSR singleton)
  cache.ts        createQueryKeys, createCacheUtils, extractItem, getItemId, updateListCache, QUERY_CONFIGS — server-safe (no "use client")
  prefetch.ts     createCrudPrefetcher, dehydrate, HydrationBoundary, prefetchInfiniteList
  sse.ts          useEventStream, buildSseUrl, subscribeToEvents
  ws.ts           useWebSocket, buildWsUrl, connectWs (subscribe-replay across reconnects)
  presets/
    soft-delete.ts  withSoftDelete  → getDeleted, restore
    bulk.ts         withBulk        → bulkCreate, bulkUpdate, bulkDelete
    slug.ts         withSlugLookup  → getBySlug
    tree.ts         withTree        → getTree, getChildren
    search.ts       withSearchPreset → searchEngine, searchSimilar, embed
tests/            Co-located vitest (1:1 with src files; tests/presets/ mirrors src/presets/)
```

Real-backend integration tests: [`../arc-next-test-api/tests/`](../arc-next-test-api/tests/). Test-api consumes this package via `file:../arc-next` — `npm run build` here makes new exports available there immediately.

## Commands

`package.json` has the canonical list. Most-used while developing:

```bash
npm test                # full vitest suite
npx vitest run tests/X  # single file
npm run typecheck       # tsc --noEmit (strict)
npm run prepublishOnly  # gate: typecheck + test + build
```

## Adding a feature — checklist

1. Pull the relevant skill (table above).
2. Pick the right file — don't create a new top-level module unless it earns its own subpath export.
3. If it's a hook, decide SSR boundary; if it touches singletons, mind the SSR-warn pattern.
4. Add tests in `tests/<same-file>.test.ts(x)` first — vitest uses jsdom + @testing-library/react.
5. If it's user-touchable, add an integration test in `arc-next-test-api/tests/`.
6. Update [README.md](README.md) only if the public API changed.
7. Run `npm run prepublishOnly` before committing.

## Build

tsdown with `unbundle: true` preserves file structure. `tsconfig.noEmit: true` — tsdown owns all output config. No sourcemaps in dist.
