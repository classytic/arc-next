# Changelog

## 0.22.0 (2026-11-07)

TanStack Query 5.107 modernization, one option factory per resource, streaming SSR, anonymous
CDN-cacheable reads, `./edge-cache`, React Native setup, and no legacy: one way to do each thing.

### ⚠ Peers

- `@tanstack/react-query` `>=5.52.1` → `>=5.102.0` (dev `^5.107.1`). Forced by `queryClient.query()` / `infiniteQuery()` (`./prefetch`, 5.102) and `environmentManager` (5.91). `@tanstack/react-query-devtools >=5.102.0` is a new OPTIONAL peer (`./devtools` only).
- `engines.node` `>=20` → `^22.22.2 || ^24.15.0 || >=26.0.0`, what the locked vitest 5 / tsdown 0.23 / jsdom 30 need under `engine-strict` and what CI tests (Node 22 and the latest LTS). `react >=19.0.0` holds: SSR tests render with `prerenderToNodeStream` (Node `prerender` is 19.2+).

### Added

- Internal CRUD hook refactor: `hooks.ts` composes dedicated read, write, preset, context and realtime modules. Public imports, hook signatures and behavior are unchanged.

- **Option factories are the one source.** `createEntityQueries<TDoc, TCreate, TUpdate>(api, entityKey)` builds `list`, `infiniteList`, `detail`, `bySlug`, `count`, `deleted`, `tree`, `children`, `aggregation` (`queryOptions` / `infiniteQueryOptions`, data typed through the key) and `create` / `update` / `remove` (`mutationOptions`, shared `keys.write()` mutation key, `meta.arc`). Every `createCrudHooks` read hook and CRUD write is a thin wrapper over them; `hooks.queries` exposes the same instance.
- **Custom routes in the factory**: `queries.route<TData>(path, { params, staleTime, token, organizationId, auth })` (GET via `invokeRoute`, abort signal, keyed `keys.route()` under `keys.routes()`) and `queries.routeMutation<TData, TBody>("/:id/approve", { method, auth, invalidates })` (`pathParams` fill the template; `invalidates` returns a `{ op, id }` change for the scoped rule or exact keys).
- **One `token` / `organizationId` rule end to end**: omitted = configured default, `null` = deliberately none, string = exactly that, from BaseApi methods, presets, hooks and factory `ctx` to the wire. `invokeRoute({ path: "/me", organizationId: null })` sends the token and no org header.
- **Paging**: `hooks.useCursorPager(params)` (and `useCursorPager(query, resetKey)` in `./query`) shows one keyset page at a time with Previous / Next over the held pages, restarting at page 1 on new params. `keepPrevious` on `useList` (default on) and `useInfiniteList` (opt-in), with `isPlaceholderData` on both results.
- **Streaming SSR in one call** (`./prefetch`): `streamQueries([...options])` starts the queries on a fresh per-request client and dehydrates at once (pending queries carry their promise, the client's `useSuspense*` hook resolves them during SSR); `prefetchQueries([...])` awaits them. `makeQueryClient()` (`./query-client`) is the per-request client; dehydration keeps pending queries and leaves error redaction to the framework. `./query-island`: `createQueryIsland(() => import("./x"))` server-renders a React Query section from that state and keeps React Query out of first-load JS until it activates (`when: "idle" | "visible" | "interaction"`).
- **Anonymous reads**: `auth: "omit"` per call (`RequestOptions`, hook options, factory `ctx`) and `readAuth: "omit"` per resource (`BaseApiConfig`, GETs only). Sends no Authorization, org, API/internal key or cookie, `credentials: "omit"`, never auth-refreshes, and is cached apart from signed-in reads, so arc's http-cache can share it at the CDN. An `organizationId` filter param is still sent. An explicit `auth: "inherit"` (hook, factory or call) overrides `readAuth` on the wire and in the key.
- **Identity partition in every key**: `{ auth, organizationId, scope }` (fixed shape) on list, infinite, detail, slug, count, presets, aggregation and route keys. Factories resolve it before building the key (`BaseApi.identity()`: client `getOrgId`, `configureAuth`, a forwarded `x-organization-id`, `readAuth`) and send that tenant; `queries.partition(ctx)` and `KEYS.lists(P)` name it for hand-written cache writes. Detail-to-list sync, list placeholders, optimistic writes, reconciliation and cache seeds stay in one partition (a private read never lands in an anonymous or other-tenant cache); invalidation reaches all.
- **Scoped invalidation**: `invalidateForChange(qc, keys, { op, id })` (and `cache.invalidateForChange`) refreshes lists, counts and aggregations plus only the written record's detail and slug variants; a delete drops the record's detail. CRUD writes and `useResourceSync` both use it. `usePendingWrites()` reads in-flight CRUD writes from `useMutationState`.
- **One tag rule**: `resourceTags(resource, id?)` is arc's http-cache rule (`<resource>`, `<resource>:<id>`); `arcTag` is `arc:` + it; `changeTags(event)` lists what a write invalidates.
- **`./edge-cache`** + **`./edge-cache/cloudflare`**: `edgePageHeaders({ routes, policy, reserved })` for `next.config` `headers()` (only listed routes; a dynamic first segment in any path-to-regexp form, `?` `*` `+` `(regex)` `{}` or mixed text, must exclude `reservedSegments(appDir)` or it throws; a literal alternation like `/:section(courses|practice)` is static; a route it cannot prove safe, or one left matching nothing, throws), `edgeRouteMatcher` for host tests (matches as Next does: path-to-regexp 6, case-insensitive), `createEdgePurger({ provider, coalesceMs })` (coalesced, never rejects, `after()`-friendly), `cloudflareEdge` / `cloudflareEdgeFromEnv` / `purgeEdgeHost` (deploy purge). `arc-next-edge purge --host <host> [--env-file <path>]` bin for CI: env wins over files, secrets redacted, exit 0/1; not an export.
- **React Native**: `./react-native` `setupReactNative({ appState, netInfo })` wires `focusManager` and `onlineManager` (modules injected, no hard dependency). `signInWithIdToken(authClient, tokens, { provider, idToken, nonce })` in `./auth-social`; its verifier and last-method storage are injectable (`storage`, `methodStorage`, `loadLastAuthMethod`). `check:rn-boundary` fails if an RN-facing subpath reaches a web, Next or Node-only module.
- `./devtools`: `QueryDevtools` lazy-loads TanStack devtools only when `enabled`.
- Typed `filters: FilterTerm[]` in list params, encoded with repo-core `formatQuery`; `PaginationMethod` derived from repo-core's wire types; `QueryClientOverrides.networkMode` (default `"offlineFirst"`); `QueryClientOverrides.retry` follows TanStack (`true` no limit, `false`, a count, a function; `true` used to mean one retry), quota 429s still never retry.

### ⚠ Removed (no legacy)

- `createCrudPrefetcher` and its option types (use the factories with `streamQueries` / `prefetchQueries`); `EntityReadApi` (now `EntityApi`).
- Token-first hook overloads `useList(token, params, options)`, `useDetail(id, token, options)`, `useInfiniteList(token, ...)`.
- `KEYS.scopedList`, `KEYS.scopedDetail`, `CacheUtils.*ScopedDetail`; the automatic `_scope: "tenant" | "super-admin"` key segment.
- Flattened `revalidate` / `tags` request options (use `next: { revalidate, tags }`); the `cursor` alias of `after`; `ListQueryOptions.prefillDetailCache`; `_scope` (now `scope`).
- `useMutationWithOptimistic` (use `useOptimisticMutation` or a factory's `mutationOptions`); the `/query` re-exports of `./cache` names; `ExtractData`; upload `isPending` alias (`isUploading`); `withOrgParams` (`./cache`).
- Envelope fallbacks arc no longer sends: list keys `items` / `results` / any-array, mongoose-paginate fields (`docs`, `totalDocs`, `totalPages`, `hasNextPage`, `currentPage`), `{ data: { count } }` verb envelopes, `fieldErrors` record/AJV shapes, `json.error` upload messages, object `details` in `errorDetails`. A paginated list needs `method`.

### Changed

- Source is organized by domain (`src/client`, `src/query`, `src/auth`, `src/realtime`, `src/platform`, `src/security`, `src/server`, `src/edge-cache`, `src/sdk`); every public subpath is unchanged.
- **Request headers merge case-insensitively** in three layers: client defaults (`defaultHeaders`, configured `getToken` / `getOrgId`, injected only when no header names them) < per-call headers < explicit options (`organizationId`, `token`, `idempotencyKey`, `elevated`). A `X-Organization-Id` header no longer reaches arc twice ("a, a"), and an explicit `organizationId` now beats a header one. Queued same-record writes keep the identity they were submitted with; the queue is per tenant. `useResourceSync` loads `./ws` on first use, like `./sse`.
- Update and `useAction` invalidate the written record's detail, not every detail. Query lint lane: `@tanstack/eslint-plugin-query` recommended-strict (`npm run lint:query`).
- **Tenant vs filter never alias**: the tenant comes from the configured org or the read's `organizationId` option / `ctx` and is keyed in the partition; an `organizationId` in params is a query-string filter (it was taken as the tenant, and dropped from anonymous reads). BaseApi and presets forward an explicit `null` (it was treated as "use the default").
- SSE: a failed lazy load of the header-auth transport is retried on the next connect instead of cached; connection state stays per subscription. Realtime tests pass in any order (`--sequence.shuffle`).
- Tests live in `tests/<domain>/` with Vitest projects (`jsdom`, `node`, `ssr`, `native`, `types`), a shared `tests/harness/` (test client, fake arc server on repo-core envelopes, storage, timers) and istanbul coverage thresholds. `npm run gate` is the one release gate: `prepublishOnly` and CI run it.

### Migration

| 0.21 | 0.22 |
|---|---|
| `createCrudPrefetcher(api, e).prefetchList(qc, params, opts)` | `streamQueries([hooks.queries.list(params, ctx)])` or `prefetchQueries([...])` |
| `prefetchDetail(qc, id, { token })` | `hooks.queries.detail(id, { token })` in the same call |
| `useList(null, params, { public: true })` | `useList(params, { public: true })`, or `{ auth: "omit" }` for an anonymous CDN-cacheable read |
| `useDetail(id, token, opts)` | `useDetail(id, opts)` (token from `configureAuth`) |
| `KEYS.scopedList(scope, params)` | `KEYS.list(params, { organizationId, scope })` |
| `KEYS.scopedDetail(id, org)` / `cache.setScopedDetail(qc, id, org, doc)` | `KEYS.detail(id, { organizationId: org })` / `cache.setDetail(qc, id, doc, { organizationId: org })` |
| `KEYS.detail(id)` read or written as the plain entry | `KEYS.detail(id, hooks.queries.partition())`; `KEYS.detail(id)` is only the prefix of every variant |
| `useNavigation` seeding the tenant-less detail too | it seeds only the reader's partition |
| a `headerOptions` `x-organization-id` overriding an explicit `organizationId` | pass the tenant as `organizationId`; it now wins over any header |
| `KEYS.custom("count" \| "deleted" \| "tree" \| "slug", ...)` | `KEYS.count()`, `KEYS.deleted()`, `KEYS.tree()`, `KEYS.slug()` |
| `KEYS.aggregation(name)` as a prefix | `KEYS.aggregations(name)` |
| `{ revalidate, tags }` request options | `{ next: { revalidate, tags } }` |
| `params.cursor` | `params.after` |
| `options._scope` | `options.scope` |
| `useMutationWithOptimistic(...)` | `useMutation(hooks.queries.update())` or `useOptimisticMutation(...)` |
| `import { createQueryKeys } from "@classytic/arc-next/query"` | `from "@classytic/arc-next/cache"` |
| `upload.isPending` | `upload.isUploading` |
| `res.docs` / `{ items }` mocks and custom routes | arc's `{ method, data, ... }` or a bare array |
| hand-rolled anonymous `fetch` for public reads | `createCrudApi(name, { readAuth: "omit" })` or `{ auth: "omit" }` |
| `useList({ organizationId: org, ... })` meaning the tenant | `useList(params, { organizationId: org })` (factory: `ctx.organizationId`); a param is now a filter |
| `api.x({ organizationId: null })` meaning "use the default" | omit it; `null` now sends no org header (same for `token`) |
| `KEYS.list(params)` read back as `{ organizationId, ... }` | `[entity, "list", { auth, organizationId, scope }, params]`: `KEYS.list(params, { organizationId })` |
| `withOrgParams(org, params)` | `KEYS.list(params, { organizationId: org })` |
| `useQuery({ queryKey: KEYS.custom("me"), queryFn: () => api.invokeRoute(...) })` | `useQuery(hooks.queries.route("/me"))`; writes: `routeMutation` |
| a host `use-cursor-pager` over `useInfiniteQuery` | `hooks.useCursorPager(params)` or `useCursorPager(query, resetKey)` |

### Added: social sign-in for bearer-token apps (`./auth-social`, `./google-one-tap`)

Client half of arc's `socialAuth()` plugin on Better Auth. Headless; additive.

- `startSocialSignIn(authClient, { provider, next, appOrigin })` sends absolute callback, error and new-user URLs (`next` checked by `safeNextPath`, open redirects fall back to `/`) and a one-time handoff challenge (base64url SHA-256 of a verifier kept 10 min in `sessionStorage`).
- `completeSocialSignIn(authClient | { baseURL }, tokens)` strips `#handoff` from the address bar, consumes the verifier once, exchanges it at `/social/handoff` and stores the token.
- `readSocialError(searchParams)` and `socialErrorIntent` / `socialErrorMessage` map Better Auth and provider codes to UI intents (`cancelled`, `link-required`, `expired-retry`, `signup-disabled`, `blocked`, ...).
- `getLastAuthMethod` / `setLastAuthMethod` (localStorage, SSR-safe) and `fetchSocialProviders(baseURL)` for Server Components (`[]` on failure).
- `useGoogleOneTap({ clientId, enabled, authClient, tokens })` (`"use client"`): loads Google's script when idle, prompts with FedCM and a nonce, posts to `/one-tap/callback`, stores the token. Loads through the `GOOGLE_ONE_TAP_POLICY` Trusted Types policy when one is enforced.

## 0.21.0 — 2026-11-03

### ⚠ Changed: the stream frame vocabulary is imported from repo-core, not from `@classytic/arc-next/sse`

Migration: `import { STREAM_FRAMES, type ReadyFrame, type ResyncFrame, type ResyncReason, type RetryFrame, type RevokedFrame, type StreamFrameName } from "@classytic/repo-core/sync"`. Same names, literals and shapes.

- `@classytic/repo-core` 0.38.0 owns the control-frame contract of a resumable stream, so arc's replay hub and this client read one definition (their `retry` docs had already drifted). `./sse` no longer exports `STREAM_FRAMES` or the seven frame types; `subscribeToEvents` and `useEventStream` behave exactly as in 0.20.
- Peer floor `@classytic/repo-core` `>=0.29.0` → `>=0.38.0`: `./sse` now imports `STREAM_FRAMES` from `@classytic/repo-core/sync` at runtime. The other peer floors from 0.20 are unchanged (`react >=19.0.0`, `@tanstack/react-query >=5.52.1`, `jose >=4.8.1`).

## 0.20.0 — 2026-11-03

### Added: `./service-worker` (register a worker, offer a waiting update)

`useServiceWorker({ url, scope, checkEveryMs, enabled })` registers a service worker with
`updateViaCache: "none"` and returns `{ updateReady, applyUpdate }`. A new worker installs and waits;
the page decides how to offer the reload, and `applyUpdate()` posts `SKIP_WAITING_MESSAGE`
(`{ type: "SKIP_WAITING" }`) to the waiting worker and reloads once it controls the page. A first
install is not reported as an update. Because the browser looks for a new worker only on navigation,
a long-open page also checks when it becomes visible again and every `checkEveryMs`. Framework-free
halves: `watchServiceWorker(options, onUpdateReady)` and `applyServiceWorkerUpdate(registration)`.
`"use client"`, no dependencies; what the worker caches stays with the host. Additive.

### Added: `errorDetails(error)` (`./sdk/errors`)

Reads a refusal's structured context (`422 { missing: [...] }`, `{ field }`, `429 { retryAfterSeconds }`)
so hosts stop hand-rolling `error.json.meta ?? error.json.details`. arc serializes a thrown error's
`details` object as the envelope's `meta`, so `meta` is read first and an object `details` (older or
non-arc backends) is the fallback; the validation `details` array stays with `ArcApiError.details` /
`fieldErrors`. Returns `Readonly<Record<string, unknown>> | undefined`, works on any error carrying a
`json` body, never throws. Additive; no existing export changes.

### Changed: peer floors lowered to what the code needs

0.19 raised every peer floor to the version used in development, not to what the code needs. That
blocked apps pinned to React 19.2 (Expo SDK 55 / React Native 0.83). New ranges, each proven by
installing that exact version and running `typecheck`, `typecheck:tests`, the full test suite,
`build` and `check:fixtures`:

| Peer | 0.19 | Now | Why this version |
|---|---|---|---|
| `react` | `>=19.3.1` | `>=19.0.0` | No React API newer than 19.0 is used (tested with `react` / `react-dom` 19.0.0 and `@types/react` 19.0). |
| `@tanstack/react-query` | `>=5.105.0` | `>=5.52.1` | First 5.x release whose own `react` peer range accepts React 19 (5.52.0 and earlier: `^18.0.0`). |
| `@classytic/repo-core` | `>=0.36.0` | `>=0.29.0` | First release exporting `ARC_ERROR_CODES`, `ARC_REASON_CODES`, `ArcReasonCode` and `DUPLICATE_KEY_DETAIL_CODE` from `./errors` (0.28.0 fails `typecheck`). |
| `jose` (optional) | `>=6.2.14` | `>=4.8.1` | First release whose types resolve under `moduleResolution: NodeNext` (4.8.0 fails `typecheck`). Uses `CompactEncrypt`, `compactDecrypt`, `importPKCS8`, `importSPKI` only. |

Dev toolchain refreshed (repo-core 0.37, vitest 5.1, knip 6.44); the peers above are deliberately not raised with it.

`react`, `@tanstack/react-query` and `@classytic/repo-core` stay required (`optional: false`);
`jose` stays optional.

- `createCacheUtils().setDetail` / `setScopedDetail` now pass `<T>` to `setQueryData` explicitly.
  Without it, older react-query releases (seen on 5.62.0) infer the cache type from the arrow's
  `void` return and fail to type-check. No runtime or declaration change.
- New `npm run check:peer-floors` (`scripts/check-peer-floors.mjs`): copies the repo into a temp
  dir, installs every peer at its exact floor (read from `peerDependencies`, so it cannot drift),
  and runs the five steps above. It needs the npm registry, so it is not in `npm test` or
  `prepublishOnly`; CI's `peer-minimums` job now runs it (the job previously hard-coded stale
  minimums: react-query 5.62.0, repo-core 0.14.0, jose 5.0.0), and it is a documented release
  step (README "Peer ranges").

### Added: resumable, alarm-grade SSE (`./sse`, `./sse-fetch`)

The client half of one realtime contract shared with arc's replay hub (`@classytic/arc/utils`).
Every option is optional; with none set, `subscribeToEvents` and `useEventStream` behave exactly as
in 0.19 (same listeners, same backoff curve, same `onConnectionChange` sequence).

- `STREAM_FRAMES` (`{ READY: "ready", RESYNC: "resync", REVOKED: "revoked", RETRY: "retry" }`) and the
  frame types `StreamFrameName`, `ResyncReason`, `ReadyFrame`, `ResyncFrame`, `RevokedFrame`,
  `RetryFrame`. The literals match
  arc's; they become re-exports of `@classytic/repo-core/sync` once the repo-core peer floor is raised
  to a version that ships them (owner decision; no floor change here).
- `SubscribeToEventsOptions`: `resumeFrom` (cursor for the first connect), `resumeQueryParam` (query
  mode: send the cursor as `?<param>=`), `onActivity(at)` (open, every frame, every chunk including
  heartbeat comments), `staleAfterMs` (silence → `stale`, close, reconnect with the cursor),
  `backoff { initialMs, factor, maxMs, jitter, random }` (`min(maxMs, initialMs * factor^(n-1)) *
  (1 - jitter * random())`; defaults reproduce the 0.19 curve; a non-positive or non-finite
  `initialMs` / `maxMs` falls back to the default, `factor` clamps to >= 1 and `jitter` to 0..1),
  `terminalEvents` / `terminalStatuses` / `onTerminal` (end the subscription, health `revoked`;
  statuses are checked before auth recovery and, on the native `EventSource`, read from the failure
  probe, which then runs on every failure rather than once), `onReady`, `onResync({ cursor,
  reason: ResyncReason | "initial" })` and `onStatus(StreamStatus)`.
- `terminalEvents` defaults to `[STREAM_FRAMES.REVOKED]` once the stream opts into resume (below),
  `[]` otherwise (0.19). Pass `terminalEvents: []` to keep reconnecting after `revoked`. This is a
  client-side stop: the server must still refuse a revoked client's reconnects.
- Client rules: `ready` and `resync` never reach `onEvent` (unless the caller lists the name in
  `eventTypes` itself). A `ready` with a `cursor` and `resumed: false`, on a connection that sent no
  cursor, sets the cursor and calls `onResync({ reason: "initial" })`; a `resync` sets the cursor and
  calls `onResync` with the server's reason: once per server signal, so an `initial` and a later
  `resync` on one connection each call it. These listeners are attached once the stream opts into
  resume (`resumeFrom`, `null` included, `resumeQueryParam`, `onReady` or `onResync`), so the
  default listener set is unchanged. A frame without `id:` (which repeats the transport's previous
  id, or reports `""` on a transport that was not seeded with the sent cursor) never overwrites the
  cursor.
- `retry` (arc's replay hub sends it when a periodic `revalidate` fails transiently, then closes):
  on a live stream the client reconnects from its current cursor after a random 0-500 ms wait
  (`backoff.random`), with no backoff step and no attempt counted; health is `connecting` until the
  new connection is live, and the server's close after the frame is not treated as a failure (no
  probe). A `retry` before the stream went live takes the normal backoff, so a server answering
  every connect with `retry` cannot drive a tight loop. Attached with the other control frames once
  the stream opts into resume; never reaches `onEvent` or `onTerminal`.
- An id-only frame (`id: <cursor>`, no data; arc's replay hub sends one after entries a viewer is
  not shown) moves the resume cursor without reaching any listener, as WHATWG specifies.
  `status().lastEventId`, a `stale` reconnect, `reconnect()` / `restart()`, a terminal frame and
  `close()` read it from the transport (`FetchEventSource.lastEventId`); the native `EventSource`
  does not expose it.
- `staleAfterMs` on the runtime's native `EventSource` (none injected) logs one warning per
  subscription outside production: heartbeat comments are invisible there, so a quiet stream
  cycles every `staleAfterMs`.
- `SubscribeToEventsHandle` gains `status()` and `restart()` (reconnect after `revoked` or
  `close()`). New types `StreamHealth` (`connecting | live | stale | offline | revoked | closed`),
  `StreamStatus`, `StreamBackoff`, `StreamResyncInfo`, `StreamTerminalInfo`.
- `useEventStream` passes the new options through and returns `status`. With `shareAcrossTabs`, the
  leader relays its status and the `ready` / `resync` / terminal frames over `BroadcastChannel`, so
  each follower runs its own `onReady` / `onResync` / `onTerminal` against its own cache, and a tab
  that joins later receives the current status with the connection state. On a resumable stream an
  effect re-run (leader handoff, `enabled` toggle, option change) resumes from the last cursor the
  hook reached on that stream (relayed events carry the leader's cursor, so a tab taking over after
  the leader died resumes too), not from the `resumeFrom` prop. When a revoked leader lets go,
  followers keep `revoked` instead of `offline`.
- `StreamStatus.lastStatus` holds failure statuses only (`0` or >= 400); a stream that ended with
  200, or a probe answering 2xx, does not set it. Health becomes `offline` once
  `maxReconnectAttempts` is exhausted, also after a `stale` timeout.
- `createSseParser` handler `onActivity()`: once per non-empty `push()`, comment-only chunks
  included (comments were dropped silently). `initialLastEventId` seeds the last event ID buffer
  (WHATWG keeps it across reconnects); `FetchEventSource` passes the `Last-Event-ID` it sent.
  `EventSourceInitLike.onActivity` (an init callback, so it cannot clash with a server event name):
  `FetchEventSource` calls it per chunk after `open`; the native `EventSource` ignores it. A
  throwing callback does not break the stream.

### Added: CSP `frameSrc` and `createProxy` `requestHeaders` (`./csp`)

- `CspInput.frameSrc?: "none" | readonly string[]`. `"none"` emits `frame-src 'none'`; combining it
  with non-empty `embedOrigins` or `extra["frame-src"]` throws a config error. An array replaces the
  built-in `'self'` / storage / API list (embed and `extra` origins still merge; an empty result is
  emitted as `'none'`). Absent: output identical to 0.19.
- `connect-src blob:` is documented and tested through `extra: { "connect-src": ["blob:"] }`; it
  stays out of the default policy.
- `CreateProxyOptions.requestHeaders?: ({ request, nonce, dev }) => Record<string, string | null> |
  undefined`: extra headers on the forwarded request, applied
  after the incoming headers are copied and before `x-nonce` and the CSP are set; `null` deletes a
  header. `x-nonce` and `content-security-policy` (any case) are dropped from its result, so the
  minted values cannot be replaced. The response is unchanged. Incoming headers pass through unless
  set or deleted, so a browser-sent trust hint (surface, tenant) reaches server components: always
  set or delete every hint the app reads.
- `frameSrc` array entries must be single source expressions: an entry with whitespace, `;` or `,`,
  an empty one, or `'none'` inside an array throws (it would inject a directive or contradict itself).

### Added: opt-in hook for session-state 403s (`./client`, `./sdk/init`)

A 403 can mean the session's state changed rather than "not allowed" (a second factor became
required after a deploy). The SDK recovered 401s but had no hook for those, so a tab left open
showed the error until reload.

- `AuthConfig.onSessionChange?: SessionChangeHook` with `SessionChangeHook { match(error:
  ArcApiError): boolean; handler: AuthErrorHandler }`. Only 403s whose parsed error passes `match`
  (usually a check on `error.code`) reach `handler`, which has the `onAuthError` contract
  (`"retry"` / `"skip"` / throw, `setToken`, 1-indexed `attempt`). Unset: behaviour identical to
  0.19.
- Concurrent matched 403s share one handler call. Recovery dedup is now per handler, so a 401
  refresh and a step-up in flight at once never replay each other's decision (401 dedup across
  fetch, upload, WebSocket and SSE is unchanged).
- A matched 403 goes to `onSessionChange` even with `retryOn403: true`; unmatched 403s keep the
  existing path. `maxAuthRetries` caps each family separately, so a 401 refresh followed by a
  step-up on the same request both run.
- Scope: the JSON client (`executeRequest`: CRUD hooks, `arcFetch`, `handleApiRequest`, actions,
  routes). Uploads and streams keep 401 recovery only.
- `SdkConfig.onSessionChange` (`./sdk/transport`), passed through by `initSDK`.
- `SessionChangeHook` added to `api-surface.json` (addition only).

### Added: live on the `ready` frame (`./sse`, G-E2E-PORTAL-1)

A resumable stream reported `live` on the transport's `open` (the response headers), while arc's
replay hub sends `ready` only after joining the log and reading the gap: on a slow database a screen
showed Live for hundreds of milliseconds during which a drop cost it the replay.

- `SubscribeToEventsOptions.liveOn?: "open" | "ready"`. `"ready"`: health turns `live` on the
  connection's `ready` frame; until then it stays `connecting` (or `offline` / `stale` on a
  reconnect) and `attempts` keeps counting. Default: `"ready"` once the stream opts into resume
  (`resumeFrom`, `resumeQueryParam`, `onReady`, `onResync`), else `"open"` (0.19, unchanged for
  plain streams). `liveOn: "ready"` opts into resume itself; pass `"open"` for a resumable server
  that sends no `ready` frame. `onConnectionChange` / `isConnected()` keep following the transport.
- `SubscribeToEventsOptions.maxResumeFailures?: number` (default 3, `0` off, ignored with
  `liveOn: "open"`): connections in a row that sent the same cursor, opened and ended before
  `ready` (error or `stale`) make the next connect send no cursor, so the server answers a fresh
  `ready` and `onResync({ reason: "initial" })` reloads the snapshot (the arc-next half of
  G-E2E-1: a cursor the server cannot serve no longer keeps the stream down).
- `useEventStream` passes both through; with `shareAcrossTabs` followers mirror the leader's
  ready-gated health. Once the cursor is dropped (own status or the leader's relay), the hook's
  carried cursor goes with it: a leader handoff or an `enabled` toggle before the fresh `ready`
  starts fresh instead of resuming from the dropped cursor or the `resumeFrom` prop.
- `useEventStream({ enabled: false })` reports `health: "closed"`, also in a follower, which
  otherwise kept the leader's last health (e.g. `live`). Tests: `tests/sse-cross-tab.test.ts`.

### Fixed: `runAction` / `useResourceAction` infer types from the descriptor (`./sdk/*`, G-PORTAL-1)

- The descriptor parameter now keeps the phantom `__input` / `__result` markers
  (`Pick<ActionDescriptor<TInput, TResult>, "verb" | "__input" | "__result">`, plus `"messages"` for
  `useResourceAction`), so `runAction(api, d, id, input)` resolves to `d`'s result instead of
  `unknown`, and the payload is checked against `d`'s input (an argument such as
  `deviceId ? { deviceId } : {}` for `{ deviceId?: string }` now compiles). Type-only: verb-only
  objects still compile, and so do explicit type arguments, including ones that differ from a typed
  descriptor's markers (`runAction<{ a: string }, Doc>(api, untypedDescriptor, id, { a })`): a
  second overload keeps the 0.19 `Pick<…, "verb">` (`"verb" | "messages"`) signature for them.
  Without type arguments only the inferring overload applies, so a payload that does not fit the
  descriptor is still an error. Tests: `tests/sdk/actions-types.test.ts` (`typecheck:tests`) and
  `fixtures/next-consumer/golden-server.ts`.

### Added: per-call request options on the descriptor runners (`./sdk/actions`, `./sdk/hooks`, `.`)

- `runAction(api, d, id, input, options?)`: `RunRequestOptions` (`idempotencyKey`, `signal`,
  `headerOptions`) after the payload reach `dispatchAction`'s `options`, never the body. A
  no-payload verb passes `undefined` in the payload's place
  (`runAction(api, d, id, undefined, { idempotencyKey })`). New type `RunActionArgs<TInput>`;
  `RouteApi.dispatchAction` args gain an optional `options`. Calls without options are unchanged
  (no `options` key reaches `dispatchAction`).
- `useResourceAction(hooks, d, { requestOptions })` and `useRouteAction(hooks, api, d,
  { requestOptions })`: `requestOptions(variables)` is read for each `mutate` / `mutateAsync`, so a
  key minted per sheet opening (closure) or carried in the variables is sent per call. Route verbs
  pass it to `runRouteAction`'s `options` (the descriptor's `body` still decides what is sent).
- `createCrudHooks().useAction` variables accept `options` (the `BaseApi` request options without
  the auth fields) and pass them to `dispatchAction`; `ActionHooksLike` mutate variables gain the
  same optional field.
- Tests: `tests/sdk/actions.test.ts` (recorder and a real `BaseApi`: `Idempotency-Key` header, body
  without the key), `tests/sdk/hooks.test.tsx`, `tests/sdk/actions-types.test.ts`.
- FLOW OCC: `apps/portal/src/sdk/occurrences/api/occurrences.ts` drops its `dispatchAction` /
  `invokeRoute` calls for the keyed writes and uses `runAction` / `runRouteAction` with options.

### Added: `dataUpdatedAt` on list results (`./query`, `.`, G-W2REC-3)

- `ListQueryResult.dataUpdatedAt` (TanStack's `dataUpdatedAt`: when this list's own data last
  landed, `0` before the first answer), from `useListQuery`, `useSuspenseListQuery` and every
  `createCrudHooks` list hook (`useList`, `useDeleted`, `useTree`, `useChildren`). A list screen can
  print "Updated 14:02" from its own read instead of a sibling query. Declared optional so code
  that builds a `ListQueryResult` itself (adapters, test doubles) still type-checks; the hooks always
  set it. Test:
  `tests/hooks.test.tsx` "dataUpdatedAt".

### Added: `compareCursors`, each data frame once in cursor order (`./sse`, G-INT-1)

- `SubscribeToEventsOptions.compareCursors?: (a, b) => number` (and `useEventStream`, read through
  a ref, so an inline function does not reconnect): a data frame whose id compares at or below the
  last delivered one is a repeat and never reaches `onEvent` (nor the cross-tab relay). The floor
  starts at `resumeFrom`, follows each delivered frame, and is set by `resync` and by a fresh
  `ready` cursor (`onResync({ reason: "initial" })`), also downwards. Frames with no id pass. Same
  comparator as arc's `createReplayHub({ compareCursors })`. Default off: 0.19 delivery unchanged.
- Caveat (documented): the transport repeats the previous id on a frame without `id:`, so with
  `compareCursors` every data frame must carry its own id (arc's replay hub writes one per entry).
- Tests: `tests/sse-resumable.test.ts` "compareCursors" (repeats on one connection, an
  at-least-once replay after a reconnect, a resync lowering the floor, off by default).
- FLOW OCC: `apps/portal/src/features/realtime/alert-stream.ts` drops its own applied-sequence
  bookkeeping (`applied`, `sequenceOf`, the repeat checks).

### ⚠ Fixed: `responseType` is read; per-request `idempotencyKey` on `BaseApi` options (`./client`, `./api`, `./sdk/actions`, G-EL-P1, G-EL-P2, G-OCC-P4)

- `RequestOptions.responseType` was declared and never read: `invokeRoute({ options: { responseType:
  "text" } })` still answered a `text/*` body as `{ data: text, response }`, and `"blob"` answered
  `{ data: blob, response }` (a CSV, a PDF) although callers typed it `Blob`. `ApiRequestOptions`
  gains `responseType` and the client honours it on a 2xx: `"text"` answers the body string,
  `"blob"` the `Blob`, `"json"` the parsed body (`undefined` when empty), whatever the
  `Content-Type`. An encrypted response is decrypted first, as before; errors are unaffected.
  Omitted: the 0.19 content-type rules, unchanged.
- Migration (⚠ only for callers that passed `responseType: "blob"` and read `.data`): drop the
  `.data` (`D:/projects/it/somriddhi/apps/web/api/qr-api.ts` `pdf()` and its `downloadBlob(res.data)`
  callers). Callers that typed the answer `Blob` now get one (`brihot/apps/web/api/transactions-api.ts`
  `exportTransactionsCsv`, commerce-bd-sdk `getStatement` CSV).
- `RequestOptions` (what `BaseApi` methods, `invokeRoute` and `dispatchAction` take in `options`)
  declares `idempotencyKey`, sent as `Idempotency-Key` (`ApiRequestOptions` already had it; the
  value flowed at runtime but did not type-check, so callers sent the header by hand in
  `headerOptions`). `runRouteAction(api, d, input, options?)` forwards per-call `RunRequestOptions`
  (`idempotencyKey`, `signal`, `headerOptions`); `RouteApi.invokeRoute` accepts `options`.
  `runAction` / `useResourceAction` / `useRouteAction` take per-call options too (see "per-call
  request options on the descriptor runners" above).
- Tests: `tests/request-options-response-type.test.ts`.
- FLOW OCC removals once this ships: `textOf` in `apps/portal/src/sdk/event-log/api/event-log.ts`
  (`me.text` becomes `invokeRoute<string>({ ..., options: { responseType: "text" } })`);
  `idempotencyHeader` (occurrences sdk) and `idempotencyOptions` (records sdk) become
  `options: { idempotencyKey }`.

### Changed: `useRealtimeSync({ source: "sse" })` loads `./sse` on first use (`.`, `./hooks`)

- `createCrudHooks(...).useRealtimeSync` imports the SSE client dynamically (as `./sse` already does
  with `./sse-fetch`), so `.` and `./hooks` no longer ship `sse.ts`: 45,310 B gz, down from the
  56,996 B the resumable SSE had pushed them to. The subscription opens one module load after
  mount; a failed load is rethrown during render, so it still reaches an error boundary. WebSocket
  sync is unchanged.

### Fixed

- `subscribeToEvents`: a `close()` while the failure probe or `onAuthError` recovery was in flight
  could still schedule a reconnect afterwards and reopen the stream; it no longer does. A manual
  `reconnect()` cancels a pending scheduled reconnect instead of connecting twice. A probe or auth
  recovery that outlives its connection (`reconnect()`, `restart()`, the stale watchdog) no longer
  acts on the newer one (closing it, ending it as `revoked`, or reconnecting again), and an `error`
  from a superseded transport is ignored.
- Header mode (`FetchEventSource`): the parser started every connection with an empty last event
  ID, so the first frame without `id:` after a reconnect (a heartbeat-only line, a `ready` frame)
  erased the cursor and the next reconnect sent no `Last-Event-ID`, losing events the server could
  have replayed. 0.19 had this too. The parser is now seeded with the sent cursor, and
  `subscribeToEvents` ignores an empty id. Behaviour change: a server `id:` with an empty value no
  longer clears the client cursor; a server that needs a reset sends a new id (or `resync`).

### Notes

- No migration needed for 0.19 callers: the new options are opt-in. Two fixes change behaviour for
  everyone, both toward the documented contract: an empty `id:` no longer clears the resume cursor
  (send a new id or `resync` to move it), and `lastStatus` no longer reports 2xx. Hosts with a
  hand-rolled resumable SSE client (heartbeat watchdog, jittered backoff, resync / revoked
  handling) can replace it with the options above; a host that wants to keep reconnecting after a
  `revoked` frame on a resumable stream passes `terminalEvents: []`.
- Bundle budgets: `.` and `./hooks` stay at 0.19's 53.5 kB gz (45,310 B with `./sse` loaded
  lazily, see above). `./sse` raised 28 → 30.5 kB gz (29,963 B), then → 31 kB for `compareCursors` (30,644 B): the resumable stream code,
  `liveOn` and the status / control-frame relay live in the `sse.ts` closure and cannot move out
  of the subpath that exports them. `api-surface.json` regenerated (additions and
  optional fields only).
- App interims to delete once this release is installed:
  - G-E2E-PORTAL-1: FLOW OCC `apps/portal/src/features/realtime/alert-stream.ts`: delete the
    `gate` / `ready` / `shown` live gating and map arc-next's `status` directly (ticket
    E2E-PORTAL-1). Its test "an open line is not live before its ready frame" keeps passing
    against arc-next.
  - G-PORTAL-1: FLOW OCC `apps/portal/src/sdk/alerts/api/alerts.ts`: delete the typed `dispatch()`
    wrapper and call `runAction(crud, alertActions.<verb>, id, input)` directly (ticket PORTAL-1).
  - G-INT-1: FLOW OCC `apps/portal/src/features/realtime/alert-stream.ts` (the hand-rolled
    resumable client on `createSseParser`) can move onto `subscribeToEvents` / `useEventStream`
    with the options above (ticket INT-1).
- Adopting repo-core's `errorKind` in `isValidationError` and friends waits for the repo-core peer
  floor to be raised to a release that ships it (owner decision).

## 0.19.0 — 2026-10-30

### Added — portal bootstrap and SDK core subpaths

Generic code extracted from two production Next.js portals. Additive: no existing export changed. The
host supplies every origin, name and schema.

- `./runtime`: `definePublicEnv({ globalName, read })` (server reads `process.env`, the root layout writes a nonce'd script, the browser reads it back), `publicEnvScript` escaping `<` and U+2028/2029, `trimSlash`, `csv`, `serializeForScript`.
- `./csp`: `contentSecurityPolicy` (nonce, `strict-dynamic`, Trusted Types in production, host-supplied api / storage / map / embed origins, `extra` per directive), `TRUSTED_TYPES_DEFAULT_POLICY`, `originOf` / `originsOf` / `hostOrigins`, `createNonce`, and `createProxy({ NextResponse, policy })` for Next's `proxy.ts` (no `next` import: the host passes `NextResponse`).
- `./auth-proxy`: `createAuthProxy({ upstream, internalUpstream })` route-handler factory (hop-by-hop filtering, every `set-cookie` preserved, `redirect: "manual"`, configurable 502 body, per-request upstream).
- `./sdk/transport`, `./sdk/init`, `./sdk/messages`, `./sdk/error-capture`, `./sdk/errors`, `./sdk/actions`, `./sdk/hooks`, `./sdk/resource`, `./sdk/download`, `./sdk/route`, `./sdk/localized`: SDK core. `defineRouteAction` / `useRouteAction` / `useQuietRouteAction`, `useRouteQuery` / `useRouteList` (`enabled`, `placeholderData`), message-KEY toasts with a host `messages` resolver and `listMessageKeys` (key prefix configurable), server `code` / `details` in the message context, a streamed `createDownloader` reporting a truncation header, trailing-slash normalization, `localizedName`, `createIsolatedClient`, `initSDK`, `defineSdkResource`. Composes `./client`, `./api`, `./mutation`, `./hooks` and `./auth-gate`; duplicates none of them.
- `api-surface.json` regenerated (additions only); bundle budgets added for the new subpaths. Tests: `tests/runtime.test.ts`, `tests/csp.test.ts`, `tests/auth-proxy.test.ts`, `tests/sdk/`.
- Agent skill rewritten for the current API only (`skills/arc-next/SKILL.md` plus `references/*.md`, `llms.txt`), covering the new subpaths. `npm run check:skills` (`scripts/check-skills.mjs`, also run by `tests/skills.test.ts` and `prepublishOnly`) fails on size budgets, unknown subpaths / imports / identifiers, banned wording and drift between `llms.txt` and the SKILL.md table. Golden paths are type-checked in `fixtures/next-consumer/golden-*.ts*`.

### Changed — peer floors to the latest published

`@classytic/repo-core >=0.36.0`, `@tanstack/react-query >=5.105.0`, `jose >=6.2.14`, `react >=19.3.1` (`react`, `@tanstack/react-query` and `@classytic/repo-core` required; `jose` optional). These floors were higher than the code needs; lowered in the next release (see [Unreleased]). Dev toolchain: tsdown `^0.23.4`, Biome 2.6 (its new `noComponentHookFactories` rule is off: this package is a hook factory by design), knip 6.44. The declaration snapshot hashes were regenerated for tsdown 0.23.4's declaration formatting; no exported name was added, removed or renamed by it.

## 0.18.0 — 2026-10-18

### Added — React Native as a supported runtime

`ClientConfig.eventSource` injects the SSE transport (e.g. `react-native-sse`); unset falls back to
`globalThis.EventSource`. `ClientConfig.streamAuth: 'header'` sends `Authorization` /
`x-organization-id` as EventSource headers (and on the failure probe) instead of `?token=` in the
URL; it refuses to connect without an injected implementation rather than leak the token into the
URL. New types `EventSourceConstructor`, `EventSourceLike`, `EventSourceInitLike`,
`EventSourceEventLike`. SSE now consumes `open` / `message` / `error` through `addEventListener`
(the contract both implementations share), not `on*` properties. `tests/runtime/react-native.test.tsx`
runs the core surface under React Native globals as part of `npm test`.

### Added — `./sse-fetch`: header-authenticated SSE in the browser

`FetchEventSource` is a dependency-free `EventSource` over streaming `fetch` that satisfies
`EventSourceConstructor`: request headers, `credentials` from `withCredentials`, `Accept:
text/event-stream`, WHATWG-conformant parsing (`event`, multi-line `data`, `id` with NULL
rejection, digits-only `retry`, comments, CRLF / LF / CR across chunk boundaries, BOM),
`addEventListener` / `removeEventListener` + `onopen` / `onmessage` / `onerror`, `readyState`,
`lastEventId` (sent as `Last-Event-ID`), `reconnectionTime`, and `close()` aborting the fetch. It
never reconnects itself; its `error` event carries the response `status` (`0` = none) and `headers`.
Also exported: `createSseParser` (the incremental parser) and the types `FetchEventSourceInit`,
`FetchEventSourceEvent`, `SseParsedEvent`, `SseParser`, `SseParserHandlers`.

`streamAuth: 'header'` with no injected `eventSource` now uses `FetchEventSource` wherever `fetch`
can stream, instead of throwing, so a browser keeps the bearer token out of the stream URL (access
logs, proxies). It is a dynamic import, so `./sse` consumers on the native `EventSource` do not pay
for it (`./sse` budget unchanged). React Native (`navigator.product === 'ReactNative'`), whose
`fetch` cannot stream, still requires an injected `eventSource` and still throws without one.

`subscribeToEvents` keeps owning reconnect and backoff, and now: sends `Last-Event-ID` (header
mode) with the last id the subscription saw; classifies a failure from `EventSourceEventLike.status`
when the transport reports it (401 / 403-with-`retryOn403` → `onAuthError` with the real status,
429 → `Retry-After`, anything else → backoff) instead of sending the HEAD / Range-GET probe, which
remains the path for the native `EventSource`. `EventSourceEventLike` gains optional `status` and
`headers`. Pinned by `tests/sse-fetch.test.ts`; the React Native simulation now sets
`navigator.product`.

### ⚠ Changed — no SDK `cache` default

`BaseApi` no longer defaults `cache` to `'no-store'`; `cache` is sent only when the call, the
instance (`BaseApiConfig.cache`) or the deployment (`ClientConfig.cache`) sets it. React Native's
whatwg-fetch turned the default into `?_=<timestamp>`, which arc's strict query validation rejects
(every list call 400'd). Next.js 15+ leaves `fetch` uncached unless it opts in, so it did not need
the default. To keep the old behaviour: `configureClient({ cache: 'no-store' })`.
`BaseApi.config.cache` is now optional.

### Fixed

- `useEventStream` never connected without `localStorage` / `BroadcastChannel` (React Native):
  `useTabLeader` now leads when there is no storage to coordinate through, and the stream only
  shares across tabs when a `BroadcastChannel` relay exists.
- `useCount` ignored the auth gate and fired token-less; it now uses the same enable rule as every
  read hook (and accepts `public`).
- `createEntityQueries().infiniteList` sent a keyset cursor as `page`; it now sends `after`, and
  starts from a caller's `after` like `useInfiniteList`.
- `useSuspenseList` built its key without `withOrgParams`, splitting the cache from `useList` and
  the factories when `organizationId: null` was passed.
- SSE failure probes were budgeted per subscription and never reset, so a long-lived stream
  stopped diagnosing drops (429 included) after the first; a successful open now resets it.
- Idempotency keys called `crypto.randomUUID()` unguarded; `_uuid()` falls back to
  `crypto.getRandomValues` and throws a clear error when there is no random source.

### Changed — build tooling

`tsdown` 0.23 (types are emitted as inline `export interface X`, not a trailing `export { }` list), `typescript` 7, `vitest` 5. `scripts/check-api-surface.mjs` reads both forms; the snapshot's names are unchanged and only the `typesHash` values moved.

## 0.17.0

### Added — keyset `PaginationData.prev` / `end`

`normalizePagination` carries a keyset page's `prev` cursor (send it back as `before`) and `end`
beside `next` and `hasPrev`, so a list can page backwards. Pinned by `tests/pagination-keyset.test.ts`.

### Added — `PaginationData.totalIsEstimate` / `countedAt`

`normalizePagination` carries mongokit's estimate flag (`false` when absent) and count time, so a
list's `pagination` tells the UI to render "10,000+" (fluid `DataTable` reads both). Pinned by
`tests/pagination-estimate.test.ts`.

### Added — bearer-token sessions: `./auth-token`

`createTokenStore(storage, key)` keeps the bearer token behind a synchronous `get()` for
`configureAuth({ getToken })`, over any storage — `localStorage` (read at once) or a device's
asynchronous secure storage (`load()` once). `bearerFetchOptions(tokens)` is the Better Auth client
`fetchOptions` that sends it and keeps the token the server issues (`set-auth-token` header, then
the body's `token`). One implementation for every arc app on Better Auth, web or device.

### Added — server caches: `onArcChange` (`./events`) and `arcTag` (`./cache`)

`createCrudHooks` reports every successful create, update, delete and restore to listeners
registered with `onArcChange`, with the document as this client last saw it (`previous`). A
delete's response carries only an id, so `previous` is how a listener still reaches the deleted
document's parent; it is read before the optimistic update drops it from the lists. `arcTag`
names server-cache tags for a resource, a record or a scoped collection, so the read that is
cached and the write that invalidates it use one string. A listener failure is logged, never
fails the write. Both subpaths are server-safe.

### Added — `queryAuthEnabled` (`./auth-gate`) and `initialData` on `useList` / `useDetail`

`queryAuthEnabled({ public?, enabled? }, client?)` is the generated hooks' enable rule
(`authGate`) for queries written with `useQuery` directly, so a per-user query stops firing (and
401-ing, and refreshing auth) for signed-out visitors. `user: true` marks an endpoint that answers for the signed-in
user (`/mine`): it needs a token even when static auth (`internalApiKey`) is configured. `initialData` + `initialDataUpdatedAt` seed a
list or detail with the response a Server Component fetched for the same params.

### Added — `ClientConfig.fetch`: the transport slot

`configureClient({ baseUrl, fetch })` / `createClient({ ..., fetch })` sends every request through
the supplied `(url, init) => Promise<Response>` instead of the runtime `fetch`. Serve the API
in-process (an offline till's device store, a test double) while envelope parsing, `ArcApiError`,
auth, retry and interceptors still run, so a local answer reaches callers exactly as a server's
does. Uploads (XHR), SSE and WebSockets do not go through it.

### Fixed — `createAuthAwareClient` dropped global config fields

It rebuilt its per-request config from a fixed field list, so `fetch`, `cache`, `timeoutMs` and
`encryption` set with `configureClient` were silently ignored by every request made through it —
which is every request an SDK built on `BaseApi` makes. It now starts from the whole global config
and applies explicit overrides on top.

### Fixed — query-string encoding the servers silently misread

- **A `Date` is sent as ISO-8601.** A top-level `{ createdAt: date }` used to emit NOTHING (the
  filter vanished and the read widened); as an operand it emitted locale text, which arc 2.42 /
  mongokit 3.40 refuse with a 400. Arrays of dates are encoded the same way.
- **`populateOptions[].match` is sent in bracket form** (`populate[p][match][field]=value`). The
  JSON string it used to send was ignored by every server parser, so the populate matched every
  document. A match is field equality only, and the servers refuse operators or nested objects.

### Added — `./server`: call arc as the signed-in user from the server

`createRequestClient({ baseUrl, headers: await headers() })` builds a per-request client that
forwards the incoming request's `cookie`, `authorization`, `x-organization-id`, `accept-language`
and trace headers — the server's `fetch` carries none of the browser's cookies — and never
hop-by-hop headers (`host`, `content-length`, …). `forwardRequestHeaders(headers)` gives the same
set for prefetchers' per-call `headers`. Framework-agnostic (`get(name)` sources). A `<Hydrate>`
wrapper was considered and not added: `prefetch` + `dehydrate` + `HydrationBoundary` is already
the three-line TanStack pattern, re-exported from `./prefetch`.

### Changed — error codes come from the repo-core catalog, not a hand-copied list

`KNOWN_ARC_ERROR_CODES` spreads `ERROR_CODES`, `ARC_ERROR_CODES` and `ARC_REASON_CODES` from
`@classytic/repo-core/errors` — the contract arc emits from and tests against — instead of
copying strings. The copy had drifted: it was missing `arc.precondition_failed` (412 stale
`If-Match`), the three idempotency codes, `arc.circuit_open`, `arc.payload_too_large` and every
`arc.auth.*` / aggregation code, and still listed `ORG_ROLE_REQUIRED` / `OWNERSHIP_DENIED`, which
arc no longer emits. The client-synthesized realtime codes are named in `CLIENT_ERROR_CODES`.
⚠ Peer `@classytic/repo-core` >=0.31.0 (browser-safe `./errors` catalogue, reserved `before` / `mode` list params).

### Added — optimistic concurrency (`versionField` → `If-Match`)

`createCrudApi(entity, { versionField: '__v' })` makes `update` send `If-Match: "<version>"`, so
arc refuses a write based on a stale read (`412 arc.precondition_failed`) instead of overwriting
a change made in between. The version is the one the EDIT was based on — explicit `version`, then
`data[versionField]`, then the cached document — never simply the cache at submit time, which a
background refetch may have advanced past what the user saw. It is resolved inside the per-record
write chain, so a second queued update uses the version the first returned. `version: null` sends
no precondition ("save anyway"). `isPreconditionFailed(err)` identifies the conflict; the failed
write rolls back and refetches like any other. `BaseApi.versionOf(doc)` reads the field. arc's
resource manifest publishes `versionField` (and the true `idField`), so both can come from it.

## 0.16.1

### Fixed — release gate had been silently broken since 0.16.0

`0.16.0` shipped without updating `api-surface.json` (so `check:api-surface`
was comparing against a stale pre-tab-leader snapshot) or the bundle-size
budgets in `scripts/check-bundle-size.mjs` for the `shareAcrossTabs`
(BroadcastChannel leader election) code it added to `./sse` and `./ws`, and
without a budget entry for the new `./tab-leader` subpath at all. Several
files also had CRLF line endings invisible to `git diff` (committed blob
stays LF; a tool that rewrites the working copy leaves Biome reporting a
whole-file diff that never says "line endings") and one `useEffect`'s
dependency array carried three entries (`queryClient`, `trackLastEvent`,
`trackEventCount`) already covered by `applyEvent`, which already depends on
them — flagged by Biome but suppressed with a stale `// eslint-disable`
comment Biome doesn't read. All fixed; `prepublishOnly`'s 11 gate steps now
pass clean.

### Changed — `@classytic/repo-core` peer floor raised to `>=0.28.0`

Was `>=0.24.0`, several releases stale.

### Fixed — count queries went stale after every CRUD write

`useActions`/`useBulkActions`/`useCreate`/`useUpdate`/`useDelete`/`useRestore`
invalidated `KEYS.lists()` and `KEYS.aggregations()` on write but never
`KEYS.custom("count")`, so a count query rendered a header/badge that drifted
from reality until something else happened to invalidate it. Every mutation
path (including the realtime broadcast handler) now invalidates counts
alongside lists and aggregations.

### Fixed — `configureClient()`'s server-side warning fired on every SSR call, including the safe ones

The warning covered the whole config object, so a Next.js SSR fetcher setting
only `baseUrl`/`basePath` — deployment constants, identical for every
request — got warned on every cold start exactly as if it had set a
per-request `beforeRequest`/`afterResponse` interceptor or `defaultHeaders`.
A warning that fires on the correct usage trains people to ignore it, which
defeats its purpose for the case it actually exists to catch. Now scoped to
`REQUEST_VARYING_CONFIG_KEYS` (`beforeRequest`, `afterResponse`,
`defaultHeaders`) — the closures/headers that can capture per-request state
into the module-level singleton.

### Fixed — a fixed `messages.error` string discarded the server's field errors

`showToast` treated a caller's `messages.error` string as the whole toast, so
an `ArcApiError` carrying `fieldErrors` (or a quota meter) rendered as the bare
headline: "Failed to record COD settlement" hid the server's own
`cashAccount: must be equal to one of the allowed values`, and the operator was
left to guess at a form the response had already explained. The string is now
the HEADLINE and the actionable detail is appended after a colon. A function
message keeps full control, and a call with no message still gets the detail
alone as before. Pinned in `tests/mutation.test.ts`.

## 0.16.0

### Added — `./tab-leader` subpath

`useTabLeader({ key, enabled? })` elects exactly one leader tab per browser per
key using `localStorage` coordination: the leader writes a heartbeat every
`1500ms`; any tab may claim leadership once that heartbeat goes stale (`>5s`);
a closing tab releases it immediately. Modelled on Odoo's
`multi_tab_fallback_service`. When storage is unavailable every tab reports
leader — the feature degrades rather than disappears, and the server-side
concurrency cap is the backstop for the duplicate connections that allows.

### Added — `shareAcrossTabs` option on `useEventStream` (default: `true`)

Holds ONE SSE connection per browser instead of one per tab. The elected tab
(via `useTabLeader`) connects and relays events and connection state over
`BroadcastChannel`; followers mirror both at zero socket cost.

`isConnected` on a follower tab reflects the shared socket's state — critical
because callers gate polling on it (`refetchInterval: isConnected ? false : …`).
A follower that assumed `true` would stop polling while nothing was delivering;
one that assumed `false` would poll while live. Set `shareAcrossTabs: false` for
a stream that must be per-tab.

### Fixed — 429 rate-limit handled by SSE reconnect

`probeConnectionFailure` (renamed from `probeForAuthFailure`) now returns a
discriminated union that includes `rate-limited` alongside `auth-failure`. On
`429` the reconnect is scheduled at the server's `Retry-After` value (parsed as
delta-seconds or HTTP-date), falling back to `60s` — not at the exponential
backoff curve that retries inside the window and refills the bucket on every
attempt.

`scheduleReconnect` accepts an explicit `delayMs` override so the probe's number
reaches the timer without being clamped by the curve.

### Fixed — probe now runs without an `onAuthError` handler

The connection-failure probe was gated on an auth handler being registered, so a
deployment with no `onAuthError` handler fell straight to backoff on every
failure — including 429, where backoff is self-defeating. The probe now runs
unconditionally; auth recovery is still guarded by the handler check.

## 0.15.1

- `ClientConfig.basePath` — deployment-level route prefix; `getBasePath()` exported from client
- `BaseApi.basePath` / `BaseApi.baseUrl` — converted to lazy getters; resolves per-read so a package's internal API instance constructed before `configureClient()` still picks up the declared prefix (fixes silent 404 on hosts not mounted at `/api/v1`)

## 0.15.0 (2026-08-26)

### Added — `refetchInterval` / `refetchIntervalInBackground` as resource-level config

Both were already supported **per call** (`useList(params, { refetchInterval })`).
They can now be declared once on the resource config, so a resource whose
freshness matters states it in one place instead of at every call site — and
cannot be forgotten at one of them. A per-call value still wins; the config is
the default (`queryOpts.refetchInterval ?? config.refetchInterval`).

The case that motivated it: an orders dashboard left open on a shop counter.
Push notifications are best-effort, so the list is the **authoritative** path to
a new order — but with no interval it fell back to `refetchOnMount` /
`refetchOnWindowFocus`, and a window that never blurs never refocuses, so it may
never refetch at all. A missed push then reads as a missing record.

`refetchIntervalInBackground` defaults to TanStack's `false`. Leave it off
unless the data must be current the instant the operator returns: a hidden tab
polling forever is load nobody is reading, and `refetchOnWindowFocus` already
catches up on return.

## 0.14.1 (2026-08-22)

### Added

- **Resource-level polling defaults** — `CrudHooksConfig` now accepts `refetchInterval` and `refetchIntervalInBackground` as resource-level config. Previously these had to be passed at every call site (`useList(params, { refetchInterval })`); declaring them once on the resource ensures no call site can accidentally omit them. Per-call values still win (`??` merge — an explicit per-call `false` disables polling even when the resource default is set). Motivated by long-lived order dashboards where `refetchOnWindowFocus` is insufficient (a window that never blurs never refocuses).

## 0.14.0 (2026-08-15)

### Changed — `@classytic/repo-core` peer floor `>=0.14.0` → `>=0.24.0`

The floor now matches the version this package is built and tested against.
`>=0.14.0` was satisfiable by ten releases the suite has never run on — an
untested lower bound that reads to a consumer as a support claim.

No source change. The contracts arc-next imports are unaffected:
`pagination/types` and `query-parser/types` are byte-identical between 0.19.0
and 0.24.0, and `/errors` changed only by ADDING the conflict taxonomy
(`VersionConflictError`, `IsTransientConflictFn`, `neverTransient`,
`isVersionConflictError`, `conservativeMongoIsTransientConflict`). Nothing was
removed or narrowed.

### API surface (classified: additive, no narrowing)

Seven subpaths report changed declaration CONTENT with no name changes — the
additive `/errors` export list above flowing through arc-next's emitted
declarations. No exported name was removed and no signature narrowed; the
snapshot is refreshed accordingly.

## 0.13.0 (2026-08-01)

### Added

- **`BaseApiConfig.client` accepts a provider thunk `() => ArcClient`** in
  addition to a retained instance. Re-resolved on every request so a consumer
  SDK can swap or reconfigure the underlying client after APIs are constructed —
  no Proxy tricks or stale-capture bugs. A retained `ArcClient` still binds at
  construction; omitting `client` falls through to the module-global transport.
- **`arc.tier_required` error code** added to `KNOWN_ARC_ERROR_CODES`.
- **`isTierRequiredError(error)`** — discriminates a tier/capability gate refusal
  from a role `arc.forbidden` so the frontend can render an "upgrade required"
  surface without string-matching the message.
- **`getTierRequirement(error)`** — extracts `{ requiredMode, currentMode }` from
  the error's machine-readable `meta` (falls back to `details`) so the UI never
  hard-codes a route→tier map.
- **`TierRequirement` interface** — `{ requiredMode: string; currentMode?: string }`.
- **`ClientConfig.cache`** — client-level default `RequestCache` mode applied to
  every request that expresses no caching intent of its own (no per-call `cache`,
  `revalidate`, or `next`). Per-call options still win; ISR opt-ins are never
  clobbered.

## 0.12.0 (2026-07-22)

Production-readiness wave: canonical repo-core contracts, hardened optimistic/bulk
cache behavior, executor-level pipeline guarantees, and arc-grade release gates.

### Timeouts, retry pacing & quiet defaults (release-candidate review fixes)

- **`timeoutMs`** — client-level (`ClientConfig.timeoutMs`) and per-request
  (`ApiRequestOptions.timeoutMs`, `0` disables) request timeout. A hung fetch is
  aborted and surfaces as a RETRYABLE `TimeoutError`, distinct from a deliberate
  caller abort (still `AbortError`, still silent). Composed with the caller's
  signal; each retry attempt gets a fresh window. Default: disabled — set it
  explicitly (10–30s typical).
- **Upload timeouts actually work** — `uploadWithProgress` gained `timeoutMs`
  and now ASSIGNS `xhr.timeout`; the pre-existing `ontimeout` handler could
  never fire without it (XHR defaults to 0 = no timeout). Rejects with
  `TimeoutError` including the configured window.
- **`retry.jitter: 'full'`** — AWS full-jitter (`[0, computed]`) so fleets
  recovering from one outage don't retry in lockstep. Default stays
  deterministic. **`Retry-After` is honored**: 429/503 responses carrying the
  header (delta-seconds or HTTP-date) are parsed onto the new
  `ArcApiError.retryAfterMs`, and the retry loop sleeps exactly that long
  instead of computed backoff.
- **Silent default toast.** The default handler no longer writes `[Success]`/
  `[Error]` to the consumer's console on every mutation — a library must be
  quiet until `configureToast` opts in. Errors still propagate normally.
- **React act() warnings are now test FAILURES.** A vitest setup file turns
  "not wrapped in act(...)" into a failure of the offending test; the 21
  warning sites in upload/realtime/aggregate tests were fixed (async-`act`
  around XHR/WS/SSE event emission and mutation settlement).
- **`lint` (Biome) + `check:dead-code` (Knip)** added to `prepublishOnly` and
  CI; knip config cleaned (dropped satisfied `ignoreDependencies`, removed the
  unused `@testing-library/jest-dom`).

### Contracts — repo-core 0.14 alignment (peer bump)

- **Peer `@classytic/repo-core` >=0.14.0** (was >=0.4.0); the declared minimum is
  now exercised by a dedicated CI job, not asserted.
- **`KNOWN_ARC_ERROR_CODES`** spreads repo-core's `ERROR_CODES` instead of
  re-typing the 11 canonical codes — a repo-core code rename now surfaces as a
  compile/test failure instead of silent drift.
- **`SortDirection`** = repo-core `SortDirection` (`1 | -1`) + `'asc' | 'desc'`;
  **`PopulateOption`** = `Pick<ParsedPopulate, 'path' | 'select' | 'match'>` —
  derived, not re-declared.
- **`cursor` → `after` rewrite** — `QueryParams.cursor` was an SDK-only alias the
  server never understood; `prepareParams` now rewrites it to the canonical
  `after` (explicit `after` wins). Dispatch verbs (`_count`/`_exists`/`_distinct`)
  are runtime-locked against repo-core's `STANDARD_RESERVED_PARAMS`.
- New `tests/type-contracts.test.ts` pins all of the above at the type level.

### Optimistic & bulk cache hardening

- **Infinite caches are first-class.** `updateListCache` now recognizes
  `{ pages, pageParams }` and maps per-page — previously the any-array fallback
  treated `pages` ITSELF as the items array, so an optimistic create on a
  resource with an infinite list cache spliced the item BETWEEN pages (cache
  corruption). New `prependToListCache` (insert into first page only) and
  `replaceItemInListCache` (in-place swap by id) exported from `./cache`.
- **Temp-ID reconciliation.** `useActions().create` inserts one `_optimistic`
  placeholder (lists only), then on success swaps it IN PLACE for the server
  document and seeds `KEYS.detail(realId)` — no flicker, real id immediately
  navigable, before any refetch.
- **Detail-cache envelope bug fixed.** Optimistic update merged into a
  `{ data: … }` sub-object that arc 2.13+ detail caches don't have; it now
  merges the raw doc. The updater is key-aware (`optimisticUpdate(old, vars,
  queryKey)`) — detail caches of the target id get a doc merge, list caches get
  per-item mapping, aggregation caches are never touched (previously the
  optimistic create was also injected into aggregation `rows`).
- **Exact rollback** now snapshot/restores exactly what was written (unchanged
  entries are no longer rewritten — fewer spurious re-renders).
- **Per-record write ordering.** Sequential `update`/`remove`/`restore` calls to
  the SAME record are chained (call order = server order); different records
  stay parallel; a failed write doesn't block the next.
- **Last-standing invalidation.** CRUD writes share a mutation key; settled
  invalidation fires only from the LAST pending write (`isMutating === 1`) —
  rapid writes produce one refetch, and an early write's refetch can never
  clobber a later write's optimistic state.
- **Bulk partial success.** `bulkUpdate` with `modifiedCount: 0` and
  `bulkRemove` with `deletedCount: 0` skip invalidation entirely;
  `bulkCreate` seeds detail caches from the returned documents.

### Pipeline & server story

- **Executor-level `autoIdempotency`.** The `Idempotency-Key` is minted once
  per logical request at the top of the executor — direct `BaseApi` calls are
  covered (previously mutation-hook-only), and every backoff/auth retry reuses
  the same key. GET/DELETE excluded; explicit keys win.
- **`createServerClient` (`./client`)** — request-scoped server client for
  Next.js App Router / SSR: static per-request credentials, no module
  singletons, no `next` dependency, no hidden cookie access (the host reads
  `cookies()`/`headers()` and passes values in).
- **`upload.ts` is now `"use client"`.** It always used React hooks; the missing
  directive let Server Components import it and fail at runtime instead of
  being flagged as a client reference (caught by the new server-import gate).

### Release gates (ported from arc)

- `check:package` (publint --strict + attw esm-only), `check:api-surface`
  (per-subpath runtime+types name diff + declaration hashes, snapshot in
  `api-surface.json`), `check:server-import` (server-safe subpaths must import
  in plain Node and reach no `"use client"` module), `check:bundle` (gzip
  budgets per subpath), `check:fixtures` (Next App Router + Vite consumer
  fixtures type-checked against the built dist) — all chained into
  `prepublishOnly`. New GitHub Actions CI: Node 20/22 matrix + a
  **peer-minimums job** that installs the exact declared minimums
  (react 19.0.0, @tanstack/react-query 5.62.0, repo-core 0.14.0, jose 5.0.0).

## 0.11.1

- **`MutationMessages<TData, TVariables>`** — success/error callbacks now
  receive typed result and variables instead of `unknown`, so toast factories
  like `success: (result) => result.name` typecheck without casts. Backwards-
  compatible: the unparameterised form defaults to `MutationMessages<unknown, unknown>`.
- **`useAction`** return type narrowed to `TransitionMutationReturn<TResult, …>`
  (was `unknown`).
- **`useSearchEngine` / `useSearchSimilar`** return types narrowed to
  `TransitionMutationReturn<TResult[] | PaginatedResult<TResult>, …>`
  (were `unknown`).
- **`useCustomMutation`** `messages` option typed with the hook's own
  `TData` / `TVariables` generics.

## 0.11.0 — arc 2.22 parity

- **Global auth auto-injection on the default request path** (`handleApiRequest`): direct `BaseApi` calls (`invokeRoute`, `aggregate`, `getAll`, … outside hooks) now inherit `configureAuth()` token + orgId exactly like the query hooks and per-client instances — previously they fired unauthenticated and burned a 401 → `onAuthError` refresh → retry cycle per call (3× round-trips; the "post-login loading storm"). Contract: `undefined` = inherit, explicit `null` = deliberately public, explicit value wins. Pinned by `tests/global-auth-injection.test.ts`; `ApiRequestOptions.token`/`organizationId` JSDoc documents the three-state semantics. **Behavior change**: callers that relied on direct calls being unauthenticated-by-default must pass `token: null` at the request-options level.
- **Dispatch verbs**: `api.count()` / `api.exists()` / `api.distinct(field)` + `useCount` hook — arc's `?_count=true` family on the list route (same permissions/filters/tenant scoping, ZERO documents fetched). Defensive envelope parsing.
- **`withHistory` preset** (`./presets/history`): `api.history(id, { limit, offset })` for arc 2.22 `history: true` audit timelines (`HistoryEntry`/`HistoryPage` wire types).
- **Typed quota 429s**: `isQuotaExceeded(err)` + `getQuotaDetails(err)` (`{ kind, used, limit, period, resetsAt }`); mutation toasts render the meter ("50 of 50 export.runs used — resets 8/1"); the shared query client NEVER retries `quota.exceeded` even when host retries are enabled (retry is now a guard function — cap semantics unchanged).
- **Wire-type convention** documented (README): `createCrudApi<T>` takes kernel WIRE types, never mongoose doc types.
- **`llms.txt`** ships in the package — push-based agent guidance ("hand-rolled fetch against an arc API is a bug"), mirroring arc 2.22's server-side move.


## 0.10.0

### Fixed — SSR hydration: `organizationId: null` no longer splits the cache

TanStack's `hashKey` keeps `null` values in the hash but drops `undefined`.
Hooks that resolved `organizationId: null` (unauthenticated / public storefront
callers) produced a DIFFERENT cache key from server prefetchers that omitted the
field entirely — silently defeating SSR hydration and causing a full client
refetch on every page load.

New `withOrgParams(organizationId, params)` helper (`cache.ts`) normalises the
key: when `organizationId` is nullish the field is OMITTED from the params
object rather than included as `null`. Applied across every read hook — `useList`,
`useInfiniteList`, `useDetail`, `useTree`, `useChildren`, `useBySlug`,
`useDeleted` — so hook keys and server-prefetch keys now match by construction.
Covered by `tests/key-parity.test.ts`.

### Added — `CrudHooksConfig.defaultPublic`

Declare a resource's read endpoints as public (`allowPublic` on the arc server)
once at hook-factory time instead of per call-site. When `defaultPublic: true`,
token-less reads are enabled by default — callers on unauthenticated pages (public
storefront product listings, category pages, brand pages) never need to remember
`{ public: true }` on every `useList`/`useDetail`. An explicit per-call `public`
or `enabled` still wins. Auth-gated resources (cart, orders, account) are
unaffected — `defaultPublic` is opt-in and defaults to `false`.

### Added — `@classytic/arc-next/query-options` subpath

Server-safe **queryOptions factory** following the TanStack v5 query-factory
convention. `createEntityQueries(api, entityKey)` returns `{ list, detail,
infiniteList, tree, children, bySlug }` helpers — each produces a
`{ queryKey, queryFn }` pair usable anywhere TanStack accepts options objects:

```ts
const products = createEntityQueries(productApi, 'products');

useQuery(products.list({ limit: 20 }))
useSuspenseQuery(products.detail('p1'))
queryClient.prefetchQuery(products.list({}, { token }))   // RSC prefetch
queryClient.ensureQueryData(products.detail('p1'))        // router loader
queryClient.setQueryData(products.detail('p1').queryKey, next)
```

Keys are built from the same primitives as `createCrudHooks` (`createQueryKeys`
+ `withOrgParams`), so a factory-seeded server cache always hydrates the
corresponding client hook — enforced by `tests/key-parity.test.ts`.

### Added — `@classytic/arc-next/field-encryption` subpath

Client-side decryption for arc's field-mode application-layer encryption
(`@classytic/arc/encryption` with `mode: 'fields'`). Field-mode responses stay
`application/json`; only the configured field values arrive as authenticated
`arc.v1.<kid>.<iv>.<ct>.<tag>` envelopes (AES-256-GCM). This subpath parses
and decrypts those envelopes via **Web Crypto** — zero dependencies, works in
Node 22+, Bun, Deno, and React Native.

**SECURITY — trusted runtimes only.** Field mode is symmetric: whoever holds
the key can decrypt every envelope ever produced. The key belongs in a Node BFF
or Server Component. This subpath must **never** be imported in a browser bundle.
For payloads a browser must decrypt, use `@classytic/arc-next/encryption` (JWE
asymmetric path). Fail-closed: unknown `kid`, tampered ciphertext, or a malformed
token throws — an encrypted field is never silently passed through.

## 0.9.1

### Fixed — `getTree` no longer paginates the hierarchy

The `withTree` preset's `getTree()` merged the API's list `defaultParams`
(`limit`/`page`) into the tree request "for parity with `getChildren`/`getAll`".
That's wrong by contract: a **tree is the full hierarchy, not a paginated list**.
At best it emitted a dead query string (`GET /:resource/tree?limit=10&page=1`);
at worst, a backend that *honours* `limit` on its tree route would silently
**truncate the hierarchy to the first page** — a latent data-loss footgun.

`getTree()` now passes only the caller's explicit `params` (e.g. a `depth` or
filter, if the resource supports one). `getChildren()` is a real paginated level
and is unchanged. **Behaviour change, not a signature change** — callers that
relied on pagination on the tree endpoint (they shouldn't have) must pass those
params explicitly now.

## 0.9.0

### Fixed — presets now COMPOSE (generic-preserving)

Each `withX(api)` previously returned `BaseApi<TDoc> & XMethods`, which widened
the input back to a bare `BaseApi` — so chaining presets, or composing a preset
over a subclass with custom methods, silently dropped every other method **at
the type level**. `withSearchPreset(withBulk(withSlugLookup(withSoftDelete(api))))`
typed as just `BaseApi & SearchPresetMethods`.

All five presets (`withSlugLookup`, `withSoftDelete`, `withBulk`, `withSearchPreset`,
`withTree`) are now generic over the API type:

```ts
export function withSlugLookup<TApi extends AnyBaseApi>(
  api: TApi,
): TApi & SlugLookupMethods<DocOf<TApi>>
```

So presets stack and the resource's own methods survive. New type helpers
exported from `@classytic/arc-next/api`: `AnyBaseApi`, `DocOf`, `CreateOf`,
`UpdateOf`. **Backward-compatible** — a single-preset call returns the same
shape it always did. Locked in by `tests/presets/compose.test.ts` +
`npm run typecheck:tests`.

### Added — first-class Next.js App Router fetch options

`RequestOptions` / `ApiRequestOptions` / `ArcFetchOptions` now accept the
idiomatic `next: { revalidate, tags }` object — passed verbatim as
`fetch(url, { next })` — so a Next host can hand it 1:1 with what they'd give
`fetch`. The flattened `revalidate` / `tags` still work and are merged
(flattened `revalidate` wins; `tags` are unioned). `revalidate` now accepts
`false` (cache indefinitely). `cache` continues to pass through. Locked in by
`tests/next-fetch-options.test.ts`.

## 0.7.1

### Fixed — `createAuthAwareClient()` reads `configureClient()` lazily

Previous revisions snapshotted `getBaseUrl()` / `getAuthMode()` /
`isAutoIdempotency()` at construction time and froze the result. That
bit hard in real apps: `createAuthAwareClient()` typically runs at
module-load (top of `api.ts`), but `configureClient({ baseUrl })` runs
LATER inside a `'use client'` provider's `useState` initializer. The
frozen `baseUrl` was `''` → every request hit a relative URL → 404
cascade against the dev server / Vercel function origin instead of
the API.

Now: per-call `request` reads the latest global config every time.
Token rotation, `baseUrl` set-after-load, `authMode` flipped via
reconfigure — all pick up automatically. The only fields that
snapshot are overrides explicitly passed in (an opt-in "I want a
different transport" signal).

Lock-in: `tests/lazy-baseUrl.test.ts`.

### Changed — query internals follow the same lazy-config rule

`src/query.ts` reaches for the resolved client at call time so query
keys / fetcher functions honour the latest `baseUrl` and auth fields
without relying on the closure captured at hook construction. No public
API change.

## 0.7.0

Fixes a real-world "`useDetail` never fires a GET" bug and the silent disable
of every protected query when the app authenticates via a global API key.
Adopts the canonical TanStack `placeholderData` pattern for list→detail
handoff (no more cache pollution, no more clobber loops). Promotes the
async-`getToken` signal from `console.warn` to a stack-traced `console.error`
so the misuse can't ship to production unnoticed.

### Breaking — cache envelope removed

The detail cache now stores **raw documents** matching arc 2.13+'s wire
shape, not the legacy `{ data: TDoc }` envelope. Every internal write path
converges on the same shape: `useDetail` queryFn, `prefetchDetail`,
`cache.setDetail` / `setScopedDetail`, and `useNavigation` all write `TDoc`.

**You don't need to change anything if you only consume `useDetail().item`,
`useDetailBySlug().item`, or `cache.getDetail()` — those continue to return
the raw doc as before** (the bug was that `useDetail` already returned the
envelope-shaped value via the identity `extractItem`, so consumers were
already coding against `TDoc`-or-`{ data: TDoc }` ambiguity).

You **do** need to update code that reads cache directly via the bare
`queryClient.getQueryData(KEYS.detail(id))` and expected the envelope:

```diff
- const cached = qc.getQueryData(KEYS.detail(id)) as { data: TDoc } | undefined;
- const item = cached?.data;
+ const item = qc.getQueryData<TDoc>(KEYS.detail(id));
```

### Breaking — `useList` no longer prefills the detail cache

The old setQueryData-based prefill ran inside a `useEffect` with an unstable
`detailKeyBuilder` dependency, which (1) blocked the real detail GET from
firing because of the default 5min `staleTime`, (2) wrote a wrong-shape
envelope that didn't match real GET responses, and (3) re-ran on every
list render, silently clobbering successful detail-fetch results with the
stale list payload. The fix is on the read side: `useDetail` /
`useDetailBySlug` now read list cache via `placeholderData`. Consumers see
an instant list-shaped preview, the real detail GET always fires, and the
cache stays clean.

- `ListQueryOptions.prefillDetailCache` is now a no-op (kept for compile-time
  back-compat; safe to remove from caller code).
- `useListQuery` no longer accepts `prefillDetailCache`, `detailKeyBuilder`,
  or `itemIdResolver` — these were the plumbing for the old broken prefill.

### Added — `isPlaceholderData` on `DetailQueryResult`

Use to dim or label the instant preview while the real GET resolves:

```tsx
const { item, isPlaceholderData } = useDetail(id);
return <article aria-busy={isPlaceholderData}>{item?.title}</article>;
```

### Added — `findItemInListCache`

```ts
import { findItemInListCache } from '@classytic/arc-next/query';
```

Exported helper that walks every `[entity, 'list', ...]` cache entry
(including infinite-query `pages` arrays) and returns the first matching
item by id. `useDetail` uses it internally as a `placeholderData` factory;
exported in case you need it for custom hooks.

### Fixed — `hasStaticAuth` now reads global `configureClient` too

Previously only inspected per-client config. An app authenticating via a
global `internalApiKey` or `defaultHeaders` saw every protected query stuck
in a permanently-disabled state. Added `hasGlobalStaticAuth()` to
`@classytic/arc-next/client` and OR'd it into the enable rule.

### Fixed — async `getToken` failure is now loud

`configureAuth({ getToken: async () => ... })` is a misuse — tokens MUST
resolve synchronously. Before 0.7 the dropped Promise produced a single
`console.warn` then silently disabled every authenticated query
(`isLoading: false, item: null` — indistinguishable from a clean empty
state). 0.7 logs a real `Error` instance via `console.error` so dev tools
surface a stack trace pointing at the offending `configureAuth` site.

### Added — 401 → refresh → retry interceptor

Lazy auth recovery wired into the SDK transport. When the backend returns
401 (or 403, with `retryOn403: true`), the optional `onAuthError` handler
fires, refreshes the token via your auth library, and arc-next replays
the request transparently. Default off — apps that don't wire it see
401s surface immediately as before, no behavior change.

```ts
import { configureAuth, createAuthRefreshHandler } from '@classytic/arc-next/client';

configureAuth({
  getToken: () => authClient.getSession().data?.session.token ?? null,
  onAuthError: createAuthRefreshHandler({
    refresh: async () => {
      const { data } = await authClient.getSession({ disableCookieCache: true });
      return data?.session.token ?? null; // null → truly expired; original 401 surfaces
    },
  }),
});
```

**Concurrent dedup.** When N requests hit 401 simultaneously, the handler
fires **once**; every concurrent caller awaits the same refresh promise
and retries with the token it produces. No stampeding the refresh
endpoint under burst auth-expiry. Verified end-to-end against a live JWT
backend with 5 concurrent expired-token requests → 1 refresh call.

**Cross-transport coverage.** Auth recovery fires across every transport
arc-next exposes — concurrent failures across mixed transports collapse
to a single `onAuthError` call (shared dedup):

| Transport | Trigger | Mechanism |
|---|---|---|
| Fetch (CRUD hooks, `arcFetch`, `handleApiRequest`) | 401 / 403 | Outer retry loop in `executeRequest` |
| XHR upload (`uploadWithProgress`) | 401 / 403 | Outer retry loop in `upload.ts` |
| WebSocket | close code `1008` / `3401` / `4001` / `4401` | `ws.onclose` → recovery → reconnect with refreshed token |
| SSE (`subscribeToEvents`) | `EventSource.onerror` | Pre-flight `fetch` probe → recovery → reopen |

Tuning knobs:
- `retryOn403: boolean` — also recover from 403 (default: 401 only)
- `maxAuthRetries: number` — cap per individual request (default: 1)
- `createAuthRefreshHandler({ onRefreshError: 'throw' })` — propagate
  refresh-fn errors instead of skipping back to the original 401

Types: `AuthErrorContext`, `AuthErrorHandler` exported from
`@classytic/arc-next/client`.

### Added — `arcFetch` + `arc.{get,post,patch,delete}` helpers

One-line authenticated fetch for non-hook contexts (event handlers,
service workers, server actions, custom MDX submits) — collapses the
5-concern boilerplate (auth header, org header, content-type, error
throw, JSON parse) into one call. Composes with `onAuthError`, the 5xx
retry loop, and the `beforeRequest`/`afterResponse` interceptors —
nothing has to be rewired.

```ts
import { arc } from '@classytic/arc-next/client';

// Before: 15 lines (manual headers, manual error parse, manual JSON)
// After:
const result = await arc.post<{ ok: boolean }>('/api/statements', statements);
```

Body sniffing handles `FormData`, `Blob`, `ArrayBuffer`,
`URLSearchParams`, `ReadableStream`, and `string` (passed through —
caller-controlled `Content-Type`); plain objects and arrays are
auto-`JSON.stringify`'d with `application/type: application/json`.

Protected headers — `Authorization`, `x-organization-id`,
`x-internal-api-key`, custom `headerName` for header-auth mode — cannot
be overridden by `options.headers`. A caller can't accidentally strip
auth by passing a custom header map.

Escape hatch for the rare full-control case:
```ts
import { arcAuthHeaders } from '@classytic/arc-next/client';
const res = await fetch(url, { headers: { ...arcAuthHeaders(), 'X-Custom': '1' } });
```

### Added — pseudo-normalization via `syncDetailToLists`

After a fresh `useDetail` (or `useDetailBySlug`) GET resolves, arc-next
walks every list cache that contains the item and shallow-merges the
new field values in-place. The list view picks up the latest values
without needing a refetch, and stays consistent with whatever the
detail page just rendered.

```ts
import { syncDetailToLists, createQueryKeys } from '@classytic/arc-next/cache';

// Most consumers never call this directly — it's wired by default into
// `useDetail` / `useDetailBySlug`. Exposed for custom hooks + tests.
// Vocabulary note: `item` matches the rest of arc-next's consumer API
// (`useDetail().item`, `useList().items`, `extractItem`, `getItemId`,
// `findItemInListCache`). The backend-facing `TDoc` generic in
// `BaseApi<TDoc>` / `Repository<TDoc>` is the same entity at the type
// layer — `item` is the runtime noun.
syncDetailToLists(queryClient, KEYS.lists(), freshItem, { idField: 'sku' });
```

**Design notes (load-bearing):**

- **Direction is one-way: detail → list, never the reverse.** List
  payloads are typically a SUBSET of detail (apps trim fields with
  `select=...` for list perf), so a list → detail merge would overwrite
  rich detail-cache values with the trimmed list versions. Mutations
  still propagate from lists to detail via `useActions.update`'s
  existing fan-out — that path is safe because mutation data is
  authoritative.
- **Shallow-merge preserves the receiver's key set.** Detail-only fields
  (populated relations, full body) never bleed into list caches —
  list-cache entries stay LEAN. No memory bloat.
- **Never creates new cache entries.** Only updates entries that already
  exist. (Creating new entries was the 0.6 prefill bug that this entire
  release was originally diagnosing.)
- **Skipped during placeholder render.** When `useDetail` shows a list-
  cache placeholder via `placeholderData`, we don't re-fan-out the
  placeholder back to lists — would be a no-op merge but burns CPU.

**Memory + CPU profile:**

- Memory cost: zero new entries; merge preserves entry sizes.
- CPU cost: O(L × M) per detail fetch, where L = matching list caches
  and M = average items per list. For typical apps (5–10 caches × 50–500
  items), <1ms. For 10k-row admin tables, ~5ms — still well below a frame.
- This is **pseudo-normalization, not the real thing**: copies still exist
  in memory, GC is still per-query. For Apollo/Relay-style entity
  normalization (one copy per entity ID, field-level invalidation, GC
  by reference count), use Apollo Client or Relay. arc-next stays
  opinionated about its niche: REST + React Query with a tiny runtime
  and zero codegen.

### Fixed — `updateListCache` short-circuits on no-op updaters

When an `optimisticUpdate` updater returns the same `items` array
reference (the canonical "I didn't actually change anything" signal),
`updateListCache` now returns the original wrapper unchanged instead of
allocating a fresh outer object. Eliminates spurious `setQueryData`
writes + the re-render cascade they trigger. Required for
`syncDetailToLists` to accurately report "did anything change".

### Fixed — `Authorization` no longer sent in `authMode: 'cookie'`

The fetch path used to add `Authorization: Bearer <token>` even when
`authMode` was `'cookie'` — redundant with the cookie, and tripped
servers (Better Auth's session validator among them) that strictly
enforce one auth mechanism per request. Aligned with `upload.ts` and
`arcAuthHeaders()` which already skipped the header in cookie mode.

### Fixed — WebSocket reconnect cascade

Closing the previous socket inside `connect()` (during a reconnect) fired
its `onclose` handler, which scheduled another reconnect — creating two
sockets per reconnect cycle. The cascade resolved in the browser because
sockets transition `CONNECTING → OPEN` fast enough to win the race, but
was visible on slower networks and in tests. Now nulls `onclose`/`onerror`
/`onmessage`/`onopen` before closing the old socket so the cascade is
structurally impossible.

### Bumped peer — TanStack Query

```diff
- "@tanstack/react-query": ">=5.0.0"
+ "@tanstack/react-query": ">=5.62.0"
```

Anchors `isPlaceholderData` semantics and the lazy `placeholderData`
factory form.

## 0.6.0

Targets Arc 2.12.x. Aligns pagination response shapes with `@classytic/repo-core/pagination` — server (arc 2.12 `fastifyAdapter` via `toCanonicalList()`) and client (arc-next typed responses) now share **one** declaration, eliminating the `method` discriminant drift that bit during the cross-package review.

### Breaking — pagination response types

Removed from `@classytic/arc-next/api`:
- `OffsetPaginationResponse<T>`
- `KeysetPaginationResponse<T>`
- `AggregatePaginationResponse<T>`
- `PaginatedResponse<T>`

These were re-declared in `src/api.ts` with subtle name/field divergence from arc's server-side equivalents. They now live in **`@classytic/repo-core/pagination`** — the same module arc's server emits these envelopes through. Server and client narrow on the same union; the `method` discriminant cannot drift.

#### Migration

```diff
- import type {
-   OffsetPaginationResponse,
-   KeysetPaginationResponse,
-   AggregatePaginationResponse,
-   PaginatedResponse,
- } from '@classytic/arc-next/api';
+ import type {
+   OffsetPaginationResponse,
+   KeysetPaginationResponse,
+   AggregatePaginationResponse,
+   PaginatedResponse,
+ } from '@classytic/repo-core/pagination';
```

Field shapes on the offset / keyset / aggregate branches are unchanged. The repo-core union additionally includes a `BareListResponse<T>` branch (`{ success: true; docs: T[] }`) for endpoints that don't paginate — predicates (`isOffsetPagination`, `isKeysetPagination`, `isAggregatePagination`) still ship from `@classytic/arc-next/api` and handle the new branch via `'method' in response &&` guards.

### Added — `@classytic/repo-core` peer dependency

```jsonc
"peerDependencies": {
  "@classytic/repo-core": ">=0.3.0",
  // ...
}
```

Hosts must install `@classytic/repo-core` alongside arc-next. (npm 7+ auto-installs peer deps; explicit on older clients.) Same model as `react` / `@tanstack/react-query`.

### Why the alignment matters

Before 0.6.0 / arc 2.12.0, three pagination-shape layers drifted across the org: arc-next's local response types, arc's inline server flatten (which silently dropped the `method` field), and mongokit's local result types. Repo-core 0.3.0 ships the canonical types and a `toCanonicalList()` runtime normaliser that arc's `fastifyAdapter` now routes every paginated response through — server and client narrow on the matching union by construction.

## 0.5.0

Targets Arc 2.11.x. Closes the surface gaps for the action router, search preset, and mongokit-style geo queries.

### New Features

- **Geo + range operators in `FilterOperator`** — `near`, `nearSphere`, `geoWithin`, `withinRadius`, `between`. Coordinate-list values (`[lng, lat, maxDistanceMeters]`, `[minLng, minLat, maxLng, maxLat]`, `[from, to]`) round-trip through `prepareParams` / `findBy` as comma-joined strings instead of being rewritten to `[in]`. Matches mongokit's URL grammar and works against any backend that accepts that grammar (mongokit native, sqlitekit-spatialite friendly).
- **`api.dispatchAction({ id, action, data })`** — POSTs to arc's unified action router (`POST /:id/action`) with `{ action, ...data }` body. Server discriminates on `body.action` and applies per-action permissions (arc v2.8+). Named `dispatchAction` (not `action`) so consumer SDKs can keep their own `action()` methods on subclasses without inheritance collisions — `action` is a common verb on state-machine resources.
- **`useAction()` hook** — typed mutation companion to `api.dispatchAction()`. Default-invalidates `lists()` + `details()` + the specific detail key; default action name on factory + per-call override via `mutate({ action })`.
- **`api.searchEngine()` / `api.searchSimilar()` / `api.embed()`** — POST routes mounted by `searchPreset()` (arc v2.9+). Distinct from `api.search()` which is the legacy GET-against-list. Custom `path` overrides supported per-call. Auto-wires from mongokit's `elasticSearchPlugin` / `vectorPlugin` when wired into `searchPreset({ repository })`.
- **`useSearchEngine()` / `useSearchSimilar()` / `useEmbed()` hooks** — mutation companions for the search preset routes.
- **`elevated: true` shorthand** — sends `x-arc-scope: platform` to trigger arc's elevated-scope upgrade (arc v2.9+). Configurable on `ClientConfig` (every request) or per-request via `RequestOptions.elevated` (which can override the client-level setting with `false` to suppress).

### Real-time additions

- **`subscribeToEvents()` plain function** — non-hook SSE client. Works in Node, Bun, tests, and non-React UIs. Returns a stable handle: `{ close, reconnect, isConnected }`. Auto-reconnect with ×1.5 exponential backoff (capped 30s), pattern filtering, named-event subscription via `addEventListener`. The `useEventStream()` hook now delegates to this — same wire behavior, smaller hook.
- **`connectWs()` plain function** — non-hook WebSocket client mirroring `subscribeToEvents()`. Returns `{ send, subscribe, unsubscribe, on, close, reconnect, isConnected }`. The `on(eventType, handler)` API registers per-type listeners alongside the global `onMessage` callback (use `'*'` for wildcard); returns an unsubscribe function. Subscriptions persist across reconnects. The `useWebSocket()` hook delegates to this.
- **`CrudEvent<TDoc>` generic type** — narrowed envelope for arc's `<resource>.<operation>` broadcasts. `CrudEvent<Todo>` types `data: Todo` and `operation: 'created' | 'updated' | 'deleted'`. `ArcServerEvent<TData>` is now generic (was `data: unknown`); `ArcWsMessage<TData>` was already generic. Pass through `subscribeToEvents<CrudEvent<Todo>>(...)` / `connectWs<CrudEvent<Todo>>(...)` for inference.
- **`useResourceSync()` hook on `createCrudHooks`** — turnkey "real-time by default" wiring. `useResourceSync({ source: 'ws' })` (or `'sse'`) subscribes to `<entityKey>` and auto-invalidates `KEYS.lists()` on every CRUD broadcast plus `KEYS.detail(id)` on `updated` / `deleted`. Honors the factory's `idField` so custom-id resources (`'sku'`, `'slug'`) resolve correctly. Optional `onEvent({ operation, id, data })` callback; `enabled: false` to opt out.
- **`getToastHandler()` companion to `configureToast()`** — returns the currently-configured `ToastHandler` (or the console-based default before `configureToast()` is called). Lets domain code outside the react-query lifecycle fire ad-hoc success/error toasts using the same handler the SDK uses internally — consumer SDKs no longer need to keep a parallel cache of the handler.

### Typed arc error codes

- **`ArcApiError.code` + `ArcApiError.detailsCode` getters** — surface arc's response codes from both slots of the wire envelope. `code` reads top-level `json.code` (set by arc's `errorHandlerPlugin` for thrown errors → `BAD_REQUEST` / `VALIDATION_ERROR` / `DUPLICATE_KEY` / etc.). `detailsCode` reads `json.details.code` (the canonical slot for controller-emitted business codes — `ORG_CONTEXT_REQUIRED`, `OWNERSHIP_DENIED`, `MIXED_UPDATE_SHAPE`, `ALL_FIELDS_STRIPPED`, `BEFORE_RESTORE_HOOK_ERROR`). Open-ended `string & {}` types so custom `errorMappers` codes still satisfy the union.
- **`isArcErrorCode(error, code)` predicate** — generic check that matches whichever slot the code lives in. Saves call sites from having to know whether arc emitted the code at the root or under `details`.
- **Specific predicates** — `isOrgContextRequiredError(error)` (the bulk-preset + orgGuard safety code — hosts hitting this need to call `configureAuth({ getOrgId })`), `isValidationError(error)`, `isDuplicateKeyError(error)`. All narrow `unknown → ArcApiError` for fluent guards.

### Upload with real progress events

- **`uploadWithProgress()` plain function** ([`./upload`](./src/upload.ts)) — XHR-based file upload with native `xhr.upload.onprogress` events. Returns a Promise that resolves with the parsed body or rejects with `ArcApiError` on non-2xx (same envelope as the fetch path — `code` / `detailsCode` / `fieldErrors` getters all work). Reuses arc-next's auth pipeline (`getClientAuthContext`), the same `Authorization` / `x-api-key` / cookie-mode `withCredentials` decisions, plus `elevated` / `idempotencyKey` / per-request headers / per-client config. Supports `responseType: 'json' | 'text' | 'blob'`. AbortSignal-driven cancellation, signal `reason` preserved verbatim. Closes the gap left by `useUpload()` (fetch-based, no progress).
- **`useUploadWithProgress()` React hook** — TanStack-Query-flavored mutation companion. Tracks `progress` as React state (every progress tick re-renders), exposes `{ upload, progress, isUploading, isPending, isSuccess, isError, data, error, cancel, reset }`. Auto-invalidates `invalidateQueries` on success, fires `messages.success` / `messages.error` through the configured `getToastHandler()`, supports dynamic `url` / `headers` / `idempotencyKey` / `elevated` callbacks that receive the call's vars. Last-call-wins semantics: starting a new upload while one is in-flight cancels the previous (matches `useMutation` behavior). New `./upload` subpath export.

Why XHR and not fetch+ReadableStream: as of 2026, Safari and Firefox still don't ship the `fetch()` + ReadableStream upload-body combination consumers need. XHR's `upload.onprogress` is universal. The hook surface is identical to what consumers would write on top of axios — no caveats per browser.

### Wire-shape bug fixes

- **`withBulk.bulkCreate()` now sends `{ items: data }` body** — arc's bulk handler (`POST /:resource/bulk`) reads `req.body.items`. Pre-fix, the SDK sent the raw array, which arc rejected with `400 Bulk create requires a non-empty items array` — masking the genuine `403 ORG_CONTEXT_REQUIRED` tenant-scope errors hosts actually need to see. The bulk integration test in `arc-next-test-api/tests/v050-error-codes-integration.test.ts` locks the corrected wire shape.
- **`ArcApiError.message` reads `json.error` first, then `json.message`** — arc's `errorHandlerPlugin` and `IControllerResponse` both emit `{ error: <human msg> }`, but the SDK was only reading `json.message`, falling back to bare `statusText` ("Forbidden", "Bad Request"). Now `message` carries arc's actual message ("Organization context required to bulk-create resources").

### Tests

- 7 new unit tests in `tests/v050.test.ts` covering `code` / `detailsCode` getters, `isArcErrorCode` cross-slot matching, and the four specific predicates.
- 3 new integration tests in `arc-next-test-api/tests/v050-error-codes-integration.test.ts` driving real bulk + 404 calls against arc 2.11.x — locks the controller-path wire convention (codes at `details.code`, not top-level `code`) and verifies `isOrgContextRequiredError(error)` fires on the bulk safety path.
- 31 new unit tests in `tests/upload.test.tsx` covering `uploadWithProgress()` (open/send/headers, progress events, abort with + without reason, ArcApiError on non-2xx, network/timeout failure, auth-mode parity bearer/cookie/header, explicit-token override + null-suppression, elevated, idempotencyKey, custom + Content-Type-stripping headers, absolute-URL passthrough, json/text/blob response types) and `useUploadWithProgress()` (data + isSuccess flow, progress mirror, query invalidation, error capture, cancel(), last-call-wins overlap, reset(), dynamic url/headers/idempotencyKey/elevated functions, toast handler integration).

### Tests

- 26 new unit tests in `tests/v050.test.ts` covering geo operators, action router, search preset, fieldErrors shape compatibility, and the `elevated` header.
- 29 new unit tests in `tests/v050-realtime.test.tsx` covering `subscribeToEvents()`, `connectWs()` (including `.on()` per-type listeners and wildcard catch-all), `useResourceSync()` invalidation behavior across WS + SSE transports, custom-`idField` propagation, and the `CrudEvent<TDoc>` compile-time generic.
- 16 new integration tests in `arc-next-test-api/tests/v050-integration.test.ts` covering action router (`complete` / `archive` / `prioritize`), search preset (`POST /search` regex backend, `searchSimilar` vector stub, `embed` deterministic stub), and live geo queries against a `2dsphere`-indexed `Place` resource (`[near]` distance sort, `[withinRadius]` 4 km radius, `[geoWithin]` bounding box, invalid-coord drop).
- 5 new integration tests in `arc-next-test-api/tests/v050-realtime-integration.test.ts` driving `connectWs()` against a real `websocketPlugin` — subscribe handshake, broadcast on create, `.on(eventType)` listeners + `off()` detach, `'*'` wildcard, `close()` idempotence, `send()` after-OPEN.

### Breaking Bug Fixes

- **`ArcApiError.fieldErrors` reads arc's actual error shape**. Pre-v0.5.0 the getter only read `json.errors` as `Record<string, string>`, but arc's `errorHandler` plugin emits `{ details: { errors: [{ field, message, keyword }] } }` (Fastify AJV pass-through) — so `fieldErrors` was effectively always `null` for real validation failures. v0.5.0 reads three shapes: legacy `{ errors: { field: msg } }` record form, arc's `details.errors[]` array form (`field` / `message`), and raw AJV `instancePath` / `params.missingProperty` form. Behavior change for callers who relied on the always-null result; matches the documented contract.

### Repo-core peer dep — declined

We considered adding `@classytic/repo-core` as a (type-only) peer dep to share `OffsetPaginationResult` / `KeysetPaginationResult` / `HttpError` shapes. We didn't:

- arc-next is a browser SDK; repo-core ships server primitives (hook engine, Filter IR, query parser, cache adapter) that are useless on the frontend.
- The HTTP envelope arc-next consumes is a strict superset of repo-core's pagination shape (adds `success: boolean`). arc-next's `OffsetPaginationResponse` / `KeysetPaginationResponse` / `AggregatePaginationResponse` types stay wire-correct without inheriting from repo-core.
- arc-next's `FilterOperator` union is intentionally larger than repo-core's URL grammar (`near` / `withinRadius` / `geoWithin` are mongokit conventions, not in repo-core). Centralizing on repo-core's grammar would force a regression for mongokit-backed consumers.

## 0.4.1

### Breaking Bug Fixes (from 0.4.0)

- **token optional in all mutation methods** — `create`, `update`, `delete`, `upload`, `request`, `restore`, `bulkCreate/Update/Delete` now default `token = null` (was required, inconsistent with query methods)
- **SSE `reconnect()` resets `manualCloseRef`** — `close()` → `reconnect()` now properly re-enables auto-reconnect on errors
- **Legacy hook signature detection fixed** — `useList(null)` now correctly uses new signature (auto-inject token); legacy requires 3 args: `useList(null, params, options)`
- **Non-JSON error responses capture body** — HTML/text error bodies (502 CDN pages, plain text) now captured in `ArcApiError.json.rawBody` instead of being silently null
- **Blob fallback error context preserved** — response parsing errors no longer silently swallowed
- Restored `BlobResponse` and `TextResponse` types
- Removed deprecated aliases (`createOptimisticMutation`, `createListQuery`, `createDetailQuery`, `createInfiniteListQuery`)

### New Features

- **Per-client auth** — `createClient({ getToken, getOrgId, headerName })` for multi-backend apps with different auth (bearer + API key side by side)
- **`getClientAuthContext(client?)`** — resolve auth for a specific client, falls back to global

## 0.4.0

### Features

- **`authMode: 'header'`** — custom header auth (x-api-key, x-admin-key) with configurable `headerName`
- **`apiVersion`** — sends `Accept-Version` header for Arc versioning plugin
- **`autoIdempotency`** — retry-safe `Idempotency-Key` generation at mutation level
- **`idField`** on `createCrudHooks` — custom ID field for cache keys and optimistic updates
- **`useDeleted`** — list soft-deleted items (softDelete preset)
- **`restore()`** on `useActions` — restore soft-deleted items
- **`useBulkActions`** — `bulkCreate`, `bulkUpdate`, `bulkRemove` (bulk preset)
- **`useDetailBySlug`** — fetch by slug (slugLookup preset)
- **`useTree` / `useChildren`** — hierarchical data (tree preset)
- **`useFindBy`** — query by field with filter operator
- **`useEventStream`** — SSE real-time with auto-reconnect, pattern filtering, query invalidation (`./sse`)
- **`maxPages`** on `useInfiniteList` — page eviction with automatic `getPreviousPageParam`
- **Filter operators** — added `like`, `exists`, `size`, `type`
- **Lookup params** — `QueryParams.lookup` for database-agnostic joins
- **SSR prefetch** — `prefetchBySlug`, `prefetchDeleted`, `prefetchTree`
- **Biome + Knip config** — linting and dead code detection

### Improvements

- `QUERY_CONFIGS` moved from mutation.ts to query.ts (re-exported for compat)
- SSR safety warnings on `configureClient`/`configureAuth` server calls
- Preset hooks never throw before React hooks (safe conditional rendering)
- `prefetch.ts` uses shared `createQueryKeys` (no duplicate key logic)
- `useBulkActions` reads auth context fresh per mutation (no stale closures)
- SSE uses refs for `patterns`/`invalidateQueries` (no reconnect storm)
- Removed dead `BlobResponse`/`TextResponse` types and unused `headers` SSE option
- `./package.json` subpath export added

### Dependencies

- Peer deps: `>=5.0.0` TanStack Query, `>=19.0.0` React
- TypeScript 6.0.2, tsdown 0.21.7, vitest 4.1.4, react 19.2.5

## 0.3.1

### Bug Fixes

- **hooks (HIGH)**: `useActions().create()` and `update()` now return the extracted entity `T`, not the raw `ApiResponse<T>`. Previously `{ success, data: T }` was cast to `T` — lying to consumers. Now uses `extractItem()` to unwrap. Factory-level `onSuccess`/`onSettled` callbacks also receive the extracted entity.
- **hooks (TYPE)**: `CrudApi` type changed from manual interface to `Pick<BaseApi, ...>` — types derived from source of truth. **Fixes compile error** where `createCrudApi()` result was not assignable to `CrudApi` (TypeScript contravariance on `Record<string, unknown>` params).
- **hooks (TYPE)**: `CrudApi` generic defaults aligned with `CrudHooksConfig` — both default `TCreate`/`TUpdate` to `Partial<T>`. Previously `CrudApi` defaulted to `unknown`.
- **api (MEDIUM)**: `defaultParams` are now merged into `getAll`, `search`, and `findBy` requests. Previously `config.defaultParams` was stored but never applied — consumers relying on `defaultParams: { limit: 25 }` got wrong queries.
- **hooks (MEDIUM)**: Multi-client `authMode` now respected. `createEnabledRule` reads auth mode lazily from `client?.config?.authMode` falling back to global `getAuthMode()`. Previously a secondary cookie-mode client would have queries disabled because the hook only checked the global bearer mode.
- **prefetch (MEDIUM)**: `prefetchDetail` now accepts `params` option (`select`, `populate`) and uses extended query key `[entity, "detail", id, params]` matching `useDetail`'s key shape. Previously only prefetched bare `[entity, "detail", id]` — hydration missed for parameterized detail queries.
- **query**: `extractItem` exported for use in hooks (was private).
- **hooks**: `useInfiniteList` pageParam cast from `unknown` to `number` — surfaced by stricter types.

### Design Decisions

- **Detail keys NOT tenant-scoped**: `_id` is globally unique in MongoDB. Backend enforces tenant isolation via middleware (`orgScoped`, permissions). Frontend cache uses simple `[entity, "detail", id]` — no `organizationId` in the key. This avoids hardcoding a specific tenant field name (`organizationId` vs `workspaceId` vs `teamId`) and keeps the cache API simple.
- **Auth mode resolved lazily**: `resolveAuthMode()` is a function (not captured at factory time) so global `configureClient({ authMode })` changes take effect immediately, while per-client overrides still work.

### Tests

- 366 tests (up from 348):
  - `create()`/`update()` return extracted entity, not raw ApiResponse (3 tests)
  - Detail keys use simple `[entity, "detail", id]` (2 tests)
  - `defaultParams` merge into `getAll`/`search`/`findBy` (4 tests)
  - Multi-client cookie auth mode enables queries (1 test)
  - `prefetchDetail` with `params` (2 tests)
  - Type-compatibility compile-time guards (5 tests)

## 0.3.0 (unpublished — superseded by 0.3.1)

### Breaking Changes

- **client**: `credentials` is no longer hardcoded to `'include'`. Bearer auth (default) now uses `'same-origin'`. Cookie auth uses `'include'`. Explicit `credentials` field added to `ClientConfig` for full control.

### Features

- **client**: Added `credentials` option to `configureClient()` and `createClient()` — supports `'include'`, `'same-origin'`, `'omit'`
- **query**: `normalizePagination` now handles keyset pagination responses (`hasMore`, `next` cursor) — previously returned `null` for keyset responses
- **query**: `PaginationData` now includes `method` field (`'offset' | 'keyset' | 'aggregate' | null`) and `next` cursor
- **query**: `extractItems` falls back to first top-level array when well-known keys not found — `{ products: [...] }`, `{ users: [...] }` now work without configuration
- **query**: `extractItem` accepts primitive `data` values (strings, numbers) — action route responses now extracted correctly
- **query**: `updateListCache` uses same flexible key detection — optimistic updates work on custom response shapes
- **hooks**: `DetailQueryOptions` now supports `refetchOnWindowFocus`
- **hooks**: `InfiniteListQueryOptions` now supports `refetchInterval` and `refetchIntervalInBackground`
- **hooks**: `useDetail` forwards `refetchOnWindowFocus` to TanStack Query
- **hooks**: `useInfiniteList` forwards `refetchInterval` and `refetchIntervalInBackground` to TanStack Query
- **package**: Added root export `"."` in package.json exports — bare `import from '@classytic/arc-next'` now works

### Bug Fixes

- **hooks**: `useNavigation` hook identity stabilized — router hook resolved at factory time instead of per-render, fixing Rules of Hooks violation risk
- **hooks**: `useUpload` no longer throws during render when `api.upload` is undefined — error deferred to mutation call time
- **hooks**: `useSearch` now picks up `params.token` for consistency with other hooks
- **query-client**: `getQueryClient()` warns when overrides are passed to subsequent calls (browser singleton ignores them)
- **mutation**: Removed unnecessary backward-compat re-export of `ToastHandler` from mutation module
- **hooks**: Removed unnecessary backward-compat re-export of `UseRouterHook` from hooks module

### Build

- **tsdown**: Replaced deprecated `external` with `deps.neverBundle`
- **tsdown**: Sourcemaps fully disabled — `dts: { sourcemap: false }`, no `.js.map` or `.d.ts.map` in dist
- **tsconfig**: Removed `declaration`, `declarationMap`, `sourceMap` (no-ops with `noEmit: true` — tsdown owns output config)
- **package**: Tarball reduced from 52.8 KB → 25.3 KB (17 files, zero sourcemaps)
- **deps**: TanStack React Query updated from 5.90.21 → 5.95.2

### Documentation

- Added SSR safety warnings to all `configure*()` function JSDoc
- Added `CLAUDE.md` for development context

### Tests

- 348 tests (up from 303) covering:
  - Credentials policy: bearer/cookie/explicit/omit/createClient (6 tests)
  - Query client overrides: applied, ignored+warned, no-warn, singleton (5 tests)
  - Flexible response extraction: custom keys, plain arrays, well-known precedence (5 tests)
  - Arc backend shapes: offset/keyset/aggregate pagination, detail, delete, action (11 tests)
  - Polling config: refetchInterval, refetchOnWindowFocus, refetchIntervalInBackground across useList/useDetail/useInfiniteList (13 tests)
  - QUERY_CONFIGS presets integration with hooks (2 tests)
  - useUpload mutation-time error, useNavigation factory-resolved hook (3 tests)

## 0.2.1

### Bug Fixes (Critical)

- **hooks**: Update mutation now includes detail cache in rollback snapshot — previously, optimistic detail updates were lost on error
- **hooks**: Delete mutation clears detail cache in `onSuccess` instead of optimistic phase — prevents data loss on rollback
- **hooks**: `useNavigation` always calls router hook unconditionally with noop fallback — fixes Rules of Hooks violation when no router configured
- **client**: `AbortError`, `TypeError`, and other native Error subclasses are now preserved through the request handler — previously swallowed by generic `Error` wrapping

### Improvements

- **hooks**: Renamed internal hook functions to follow React naming convention:
  - `createListQuery` → `useListQuery` (deprecated alias kept)
  - `createDetailQuery` → `useDetailQuery` (deprecated alias kept)
  - `createInfiniteListQuery` → `useInfiniteListQuery` (deprecated alias kept)
  - `createOptimisticMutation` → `useOptimisticMutation` (deprecated alias kept)
- **hooks**: `CrudApi` interface generics now thread through return types for better type safety
- **query**: `items` and `pagination` in list queries memoized with `useMemo` — prevents unnecessary `useEffect` runs on every render
- **hooks**: `useActions` wraps `create`/`update`/`remove` in `useCallback` for stable refs

### Build

- Updated tsdown from 0.20.3 to 0.21.4

### Tests

- Added 9 new tests (294 → 303 total) covering:
  - Detail cache rollback on update mutation failure
  - `useNavigation` noop safety when no router configured
  - `useActions` function shape validation
  - Deprecated aliases (`createListQuery` = `useListQuery`, etc.)
  - AbortError/TypeError preservation through request handler
  - Non-Error throw wrapping

## 0.1.3 (unreleased)

### Bug Fixes

- **client**: `BaseApi.config.headers` (e.g., `x-arc-scope: platform`) are now merged into every HTTP request — previously stored but never sent
- **query**: `updateListCache` rewritten to handle all 4 array formats (`docs[]`, `data[]`, `items[]`, `results[]`) plus raw arrays, with correct `total`/`totalDocs` delta tracking

### Tests

- Added 78 new tests across all modules (165 → 243 total)
  - `mutation.test.ts`: 1 → 26 tests (QUERY_CONFIGS, useMutationWithTransition, useMutationWithOptimistic)
  - `client.test.ts`: 34 → 53 tests (response types, error edge cases, getAuthMode, defaultHeaders)
  - `query.test.ts`: 30 → 53 tests (updateListCache edge cases, createQueryKeys, createCacheUtils, getItemId)
  - `hooks.test.tsx`: 42 → 53 tests (cookie auth mode, custom staleTime, useDetail params, useActions silent/invalidation)
  - `prefetch.test.ts`: 6 → 11 tests (token/org handling, cache key alignment, dehydrate)

### Documentation

- README rewritten to match SKILL.md — added configureAuth, cookie auth mode, prefetch subpath, config.headers, multi-client, ArcApiError, QUERY_CONFIGS, SSR Prefetch section

## 0.1.2 (2025-03-01)

### Features

- `configureAuth` — auto-inject token and organizationId into queries/mutations
- Cookie auth mode (`authMode: 'cookie'`) for Better Auth same-origin proxy
- `createCrudPrefetcher` + `dehydrate` for SSR prefetch in server components
- `createClient()` — multi-client support for multiple API backends
- `ArcApiError` class for structured error handling
- `QUERY_CONFIGS` presets — realtime, frequent, stable, static
- `config.headers` on `createCrudApi` for per-instance headers
- `useInfiniteList` hook for cursor-based infinite scrolling

## 1.0.0 (2025-02-24)

### Features

- `createCrudHooks` factory — generates `useList`, `useDetail`, `useActions`, `useInfiniteList`, and `useNavigation` from a single config
- `createCrudApi` — typed CRUD API client with cookie and bearer auth modes
- `configureClient` — global client configuration (baseUrl, authMode, token provider, org context)
- Optimistic updates with automatic rollback on mutation failure
- `getQueryClient` — SSR-safe singleton TanStack Query client
- `QUERY_CONFIGS` presets — realtime, frequent, stable, and static caching strategies
- Multi-tenant support with automatic `organizationId` injection
- Cache utilities — invalidate, set, get, remove per entity
