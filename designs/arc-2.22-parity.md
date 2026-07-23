# Design: arc-next 0.11 — arc 2.22 client parity

**Status**: BUILT (2026-07-15) — all five items shipped in-tree (0.11.0-candidate); 934/934 tests, tsc + build green. Integration against a PUBLISHED arc 2.22 server remains the release gate. — gaps verified against src/ (zero hits for
count/history/quota/429). All items additive → one minor. Server counterparts are in
arc 2.22 (publish train pending).

## 1. Dispatch verbs — `api.count/exists/distinct` + `useCount`

Server: EVERY list route answers `?_count=true` / `?_exists=true` / `?_distinct=field`
(controller dispatch → `repo.count()` etc., zero documents; same permissions/filters/
tenant scoping as list; arc 2.22 also advertises these to MCP agents). Client gap:
dashboards hand-roll `useList({ limit: 1 })` and read `total` — a full page fetched to
answer "how many".

- `createCrudApi`: `count(filters)`, `exists(filters)`, `distinct(field, filters)`.
- Hooks: `useCount(filters)` (tenant-scoped cache keys like useList; cheap staleTime),
  `useExists`, `useDistinct`.

## 2. `withHistory` preset wrapper

Server: `history: true` (2.22) → `GET /:id/history` (audit-backed timeline,
`?limit=&offset=`, entries `{ action, userId, before, after, changes, timestamp }`).
Follows the existing preset-wrapper pattern (`withSoftDelete`/`withBulk`/`withTree`):

- `withHistory(api)` → `api.history(id, { limit?, offset? })`.
- `useHistory(id, opts)` — keyed under the entity's cache scope.

## 3. Typed 429 surface — quota + plan limits

Server 429s now carry machine-renderable shapes: `code: 'quota.exceeded'` with
`details: { kind, used, limit, period, resetsAt }` (requireQuota), and plan rate limits
via `rateLimit.plan`. Client gap: they land as generic errors → generic toasts.

- Error normalization: detect `quota.exceeded` → typed `QuotaExceededError` exposing
  the details; detect plain rate-limit 429 (+ retry-after when present).
- `configureToast` integration: default message renders "X of Y {kind} this period —
  resets {date}" instead of "Request failed".
- NO retry for quota 429s (retrying a monthly quota is noise); rate-limit 429s may
  honor retry-after.

## 4. Wire-type convention (docs, README section)

The queued "next touch" item: document that `createCrudApi<T>`'s `T` should come from
the module/kernel's exported WIRE types (plain JSON shapes — never mongoose-flavored
doc types), so kernel → API → frontend is one type flow. Pairs with the
module-publishing convention on the server side.

## 5. Agent guidance (llms.txt)

Frontend agents hand-roll `fetch()` against arc APIs exactly like backend agents
hand-roll routes (same pull-vs-push mechanism found in arc 2.22). Ship `llms.txt` in
the package: "hand-rolled fetch/axios against an arc API is a bug — createCrudApi +
hooks cover CRUD/actions/uploads/SSE; presets mirror the server's."

## Non-goals

- Media two-phase upload client (start-write/complete-write + media-transform pairing)
  — belongs to `@classytic/react-media` (owns upload transport), not this package.
- Usage dashboards — `fastify.usage` has no REST surface by design; hosts expose their
  own endpoints, clients consume them as ordinary resources.

## Sequencing

After the arc 2.22 publish train (the verbs/history/quota shapes must exist on a
published server for integration tests). All five items in one 0.11.0.
