---
name: arc-next
description: |
  @classytic/arc-next — React + TanStack Query SDK for Arc resources.
  Production-grade CRUD hooks with optimistic updates, multi-tenant scoping, and pluggable configuration.
  Use when building React CRUD UIs, creating API hooks with TanStack Query, implementing optimistic updates,
  paginated lists, list→detail placeholderData handoff, or multi-tenant data fetching.
  Triggers: arc-next, createCrudApi, createCrudHooks, tanstack query hooks, crud hooks, optimistic updates,
  react query factory, api client hooks, pagination normalization, configureClient, configureToast,
  isPlaceholderData, findItemInListCache.
version: "0.7.0"
tags: [react, tanstack-query, crud, api-client, hooks, optimistic-updates]
metadata:
  author: Classytic
---

# @classytic/arc-next

React + TanStack Query SDK for Arc resources. Typed CRUD hooks with optimistic updates, automatic rollback, multi-tenant scoping, pagination normalization, and detail cache prefilling. No separate state management library needed.

**Requires:** React 19+, TanStack React Query 5+

## Install

```bash
npm install @classytic/arc-next
# Peer deps:
npm install react@^19 @tanstack/react-query@^5
```

## Setup (call once at app init)

```ts
import { configureClient, configureAuth } from "@classytic/arc-next/client";
import { configureToast } from "@classytic/arc-next/mutation";
import { configureNavigation } from "@classytic/arc-next/hooks";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

// Required — sets the API base URL and auth mode
configureClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL!,
  authMode: 'cookie', // 'cookie' for Better Auth, 'bearer' for token auth (default)
  internalApiKey: process.env.NEXT_PUBLIC_INTERNAL_API_KEY, // optional
});

// Optional — auto-inject org context into queries/mutations
configureAuth({
  getOrgId: () => activeOrgId, // return current org ID
  getToken: () => null,        // null for cookie auth (token only for bearer)
  // 0.7+: lazy 401 recovery. Refreshes + retries transparently when the
  // session token expires mid-page. Concurrent 401s collapse to ONE refresh.
  onAuthError: createAuthRefreshHandler({
    refresh: async () => {
      const { data } = await authClient.getSession({ disableCookieCache: true });
      return data?.session.token ?? null; // null → truly expired; surface 401 to caller
    },
  }),
});

// Optional — pluggable toast (defaults to console)
configureToast({ success: toast.success, error: toast.error });

// Optional — enables useNavigation() routing (defaults to cache-only)
configureNavigation(useRouter);
```

### `arcFetch` — one-line authenticated fetch outside hooks (0.7+)

For non-hook contexts (event handlers, service workers, server actions,
MDX submit buttons, background polls) where `useQuery` / `useMutation`
aren't available:

```ts
import { arc } from "@classytic/arc-next/client";

const result = await arc.post<{ ok: boolean }>("/api/statements", statements);
// Auto-injects Authorization + x-organization-id + content-type
// Throws ArcApiError on non-2xx
// Composes with onAuthError refresh, retry, beforeRequest/afterResponse
```

Method shorthands: `arc.get`, `arc.post`, `arc.put`, `arc.patch`,
`arc.delete`. For full `RequestInit` control, call `arcFetch(path, opts)`
directly. For raw `Response` access, use plain `fetch` with
`arcAuthHeaders()` which returns the same auto-injected headers
(`Authorization`, `x-organization-id`, etc.).

Protected headers: `Authorization`, `x-organization-id`,
`x-internal-api-key`, and the `authMode: "header"` custom header cannot
be overridden by `options.headers` — prevents accidental auth-strip when
a caller spreads their own header map.

### Auth Recovery (0.7+) — when to use `onAuthError`

Use whenever your app authenticates via a bearer token that can expire
mid-session (Better Auth, NextAuth, Clerk, custom OAuth). Skip for
cookie-only auth where the server's `Set-Cookie` handles refresh
out-of-band.

| Handler return | Effect |
|---|---|
| `'retry'` | SDK re-issues the request once with the token from `setToken` (or `getToken` if `setToken` wasn't called) |
| `'skip'` | Original 401 surfaces to the caller — route them to sign-in |
| throws | Thrown error propagates instead of the 401 |

The handler is invoked **at most `maxAuthRetries` times per request**
(default `1`). Concurrent 401s share one in-flight refresh promise —
verified end-to-end with 5 concurrent expired-token requests collapsing
to 1 refresh call. See [tests/auth-refresh.test.ts](../../tests/auth-refresh.test.ts)
for the full spec.

## Subpath Imports

| Import | Purpose | `"use client"` |
|---|---|:-:|
| `@classytic/arc-next/client` | `configureClient`, `configureAuth`, `createClient`, `createAuthAwareClient`, `handleApiRequest`, `createQueryString`, `ArcApiError`, `isArcApiError`, `getAuthMode`, `getAuthContext`, `createAuthRefreshHandler` (0.7+), `arcFetch` / `arc.{get,post,put,patch,delete}` / `arcAuthHeaders` (0.7+) | No |
| `@classytic/arc-next/api` | `BaseApi`, `createCrudApi`, response types, type guards | No |
| `@classytic/arc-next/query` | `createQueryKeys`, `createCacheUtils`, `createListQuery`, `createDetailQuery` | Yes |
| `@classytic/arc-next/mutation` | `configureToast`, `useMutationWithTransition`, `createOptimisticMutation` | Yes |
| `@classytic/arc-next/hooks` | `createCrudHooks`, `configureNavigation` | Yes |
| `@classytic/arc-next/query-client` | `getQueryClient` (SSR-safe singleton) | No |
| `@classytic/arc-next/prefetch` | `createCrudPrefetcher`, `dehydrate` (SSR prefetch) | No |

No barrel index — every file is its own entry point. Tree-shakeable (`sideEffects: false`).

## Quick Start

### 1. Define API

```ts
import { createCrudApi } from "@classytic/arc-next/api";

interface Product {
  _id: string;
  name: string;
  price: number;
  organizationId: string;
}

interface CreateProduct {
  name: string;
  price: number;
}

export const productsApi = createCrudApi<Product, CreateProduct>(
  "products",
  { basePath: "/api" }
);
```

### 2. Create hooks

```ts
import { createCrudHooks } from "@classytic/arc-next/hooks";
import { productsApi } from "./products-api";

export const {
  KEYS: productKeys,
  cache: productCache,
  useList: useProducts,
  useDetail: useProduct,
  useActions: useProductActions,
  useNavigation: useProductNavigation,
} = createCrudHooks<Product, CreateProduct>({
  api: productsApi,
  entityKey: "products",
  singular: "Product",
});
```

### 3. Use in components

```tsx
"use client";

export function ProductsPage() {
  const { items, pagination, isLoading } = useProducts(null, {
    organizationId: "org-123",
  }, { public: true });

  const { create, remove, isCreating } = useProductActions();

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      <button
        onClick={() => create({ data: { name: "Widget", price: 9.99 } })}
        disabled={isCreating}
      >
        Add Product
      </button>
      {items.map((p) => (
        <div key={p._id}>
          {p.name} — ${p.price}
          <button onClick={() => remove({ id: p._id })}>Delete</button>
        </div>
      ))}
      {pagination && <span>{pagination.total} total</span>}
    </div>
  );
}
```

## API Reference

### `configureClient(config)`

```ts
configureClient({
  baseUrl: string;                          // Required — API base URL
  authMode?: 'cookie' | 'bearer';          // Default: 'bearer'
  internalApiKey?: string;                  // Optional — sent as x-internal-api-key header
  defaultHeaders?: Record<string, string>; // Optional — merged into every request
});
```

- `authMode: 'bearer'` (default) — requires a token for authenticated requests; queries are disabled until a token is provided
- `authMode: 'cookie'` — auth via HTTP-only cookies (e.g. Better Auth); queries are always enabled, no token needed

Must be called before any API requests. Throws if not configured.

### `configureAuth(config)`

```ts
configureAuth({
  getToken?: () => string | null;   // For bearer auth — return access token
  getOrgId?: () => string | null;   // Return active organization ID
});
```

Auto-injects `token` and `organizationId` into queries/mutations. Hooks use the new signature (no explicit token param) — legacy signature still works.

### `handleApiRequest<T>(method, endpoint, options?)`

Universal fetch wrapper. Handles JSON, PDF, image, CSV, and text responses.

```ts
import type { OffsetPaginationResult } from "@classytic/repo-core/pagination";

const result = await handleApiRequest<ApiResponse<User>>("GET", "/api/users/me");
const list = await handleApiRequest<OffsetPaginationResult<Product>>("GET", "/api/products?page=1");
```

**Options:**
- `body` — request body (auto-serializes JSON, passes FormData as-is)
- `token` — Bearer token
- `organizationId` — sent as `x-organization-id` header
- `headerOptions` — additional headers merged into request
- `signal` — AbortSignal for request cancellation
- `revalidate` / `tags` / `cache` — Next.js fetch extensions

### `createQueryString(params)`

MongoKit-compatible query string builder:
- Arrays → `field[in]=a,b,c`
- `populateOptions` → `populate[path][select]=field1,field2`
- `null` → `field=null`

### `createCrudApi<TDoc, TCreate, TUpdate>(entity, config?)`

Creates a typed API client instance.

```ts
const api = createCrudApi<Product, CreateProduct>("products", {
  basePath: "/api",       // default: "/api/v1"
  defaultParams: { limit: 20 },
  cache: "no-store",      // default
  headers: {              // optional — sent with every request from this instance
    "x-arc-scope": "platform",  // e.g. for superadmin elevation
  },
});
```

**Methods:**
| Method | Signature |
|---|---|
| `getAll` | `({ token?, organizationId?, params? }) → PaginationResult<T>` |
| `getById` | `({ id, token?, organizationId?, params? }) → ApiResponse<T>` |
| `create` | `({ data, token?, organizationId? }) → ApiResponse<T>` |
| `update` | `({ id, data, token?, organizationId? }) → ApiResponse<T>` |
| `delete` | `({ id, token?, organizationId? }) → DeleteResponse` |
| `upload` | `({ data: FormData, id?, path?, token?, organizationId? }) → ApiResponse<T>` |
| `request` | `(method, endpoint, { data?, params?, token? }) → T` |

`search()` and `findBy()` were removed — both routed to `GET /` with operators; pass operators directly via `getAll({ params: { 'title[contains]': q } })`. Pagination result types are discriminated on `method` ('offset' | 'keyset' | 'aggregate') and live in `@classytic/repo-core/pagination`.

**`prepareParams(params)`** — processes query params: critical filters (`organizationId`, `ownerId`) preserved as null, arrays → `field[in]`, pagination parsed to int.

### `createCrudHooks<T, TCreate, TUpdate>(config)`

Factory that returns everything you need:

```ts
const {
  KEYS, cache,
  useList, useDetail, useInfiniteList,
  useActions, useUpload, useCustomMutation,
  useNavigation,
} = createCrudHooks<Product, CreateProduct>({
    api: productsApi,       // from createCrudApi()
    entityKey: "products",  // TanStack Query key prefix
    singular: "Product",    // for toast messages
    defaults: {             // optional
      staleTime: 60_000,
      messages: { createSuccess: "Product added!" },
    },
    callbacks: {            // optional
      onCreate: {
        onSuccess: (data) => console.log("Created:", data),
        onSettled: (data, error) => console.log("Done"),
      },
    },
  });
```

**Returned hooks:**

#### `useList(params?, options?)` — new signature (recommended)

```ts
const { items, pagination, isLoading, isFetching, refetch } = useList(
  { organizationId: "org-123", status: "active" },
  { public: true, staleTime: 30_000 }
);
```

- Auto-injects `token` + `organizationId` from `configureAuth()`
- Auto-scopes query keys by `organizationId` (tenant vs super-admin)
- Normalizes pagination from `docs`/`data`/`items`/`results` formats
- `options.public: true` — enables query without token

Legacy `useList(token, params, options)` still compiles.

**`select` transform** — transform raw API data before it reaches your component:

```ts
const { items } = useList({ organizationId }, {
  select: (data) => ({
    ...data,
    docs: data.docs.map((p) => ({ ...p, displayName: `${p.name} ($${p.price})` })),
  }),
});
```

#### `useDetail(id, options?)` — with placeholderData handoff (0.7+)

```ts
const { item, isLoading, isPlaceholderData } = useDetail(productId, {
  organizationId: "org-123",
});

return (
  <article aria-busy={isPlaceholderData}>
    <h1>{item?.name}</h1>
    {/* `isPlaceholderData` is true while the detail GET runs against a list-cached preview */}
  </article>
);
```

**How the list→detail handoff works.** When a parent `useList` /
`useInfiniteList` already has this entity in cache, `useDetail` reads the
item via TanStack's `placeholderData` factory — the consumer sees an
instant list-shaped preview, but the real detail GET **always** fires and
swaps in the richer payload. The list payload is never written to the
detail cache, so `staleTime` reasons about real fetches only and there's
no shape pollution.

> **Why this matters.** A prior revision used `setQueryData` to eagerly
> prefill detail keys from list results. That blocked the real detail GET
> (cache looked "fresh"), wrote a wrong-shape envelope that didn't match
> the GET response, and re-ran every render of the list — silently
> clobbering successful detail fetches. The new `placeholderData` pattern
> is the canonical TanStack way to do this. Don't reach for `setQueryData`
> to seed cache from list payloads — let `useDetail` pull from list on
> demand. `cache.setDetail` / `setScopedDetail` remain for cases where you
> have a known-authoritative TDoc to seed (POST-after-create response,
> WebSocket push, etc.).

**Detail → list pseudo-normalization (0.7+).** When a `useDetail` GET
resolves with fresh data, arc-next walks every list cache holding this
id and shallow-merges the new values in-place. The list view stays
consistent with the detail page without firing a refetch. Direction is
one-way (detail → list, never the reverse) because list payloads are
typically trimmed subsets of detail. Shallow-merge preserves the list-
cache key set, so detail-only fields (populated relations, full body)
never bleed into list caches. Exposed for custom hooks as
`syncDetailToLists(qc, KEYS.lists(), doc, { idField? })` in
`@classytic/arc-next/cache`. For true entity normalization (one copy
per id, field-level invalidation, GC by reference count), use Apollo
Client or Relay — arc-next stays opinionated about its niche.

- Disabled when `id` is null (conditional fetching)
- Extracts item from `{ data: T }` wrapper

**`select` transform:**

```ts
const { item } = useDetail(productId, token, {
  select: (data) => ({ ...data.data, fullName: `${data.data.firstName} ${data.data.lastName}` }),
});
```

#### `useActions()`

```ts
const { create, update, remove, isCreating, isUpdating, isDeleting, isMutating } =
  useActions();

// All mutations have optimistic updates + automatic rollback on error
await create({ data: { name: "New" }, organizationId: "org-123" });
await update({ id: "123", data: { name: "Updated" } });
await remove({ id: "123" });

// Per-call callbacks
await create(
  { data: { name: "New" } },
  { onSuccess: (item) => navigate(`/products/${item._id}`) }
);
```

- **Create** — optimistic: prepends to list with temp ID
- **Update** — optimistic: patches item in list + detail cache
- **Delete** — optimistic: removes from list + detail cache
- All roll back automatically on error

#### `useNavigation()`

```ts
const navigate = useNavigation();
navigate(`/products/${id}`, product);              // push + cache prefill
navigate(`/products/${id}`, product, { replace: true }); // replace
```

Sets detail cache before navigation (instant page load, no loading spinner).
Requires `configureNavigation(useRouter)` — without it, only sets cache (no routing).

#### `useInfiniteList(token, params?, options?)`

Cursor-based infinite scrolling with automatic page aggregation:

```ts
const { items, hasNextPage, fetchNextPage, isFetchingNextPage, isLoading } =
  useInfiniteList(token, { organizationId: "org-123", limit: 20 });
```

- Supports both keyset (`hasMore`/`next`) and offset (`hasNext`/`page`) pagination
- Returns flattened `items` across all pages
- Auto-scopes query keys like `useList`

#### `useUpload(options?)`

Upload FormData with cache invalidation:

```ts
const { mutateAsync: upload, isPending } = useUpload({
  messages: { success: "Uploaded!", error: "Upload failed" },
  onSuccess: (data) => console.log("Uploaded:", data),
});

// Post to base collection URL
await upload({ data: formData });
// Post to /products/{id}/upload
await upload({ data: formData, id: "doc-123" });
// Post to /products/bulk-import (custom path takes precedence over id)
await upload({ data: formData, path: "bulk-import" });
```

Requires `api.upload` to be defined. Throws if not available.

#### Searching with `useList`

`useSearch` was removed — both `search()` and `findBy()` routed to `GET /` with bracket-key operators. Use `useList` with operator params:

```ts
const { items, pagination, isLoading } = useList(token, {
  organizationId: "org-123",
  'name[contains]': "widget",
});
```

#### `useCustomMutation<TData, TVariables>(config)`

Build custom mutations that share the entity's toast and invalidation patterns:

```ts
const { mutateAsync: publish, isPending } = useCustomMutation({
  mutationFn: (id: string) => api.request("POST", `${api.baseUrl}/${id}/publish`),
  invalidateQueries: [productKeys.lists()],
  messages: { success: "Published!", error: "Failed to publish" },
});
```

### Query Keys (`KEYS`)

```ts
KEYS.all                          // ["products"]
KEYS.lists()                      // ["products", "list"]
KEYS.list(params)                 // ["products", "list", params]
KEYS.details()                    // ["products", "detail"]
KEYS.detail(id)                   // ["products", "detail", id]
KEYS.custom("stats", orgId)       // ["products", "stats", orgId]
KEYS.scopedList("tenant", params) // ["products", "list", { _scope: "tenant", ...params }]
```

### Cache Utilities (`cache`)

```ts
await cache.invalidateAll(queryClient);
await cache.invalidateLists(queryClient);
await cache.invalidateDetail(queryClient, id);

// Writes/reads the raw doc — no `{ data: TDoc }` envelope (0.7+). Matches
// what useDetail, prefetchDetail, and useNavigation all produce, so callers
// can mix-and-match without shape coercion.
cache.setDetail(queryClient, id, data);
cache.getDetail(queryClient, id);       // T | undefined
cache.removeDetail(queryClient, id);
```

### `getQueryClient(overrides?)`

SSR-safe singleton. Server: new per request. Browser: reuses singleton.

```ts
import { getQueryClient } from "@classytic/arc-next/query-client";
import { QueryClientProvider } from "@tanstack/react-query";

function Providers({ children }) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
```

Defaults: `staleTime: 5min`, `gcTime: 30min`, `retry: 0`, `refetchOnWindowFocus: false`.

## SSR Prefetch (Server Components)

Pre-populate the query cache on the server to avoid loading spinners:

```ts
// products-prefetch.ts
import { createCrudPrefetcher } from "@classytic/arc-next/prefetch";
import { productsApi } from "@/api/products-api";

export const productsPrefetcher = createCrudPrefetcher(productsApi, "products");
```

```tsx
// app/products/page.tsx (server component)
import { getQueryClient } from "@classytic/arc-next/query-client";
import { dehydrate } from "@classytic/arc-next/prefetch";
import { HydrationBoundary } from "@tanstack/react-query";
import { productsPrefetcher } from "@/prefetch/products-prefetch";

export default async function ProductsPage() {
  const queryClient = getQueryClient();
  await productsPrefetcher.prefetchList(queryClient, { limit: 20 });

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ProductsList />
    </HydrationBoundary>
  );
}
```

**Methods:** `prefetchList(queryClient, params?, options?)`, `prefetchDetail(queryClient, id, options?)`

## Custom Mutations

For operations beyond CRUD (publish, schedule, upload):

### `useMutationWithTransition(config)`

Mutation + React 19 `useTransition` for smooth cache invalidation:

```ts
import { useMutationWithTransition } from "@classytic/arc-next/mutation";

export function usePublishPost() {
  return useMutationWithTransition({
    mutationFn: (id: string) =>
      postsApi.request("POST", `${postsApi.baseUrl}/${id}/publish`),
    invalidateQueries: [postKeys.all],
    messages: { success: "Published!", error: "Failed to publish" },
    useTransition: true,     // default
    showToast: true,         // default
  });
}
```

Returns: `{ mutate, mutateAsync, isPending, isSuccess, isError, error, data, reset }`

### `useMutationWithOptimistic(config)`

Mutation + optimistic updates + automatic rollback:

```ts
import { useMutationWithOptimistic } from "@classytic/arc-next/mutation";

export function useToggleFavorite() {
  return useMutationWithOptimistic({
    mutationFn: ({ id, isFav }) => api.request("PATCH", `/api/products/${id}`, {
      data: { favorite: !isFav },
    }),
    queryKeys: [productKeys.lists()],
    optimisticUpdate: (old, { id, isFav }) =>
      updateListCache(old, (items) =>
        items.map((i) => getItemId(i) === id ? { ...i, favorite: !isFav } : i)
      ),
    messages: { success: "Updated!" },
  });
}
```

### Query Config Presets

```ts
import { QUERY_CONFIGS } from "@classytic/arc-next/mutation";

// Use in useList options:
useProducts(token, {}, { ...QUERY_CONFIGS.realtime });
```

| Preset | `staleTime` | `refetchInterval` |
|---|---|---|
| `realtime` | 20s | 30s |
| `frequent` | 1min | — |
| `stable` | 5min | — |
| `static` | 10min | — |

## Low-Level Utilities

### `updateListCache(listData, updater)`

Transforms list cache regardless of format (`docs[]`, `data[]`, `items[]`, `results[]`, or raw array).
Automatically adjusts `total`/`totalDocs` counts when items are added or removed (optimistic add/delete):

```ts
import { updateListCache } from "@classytic/arc-next/query";

queryClient.setQueryData(KEYS.lists(), (old) =>
  updateListCache(old, (items) => items.filter((i) => i.status !== "archived"))
);
```

### `getItemId(item)`

Extracts `_id` or `id` from any item. Returns `string | null`.

## Response Types

arc 2.13+ has no wire envelope — handlers receive the raw payload directly. CRUD responses are the entity (`TDoc`), bulk/delete responses are repo-core result shapes, and errors throw `ArcApiError` carrying the canonical `ErrorContract`.

```ts
import type {
  BulkCreateResult,
  DeleteResult,           // { message?, id?, soft? }
  DeleteManyResult,
  UpdateManyResult,
} from "@classytic/arc-next/api";

import type {
  OffsetPaginationResult,    // { method: 'offset', data: TDoc[], page, limit, total, pages, hasNext, hasPrev }
  KeysetPaginationResult,    // { method: 'keyset', data: TDoc[], limit, hasMore, next }
  AggregatePaginationResult, // { method: 'aggregate', data: TDoc[], ... }
  BareListResult,            // { data: TDoc[] } — non-paginated list endpoints
  PaginatedResult,           // discriminated union on `method` (includes BareListResult)
} from "@classytic/repo-core/pagination";

import type { ErrorContract } from "@classytic/repo-core/errors";
//   { code, message, status, details?, meta?, correlationId? }

// Type guards
import { isOffsetPagination, isKeysetPagination, isAggregatePagination } from "@classytic/arc-next/api";
```

## Common Patterns

### Multi-tenant data fetching

```ts
// organizationId in params → scoped query key → isolated cache per tenant
const { items } = useProducts(token, { organizationId: currentOrg });
```

### Public endpoints (no auth)

```ts
const { items } = useProducts(null, {}, { public: true });
```

### Conditional fetching

```ts
const { item } = useProduct(selectedId, token); // disabled when selectedId is null
```

### Per-call callbacks

```ts
await create(
  { data: formData, organizationId: org },
  {
    onSuccess: (product) => router.push(`/products/${product._id}`),
    onError: (err) => setFieldErrors(err),
    onSettled: (data, error) => setSubmitting(false), // fires after success or error
  }
);
```

### Navigate with cache prefill

```ts
const navigate = useProductNavigation();
// Prefills detail cache → no loading spinner on detail page
navigate(`/products/${product._id}`, product);
```

## Error Handling

All API errors throw `ArcApiError`:

```ts
import { ArcApiError, isArcApiError } from "@classytic/arc-next/client";

try {
  await productsApi.create({ data: { name: "" } });
} catch (err) {
  if (isArcApiError(err)) {
    console.log(err.status);      // HTTP status code
    console.log(err.message);     // Error message from server
    console.log(err.fieldErrors); // { field: "message" } or null
    console.log(err.endpoint);    // Request endpoint
    console.log(err.method);      // HTTP method
  }
}
```

## Per-Instance Headers

```ts
// All requests from this API include x-arc-scope header
const adminApi = createCrudApi("users", {
  headers: { "x-arc-scope": "platform" },
});
```

## Multi-Client (Multiple APIs)

By default, `configureClient()` sets a single global `baseUrl`. Use `createClient()` when your app talks to multiple backends.

### Create isolated clients

```ts
import { createClient } from "@classytic/arc-next/client";
import { createCrudApi } from "@classytic/arc-next/api";
import { createCrudHooks } from "@classytic/arc-next/hooks";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

const analyticsClient = createClient({
  baseUrl: "https://analytics.example.com",
  internalApiKey: "analytics-key",
  toast: { success: toast.success, error: toast.error },
  navigation: useRouter,
});
```

### Use with createCrudApi

Pass `client` in the config — requests go through the client's `baseUrl` instead of the global one:

```ts
const eventsApi = createCrudApi("events", {
  basePath: "/api",
  client: analyticsClient,
});
```

### Use with createCrudHooks

Pass `client` — toast and navigation use the client's handlers instead of globals:

```ts
const { useList, useActions } = createCrudHooks({
  api: eventsApi,
  entityKey: "events",
  singular: "Event",
  client: analyticsClient,
});
```

### Direct requests

```ts
const data = await analyticsClient.request("GET", "/api/stats");
const result = await analyticsClient.request("POST", "/api/events", {
  body: { type: "page_view" },
});
```

### Coexisting with global client

Global and client-scoped APIs work side by side — no conflicts:

```ts
// Global (main backend)
configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL! });
const postsApi = createCrudApi("posts");

// Isolated (analytics backend)
const analyticsClient = createClient({ baseUrl: "https://analytics.example.com" });
const eventsApi = createCrudApi("events", { client: analyticsClient });
```

### `ArcClient` interface

```ts
interface ArcClient {
  request: <T>(method: HttpMethod, endpoint: string, options?: ApiRequestOptions) => Promise<T>;
  config: ClientConfig;
  toast?: ToastHandler;
  navigation?: UseRouterHook;
}
```

`toast` and `navigation` are optional — when omitted, mutations fall back to the global `configureToast()`/`configureNavigation()` handlers.
