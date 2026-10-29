---
name: arc-next
description: React + TanStack Query SDK for arc APIs. Typed CRUD hooks, optimistic updates, tenant-scoped cache, auth recovery, SSE/WS/uploads, server clients; plus Next.js portal bootstrap (runtime env, CSP proxy, auth proxy) and SDK core (route actions, message-key toasts, downloads). Use for any data access to an arc API from React or Next. Triggers arc-next, createCrudHooks, initSDK, createProxy.
metadata:
  author: Classytic
  minVersion: "0.19.0"
---

# @classytic/arc-next

Peers: React 19+, TanStack Query 5+. Every file is its own subpath (no barrel). `T` in `createCrudApi<T>` is the module's WIRE type (plain JSON), never a mongoose document.

## Do not hand-roll

| Need | Use (subpath) |
|---|---|
| CRUD + list/detail/mutations | `createCrudApi` (`/api`), `createCrudHooks` (`/hooks`) |
| Boot config, once, browser only | `configureClient`, `configureAuth` (`/client`), `configureToast` (`/mutation`), `configureNavigation` (`/hooks`), or `initSDK` (`/sdk/init`) |
| Count / exists without rows | `api.count()`, `useCount` |
| State transition (`POST /:id/action`) | `useAction`, `api.dispatchAction`; typed: `defineCommitAction` (`/sdk/actions`) |
| Custom route read or write | `api.invokeRoute`; typed: `defineRouteAction`, `useRouteAction`, `useRouteQuery`, `useRouteList` (`/sdk/hooks`) |
| Autosave / ping with no toast | `useQuietRouteAction` (`/sdk/hooks`) |
| Hand-written `useQuery` auth gate | `queryAuthEnabled` (`/auth-gate`) |
| Outside hooks (handlers, actions) | `arc.get/post`, `arcFetch` (`/client`) |
| Server Components / route handlers | `createRequestClient` (`/server`), `createServerClient` (`/client`), `createCrudPrefetcher` (`/prefetch`) |
| 401 refresh and retry | `createAuthRefreshHandler` + `onAuthError` (`/client`) |
| Server error handling | `isArcApiError`, `isAbortError`, `isQuotaExceeded`, `isPreconditionFailed` (`/client`); `mapError` (`/sdk/errors`) |
| Backend presets | `withSoftDelete`, `withBulk`, `withTree`, `withSlugLookup`, `withSearchPreset`, `withHistory` (`/presets/*`) |
| Realtime | `useEventStream` (`/sse`), `useWebSocket` (`/ws`), `useUploadWithProgress` (`/upload`) |
| Runtime public settings (one image, many envs) | `definePublicEnv` (`/runtime`) |
| CSP with nonce + Trusted Types | `contentSecurityPolicy`, `createProxy` (`/csp`) |
| Same-origin auth reverse proxy | `createAuthProxy` (`/auth-proxy`) |
| Localized toasts (message keys) | `configureMessages`, `listMessageKeys` (`/sdk/messages`) |
| Streamed file download | `createDownloader`, `streamDownload`, `saveDownload` (`/sdk/download`) |
| Resource definition (path, key root, names) | `defineSdkResource`, `invalidateRoots` (`/sdk/resource`) |
| SSR / test client with no globals | `createIsolatedClient` (`/sdk/transport`) |
| Bilingual names, bounded page walks | `localizedName` (`/sdk/localized`), `fetchAllPages` (`/sdk/route`) |

## Golden path

```ts
// api + hooks (one file per resource, "use client" for the hooks half)
const api = withBulk(createCrudApi<Product>("products", { basePath: "/api" }));
export const { KEYS, useList, useDetail, useActions } = createCrudHooks<Product>({
  api, entityKey: "products", singular: "Product",
});
```

```ts
// boot once from a client provider
initSDK({
  baseUrl: publicEnv.apiUrl, basePath: "/api", getToken: () => tokens.get(),
  toast, navigation: useRouter, messages: (ctx) => t(ctx.key, ctx),
});
```

```ts
// custom route verb: one descriptor, hook + imperative share it
const sweep = defineRouteAction<{ id: string }, { ok: boolean }>({
  key: "stock.sweep", method: "POST", path: ({ id }) => `/${id}/sweep`,
  fallback: { success: "Swept" },
});
const mutation = useRouteAction(hooks, api, sweep); // invalidates hooks.KEYS.all
```

```ts
// per-request server client (never configureClient on a server)
const client = createRequestClient({ baseUrl: process.env.API_URL!, headers: await headers() });
const page = await createCrudApi<Order>("orders", { client }).getAll();
```

```ts
// proxy.ts; the matcher export stays a static literal in your file
export const proxy = createProxy({
  NextResponse,
  policy: ({ nonce, dev }) => contentSecurityPolicy({ nonce, dev, apiOrigin: publicEnv.apiUrl }),
});
```

## Gotchas

- `getToken` is synchronous. Cache async tokens out-of-band; a Promise is dropped with a warning.
- `configure*` and `initSDK` set module singletons. Browser only; on a server build a request-scoped client.
- Call `configureNavigation(useRouter)` before `createCrudHooks()`.
- No envelope: responses are the raw payload; errors throw `ArcApiError` (`code`, `status`, `fieldErrors`).
- No `search()`/`findBy()`: pass operators to `getAll({ params: { "title[contains]": q } })`.
- Presets are opt-in wrappers; use only what the backend mounts.
- Per-user hand-written queries need `queryAuthEnabled({ user: true, enabled })`, not `enabled: !!id`.
- Quota 429: show `getQuotaDetails(err)`; never auto-retry.
- `defineRouteAction` paths are relative to the resource; the SDK sends collection routes without a trailing slash.
- Toast text is a message KEY until display; resolve with `configureMessages` or wrap with `localizeToastHandler`.
- The CSP `matcher` must be a literal in the host `proxy.ts`; Next reads it at build time.
- `createProxy` takes `NextResponse` as an argument; the package imports nothing from `next`.
- React Native: inject `eventSource`, never set `cache: "no-store"`.

## Never

- `fetch`/axios against an arc API, or threading tokens by hand.
- Importing `next/headers` or reading cookies inside the SDK; hosts pass plain values.
- Deep imports into `dist/` or reading `node_modules` for API.
- Hand-written cache key arrays: use `KEYS.custom(...)` and `invalidateRoots`.
- Calling client-only modules (`/hooks`, `/query`, `/mutation`, `/sse`, `/ws`, `/upload`, `/sdk/hooks`, `/sdk/init`) from a Server Component.

## References

- `references/core-hooks.md`: read for list/detail/actions semantics, optimistic guarantees, keys and cache, presets, filters.
- `references/client-server.md`: read for auth modes, 401 recovery, `arcFetch`, errors, server clients, prefetch, events.
- `references/realtime-uploads.md`: read for SSE/WS/upload setup, header-authenticated streams, React Native.
- `references/portal-bootstrap.md`: read for `/runtime`, `/csp`, `/auth-proxy` wiring in a Next app.
- `references/sdk-core.md`: read for `/sdk/*`: resources, route actions, message keys, downloads, isolated clients.
- Related skills: `tanstack-query-best-practices`, `nextjs`, `react-19` (do not duplicate them here).
