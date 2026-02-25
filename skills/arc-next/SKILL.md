---
name: arc-next
description: |
  @classytic/arc-next — React + TanStack Query SDK for Arc resources.
  Production-grade CRUD hooks with optimistic updates, multi-tenant scoping, and pluggable configuration.
  Use when building React CRUD UIs, creating API hooks with TanStack Query, implementing optimistic updates,
  paginated lists, detail cache prefilling, or multi-tenant data fetching.
  Triggers: arc-next, createCrudApi, createCrudHooks, tanstack query hooks, crud hooks, optimistic updates,
  react query factory, api client hooks, pagination normalization, configureClient, configureToast.
version: "1.0.0"
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
import { configureClient } from "@classytic/arc-next/client";
import { configureToast } from "@classytic/arc-next/mutation";
import { configureNavigation } from "@classytic/arc-next/hooks";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

// Required — sets the API base URL
configureClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL!,
  internalApiKey: process.env.NEXT_PUBLIC_INTERNAL_API_KEY, // optional
});

// Optional — pluggable toast (defaults to console)
configureToast({ success: toast.success, error: toast.error });

// Optional — enables useNavigation() routing (defaults to cache-only)
configureNavigation(useRouter);
```

## Subpath Imports

| Import | Purpose | `"use client"` |
|---|---|:-:|
| `@classytic/arc-next/client` | `configureClient`, `createClient`, `handleApiRequest`, `createQueryString` | No |
| `@classytic/arc-next/api` | `BaseApi`, `createCrudApi`, response types, type guards | No |
| `@classytic/arc-next/query` | `createQueryKeys`, `createCacheUtils`, `createListQuery`, `createDetailQuery` | Yes |
| `@classytic/arc-next/mutation` | `configureToast`, `useMutationWithTransition`, `createOptimisticMutation` | Yes |
| `@classytic/arc-next/hooks` | `createCrudHooks`, `configureNavigation` | Yes |
| `@classytic/arc-next/query-client` | `getQueryClient` (SSR-safe singleton) | No |

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
  baseUrl: string;              // Required — API base URL
  internalApiKey?: string;      // Optional — sent as x-internal-api-key header
  defaultHeaders?: Record<string, string>; // Optional — merged into every request
});
```

Must be called before any API requests. Throws if not configured.

### `handleApiRequest<T>(method, endpoint, options?)`

Universal fetch wrapper. Handles JSON, PDF, image, CSV, and text responses.

```ts
const result = await handleApiRequest<ApiResponse<User>>("GET", "/api/users/me");
const list = await handleApiRequest<PaginatedResponse<Product>>("GET", "/api/products?page=1");
```

**Options:**
- `body` — request body (auto-serializes JSON, passes FormData as-is)
- `token` — Bearer token
- `organizationId` — sent as `x-organization-id` header
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
});
```

**Methods:**
| Method | Signature |
|---|---|
| `getAll` | `({ token?, organizationId?, params? }) → PaginatedResponse<T>` |
| `getById` | `({ id, token?, organizationId?, params? }) → ApiResponse<T>` |
| `create` | `({ data, token?, organizationId? }) → ApiResponse<T>` |
| `update` | `({ id, data, token?, organizationId? }) → ApiResponse<T>` |
| `delete` | `({ id, token?, organizationId? }) → DeleteResponse` |
| `search` | `({ searchParams?, params?, token?, organizationId? }) → PaginatedResponse<T>` |
| `findBy` | `({ field, value, operator?, token?, organizationId? }) → PaginatedResponse<T>` |
| `request` | `(method, endpoint, { data?, params?, token? }) → T` |

**`prepareParams(params)`** — processes query params: critical filters (`organizationId`, `ownerId`) preserved as null, arrays → `field[in]`, pagination parsed to int.

### `createCrudHooks<T, TCreate, TUpdate>(config)`

Factory that returns everything you need:

```ts
const { KEYS, cache, useList, useDetail, useActions, useNavigation } =
  createCrudHooks<Product, CreateProduct>({
    api: productsApi,       // from createCrudApi()
    entityKey: "products",  // TanStack Query key prefix
    singular: "Product",    // for toast messages
    defaults: {             // optional
      staleTime: 60_000,
      messages: { createSuccess: "Product added!" },
    },
    callbacks: {            // optional
      onCreate: { onSuccess: (data) => console.log("Created:", data) },
    },
  });
```

**Returned hooks:**

#### `useList(token, params?, options?)`

```ts
const { items, pagination, isLoading, isFetching, refetch } = useList(
  token,
  { organizationId: "org-123", status: "active" },
  { public: true, staleTime: 30_000, prefillDetailCache: true }
);
```

- Auto-scopes query keys by `organizationId` (tenant vs super-admin)
- Normalizes pagination from `docs`/`data`/`items`/`results` formats
- Prefills detail cache from list results (skips re-fetch on navigate)
- `options.public: true` — enables query without token

#### `useDetail(id, token, options?)`

```ts
const { item, isLoading } = useDetail(productId, token, {
  organizationId: "org-123",
});
```

- Disabled when `id` is null (conditional fetching)
- Extracts item from `{ data: T }` wrapper

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

Transforms list cache regardless of format (`docs[]`, `data[]`, or raw array):

```ts
import { updateListCache } from "@classytic/arc-next/query";

queryClient.setQueryData(KEYS.lists(), (old) =>
  updateListCache(old, (items) => items.filter((i) => i.status !== "archived"))
);
```

### `getItemId(item)`

Extracts `_id` or `id` from any item. Returns `string | null`.

## Response Types

```ts
import type {
  ApiResponse,             // { success, data?, message? }
  PaginatedResponse,       // OffsetPaginationResponse | KeysetPaginationResponse | AggregatePaginationResponse
  OffsetPaginationResponse,// { docs[], page, limit, total, pages, hasNext, hasPrev }
  KeysetPaginationResponse,// { docs[], limit, hasMore, next }
  AggregatePaginationResponse, // same shape as offset
  DeleteResponse,          // { success, deleted, id?, soft?, message? }
} from "@classytic/arc-next/api";

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
  }
);
```

### Navigate with cache prefill

```ts
const navigate = useProductNavigation();
// Prefills detail cache → no loading spinner on detail page
navigate(`/products/${product._id}`, product);
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
