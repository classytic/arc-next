# @classytic/arc-next — Agent Development Guide

User-facing API docs live in [README.md](README.md). This file is for agents working on this package.

## Invoke the right skill for the work

| When working on... | Run |
|---|---|
| `useQuery` / `useMutation` / cache keys / invalidation | `/tanstack-query-best-practices` |
| New hooks, `use()`, Actions, `useTransition`, refs, server components | `/react-19` |
| `useMemo` / `useCallback` / re-render audits / list virtualization | `/react-performance-optimization` |
| Data-fetching waterfalls, bundle size, Next.js perf (Vercel Engineering rules) | `/vercel-react-best-practices` |
| Writing or refactoring vitest hook tests in `tests/` | `/react-testing-library` |
| TS generics, `Pick`/`Omit` discipline, type drift | `/typescript-best-practices` |
| Reviewing your own diff before commit | `/simplify` |
| Don't know what skill fits | `/find-skills` |

Always pull the relevant skill into context **before** writing code — these encode rules (`qk-array-structure`, `cache-invalidation`, `perf-select-transform`, etc.) that the project relies on.

## Project conventions (must follow)

- **No barrels.** Source is grouped by domain (`src/<domain>/`); every public subpath maps to ONE entry module (named for the subpath, or `index.ts` for a folder subpath like `./edge-cache`). Internal helpers live next to their users (`src/query/defaults.ts`). Never add an index that aggregates unrelated modules. Public subpaths never change when files move: only `exports` and the tsdown entries do.
- **No legacy.** One way to do each thing: no deprecated aliases, back-compat overloads, flattened duplicates of an option, re-exports of moved names, or fallbacks for wire shapes arc no longer sends. A break goes in the CHANGELOG Migration table.
- **Option factories are the one source of keys.** `createEntityQueries` (`src/query/query-options.ts`) builds every `{ queryKey, queryFn }`, CRUD `mutationOptions`, and custom routes (`route` / `routeMutation`, keyed under `keys.routes()`); `createCrudHooks` read hooks and writes are thin wrappers over it (`hooks.queries`). Never build a resource key by hand; add a builder to `createQueryKeys`.
- **Wire types come from repo-core.** Pagination, query grammar (`formatQuery` / `parseUrl`), errors, repository results: import them (type-only where possible), never redeclare. `tests/contract/` pins it.
- **`sideEffects: false`.** Don't add side-effectful imports.
- **`"use client"` matters.** Client-only modules: `query/query.ts`, `query/mutation.ts`, `query/hooks.ts`, `query/devtools.ts`, `query/query-island.ts` (+ its lazy `query-island-root.ts`), `realtime/sse.ts`, `realtime/ws.ts`, `realtime/tab-leader.ts`, `client/upload.ts`, `auth/google-one-tap.ts`, `platform/service-worker.ts`, `sdk/hooks.ts`, `sdk/init.ts`. Server-safe: everything else (`client/*`, `query/cache.ts`, `query/query-options.ts`, `query/query-client.ts`, `query/prefetch.ts`, `query/events.ts`, `auth/auth-gate.ts`, `client/presets/*`, `security/*`, `edge-cache/*`, `server/*`). **Don't import client-only modules from server-safe ones** — Server Components see `"use client"` exports as client references and can't call them. If you find yourself wanting to call a pure utility from `query/prefetch.ts`, move it to `query/cache.ts` (no directive).
- **React Native boundary.** RN-facing subpaths (list in `scripts/check-rn-boundary.mjs`) must not reach DOM, Next or Node-only modules at load; `npm run check:rn-boundary` (dist graph) and the `native` test project (no DOM globals) enforce it. Web-only code goes in its own subpath.
- **Server-import boundary is machine-enforced**: `npm run check:server-import` walks the dist import graph and fails on violations — it's in `prepublishOnly` and CI.
- **`configure*` are module singletons.** Setting them on the server leaks state across SSR requests. They warn on `typeof window === "undefined"` — preserve that.
- **`getToken` is sync-only.** Promise/thenable returns are dropped + warned via `readToken()`. Don't widen the type to `Promise<string | null>`.
- **`CrudApi` = `Pick<BaseApi, core>` ∪ `Partial<XxxMethods>` for each preset.** Never duplicate interfaces. When you add a CRUD-level method to `BaseApi`, add it to the `Pick` list in `crud-types.ts`. When you add a method to a preset, add it to that preset's `XxxMethods` interface — the intersection in `hooks.ts` already pulls it through.
- **Preset wrappers use only the public BaseApi surface.** They mutate `api` via `Object.assign` and call back into `api.request()` for transport. Do NOT add private accessors for presets — keep `api.request()` as the only extension primitive so presets stay implementable from outside the package.
- **Preset methods MUST be `async`.** Throws inside object-literal methods are synchronous, but tests + callers expect Promise rejections. Always `async fnName(...)` in the `withXxx()` factory.
- **No envelope unwrap.** arc 2.13+ emits raw payloads; HTTP status discriminates success vs error. `useApiQuery` and `extractItem` are identity passthroughs — DON'T add `{ success, data }` unwrap logic. Errors come back as a thrown `ArcApiError` carrying repo-core's `ErrorContract` (`{ code, message, status, details?, meta? }`).
- **No `search()` / `findBy()` methods.** Both are gone — they hit the same `GET /` as `getAll()`. Pass operators directly: `getAll({ params: { 'title[contains]': q, 'priority[gte]': 5 } })`. `prepareParams` recognizes any bracket-keyed array and keeps it comma-joined (no double `[in]` rewriting). DON'T add `findBy` / `search` back even as a sugar method — the API surface should match arc backend routes 1:1.
- **One list shape.** `extractItems` / `updateListCache` read arc's list `data` (or a bare array) and nothing else; the `docs` / `items` / `results` / any-array fallbacks are gone (0.22). Don't add them back.
- **Tenant vs filter.** The tenant (`x-organization-id`) comes from `ctx` / options `organizationId`; an `organizationId` in params is a query-string filter, signed in or anonymous. Never alias them. `token` / `organizationId` are three-state end to end: `undefined` = configured default, `null` = deliberately none.
- **Identity partition.** Every resource key carries `P = { auth, organizationId, scope }` in full (fixed shape, `null` for none, so TanStack's partial prefix match on `[entity, "list", P]` is exact). `createEntityQueries` resolves it BEFORE building the key through `api.identity()` (`BaseApi` mirrors the transport: per-call auth over `readAuth`, `x-organization-id` header over the org option, client `getOrgId` / `configureAuth`) and sends that exact tenant: every input that changes the response is in the key (eslint-plugin-query exhaustive-deps). Detail-to-list sync, list placeholders, optimistic writes, reconciliation and cache seeds stay in ONE partition (`KEYS.lists(P)`, `KEYS.detail(id, P)`, `writePartition`); invalidation reaches every partition. Never seed or merge across partitions, never key the token (clear the client on sign-out).
- **Detail keys.** `KEYS.detail(id)` (no options) is only the prefix of every variant; `KEYS.detail(id, P)` is one partition's entry. Writes invalidate through `invalidateForChange` (scoped: lists, counts, aggregations, the record's own detail), never `details()` except for filter-based bulk writes.
- **`auth: "omit"` is explicit.** Anonymous reads (per call, or `readAuth` per api) strip every credential header and use `credentials: "omit"`; never make it a default.
- **All headers conditional.** `Authorization` only when token truthy, `x-organization-id` only when orgId truthy. BaseApi and presets forward `token` / `organizationId` only when `!== undefined` (so `null` reaches the transport as "none"); hooks map a context value they do not have to `undefined`, never `null`.
- **SSE listens on both channels.** `useEventStream` subscribes via `addEventListener(<type>)` AND keeps `onmessage` — Arc's `ssePlugin` writes named frames; legacy paths still write JSON to `message`.
- **WS subscriptions persist across reconnects.** `useWebSocket` keeps an internal `Set<string>` of resource subscriptions; on every (re)open it replays `{type:'subscribe', resource}` frames. Don't bypass this — always go through `subscribe()` / `unsubscribe()` instead of raw `send()`.
- **`buildWsUrl` rewrites protocol.** `http(s)://` → `ws(s)://`. Make sure `configureClient.baseUrl` is set BEFORE building.
- **`useNavigation` captures router at factory time.** Call `configureNavigation(useRouter)` BEFORE `createCrudHooks()`, not after.
- **`upload.ts` is XHR, not fetch.** It's a separate transport for cross-browser progress events. **`ClientConfig.retry`, `beforeRequest`, and `afterResponse` do NOT propagate to uploads** — that's documented behavior, not a bug. Auth headers, `ArcApiError` parsing, `x-arc-scope`, `Idempotency-Key`, and `Accept-Version` all carry over. If you change interceptor behavior in `executeRequest`, do NOT also bridge it into `upload.ts` — uploads should stay isolated. Per-upload trace headers go through the `headers` option.
- **`autoIdempotency` is an EXECUTOR concern (0.12+).** The key is minted once per logical request at the top of `executeRequest` so backoff + auth retries reuse it; the mutation-layer ref additionally covers TanStack-level retries. POST/PUT/PATCH only; explicit `idempotencyKey` always wins. Don't move key generation into `executeAttempt` — per-attempt keys defeat the dedup.
- **Optimistic guarantees are contract (0.12+).** `useOptimisticMutation`'s updater is key-aware (`(old, vars, queryKey)`); list inserts go through `prependToListCache` (first infinite page only), reconciliation through `replaceItemInListCache`; CRUD writes share `WRITE_MUTATION_KEY` for last-standing invalidation; `enqueueWrite` chains same-record writes. See README "Guarantees" and tests/query/crud-mutations.test.tsx before changing any of it.
- **Server story:** `createServerClient` is the sanctioned per-request server path — never add `next` imports, `next/headers`, or cookie reads to the SDK; hosts pass plain values.

The CRUD factory composes internal factories with narrow `Pick<CrudContext, ...>` dependencies.
Keep runtime imports pointed into these modules, never back to `hooks.ts`. Import shared hook
types from `crud-types.ts`; `hooks.ts` preserves the public type exports. Mutable write queues
and settled-change tracking belong to `crud-writes.ts`, created once per resource factory.

## Layout

```
src/
  client/      client.ts (transport, ArcApiError, auth injection, auth: omit), api.ts (BaseApi, createCrudApi),
               runtime.ts (definePublicEnv), upload.ts ("use client"), presets/ (withSoftDelete, withBulk, ...)
  query/       query-options.ts (createEntityQueries: THE key/queryFn/mutationOptions source), cache.ts (key
               factory, invalidateForChange, resourceTags/arcTag, list helpers), defaults.ts (internal),
               query-client.ts, prefetch.ts (streamQueries / prefetchQueries), query.ts, mutation.ts,
               hooks.ts (createCrudHooks composition + navigation), crud-types.ts (public hook contracts),
               crud-context.ts (auth/partition policy + defaults), crud-reads.ts, crud-writes.ts
               (owns write queues + settled changes), crud-presets.ts, resource-sync.ts,
               events.ts (onArcChange), devtools.ts
  auth/        auth-token.ts, auth-gate.ts, auth-social.ts (+ signInWithIdToken), google-one-tap.ts, auth-proxy.ts
  realtime/    sse.ts, sse-fetch.ts, ws.ts, tab-leader.ts
  platform/    react-native.ts (setupReactNative), service-worker.ts, csp.ts
  security/    encryption.ts, field-encryption.ts
  server/      server.ts (createRequestClient, forwardRequestHeaders)
  edge-cache/  index.ts (headers, route matcher, purger), cloudflare.ts, cli.ts (`arc-next-edge` bin, Node only, not an export)
  sdk/         host SDK core (messages, actions, hooks, init, resource, download, transport, errors, ...)
tests/         OUTSIDE src (never shipped). Mirrors src domains: tests/<domain>/<public-api>.test.ts(x)
  harness/     createTestQueryClient, createWrapper, renderWithClient, fake-arc (repo-core envelopes), storage, timers
  setup/       dom.ts (act warnings fail), ssr.ts, native.ts (no DOM globals, navigator.product)
tools/lint-query/  isolated eslint + @tanstack/eslint-plugin-query install (TS 7 has no JS API for typescript-eslint)
```

Test environment is chosen by file name (`vitest.config.ts` projects): `*.native.test.ts` native,
`*.ssr.test.ts(x)` ssr, `*.node.test.ts` node, other `*.test.ts(x)` jsdom, `*.test-d.ts` types
(`vitest --typecheck`). Name a test after the public API it covers, never after a version or a bug;
put a regression next to the API it protects. Use `tests/harness/`; never copy a wrapper or client into a file.

Real-backend integration tests: [`../arc-next-test-api/tests/`](../arc-next-test-api/tests/). Test-api consumes this package via `file:../arc-next` — `npm run build` here makes new exports available there immediately.

## Commands

`package.json` has the canonical list. Most-used while developing:

```bash
npm test                  # vitest projects jsdom + node + ssr + native
npm run test:types        # *.test-d.ts through vitest --typecheck
npm run test:coverage     # istanbul, thresholds on src/client, src/query, src/auth
npx vitest run tests/<domain>/X  # single file
npm run lint:query        # @tanstack/eslint-plugin-query (first: npm run lint:query:install)
npm run typecheck         # tsc --noEmit (strict)
npm run typecheck:tests   # test lane (includes type-contracts)
npm run gate              # FULL gate (prepublishOnly and CI run exactly this): typecheck×2 + test + build + check:package
                          #   + test:types + lint (biome + query) + check:api-surface
                          #   + check:server-import + check:rn-boundary
                          #   + check:bundle + check:fixtures
npm run api:surface       # regenerate api-surface.json (after intentional API change)
```

Release-gate notes (0.12+, ported from arc):
- `api-surface.json` snapshots every subpath's runtime+type exports + declaration hashes. Any removal or signature change FAILS until you regenerate the snapshot in the same change and note it in CHANGELOG.md.
- `scripts/check-bundle-size.mjs` holds gzip budgets per subpath — raising a budget is a reviewed edit, not automatic.
- `fixtures/` holds Next App Router + Vite consumer fixtures type-checked against the BUILT dist via package self-reference — run `npm run build` first.
- Peer floors: `npm run check:peer-floors` (`scripts/check-peer-floors.mjs`) installs every `peerDependencies` floor exactly into a temp copy and runs typecheck×2 + test + build + check:fixtures. CI's peer-minimums job runs it; run it locally before a release (needs network, so not in `prepublishOnly`). Never raise a floor to the dev version: raise it only when this check fails at the old floor, and name the API that forced it in CHANGELOG.md.

## Adding a feature — checklist

1. Pull the relevant skill (table above).
2. Pick the right file — don't create a new top-level module unless it earns its own subpath export.
3. If it's a hook, decide SSR boundary; if it touches singletons, mind the SSR-warn pattern.
4. Add tests in `tests/<domain>/<public-api>.test.ts(x)` first (pick the environment by file name; use `tests/harness/`).
5. If it's user-touchable, add an integration test in `arc-next-test-api/tests/`.
6. Update [README.md](README.md) only if the public API changed.
7. Run `npm run gate` before committing (Node `^22.22.2 || ^24.15.0 || >=26`; `npm run lint:query:install` once).

## Build

tsdown with `unbundle: true` preserves file structure. `tsconfig.noEmit: true` — tsdown owns all output config. No sourcemaps in dist.
