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

Social sign-in (`/auth-social`, server-safe): `startSocialSignIn(authClient, { provider, next, appOrigin })` on the button, `completeSocialSignIn(authClient, tokens)` once on the callback page (it reads `#handoff`, never a token in the URL), `readSocialError(searchParams)` on the sign-in page (intent `cancelled` shows nothing), `fetchSocialProviders(authUrl)` in a Server Component. Never hand-build redirect URLs: `next` must pass `safeNextPath`. One Tap: `useGoogleOneTap` (`/google-one-tap`, client only).

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
if (isArcApiError(err)) { err.status; err.code; err.fieldErrors; err.endpoint; err.correlationId; }
isQuotaExceeded(err); getQuotaDetails(err);    // "X of Y, resets <date>"; never auto-retry
isTierRequiredError(err); getTierRequirement(err);
isValidationError(err); isDuplicateKeyError(err); isPreconditionFailed(err); isOrgContextRequiredError(err);
```

`err.correlationId` is the support reference: the body's `correlationId` (arc's logged request id), else the `x-request-id` header, else `undefined` (network failure: no response). Show `Error ref: ${ref.slice(0, 8)}` next to the message; for a retried write say the work is saved and will send automatically.

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

## SSR and streaming

```tsx
// Server Component: a NEW per-request client, queries started, state dehydrated, nothing awaited
const state = streamQueries([hooks.queries.list({ limit: 20 }, { auth: "omit" })]);
return <HydrationBoundary state={state}><Suspense fallback={<Shelf />}><List /></Suspense></HydrationBoundary>;
// List ("use client"): useSuspenseList({ limit: 20 }, { auth: "omit" }) suspends on the streamed promise
```

Public page that must not ship React Query on first load: `createQueryIsland(() => import("./list"))` (`/query-island`, in your own `"use client"` file) and `<ListIsland state={await prefetchQueries([...])} when="visible" />`. The server renders the real HTML; React Query loads when the island activates (`"idle"` default, `"visible"`, `"interaction"`). Pays off only when nothing else on the page imports React Query.

`prefetchQueries([...])` awaits instead (complete HTML). Forward identity with `{ headers: forwardRequestHeaders(await headers()) }` in the factory ctx. Same keys as the hooks by construction (`createEntityQueries` / `hooks.queries`). Seed instead with `useList(params, { initialData, initialDataUpdatedAt })` for the same params.

## Anonymous reads

`auth: "omit"` (per call, hook option or ctx) or `createCrudApi(name, { readAuth: "omit" })` sends no token, org, keys or cookies, so arc's http-cache can keep the response at the CDN. Only for endpoints that answer the same for everyone.

## Server caches and the edge

One tag rule with arc's http-cache: `resourceTags(resource, id)` is `<resource>`, `<resource>:<id>`; `arcTag` adds `arc:` for Next tags. Tag reads with `next: { tags: [arcTag(entity, id)] }`; invalidate in one `onArcChange` listener: `revalidateArc(changeTags(event))`. Public pages at the CDN: `edgePageHeaders({ routes, policy, reserved: await reservedSegments(appDir) })` in `next.config` `headers()`, `createEdgePurger({ provider: cloudflareEdgeFromEnv() })` after edits, `purgeEdgeHost` after deploys (`/edge-cache`, `/edge-cache/cloudflare`); from CI: `npx arc-next-edge purge --host example.com --env-file .env.production` (env wins over files, token never printed, exit 0/1).

## Auth gate for hand-written queries

```ts
useQuery({ queryKey, queryFn, enabled: queryAuthEnabled({ user: true, enabled: !!id }) });
```

`user: true` for "my" endpoints, `public: true` for open ones. `authGate` is the pure form.
