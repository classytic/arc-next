# @classytic/arc-next

React + TanStack Query SDK for the Arc backend framework. Companion to `@classytic/arc` (Fastify) and `@classytic/mongokit` (MongoDB).

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build with tsdown (ESM, .d.ts, no sourcemaps) |
| `npm run dev` | Watch mode |
| `npm test` | Run vitest (348 tests) |
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
