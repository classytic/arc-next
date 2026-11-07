// Server-safe cache + response-shape utilities.
//
// Lives WITHOUT a `"use client"` directive so Server Components (Next.js
// App Router prefetch, RSC streaming) can import + call these functions
// during SSR. The matching React hooks (`useListQuery`, `useDetailQuery`,
// `useInfiniteListQuery`, `useApiQuery`) live in `./query.ts`, which IS
// `"use client"` because hooks can only run on the client.
//
// Anything in this file MUST stay free of React hooks and browser APIs.

import type {
  AggregatePaginationResult,
  KeysetPaginationResult,
  OffsetPaginationResult,
} from "@classytic/repo-core/pagination";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { RequestAuth } from "../client/client.js";

// ============================================================================
// Pagination shape
// ============================================================================

/** arc's pagination strategies, taken from repo-core's wire types (a rename is a compile error). */
export type PaginationMethod = (
  | OffsetPaginationResult<unknown>
  | KeysetPaginationResult<unknown>
  | AggregatePaginationResult<unknown>
)["method"];

export interface PaginationData {
  /** The strategy arc paginated with (repo-core's `method` discriminant). */
  method: PaginationMethod;
  total: number;
  pages: number;
  page: number;
  limit: number;
  hasNext: boolean;
  hasPrev: boolean;
  /** Keyset cursor for next page (keyset pagination only) */
  next?: string | null;
  /** Keyset cursor for the previous page — send it back as `before` (keyset only). */
  prev?: string | null;
  /** Keyset cursor at the page's last row — resume a feed with `after` (keyset only). */
  end?: string | null;
  /** `total` is an estimate (mongokit): a floor to render as "10,000+", never an exact count. */
  totalIsEstimate?: boolean;
  /** When the count was taken (ISO string), when the backend says. */
  countedAt?: string;
}

// ============================================================================
// TanStack Query defaults + freshness presets
// ============================================================================

export { DEFAULT_QUERY_CONFIG, QUERY_CONFIGS } from "./defaults.js";

// ============================================================================
// Response-shape utilities
// ============================================================================

/**
 * The list array of a list response. arc emits exactly two list shapes (repo-core
 * `toCanonicalList`): a bare array, or an envelope whose rows are in `data` (offset, keyset,
 * aggregate, bare-list results alike).
 */
function listArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: unknown[] }).data;
  }
  return null;
}

/**
 * Extract `_id` or `id` from any item. Returns `null` if neither exists.
 * Coerces numeric IDs to strings so cache keys stay consistent.
 */
export function getItemId(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const id = obj._id ?? obj.id;
  return typeof id === "string" ? id : id ? String(id) : null;
}

/**
 * Normalize any pagination response shape (offset / keyset / aggregate) to a
 * uniform `PaginationData` object. Returns `null` when no pagination signal
 * is present.
 */
export function normalizePagination(data: unknown): PaginationData | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const method = (d.method as PaginationData["method"]) ?? null;
  if (method === null) return null;
  const isKeyset = method === "keyset";
  return {
    method,
    total: Number(d.total ?? 0),
    pages: Number(d.pages ?? (isKeyset ? 0 : 1)),
    page: Number(d.page ?? (isKeyset ? 0 : 1)),
    limit: Number(d.limit ?? 10),
    hasNext: Boolean(isKeyset ? d.hasMore : d.hasNext),
    hasPrev: Boolean(d.hasPrev ?? false),
    ...(isKeyset
      ? {
          next: typeof d.next === "string" ? d.next : null,
          prev: typeof d.prev === "string" ? d.prev : null,
          ...(d.end !== undefined ? { end: typeof d.end === "string" ? d.end : null } : {}),
        }
      : {}),
    totalIsEstimate: d.totalIsEstimate === true,
    ...(typeof d.countedAt === "string" ? { countedAt: d.countedAt } : {}),
  };
}

/** The rows of a list response (bare array or `{ data }` envelope); `[]` for anything else. */
export function extractItems<T>(data: unknown): T[] {
  return (listArray(data) as T[] | null) ?? [];
}

/**
 * Detail extractor. Arc emits the doc directly (no envelope wrapper) — this
 * function is identity-with-null-guard. Kept as a named helper so callers
 * have a stable seam if a future backend ever ships an envelope, and so
 * `null` / `undefined` responses normalize to `null` consistently.
 */
export function extractItem<T>(data: unknown): T | null {
  if (data == null) return null;
  return data as T;
}

/**
 * Optimistic-update helper that rewrites the rows of a list cache (bare array, `{ data }`
 * envelope, or every page of an infinite list). Adjusts `total` when the row count changes.
 */
export function updateListCache<T>(listData: unknown, updater: (items: T[]) => T[]): unknown {
  if (!listData) return listData;

  if (Array.isArray(listData)) {
    return updater(listData as T[]);
  }

  if (typeof listData !== "object") return listData;
  const d = listData as Record<string, unknown>;

  // Infinite-query value: `{ pages: unknown[], pageParams: unknown[] }`.
  // Each page is a list response of its own, so the updater runs per page and
  // optimistic rows are never spliced BETWEEN pages. Per-item updaters (map / filter /
  // replace) are applied to every page; length-changing inserts should use
  // {@link prependToListCache}, which targets the first page only.
  if (Array.isArray(d.pages) && Array.isArray(d.pageParams)) {
    let changed = false;
    const nextPages = (d.pages as unknown[]).map((page) => {
      const next = updateListCache(page, updater);
      if (next !== page) changed = true;
      return next;
    });
    return changed ? { ...d, pages: nextPages } : listData;
  }

  if (!Array.isArray(d.data)) return listData;
  const original = d.data as T[];
  const updated = updater(original);
  // Short-circuit: when the updater returns the same array reference (the
  // canonical "I didn't actually change anything" signal), return the
  // original wrapper unchanged. Otherwise we'd allocate a new outer object
  // here on every call, which would make `syncDetailToLists` (and any other
  // helper that defers to `updateListCache`) report false-positive updates
  // and cause spurious `setQueryData` writes → re-render cascades.
  if (updated === original) return listData;
  const delta = updated.length - original.length;

  const result: Record<string, unknown> = { ...d, data: updated };
  if (delta !== 0 && d.total != null) result.total = Math.max(0, Number(d.total) + delta);

  return result;
}

/**
 * Insert an item at the head of a list cache entry — the optimistic-create
 * primitive. Unlike {@link updateListCache} with a prepending updater (which,
 * on an infinite cache, would insert into EVERY page), this targets exactly
 * one location: the first page of an infinite cache, or the single payload of
 * a flat list. Totals adjust via `updateListCache`'s existing delta logic.
 */
export function prependToListCache(listData: unknown, item: unknown): unknown {
  if (!listData) return listData;
  if (
    typeof listData === "object" &&
    !Array.isArray(listData) &&
    Array.isArray((listData as Record<string, unknown>).pages) &&
    Array.isArray((listData as Record<string, unknown>).pageParams)
  ) {
    const d = listData as { pages: unknown[]; pageParams: unknown[] };
    if (d.pages.length === 0) return listData;
    const first = updateListCache(d.pages[0], (items: unknown[]) => [item, ...(items || [])]);
    if (first === d.pages[0]) return listData;
    return { ...d, pages: [first, ...d.pages.slice(1)] };
  }
  return updateListCache(listData, (items: unknown[]) => [item, ...(items || [])]);
}

/**
 * Replace an item (matched by id) across a list cache entry — the
 * temp-ID-reconciliation primitive. After a create succeeds, the optimistic
 * placeholder (`temp-…` id) is swapped for the server document in place, so
 * the UI keeps the row (no flicker) while the id becomes real. Works on flat
 * and infinite shapes via {@link updateListCache}.
 */
export function replaceItemInListCache(
  listData: unknown,
  matchId: string,
  replacement: unknown,
  opts: { idField?: string } = {},
): unknown {
  return updateListCache(listData, (items: unknown[]) => {
    let changed = false;
    const next = items.map((item) => {
      const id = opts.idField
        ? String((item as Record<string, unknown> | null)?.[opts.idField] ?? "") || getItemId(item)
        : getItemId(item);
      if (id !== matchId) return item;
      changed = true;
      return replacement;
    });
    return changed ? next : items;
  });
}

// ============================================================================
// Cross-cache pseudo-normalization (0.7+)
// ============================================================================
//
// Vocabulary lock-in with arc / repo-core:
//   - `TDoc` (the type) is the backend-facing entity generic. Comes from
//     `BaseApi<TDoc>` / `Repository<TDoc>` / mongokit's `Document`. We don't
//     redefine it here.
//   - `item` (the variable / JSDoc noun) is what arc-next consumers see:
//     `useDetail().item`, `useList().items`, `extractItem`, `getItemId`,
//     `findItemInListCache`. We use `item` consistently on the public
//     helper surface so a reader scanning a hook + a cache call recognizes
//     the same thing without translation.
//   - `data` is the JSON envelope field name on the WIRE (`{ data: [...],
//     total, ... }`). It is NOT a noun for "one entity" — `data[i]` is one
//     item, `data` itself is the list array. We avoid `data` as a variable
//     name in this layer to keep the wire-vs-runtime split clean.
//
// arc-next holds one cache entry per query, not one per entity (TanStack
// Query is a query cache, not an entity store). Without help, the same item
// can live in N places at once: list payloads, detail-by-id, detail-by-slug,
// scoped variants, infinite-query pages, etc. — each with its own staleness
// clock.
//
// `syncDetailToLists` is the cheapest possible fix for the read-side of
// this duplication: after a fresh detail fetch lands, walk every list
// cache containing the item and shallow-merge the new fields in place.
// We do NOT create new cache entries (that was the 0.6 prefill bug — it
// blocked subsequent GETs because the cache looked fresh). We only UPDATE
// entries that already exist, so the user sees consistent values across
// every component reading those caches without any extra network round-trip.
//
// This is pseudo-normalization, not the real thing — copies still exist in
// memory, garbage collection is still per-query. For true normalization
// (one copy per entity, field-level invalidation, GC by reference count),
// use Apollo Client or Relay. arc-next stays opinionated about its niche:
// REST + React Query with a tiny runtime and zero codegen.
// ============================================================================

/** Item-identity helper that respects a custom idField, falling back to `_id` / `id`. */
function resolveId(item: unknown, idField?: string): string | null {
  if (!item || typeof item !== "object") return null;
  if (idField) {
    const v = (item as Record<string, unknown>)[idField];
    if (v != null) return String(v);
  }
  return getItemId(item);
}

/**
 * Shallow-merge updater that preserves the receiver's key set. Detail payloads
 * are often richer than list payloads (populated relations, full body fields).
 * If we replaced wholesale we'd bloat list caches with detail-only fields and
 * force a full re-render on every value change. Merge keeps lists lean while
 * still picking up updates to fields the list already cares about.
 */
function shallowMergeKept<T extends Record<string, unknown>>(
  receiver: T,
  source: Record<string, unknown>,
): T {
  let changed = false;
  const next: Record<string, unknown> = { ...receiver };
  for (const key of Object.keys(receiver)) {
    if (key in source && !Object.is(receiver[key], source[key])) {
      next[key] = source[key];
      changed = true;
    }
  }
  return changed ? (next as T) : receiver;
}

/**
 * After a detail fetch lands, propagate the fresh values into every cached
 * list entry that contains this item. The item's ID is resolved via
 * `idField`, falling back to `_id` / `id`. Handles both flat list payloads
 * and infinite-query page arrays.
 *
 * Only updates EXISTING list entries — never creates new caches or new items
 * in lists. If the item moved between filter buckets (e.g. status changed),
 * the relevant lists will refetch on their own; we don't try to predict
 * filter membership.
 *
 * Returns the number of cache entries updated (useful for tests + telemetry).
 *
 * Pass the lists of the detail's OWN partition (`KEYS.lists(partition)`): a document read as one
 * identity must never land in a list read as another (a private read in an anonymous list).
 *
 * @param qc TanStack QueryClient
 * @param listsKey Prefix key of the lists to update (`KEYS.lists(partition)`)
 * @param item Fresh entity to merge into matching list items
 * @param opts.idField Custom ID field name (defaults to `_id` / `id` lookup)
 */
export function syncDetailToLists<TItem extends Record<string, unknown>>(
  qc: QueryClient,
  listsKey: QueryKey,
  item: TItem,
  opts: { idField?: string } = {},
): number {
  const targetId = resolveId(item, opts.idField);
  if (!targetId) return 0;

  let updates = 0;
  const entries = qc.getQueriesData<unknown>({ queryKey: listsKey });
  for (const [qKey, raw] of entries) {
    if (!raw) continue;

    // Infinite-query value is `{ pages: unknown[], pageParams }`. Walk pages so
    // we don't double-write the wrapper.
    const isInfinite =
      typeof raw === "object" && raw !== null && Array.isArray((raw as { pages?: unknown }).pages);

    if (isInfinite) {
      const inf = raw as { pages: unknown[]; pageParams: unknown[] };
      let pagesChanged = false;
      const nextPages = inf.pages.map((page) => {
        const merged = mergeItemIntoListPage(page, targetId, item, opts.idField);
        if (merged !== page) pagesChanged = true;
        return merged;
      });
      if (pagesChanged) {
        qc.setQueryData(qKey, { ...inf, pages: nextPages });
        updates += 1;
      }
      continue;
    }

    const merged = mergeItemIntoListPage(raw, targetId, item, opts.idField);
    if (merged !== raw) {
      qc.setQueryData(qKey, merged);
      updates += 1;
    }
  }
  return updates;
}

/** Internal — merge an item into a single list payload (one filter result or one infinite page). */
function mergeItemIntoListPage<TItem extends Record<string, unknown>>(
  page: unknown,
  targetId: string,
  item: TItem,
  idField?: string,
): unknown {
  return updateListCache(page, (items: unknown[]) => {
    let changed = false;
    const next = items.map((listItem) => {
      if (!listItem || typeof listItem !== "object") return listItem;
      if (resolveId(listItem, idField) !== targetId) return listItem;
      const merged = shallowMergeKept(listItem as Record<string, unknown>, item);
      if (merged !== listItem) changed = true;
      return merged;
    });
    return changed ? next : items;
  });
}

// NOTE on the reverse direction (list → detail): we intentionally do NOT
// ship a `syncListsToDetail`. List payloads are typically a SUBSET of the
// detail payload (apps trim fields with `select=...` for list-page perf),
// so a post-fetch list → detail merge overwrites the rich detail-cache
// values with the trimmed list values. The detail GET is the authoritative
// read for one item; we mirror it OUT to lists (above), but never IN from
// lists. For propagating optimistic mutations from a list view into open
// detail views, use `useActions.update` — it already fans out to every
// `[entity, 'detail', id, *]` cache (hooks.ts onMutate path).

// ============================================================================
// Query keys: ONE factory per resource
// ============================================================================

/**
 * WHO a cached read was made for: the identity partition every resource key carries in full.
 * Two reads that differ in any of these answer differently, so they never share an entry, and a
 * write, a detail-to-list sync or a list placeholder only ever moves data WITHIN one partition.
 *
 * - `auth`: `"omit"` for an anonymous read (no credential, CDN-shareable), else `"inherit"`.
 * - `organizationId`: the tenant the request carries (`x-organization-id`), resolved the way the
 *   transport resolves it (see `BaseApi.identity`); `null` when it carries none. Never a filter.
 * - `scope`: an explicit partition for reads whose request context differs in a way arc-next
 *   cannot see (custom headers); `null` when unset.
 *
 * Always all three fields, `null` for none: TanStack's prefix filters match objects PARTIALLY
 * (`partialMatchKey`), so only a fixed shape makes `[entity, "list", partition]` an exact
 * partition filter.
 */
export interface KeyPartition {
  auth: RequestAuth;
  organizationId: string | null;
  scope: string | null;
}

/** A partition as a caller states it; omitted fields are the defaults (`inherit`, none, none). */
export type KeyScope = Partial<KeyPartition>;

/** The full partition segment of a key; anonymous reads carry no tenant. */
function keyPartition(scope: KeyScope = {}): KeyPartition {
  const auth: RequestAuth = scope.auth === "omit" ? "omit" : "inherit";
  return {
    auth,
    organizationId: auth === "omit" ? null : scope.organizationId || null,
    scope: scope.scope || null,
  };
}

/**
 * The key factory for one resource. Every hook, every `queryOptions` factory, every prefetch
 * and every invalidation builds its key here, so a server-seeded cache always hydrates the
 * matching hook and an invalidation always reaches what it means to. `P` is the
 * {@link KeyPartition}, always present in full; build it from what the read will SEND (the
 * option factories resolve it from the api's transport: `queries.partition(ctx)`).
 *
 * Shape (prefixes invalidate everything under them):
 *   [entity]                                   all
 *   [entity, "list", P, params]                list        (lists() / lists(P) prefixes)
 *   [entity, "list", P, params, "infinite"]    infinite    (lists() prefix: writes reach it)
 *   [entity, "detail", id, P, params?]         detail      (detail(id) prefix: every variant)
 *   [entity, "slug", slug, P, params?]         bySlug      (slugs() prefix)
 *   [entity, "count", P, params]               count       (counts() prefix)
 *   [entity, "aggregation", name, P, filter]   aggregation (aggregations() / aggregations(name))
 *   [entity, "deleted" | "tree", P, params]    presets
 *   [entity, "children", parentId, P, params]  preset
 *   [entity, "route", path, P, params]         custom route (routes() prefix)
 *   [entity, "write"]                          mutationKey of every CRUD write
 */
export interface QueryKeys {
  all: readonly [string];
  /** Every list of the resource; with a partition, only the lists read as that identity. */
  lists: (scope?: KeyScope) => QueryKey;
  list: (params?: Record<string, unknown>, scope?: KeyScope) => QueryKey;
  infinite: (params?: Record<string, unknown>, scope?: KeyScope) => QueryKey;
  details: () => QueryKey;
  /**
   * Without options: the prefix of every variant of this id (every partition and params). With
   * options: the entry of one partition (`{}` = the default one), which prefixes its params
   * variants.
   */
  detail: (id: string, opts?: KeyScope & { params?: Record<string, unknown> }) => QueryKey;
  slugs: () => QueryKey;
  slug: (slug: string, opts?: KeyScope & { params?: Record<string, unknown> }) => QueryKey;
  counts: () => QueryKey;
  count: (params?: Record<string, unknown>, scope?: KeyScope) => QueryKey;
  deleted: (params?: Record<string, unknown>, scope?: KeyScope) => QueryKey;
  tree: (params?: Record<string, unknown>, scope?: KeyScope) => QueryKey;
  children: (parentId: string, params?: Record<string, unknown>, scope?: KeyScope) => QueryKey;
  /** Every aggregation of the resource, or every variant of one named aggregation. */
  aggregations: (name?: string) => QueryKey;
  aggregation: (name: string, filter?: Record<string, unknown>, scope?: KeyScope) => QueryKey;
  /** Every custom-route read of the resource (prefix of `route`). */
  routes: () => QueryKey;
  /** A custom route read (`GET /:resource/<path>`); `path` is normalized to a leading `/`. */
  route: (path: string, params?: Record<string, unknown>, scope?: KeyScope) => QueryKey;
  /** The `mutationKey` every CRUD write of this resource shares (`useMutationState` filters on it). */
  write: () => QueryKey;
  /** A host-defined read under this resource (`custom("mine")`), invalidated by `all`. */
  custom: (key: string, ...args: unknown[]) => QueryKey;
}

/**
 * A single-record key: `[entity, kind, id]` alone is the prefix of every variant; with options it
 * is one partition's entry, plus `params` when the read has them.
 */
function recordKey(
  entityKey: string,
  kind: string,
  id: string,
  opts?: KeyScope & { params?: Record<string, unknown> },
): QueryKey {
  if (!opts) return [entityKey, kind, id];
  const { params, ...scope } = opts;
  return params
    ? [entityKey, kind, id, keyPartition(scope), params]
    : [entityKey, kind, id, keyPartition(scope)];
}

export function createQueryKeys(entityKey: string): QueryKeys {
  // `params` are the query string as given (an `organizationId` FILTER included); the tenant is
  // the partition's `organizationId`, so a tenant and a filter of the same name never alias.
  const list = (params: Record<string, unknown> = {}, scope?: KeyScope): QueryKey => [
    entityKey,
    "list",
    keyPartition(scope),
    params,
  ];
  const collection =
    (kind: string) =>
    (params: Record<string, unknown> = {}, scope?: KeyScope): QueryKey => [
      entityKey,
      kind,
      keyPartition(scope),
      params,
    ];
  return {
    all: [entityKey],
    lists: (scope) => (scope ? [entityKey, "list", keyPartition(scope)] : [entityKey, "list"]),
    list,
    infinite: (params, scope) => [...list(params, scope), "infinite"],
    details: () => [entityKey, "detail"],
    detail: (id, opts) => recordKey(entityKey, "detail", id, opts),
    slugs: () => [entityKey, "slug"],
    slug: (slug, opts) => recordKey(entityKey, "slug", slug, opts),
    counts: () => [entityKey, "count"],
    count: collection("count"),
    deleted: collection("deleted"),
    tree: collection("tree"),
    children: (parentId, params = {}, scope) => [
      entityKey,
      "children",
      parentId,
      keyPartition(scope),
      params,
    ],
    aggregations: (name) => (name ? [entityKey, "aggregation", name] : [entityKey, "aggregation"]),
    aggregation: (name, filter = {}, scope) => [
      entityKey,
      "aggregation",
      name,
      keyPartition(scope),
      filter,
    ],
    routes: () => [entityKey, "route"],
    route: (path, params = {}, scope) => [
      entityKey,
      "route",
      path.startsWith("/") ? path : `/${path}`,
      keyPartition(scope),
      params,
    ],
    write: () => [entityKey, "write"],
    custom: (key, ...args) => [entityKey, key, ...args],
  };
}

// ============================================================================
// Change-driven invalidation: the ONE rule for what a write makes stale
// ============================================================================

/** The part of a write that decides what it makes stale (an `ArcChangeEvent` fits). */
export interface CacheChange {
  op: "create" | "update" | "delete" | "restore";
  id?: string | null;
}

/**
 * Invalidate exactly what one write can have changed, never the whole resource:
 *
 * - every write: lists (and infinite lists), counts and aggregations, whose rows derive from it;
 * - update / restore: that record's detail and slug variants (not every other record's);
 * - delete: that record's detail is removed, not refetched (it would 404);
 * - restore: the soft-deleted list too.
 *
 * Shared by `createCrudHooks` mutations and `useResourceSync` (realtime), so a local write and a
 * broadcast from another tab or user refresh the same caches.
 */
export async function invalidateForChange(
  client: QueryClient,
  keys: QueryKeys,
  change: CacheChange,
): Promise<void> {
  const targets: QueryKey[] = [keys.lists(), keys.counts(), keys.aggregations()];
  if (change.op === "restore") targets.push(keys.deleted().slice(0, 2));
  if (change.id && (change.op === "update" || change.op === "restore")) {
    targets.push(keys.detail(change.id), keys.slugs());
  }
  if (change.id && change.op === "delete") {
    client.removeQueries({ queryKey: keys.detail(change.id) });
  }
  await Promise.all(targets.map((queryKey) => client.invalidateQueries({ queryKey })));
}

// ============================================================================
// Cache tags: one naming rule for the CDN and for server caches
// ============================================================================

/**
 * The resource tag rule, identical to arc's http-cache `resourceTags`
 * (`@classytic/arc/http-cache`, `policy/tags.ts`): `<resource>` and `<resource>:<id>`.
 * arc stamps these on cacheable responses (`Cache-Tag` / `Surrogate-Key`) and purges them on
 * writes, so a client that names CDN tags must name them the same way. arc-next does not import
 * arc (server code); `tests/cache-tags.test.ts` pins the rule instead.
 */
export function resourceTags(resource: string, id?: unknown): string[] {
  return id === undefined || id === null || id === ""
    ? [resource]
    : [resource, `${resource}:${String(id)}`];
}

/**
 * The server-cache tag (Next `fetch(..., { next: { tags } })`, `revalidateTag`) for a resource,
 * one record of it, or a scoped collection: `arc:` + the resource tag rule.
 *
 *   arcTag("lessons")                                  "arc:lessons"
 *   arcTag("lessons", id)                              "arc:lessons:<id>"
 *   arcTag("lessons", undefined, { by: "course", id }) "arc:lessons@course:<id>"
 *
 * The `arc:` prefix keeps arc's tags apart from the host's own in Next's shared tag namespace;
 * strip it and the tag is exactly the one arc's CDN layer uses.
 */
export function arcTag(entity: string, id?: string, scope?: { by: string; id: string }): string {
  if (scope) return `arc:${entity}@${scope.by}:${scope.id}`;
  const tags = resourceTags(entity, id);
  return `arc:${tags[tags.length - 1]}`;
}

/**
 * The server-cache tags one write invalidates: the resource's collection tag and, when the write
 * names a record, that record's tag. Feed them to `revalidateTag` / `updateTag` from an
 * `onArcChange` listener.
 */
export function changeTags(change: { entity: string; id?: string | null }): string[] {
  return change.id
    ? [arcTag(change.entity), arcTag(change.entity, change.id)]
    : [arcTag(change.entity)];
}

// ============================================================================
// Cache utilities factory
// ============================================================================

export interface CacheUtils<T> {
  invalidateAll: (client: QueryClient) => Promise<void>;
  invalidateLists: (client: QueryClient) => Promise<void>;
  /** Invalidate detail by ID (prefix-matches all scoped/parameterized variants). */
  invalidateDetail: (client: QueryClient, id: string) => Promise<void>;
  /**
   * Write one partition's detail entry (omitted: the default partition, signed in with no
   * tenant). Pass the partition the reading hook uses: `hooks.queries.partition(ctx)`.
   */
  setDetail: (client: QueryClient, id: string, data: T, scope?: KeyScope) => void;
  getDetail: (client: QueryClient, id: string, scope?: KeyScope) => T | undefined;
  /** Remove every cached variant of the record. */
  removeDetail: (client: QueryClient, id: string) => void;
  /**
   * Invalidate every aggregation for this resource, or every variant of one named aggregation.
   */
  invalidateAggregations: (client: QueryClient, name?: string) => Promise<void>;
  /** {@link invalidateForChange} bound to this resource's keys. */
  invalidateForChange: (client: QueryClient, change: CacheChange) => Promise<void>;
}

/**
 * Cache read/write/invalidate helpers bound to a key factory. Server-safe: works on a per-request
 * server client (prefetch) and on the browser client alike.
 *
 * **Wire shape:** arc emits raw documents on `GET /:resource/:id` (no envelope), so detail caches
 * hold `TDoc` everywhere: hook `queryFn`, `useNavigation`, prefetch and these helpers.
 */
export function createCacheUtils<T>(KEYS: QueryKeys): CacheUtils<T> {
  return {
    invalidateAll: (client) => client.invalidateQueries({ queryKey: KEYS.all }),
    invalidateLists: (client) => client.invalidateQueries({ queryKey: KEYS.lists() }),
    invalidateDetail: (client, id) => client.invalidateQueries({ queryKey: KEYS.detail(id) }),
    setDetail: (client, id, data, scope = {}) =>
      client.setQueryData<T>(KEYS.detail(id, scope), data),
    getDetail: (client, id, scope = {}) =>
      client.getQueryData<T>(KEYS.detail(id, scope)) ?? undefined,
    removeDetail: (client, id) => client.removeQueries({ queryKey: KEYS.detail(id) }),
    invalidateAggregations: (client, name) =>
      client.invalidateQueries({ queryKey: KEYS.aggregations(name) }),
    invalidateForChange: (client, change) => invalidateForChange(client, KEYS, change),
  };
}
