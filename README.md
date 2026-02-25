# @classytic/arc-next

React + TanStack Query SDK for Arc resources. Production-grade CRUD hooks with optimistic updates, multi-tenant scoping, and pluggable configuration.

## Install

```bash
npm install @classytic/arc-next
```

**Peer dependencies:**

```bash
npm install react@^19 @tanstack/react-query@^5
```

## Setup

Call the configuration functions once at app init (e.g., in your root providers):

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
configureToast({
  success: toast.success,
  error: toast.error,
});

// Optional — enables useNavigation() routing (defaults to cache-only)
configureNavigation(useRouter);
```

## Usage

### 1. Define your API

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

  const handleCreate = async () => {
    await create({ data: { name: "New Product", price: 29.99 } });
  };

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      <button onClick={handleCreate} disabled={isCreating}>
        Add Product
      </button>
      {items.map((product) => (
        <div key={product._id}>
          {product.name} — ${product.price}
          <button onClick={() => remove({ id: product._id })}>Delete</button>
        </div>
      ))}
      {pagination && <span>{pagination.total} total</span>}
    </div>
  );
}
```

## Subpath Exports

| Import | Purpose | `"use client"` |
|---|---|:-:|
| `@classytic/arc-next/client` | `configureClient`, `handleApiRequest`, `createQueryString` | No |
| `@classytic/arc-next/api` | `BaseApi`, `createCrudApi`, response types, type guards | No |
| `@classytic/arc-next/query` | `createQueryKeys`, `createCacheUtils`, `createListQuery`, `createDetailQuery` | Yes |
| `@classytic/arc-next/mutation` | `configureToast`, `useMutationWithTransition`, `createOptimisticMutation` | Yes |
| `@classytic/arc-next/hooks` | `createCrudHooks`, `configureNavigation` | Yes |
| `@classytic/arc-next/query-client` | `getQueryClient` (SSR-safe singleton) | No |

## Features

- **CRUD Factory** — `createCrudApi` + `createCrudHooks` generates typed API clients and React Query hooks
- **Optimistic Updates** — Create, update, delete with instant UI feedback and automatic rollback
- **Multi-Tenant Scoping** — `organizationId` in headers + scoped query keys
- **Pagination Normalization** — Handles `docs`/`data`/`items` response formats, offset/keyset/aggregate pagination
- **Detail Cache Prefilling** — List results auto-populate detail query cache
- **React 19 Transitions** — `useMutationWithTransition` wraps invalidation in `startTransition`
- **Pluggable Toast** — `configureToast()` — use sonner, react-hot-toast, or anything
- **Pluggable Navigation** — `configureNavigation()` — use Next.js, React Router, or any router
- **SSR-Safe QueryClient** — `getQueryClient()` — singleton in browser, new per request on server
- **Framework-Agnostic** — No hard dependency on Next.js
- **Tree-Shakeable** — `sideEffects: false`, flat files, no barrels

## Custom Mutations

For operations beyond CRUD (publish, schedule, upload), use the mutation factories directly:

```ts
import { useMutationWithTransition } from "@classytic/arc-next/mutation";
import { productsApi, productKeys } from "./products";

export function usePublishProduct() {
  return useMutationWithTransition({
    mutationFn: (id: string) =>
      productsApi.request("POST", `${productsApi.baseUrl}/${id}/publish`),
    invalidateQueries: [productKeys.all],
    messages: { success: "Product published!", error: "Failed to publish" },
  });
}
```

## QueryClient Setup

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

## License

MIT
