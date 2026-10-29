# SDK core: `/sdk/*`

One subpath per file. Server-safe: `actions`, `messages`, `error-capture`, `errors`, `transport`, `download`, `resource`, `route`, `localized`. Client-only (`"use client"`): `hooks`, `init`.

## Boot and isolation

```ts
initSDK({                       // /sdk/init, browser only, once
  baseUrl, basePath: "/api", getToken,
  onAuthError, toast, navigation: useRouter,
  messages: (ctx) => translate(ctx),
  messageKeyPrefix: "app",
  timeoutMs: 20_000, bareCollectionPaths: true, captureErrors: true,
});
const { client, transport } = createIsolatedClient(config);   // /sdk/transport, no globals
const api = resource.bind(client, transport.basePath);
```

`initSDK` configures client (bearer, no cookies, `autoIdempotency`, timeout), auth, toast (wrapped with `localizeToastHandler`), navigation and messages, and stores the global transport that `streamDownload` uses. `basePath` defaults to `DEFAULT_API_BASE_PATH`, arc-next's own mount point. `eventSource` and `streamAuth` pass through.

## Resource definition

```ts
const items = defineSdkResource<Item>({
  path: "catalog/items",                 // key root "catalog-items" (slashes become "-")
  singular: "Item", plural: "Items",
  permission: "items",                   // or null; surfaces in the message context
  operations: ["list", "get", "create"], // documentation/test hook
  routesOnly: false,                     // true: no CRUD message keys
});
export const hooks = createCrudHooks(items.hooksConfig);
```

Returns `{ def, api, keyRoot, bind(client, basePath), hooksConfig }`. `keyRoot(path)` declares a root for a route without CRUD. Key rule: root = path with `/` as `-`; every other query is `hooks.KEYS.custom(name, ...args)`; invalidate by `invalidateRoots(qc, [items.keyRoot])`.

## Actions

```ts
const publish = defineCommitAction<{ expectedVersion: number }, Item>("publish", {
  key: "catalog.item.publish", fallback: { success: "Published" },   // silent: true = no toast
});
const mutation = useResourceAction(hooks, publish);                  // mutate({ id, expectedVersion })
await runAction(api, publish, id, { expectedVersion: 3 });

const revoke = defineRouteAction<{ id: string; reason: string }, Item, { data: Item }>({
  key: "catalog.item.revoke", method: "POST",
  path: ({ id }) => `/${id}/revoke`, body: ({ reason }) => ({ reason }),
  params: () => undefined, select: (raw) => raw.data,
});
useRouteAction(hooks, api, revoke);          // invalidates hooks.KEYS.all unless invalidateQueries
useQuietRouteAction(api, revoke);            // no toast at all
await runRouteAction(api, revoke, input);
```

`createCommitActionDefiner({ reservedVerbs, reservedBy })` makes a `defineCommitAction` that refuses verbs another constructor owns; `defineAction(verb, kind, options)` adds your own `kind`. `RouteApi` is the structural slice (`invokeRoute`, `dispatchAction`) so tests pass stubs.

## Reads

```ts
useRouteQuery(hooks, ["summary", id], ({ signal }) => load(id, signal), { user: true, enabled: !!id });
useRouteList(hooks, query, load, { user: true }, { enabled, placeholderData: (prev) => prev });
```

Key is `hooks.KEYS.custom(...)`; list key is `custom("list", query)`. Gate is `queryAuthEnabled` (`public`, `user`, `enabled`). Also `refetchInterval` (number or function of the query state), `staleTime`, `retry`.

## Message keys

Toasts carry keys until display (`resolveToastText`). Key shape: `<prefix>.crud.<resource>.<create|update|delete>.<success|error>` and `<prefix>.action.<key>.<success|error>`; default prefix `sdk`, set with `configureMessages(resolver, { keyPrefix })` or `initSDK({ messageKeyPrefix })`.

```ts
messages: (ctx) => {            // MessageContext: kind "crud" | "action"
  // ctx.key, ctx.outcome, ctx.fallback, ctx.detail (server text), ctx.code, ctx.details
  return catalog[ctx.key] ?? undefined;       // undefined keeps the English fallback
}
```

`listMessageKeys()` returns every registered `{ key, fallback }`: export it into the translation catalog and assert coverage in a test. A key the host lacks falls back to English, never a raw key. `toastCrudSuccess(resource, "update")` shows the standard success line for a sheet that renders failures inline. `code` and `details` come from `captureServerErrors`, the ring `initSDK` installs on the API fetch (10 s TTL).

## Downloads

```ts
const result = await streamDownload({ path: "reports/summary/export", params: { format: "csv" }, signal });
result.truncated;                 // header x-export-truncated === "1"; change with createDownloader(t, { truncatedHeader })
await saveDownload(result, "summary.csv");   // browser; returns { truncated }
```

Token goes in a header, never the URL. A path already starting with the mount point is not doubled. Failures throw `SdkRequestError` (`code` from the body or `http.<status>`, `network` with status 0, `arc.unauthorized` without a token). Read `result.stream` chunk by chunk or call `result.blob()` once.

## Errors and small helpers

`errorCode`, `errorStatus`, `isNetworkFailure`, `mapError` (`{ code, status, network, fields }`) work on `ArcApiError` and `SdkRequestError`. `compact` drops empty params, `enc` is `encodeURIComponent`, `getRoute`, `fetchAllPages(read, { maxPages })` throws `PageLimitError` rather than return a truncated list. `localizedName(entity, "ar")` prefers `titleAr`/`nameAr`/`labelAr`, then English. `bareCollectionPath` strips the trailing slash arc-next adds to a collection route.
