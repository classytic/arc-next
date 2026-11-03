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
| `useList(params, options)`, `useInfiniteList`, `useSuspenseList` | Lists; `{ items, pagination, isLoading, dataUpdatedAt, refetch }` (`dataUpdatedAt`: when this list's data landed, `0` before) |
| `useDetail(id, options)`, `useSuspenseDetail` | `{ item, isPlaceholderData }` |
| `useActions()` | `create`, `update`, `remove`, `restore` with optimistic update and rollback |
| `useBulkActions()` | With `withBulk` |
| `useCount`, `useAggregation(name, filter)` | Counts and aggregations |
| `useAction({ action })` | Action-router verb with toast and invalidation |
| `useCustomMutation({ mutationFn, invalidateQueries, messages })` | Anything else, same toast rules |
| `useUpload`, `useResourceSync`, `useNavigation` | Upload, live invalidation, push with cache prefill |
| `useDeleted`, `useDetailBySlug`, `useTree`, `useChildren`, `useSearchEngine`, `useSearchSimilar`, `useEmbed` | Preset hooks; throw at call time if the api lacks the preset wrapper |

Options on reads: `public: true` (no token needed), `enabled`, `staleTime`, `select`, `initialData`. Params carry `organizationId`; keys scope by it automatically.

## Guarantees you can rely on

- List to detail: `useDetail` shows the cached list row through `placeholderData` (`isPlaceholderData`), the real GET always fires; the list payload is never written to the detail cache.
- Detail to list: a resolved detail shallow-merges into every list cache holding that id (`syncDetailToLists`).
- Optimistic writes: cancel-before-snapshot, every affected cache (detail, lists, infinite pages), exact rollback, temp-id swapped for the server id, same-record writes chained, one settled refetch after a burst, bulk with zero changes skips invalidation.
- `useActions` writes also emit change events (`onArcChange`, `/events`).

## Keys and cache

```ts
KEYS.all; KEYS.lists(); KEYS.list(p); KEYS.detail(id); KEYS.scopedDetail(id, orgId);
KEYS.custom("stats", orgId);            // [entity, "stats", orgId]
cache.invalidateAll(qc); cache.invalidateLists(qc); cache.invalidateDetail(qc, id);
cache.setDetail(qc, id, doc);           // raw doc, no envelope
```

Server-safe helpers in `/cache`: `createQueryKeys`, `createCacheUtils`, `extractItems`, `extractItem`, `getItemId`, `normalizePagination`, `updateListCache`, `prependToListCache`, `replaceItemInListCache`, `withOrgParams`, `arcTag`, `QUERY_CONFIGS` (`realtime`, `frequent`, `stable`, `static`). Detail keys are unscoped (`[entity, "detail", id]`).

## Non-CRUD reads

```ts
const { data } = useApiQuery<Stats>({
  queryKey: [KEYS.all[0], "stats"],
  queryFn: ({ signal }) => api.invokeRoute({ path: "/stats", options: { signal } }),
  freshness: "frequent",              // realtime | frequent | stable | static
});
```

`createEntityQueries(api, "products")` (`/query-options`) gives `list`, `detail`, `infiniteList` option objects usable with `useQuery`, `useSuspenseQuery`, prefetch and `ensureQueryData`; keys match the hooks (pinned by a parity test).

## Custom mutations

```ts
const { mutateAsync, isPending } = useMutationWithTransition({
  mutationFn: (id: string) => api.invokeRoute({ method: "POST", path: `/${id}/publish` }),
  invalidateQueries: [KEYS.all],
  messages: { success: "Published", error: "Failed to publish" },
});
```

`useMutationWithOptimistic` and `useOptimisticMutation` add a key-aware updater `(old, vars, queryKey)` with rollback. Without `configureToast` toasts are a silent no-op; errors still reject.

## Presets (wrap only what the backend mounts)

`withSoftDelete` (`getDeleted`, `restore`), `withBulk` (`bulkCreate`, `bulkUpdate`, `bulkDelete`), `withSlugLookup` (`getBySlug`), `withTree` (`getTree`, `getChildren`), `withSearchPreset` (`searchEngine`, `searchSimilar`, `embed`), `withHistory` (`history(id)` audit timeline). Each is `with<Preset>(api)` imported from `/presets/<name>`. Preset methods are async and use only the public `request()` surface.

## Query client

`getQueryClient()` (`/query-client`): new per request on the server, singleton in the browser. Defaults: staleTime 5 min, gcTime 30 min, retry 0, no refetch on focus; a 429 quota error is never retried.
