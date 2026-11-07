# Core hooks, cache and presets

Subpaths: `/api` (server-safe), `/hooks` `/query` `/mutation` (client), `/cache` `/query-options` `/query-client` (server-safe).

## Api

```ts
const api = createCrudApi<Product, CreateProduct, UpdateProduct>("products", {
  basePath: "/api",                 // default "/api/v1"; ClientConfig.basePath sets it once
  headers: { "x-arc-scope": "platform" },
  versionField: "__v",              // update sends If-Match; stale write: isPreconditionFailed(err)
  client,                           // optional ArcClient: isolated baseUrl/auth
});
```

| Method | Notes |
|---|---|
| `getAll({ params })`, `getById({ id })`, `create({ data })`, `update({ id, data })`, `delete({ id })` | Raw payloads, no envelope |
| `count({ params })`, `exists`, `distinct` | `?_count=true` verbs, zero documents fetched |
| `dispatchAction({ id, action, data })` | `POST /:id/action` |
| `invokeRoute({ method, path, data, params })` | Resource-relative custom route; path is relative, leading slash optional |
| `upload({ data: FormData })` | Multipart through the same auth |

Operators go in params with bracket keys: `"priority[gte]": 5`, `"title[contains]": q`, `status: ["a", "b"]` (becomes `status[in]=a,b`), geo tuples kept as given.

## Hooks bundle

`createCrudHooks({ api, entityKey, singular, plural?, idField?, defaults?, callbacks?, client? })` returns:

| Member | Use |
|---|---|
| `KEYS`, `cache` | Key builders and cache writers |
| `useList(params, options)`, `useInfiniteList`, `useSuspenseList` | Lists; `{ items, pagination, isLoading, isPlaceholderData, dataUpdatedAt, refetch }`; `keepPrevious` (default on for `useList`, off for `useInfiniteList`) |
| `useCursorPager(params, options)` | Previous / Next one page at a time over a keyset list; `{ items, page, hasPrev, hasNext, prev, next, goTo }`; new params restart at page 1 |
| `useDetail(id, options)`, `useSuspenseDetail` | `{ item, isPlaceholderData }` |
| `useActions()` | `create`, `update`, `remove`, `restore` with optimistic update and rollback |
| `useBulkActions()` | With `withBulk` |
| `useCount`, `useAggregation(name, filter)` | Counts and aggregations |
| `useAction({ action })` | Action-router verb with toast and invalidation |
| `useCustomMutation({ mutationFn, invalidateQueries, messages })` | Anything else, same toast rules |
| `useUpload`, `useResourceSync`, `useNavigation` | Upload, live invalidation, push with cache prefill |
| `useDeleted`, `useDetailBySlug`, `useTree`, `useChildren`, `useSearchEngine`, `useSearchSimilar`, `useEmbed` | Preset hooks; throw at call time if the api lacks the preset wrapper |

Options on reads: `public: true` (no token needed), `enabled`, `staleTime`, `select`, `initialData`, `organizationId` (the tenant; `null` = no org header), `auth` (`"omit"` anonymous, `"inherit"` overrides `readAuth`), `scope`. Params are the query string: an `organizationId` param is a filter, never the tenant.

Every key carries an identity partition `{ auth, organizationId, scope }`, resolved before the key is built from what the request sends (configured org included), so tenants, clients and anonymous reads never share an entry.

`token` / `organizationId` everywhere (api methods, presets, hooks, factory ctx): omitted = configured default, `null` = deliberately none, string = exactly this. `invokeRoute({ path: "/me", organizationId: null })` sends the token and no org header.

## Guarantees you can rely on

- List to detail: `useDetail` shows a cached list row of the same partition through `placeholderData` (`isPlaceholderData`), the real GET always fires; the list payload is never written to the detail cache.
- Detail to list: a resolved detail shallow-merges into the lists of its own partition holding that id (`syncDetailToLists`), never into an anonymous or other-tenant list.
- Optimistic writes: cancel-before-snapshot, the writer's partition only (detail, lists, infinite pages), exact rollback, temp-id swapped for the server id, same-record writes chained, one settled refetch of every partition after a burst, bulk with zero changes skips invalidation.
- `useActions` writes also emit change events (`onArcChange`, `/events`).

## Keys and cache

```ts
const p = hooks.queries.partition();    // the partition a default read uses
KEYS.all; KEYS.lists(); KEYS.lists(p); KEYS.list(params, p); KEYS.detail(id, { ...p, params });
KEYS.detail(id);                        // prefix of every variant (invalidation only)
KEYS.routes(); KEYS.route("/stats", params, p);   // custom-route reads
cache.invalidateAll(qc); cache.invalidateLists(qc); cache.invalidateDetail(qc, id);
cache.setDetail(qc, id, doc, p);        // raw doc, no envelope, into that partition
```

Server-safe helpers in `/cache`: `createQueryKeys`, `createCacheUtils`, `extractItems`, `extractItem`, `getItemId`, `normalizePagination`, `updateListCache`, `prependToListCache`, `replaceItemInListCache`, `arcTag`, `QUERY_CONFIGS` (`realtime`, `frequent`, `stable`, `static`).

## Custom routes (never hand-build their keys)

```ts
const me = useQuery(iam.queries.route<Me>("/me", { organizationId: null, staleTime: 60_000 }));
const approve = useMutation(orders.queries.routeMutation<Order, { note: string }>("/:id/approve", {
  invalidates: (order) => ({ op: "update", id: order._id }),   // or [orders.KEYS.routes()]
}));
approve.mutate({ pathParams: { id }, data: { note } });
```

`createEntityQueries(api, "products")` (`/query-options`, also `hooks.queries`) gives `list`, `detail`, `infiniteList`, `count`, `aggregation`, `route`, `routeMutation` option objects usable with `useQuery`, `useSuspenseQuery`, `useMutation`, prefetch and `ensureQueryData`; keys match the hooks (pinned by a parity test).

## Custom mutations with toasts

```ts
const { mutateAsync, isPending } = useMutationWithTransition({
  mutationFn: (id: string) => api.invokeRoute({ method: "POST", path: `/${id}/publish` }),
  invalidateQueries: [KEYS.all],
  messages: { success: "Published", error: "Failed to publish" },
});
```

`useOptimisticMutation` adds a key-aware updater `(old, vars, queryKey)` with rollback. Without `configureToast` toasts are a silent no-op; errors still reject.

## Presets (wrap only what the backend mounts)

`withSoftDelete` (`getDeleted`, `restore`), `withBulk` (`bulkCreate`, `bulkUpdate`, `bulkDelete`), `withSlugLookup` (`getBySlug`), `withTree` (`getTree`, `getChildren`), `withSearchPreset` (`searchEngine`, `searchSimilar`, `embed`), `withHistory` (`history(id)` audit timeline). Each is `with<Preset>(api)` imported from `/presets/<name>`. Preset methods are async and use only the public `request()` surface.

## Query client

`getQueryClient()` (`/query-client`): new per request on the server, singleton in the browser. Defaults: staleTime 5 min, gcTime 30 min, retry 0, no refetch on focus. `retry` means what it means in TanStack (`true` no limit, a count, or a function); a 429 quota error is never retried.