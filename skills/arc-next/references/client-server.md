# Client config, auth, errors, server usage

Subpaths: `/client` `/server` `/prefetch` `/auth-gate` `/events` `/auth-token` (all server-safe).

## Boot (browser, once, from a client provider)

```ts
configureClient({ baseUrl: API_URL, authMode: "bearer", timeoutMs: 20_000 });
configureAuth({ getToken: () => tokens.get(), getOrgId: () => org?.id ?? null });
configureToast({ success: toast.success, error: toast.error });
configureNavigation(useRouter);        // before createCrudHooks()
```

| `authMode` | When |
|---|---|
| `bearer` (default) | `getToken()` returns the token; reads wait for a token |
| `cookie` | Session cookies; `credentials: "include"`, no token |
| `header` | API key in `headerName` |

`getToken` and `getOrgId` are synchronous. Headers are conditional: `Authorization` only with a token, `x-organization-id` only with an org. The SDK sends `cache` only when you set it (call, instance or `ClientConfig.cache`).

`createTokenStore(storage, key)` and `bearerFetchOptions(tokens)` (`/auth-token`) hold a bearer session without a library.

## 401 recovery

```ts
configureAuth({
  getToken,
  onAuthError: createAuthRefreshHandler({
    refresh: async () => (await authClient.getSession({ disableCookieCache: true })).data?.session.token ?? null,
  }),
  retryOn403: false,       // default
  maxAuthRetries: 1,       // default
});
```

Handler returns `"retry"` or `"skip"`, or throws. Concurrent 401s share one refresh across fetch, XHR upload, WebSocket and SSE. Custom handler gets `{ error, request, attempt, setToken }`.

403s that mean the session changed (second factor now required) are opt-in, JSON client only:
`onSessionChange: { match: (e) => e.code === "auth.second_factor_required", handler }`. Same handler
contract, own dedup and retry budget; matched 403s skip `retryOn403`.

## Outside hooks

```ts
const res = await arc.post<{ ok: boolean }>("/api/statements", body);   // get/post/put/patch/delete
await arcFetch<T>(path, { method, body, signal, idempotencyKey });
fetch(url, { headers: arcAuthHeaders() });                              // raw Response needed
```

Auth headers cannot be overridden by `options.headers`. Mutating requests get an `Idempotency-Key` when `autoIdempotency` is on (minted once per logical request, reused by retries).

## Errors

```ts
if (isAbortError(err)) return;
if (isArcApiError(err)) { err.status; err.code; err.fieldErrors; err.endpoint; }
isQuotaExceeded(err); getQuotaDetails(err);    // "X of Y, resets <date>"; never auto-retry
isTierRequiredError(err); getTierRequirement(err);
isValidationError(err); isDuplicateKeyError(err); isPreconditionFailed(err); isOrgContextRequiredError(err);
```

`err.code` values come from `@classytic/repo-core/errors` (`KNOWN_ARC_ERROR_CODES` spreads it; `CLIENT_ERROR_CODES` are client-side only). Interceptors: `ClientConfig.beforeRequest`, `afterResponse`, `retry`.

## Servers: request-scoped clients

Module singletons are wrong on a server. Build a client per request from plain values:

```ts
const client = createRequestClient({ baseUrl: process.env.API_URL!, headers: await headers() });
const orders = await createCrudApi<Order>("orders", { client }).getAll({
  options: { next: { revalidate: 60, tags: ["orders"] } },   // typed pass-through to fetch
});
```

`createRequestClient` forwards `cookie`, `authorization`, `x-organization-id`, locale and trace headers (`FORWARDED_REQUEST_HEADERS`; `x-forwarded-for` only if you add it). `createServerClient({ baseUrl, token, organizationId })` is the explicit-token form. `createAuthAwareClient()` bridges the global auth singleton for a consumer SDK. `createClient` makes an independent client (own baseUrl, auth, headers).

## SSR prefetch

```tsx
const prefetcher = createCrudPrefetcher(api, "products");
const qc = getQueryClient();
await prefetcher.prefetchList(qc, { limit: 20 }, { headers: forwardRequestHeaders(await headers()) });
return <HydrationBoundary state={dehydrate(qc)}><ProductsList /></HydrationBoundary>;
```

Methods: `prefetchList`, `prefetchDetail`, `prefetchBySlug`, `prefetchDeleted`, `prefetchTree`, `prefetchInfiniteList` (seeds the `{ pages, pageParams }` shape). Seed instead of prefetch with `useList(params, { initialData, initialDataUpdatedAt })` for the same params.

## Server caches

Tag Next fetch reads with `arcTag(entity, id?, scope?)` and invalidate in one `onArcChange` listener (registered in a client provider) that calls a server action with the same tags. A delete event carries `previous`, so the parent tag is reachable. Behind a load balancer, back Next's `cacheHandler` with a shared store.

## Auth gate for hand-written queries

```ts
useQuery({ queryKey, queryFn, enabled: queryAuthEnabled({ user: true, enabled: !!id }) });
```

`user: true` for "my" endpoints, `public: true` for open ones. `authGate` is the pure form.
