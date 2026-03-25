# @classytic/arc-next

React + TanStack Query SDK for the Arc backend framework. Companion to `@classytic/arc` (Fastify) and `@classytic/mongokit` (MongoDB).

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build with tsdown (ESM, .d.ts, no sourcemaps) |
| `npm run dev` | Watch mode |
| `npm test` | Run vitest (366 tests) |
| `npm run test:watch` | Watch mode tests |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run prepublishOnly` | Full gate: typecheck + test + build |
| `npm pack --dry-run` | Preview tarball contents |

## Architecture

```
src/
  client.ts       — Transport: configureClient, configureAuth, createClient, fetch wrapper
  api.ts          — REST: BaseApi class, createCrudApi factory, response types
  query.ts        — TanStack hooks: useListQuery, useDetailQuery, useInfiniteListQuery, cache utils
  mutation.ts     — TanStack mutations: useMutationWithTransition, useOptimisticMutation, toast
  hooks.ts        — Composition: createCrudHooks factory (wires api + query + mutation)
  query-client.ts — SSR singleton: getQueryClient (isServer → new, browser → singleton)
  prefetch.ts     — Server Components: createCrudPrefetcher, dehydrate re-export

tests/            — Co-located vitest tests (1:1 with src modules)
```

**No barrels.** Each file is its own entry point via `package.json` exports. Tree-shakeable (`sideEffects: false`).

### SSR boundary

| File | `"use client"` | Why |
|------|:-:|---|
| `client.ts` | No | Used server-side by prefetch and handleApiRequest |
| `api.ts` | No | REST class, used server-side for prefetching |
| `query-client.ts` | No | SSR-safe factory uses `isServer` from TanStack |
| `prefetch.ts` | No | Runs in React Server Components |
| `query.ts` | Yes | React hooks (useQuery, useEffect, useMemo) |
| `mutation.ts` | Yes | React hooks (useMutation, useTransition) |
| `hooks.ts` | Yes | React hooks (composition layer) |

## Key patterns

### Response extraction is flexible
`extractItems` checks well-known keys (`docs`, `data`, `items`, `results`) then falls back to **any top-level array**. So `{ products: [...] }` works without config. Same for `updateListCache` and `extractItem`.

### Credentials derived from authMode
`credentials` is NOT hardcoded. Bearer mode → `'same-origin'`, cookie mode → `'include'`. Explicit `credentials` field overrides both.

### Module-level singletons (configure* functions)
`configureClient`, `configureAuth`, `configureToast`, `configureNavigation` set module-level state. They must only be called client-side. Calling on the server risks leaking state between SSR requests.

### useNavigation resolves router at factory time
The router hook is captured when `createCrudHooks()` is called, not per-render. Call `configureNavigation(useRouter)` BEFORE `createCrudHooks()`.

### useUpload defers missing-method error
If `api.upload` is undefined, the error is thrown at mutation call time (Promise rejection), not during render. This avoids React render-time crashes.

### Polling options are symmetric
All three query types (`ListQueryOptions`, `DetailQueryOptions`, `InfiniteListQueryOptions`) support the same polling fields: `refetchInterval`, `refetchIntervalInBackground`, `refetchOnWindowFocus`.

### CrudApi is derived from BaseApi via Pick
`CrudApi` is NOT a separate interface — it's `Pick<BaseApi, 'getAll' | 'getById' | ...>`. This means:
- Types auto-sync when BaseApi methods change (no manual duplication)
- `createCrudApi()` result is always assignable to `createCrudHooks()` without casts
- Compile-time tests in `tests/hooks.test.tsx` guard against type drift
- Generic defaults (`TCreate = Partial<T>`, `TUpdate = Partial<T>`) match `CrudHooksConfig`

### useActions extracts entity from ApiResponse
`create()` and `update()` use `extractItem()` to unwrap `{ success, data: T }` → `T`. Callbacks (`onSuccess`, `onSettled`) also receive the extracted entity, not the raw response.

### defaultParams merge into request methods
`config.defaultParams` (set in `createCrudApi`) are merged into `getAll`, `search`, and `findBy` before `prepareParams`. Explicit params override defaults.

### Multi-client auth mode resolved lazily
`resolveAuthMode()` reads `client?.config?.authMode` falling back to global `getAuthMode()`. It's a function (not captured at factory time) so global config changes take effect immediately.

### Detail cache keys are simple — no tenant scoping
`[entity, "detail", id]` — because `_id` is globally unique. Backend enforces tenant isolation (Arc's `multiTenantPreset`, permissions). The frontend doesn't hardcode any tenant field name.

### All headers are conditional
`x-organization-id` only sent when `organizationId` is truthy. `Authorization` only when `token` is truthy. With session cookie auth, no headers need to be sent — the backend reads context from the cookie.

## Arc backend compatibility

The library handles all response shapes from `@classytic/arc`:

- `BaseController.list` — offset (`docs[]`, `total`, `pages`), keyset (`docs[]`, `hasMore`, `next`), aggregate
- `BaseController.get/create/update` — `{ success, data: TDoc }`
- `BaseController.delete` — `{ success, data: { message, id, soft } }`
- `createActionRouter` — `{ success, data: any }` (primitives and objects)
- Additional routes — any shape via fallback array detection + `select` transform

## Testing

Tests use vitest + jsdom + @testing-library/react. Module-level singletons require `vi.resetModules()` for isolation (see `query-client.test.ts`).

Run a single test file: `npx vitest run tests/hooks.test.tsx`

## Build

tsdown with `unbundle: true` preserves file structure. Output: 14 files (7 `.js` + 7 `.d.ts`), ~46KB JS total. No sourcemaps in dist — `dts: { sourcemap: false }` in tsdown config. The tsconfig `noEmit: true` means `declaration`/`sourceMap`/`declarationMap` are NOT set there — tsdown fully owns output config.
