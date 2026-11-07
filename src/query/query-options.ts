// Server-safe option factories: the TanStack v5 "query factory" convention, and the ONE place an
// arc resource's { queryKey, queryFn } and { mutationKey, mutationFn } pairs are assembled.
//
//   const products = createEntityQueries<Product>(productApi, "products");
//
//   useQuery(products.list({ limit: 20 }))                     // client
//   useSuspenseQuery(products.detail("p1"))                    // suspense / streaming SSR
//   streamQueries([products.list({ limit: 20 }, { token })])   // Server Component (./prefetch)
//   queryClient.query({ ...products.detail("p1"), staleTime: "static" }) // loader
//   queryClient.setQueryData(products.detail("p1").queryKey, next)     // typed (DataTag)
//   useMutation(products.update())                             // shares the CRUD write key
//
// `createCrudHooks` builds its read hooks and its CRUD mutations from these same factories, so a
// factory-seeded cache hydrates the hook by construction (tests/key-parity.test.ts).
//
// No `"use client"`: `queryOptions` / `infiniteQueryOptions` / `mutationOptions` are pure, so a
// Server Component may import this file. No DOM, no Next imports: React Native safe.
//
// AUTH: hooks resolve token/org per render from the configured auth context. On the SERVER there
// is no ambient auth: pass `{ token, organizationId }` (or forwarded `headers`) in `ctx`. A public
// endpoint can be read anonymously with `{ auth: "omit" }` (CDN-cacheable; see `RequestAuth`).

import type { PaginatedResult } from "@classytic/repo-core/pagination";
import type { AggResult, AggRow } from "@classytic/repo-core/repository";
import {
  infiniteQueryOptions,
  type MutationMeta,
  mutationOptions,
  type QueryKey,
  queryOptions,
  type StaleTime,
} from "@tanstack/react-query";
import { isKeysetPagination, isOffsetPagination } from "../client/api.js";
import {
  type NextFetchOptions,
  type RequestAuth,
  type RequestIdentity,
  resolveRequestIdentity,
} from "../client/client.js";
import {
  type CacheChange,
  createQueryKeys,
  invalidateForChange,
  type KeyPartition,
  type QueryKeys,
} from "./cache.js";

// ============================================================================
// Types
// ============================================================================

/** Per-call request context: who the read is for, plus fetch caching passthrough. */
export interface QueryFnContext {
  /**
   * Bearer token. Omitted: the configured one (`configureAuth`, the api's client). `null`: none.
   * Server-side there is no configured one, so pass it for non-public reads.
   */
  token?: string | null;
  /**
   * The tenant (`x-organization-id`), keyed in the read's identity partition. Omitted: the
   * configured org, resolved before the key is built. `null`: no org header (a user-level read
   * such as `/me`). Never a filter: an `organizationId` in `params` is a query-string filter.
   */
  organizationId?: string | null;
  /** `"omit"`: read anonymously (no token, org, keys, cookies); its own cache entry. */
  auth?: RequestAuth;
  /** An explicit cache partition for two reads with equal params that must not share a cache. */
  scope?: string;
  /** Extra headers (e.g. forwarded request headers, x-api-key). */
  headers?: Record<string, string>;
  /** Fetch cache mode forwarded to the API call. */
  cache?: RequestCache;
  /** Next data cache (`{ revalidate, tags }`) for an ISR-friendly prefetch. Inert off-Next. */
  next?: NextFetchOptions;
  timeoutMs?: number;
}

export interface DetailQueryOpts extends QueryFnContext {
  /** Query params (select, populate): part of the key, matching `useDetail`. */
  params?: { select?: string; populate?: string | string[] };
}

/** HTTP methods a custom route can be called with (`BaseApi.invokeRoute`). */
export type RouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Options of {@link EntityQueries.route}: a GET custom route as a query. */
export interface RouteQueryOpts extends QueryFnContext {
  /** Query string (same grammar as list params). Part of the key. */
  params?: Record<string, unknown>;
  /** Freshness for this route (a `/me` or a stats tile rarely shares the resource's default). */
  staleTime?: StaleTime;
}

/** Variables of a {@link EntityQueries.routeMutation} call. */
export interface RouteMutationVariables<TBody = unknown> {
  /** JSON body. */
  data?: TBody;
  /** Query string. */
  params?: Record<string, unknown>;
  /** Values for the template's `:name` segments (`"/:id/approve"` takes `{ id }`), URL-encoded. */
  pathParams?: Record<string, string>;
  /** `undefined`: configured token. `null`: none. */
  token?: string | null;
  /** `undefined`: configured org. `null`: no `x-organization-id`. */
  organizationId?: string | null;
}

/** Options of {@link EntityQueries.routeMutation}. */
export interface RouteMutationOpts<TData, TBody> {
  /** Default `"POST"`. */
  method?: Exclude<RouteMethod, "GET">;
  /** `"omit"`: send the write anonymously (a public form). Default: the caller's identity. */
  auth?: RequestAuth;
  /**
   * What the write made stale, run on success against the mutation's own `QueryClient`:
   * a {@link CacheChange} (`{ op, id }`) goes through the scoped `invalidateForChange` (lists,
   * counts, aggregations, that record's detail); a key list invalidates exactly those keys
   * (`[keys.routes()]` for every custom-route read of the resource). Omitted: nothing.
   */
  invalidates?: (
    data: TData,
    variables: RouteMutationVariables<TBody>,
  ) => CacheChange | readonly QueryKey[] | undefined;
}

/** Request options this module forwards to the api (a subset of `RequestOptions`). */
type ForwardedApiOptions = {
  headerOptions?: Record<string, string>;
  cache?: RequestCache;
  next?: NextFetchOptions;
  timeoutMs?: number;
  auth?: RequestAuth;
  signal?: AbortSignal;
};

interface Who {
  token?: string | null;
  organizationId?: string | null;
  options?: ForwardedApiOptions;
}

/** Structural api contract (`BaseApi` satisfies it; presets add the optionals). */
export interface EntityApi {
  /**
   * The identity a read is sent with, resolved through the api's own transport (`BaseApi`
   * provides it). An api without it is taken to use the global transport
   * (`configureClient` / `configureAuth`).
   */
  identity?: (args: {
    organizationId?: string | null;
    options?: { auth?: RequestAuth; headerOptions?: Record<string, string> };
  }) => RequestIdentity;
  getAll: (opts: Who & { params?: Record<string, unknown> }) => Promise<unknown>;
  getById: (opts: Who & { id: string; params?: Record<string, unknown> }) => Promise<unknown>;
  count?: (opts: Who & { params?: Record<string, unknown> }) => Promise<number>;
  getBySlug?: (opts: Who & { slug: string; params?: Record<string, unknown> }) => Promise<unknown>;
  getDeleted?: (opts: Who & { params?: Record<string, unknown> }) => Promise<unknown>;
  getTree?: (opts: Who & { params?: Record<string, unknown> }) => Promise<unknown>;
  getChildren?: (
    opts: Who & { parentId: string; params?: Record<string, unknown> },
  ) => Promise<unknown>;
  aggregate?: (opts: Who & { name: string; filter?: Record<string, unknown> }) => Promise<unknown>;
  invokeRoute?: (
    opts: Who & {
      method?: RouteMethod;
      path: string;
      data?: unknown;
      params?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
  create?: (opts: Who & { data: never }) => Promise<unknown>;
  update?: (opts: Who & { id: string; data: never; version?: number }) => Promise<unknown>;
  delete?: (opts: Who & { id: string }) => Promise<unknown>;
}

/** Variables of the CRUD write mutations. `token` / `organizationId` default to the auth context. */
export interface CreateVariables<TCreate> {
  data: TCreate;
  token?: string | null;
  organizationId?: string | null;
}
export interface UpdateVariables<TUpdate> {
  id: string;
  data: TUpdate;
  /** `If-Match` version (needs `versionField` on the api); `null` = no precondition. */
  version?: number | null;
  token?: string | null;
  organizationId?: string | null;
}
export interface DeleteVariables {
  id: string;
  token?: string | null;
  organizationId?: string | null;
}

/** `meta.arc` on every CRUD write mutation: which resource and which operation. */
export interface ArcMutationMeta extends MutationMeta {
  arc: { entity: string; op: "create" | "update" | "delete" };
}

/** Next page param for arc's list shapes: keyset `next` cursor, else offset `page + 1`. */
export function nextPageParam(lastPage: unknown): string | number | undefined {
  const page = lastPage as PaginatedResult<unknown> | null;
  if (!page || typeof page !== "object") return undefined;
  if (isKeysetPagination(page)) return page.hasMore && page.next ? page.next : undefined;
  if (isOffsetPagination(page)) return page.hasNext ? page.page + 1 : undefined;
  const p = page as unknown as Record<string, unknown>;
  if (typeof p.hasNext === "boolean" && typeof p.page === "number") {
    return p.hasNext ? p.page + 1 : undefined;
  }
  return undefined;
}

/** Previous page param for offset shapes (keyset pages are append-only). */
export function previousPageParam(firstPage: unknown): number | undefined {
  const p = firstPage as Record<string, unknown> | null;
  if (p && typeof p.hasPrev === "boolean" && typeof p.page === "number") {
    return p.hasPrev ? p.page - 1 : undefined;
  }
  return undefined;
}

// ============================================================================
// Factory
// ============================================================================

export type EntityQueries<
  TDoc = unknown,
  TCreate = Partial<TDoc>,
  TUpdate = Partial<TDoc>,
> = ReturnType<typeof createEntityQueries<TDoc, TCreate, TUpdate>>;

const missing = (entityKey: string, method: string, preset: string) =>
  Promise.reject(new Error(`[arc-next] "${entityKey}" api does not define ${method} (${preset})`));

/** `"/:id/approve"` + `{ id: "o 1" }` → `"/o%201/approve"`; a segment with no value throws. */
function fillPath(template: string, values: Record<string, string> = {}): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === "") {
      throw new Error(`[arc-next] route "${template}" needs pathParams.${name}`);
    }
    return encodeURIComponent(value);
  });
}

const isKeyList = (value: CacheChange | readonly QueryKey[]): value is readonly QueryKey[] =>
  Array.isArray(value);

/**
 * Build the option factories for one resource. Server-safe and React Native safe; keys come from
 * `createQueryKeys(entityKey)`, the same factory `createCrudHooks` uses.
 *
 * @example
 * export const productQueries = createEntityQueries<Product>(productApi, "products");
 * // RSC: <HydrationBoundary state={streamQueries([productQueries.list({ limit: 20 })])}>
 */
export function createEntityQueries<
  TDoc = unknown,
  TCreate = Partial<TDoc>,
  TUpdate = Partial<TDoc>,
>(api: EntityApi, entityKey: string) {
  const keys: QueryKeys = createQueryKeys(entityKey);
  // A resource declared `readAuth: "omit"` (BaseApiConfig) reads anonymously everywhere, so its
  // keys must say so everywhere too: a server prefetch and a signed-in hook then share one entry.
  const resourceAuth = (api as { config?: { readAuth?: RequestAuth } }).config?.readAuth;

  const fwd = (ctx: QueryFnContext, signal?: AbortSignal): { options?: ForwardedApiOptions } => {
    const opt: ForwardedApiOptions = {};
    if (ctx.headers) opt.headerOptions = ctx.headers;
    if (ctx.cache !== undefined) opt.cache = ctx.cache;
    if (ctx.next !== undefined) opt.next = ctx.next;
    if (ctx.timeoutMs !== undefined) opt.timeoutMs = ctx.timeoutMs;
    if (ctx.auth !== undefined) opt.auth = ctx.auth;
    if (signal) opt.signal = signal;
    return Object.keys(opt).length ? { options: opt } : {};
  };

  /**
   * The identity partition a read with this `ctx` is sent as, resolved NOW through the api's
   * transport (its client's `getOrgId`, `configureAuth`, a forwarded `x-organization-id` header,
   * `readAuth`), so the key names every input that changes the response (TanStack's
   * exhaustive-deps rule) and two request contexts never share an entry.
   */
  const partition = (ctx: QueryFnContext = {}): KeyPartition => {
    const options = {
      ...(ctx.auth !== undefined ? { auth: ctx.auth } : {}),
      ...(ctx.headers ? { headerOptions: ctx.headers } : {}),
    };
    const args = {
      ...(ctx.organizationId !== undefined ? { organizationId: ctx.organizationId } : {}),
      options,
    };
    const identity = api.identity
      ? api.identity(args)
      : resolveRequestIdentity(undefined, {
          ...args,
          ...options,
          auth: ctx.auth ?? resourceAuth ?? "inherit",
        });
    // The identity already drops the tenant of an anonymous read; `null` for none, never undefined.
    return {
      auth: identity.auth,
      organizationId: identity.organizationId,
      scope: ctx.scope || null,
    };
  };

  /**
   * Who the read is for. `params` are the query string, sent as given, so an `organizationId`
   * FILTER stays a filter (signed-in or anonymous) and never becomes the `x-organization-id`
   * header, nor the header a filter. The request carries the tenant its key was built for (not
   * one re-resolved when a background refetch runs later); the token keeps the transport's three
   * states (`undefined` = configured default, `null` = none). An anonymous read sends neither.
   */
  const who = (params: Record<string, unknown>, ctx: QueryFnContext) => {
    const p = partition(ctx);
    const anonymous = p.auth === "omit";
    return {
      org: anonymous ? undefined : p.organizationId,
      rest: params,
      scope: p,
      token: anonymous ? undefined : ctx.token,
    };
  };

  /**
   * A method of the api, looked up on EVERY call (a preset applied, or a method replaced, after the
   * factory was built still counts), or a rejection naming the preset that provides it.
   */
  type Method = Exclude<keyof EntityApi, "getAll" | "getById">;
  const preset =
    <A>(key: Method, from: string) =>
    (args: A): Promise<unknown> => {
      const method = api[key] as ((args: A) => Promise<unknown>) | undefined;
      return method ? method.call(api, args) : missing(entityKey, key, from);
    };
  const getBySlug = preset<Parameters<NonNullable<EntityApi["getBySlug"]>>[0]>(
    "getBySlug",
    "slugLookup preset",
  );
  const count = preset<Parameters<NonNullable<EntityApi["count"]>>[0]>("count", "BaseApi");
  const getDeleted = preset<Parameters<NonNullable<EntityApi["getDeleted"]>>[0]>(
    "getDeleted",
    "softDelete preset",
  );
  const getTree = preset<Parameters<NonNullable<EntityApi["getTree"]>>[0]>(
    "getTree",
    "tree preset",
  );
  const getChildren = preset<Parameters<NonNullable<EntityApi["getChildren"]>>[0]>(
    "getChildren",
    "tree preset",
  );
  const aggregate = preset<Parameters<NonNullable<EntityApi["aggregate"]>>[0]>(
    "aggregate",
    "arc 2.13+",
  );
  const invokeRoute = preset<Parameters<NonNullable<EntityApi["invokeRoute"]>>[0]>(
    "invokeRoute",
    "BaseApi",
  );
  const create = preset<Parameters<NonNullable<EntityApi["create"]>>[0]>("create", "BaseApi");
  const update = preset<Parameters<NonNullable<EntityApi["update"]>>[0]>("update", "BaseApi");
  const remove = preset<Parameters<NonNullable<EntityApi["delete"]>>[0]>("delete", "BaseApi");

  const write = (op: ArcMutationMeta["arc"]["op"]): ArcMutationMeta => ({
    arc: { entity: entityKey, op },
  });

  return {
    /** The resource's key factory (invalidation, `setQueryData`, `useMutationState` filters). */
    keys,

    /** `true` when the api reads anonymously (`readAuth: "omit"`): reads need no session. */
    anonymousReads: resourceAuth === "omit",

    /**
     * The identity partition a read with `ctx` is keyed under (the same resolution every factory
     * below runs). Build a hand-written cache write with it, so it lands where the hook reads:
     * `qc.setQueryData(keys.detail(id, queries.partition()), doc)`.
     */
    partition,

    /** GET /:resource: the `useList` key. */
    list(params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const w = who(params, ctx);
      return queryOptions({
        queryKey: keys.list(w.rest, w.scope),
        queryFn: ({ signal }) =>
          api.getAll({
            params: w.rest,
            token: w.token,
            organizationId: w.org,
            ...fwd(ctx, signal),
          }) as Promise<PaginatedResult<TDoc>>,
      });
    },

    /**
     * Infinite list over arc's offset AND keyset strategies: a keyset cursor (string) is sent as
     * `after`, an offset page (number) as `page`. The `useInfiniteList` key.
     */
    infiniteList(params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const w = who(params, ctx);
      return infiniteQueryOptions({
        queryKey: keys.infinite(w.rest, w.scope),
        queryFn: ({ pageParam, signal }) =>
          api.getAll({
            // A cursor sent as `page` fails arc's query validation.
            params: {
              ...w.rest,
              ...(typeof pageParam === "string"
                ? { after: pageParam }
                : pageParam
                  ? { page: pageParam }
                  : {}),
            },
            token: w.token,
            organizationId: w.org,
            ...fwd(ctx, signal),
          }) as Promise<PaginatedResult<TDoc>>,
        initialPageParam: (typeof w.rest.after === "string" ? w.rest.after : 1) as string | number,
        getNextPageParam: (lastPage) => nextPageParam(lastPage),
      });
    },

    /** GET /:resource/:id: the `useDetail` key (tenant-scoped, + params variant). */
    detail(id: string, opts: DetailQueryOpts = {}) {
      const { params, ...ctx } = opts;
      const w = who({}, ctx);
      return queryOptions({
        queryKey: keys.detail(id, { ...w.scope, ...(params ? { params } : {}) }),
        queryFn: ({ signal }) =>
          api.getById({
            id,
            token: w.token,
            organizationId: w.org,
            ...(params ? { params } : {}),
            ...fwd(ctx, signal),
          }) as Promise<TDoc>,
      });
    },

    /** GET /:resource/slug/:slug (slugLookup preset): the `useDetailBySlug` key. */
    bySlug(slug: string, opts: DetailQueryOpts = {}) {
      const { params, ...ctx } = opts;
      const w = who({}, ctx);
      return queryOptions({
        queryKey: keys.slug(slug, { ...w.scope, ...(params ? { params } : {}) }),
        queryFn: ({ signal }) =>
          getBySlug({
            slug,
            token: w.token,
            organizationId: w.org,
            ...(params ? { params } : {}),
            ...fwd(ctx, signal),
          }) as Promise<TDoc>,
      });
    },

    /** GET /:resource?_count=true: zero documents fetched. The `useCount` key. */
    count(params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const w = who(params, ctx);
      return queryOptions({
        queryKey: keys.count(w.rest, w.scope),
        queryFn: ({ signal }) =>
          count({
            params: w.rest,
            token: w.token,
            organizationId: w.org,
            ...fwd(ctx, signal),
          }) as Promise<number>,
      });
    },

    /** GET /:resource/deleted (softDelete preset): the `useDeleted` key. */
    deleted(params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const w = who(params, ctx);
      return queryOptions({
        queryKey: keys.deleted(w.rest, w.scope),
        queryFn: ({ signal }) =>
          getDeleted({
            params: w.rest,
            token: w.token,
            organizationId: w.org,
            ...fwd(ctx, signal),
          }) as Promise<PaginatedResult<TDoc>>,
      });
    },

    /** GET /:resource/tree (tree preset): the `useTree` key. */
    tree(params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const w = who(params, ctx);
      return queryOptions({
        queryKey: keys.tree(w.rest, w.scope),
        queryFn: ({ signal }) =>
          getTree({
            params: w.rest,
            token: w.token,
            organizationId: w.org,
            ...fwd(ctx, signal),
          }) as Promise<PaginatedResult<TDoc> | TDoc[]>,
      });
    },

    /** GET /:resource/:parentId/children (tree preset): the `useChildren` key. */
    children(parentId: string, params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const w = who(params, ctx);
      return queryOptions({
        queryKey: keys.children(parentId, w.rest, w.scope),
        queryFn: ({ signal }) =>
          getChildren({
            parentId,
            params: w.rest,
            token: w.token,
            organizationId: w.org,
            ...fwd(ctx, signal),
          }) as Promise<PaginatedResult<TDoc> | TDoc[]>,
      });
    },

    /** GET /:resource/aggregations/:name (arc 2.13+): the `useAggregation` key. */
    aggregation<TRow extends AggRow = AggRow>(
      name: string,
      filter?: Record<string, unknown>,
      ctx: QueryFnContext = {},
    ) {
      const w = who({}, ctx);
      return queryOptions({
        queryKey: keys.aggregation(name, filter, w.scope),
        queryFn: ({ signal }) =>
          aggregate({
            name,
            filter,
            token: w.token,
            organizationId: w.org,
            ...fwd(ctx, signal),
          }) as Promise<AggResult<TRow>>,
      });
    },

    /**
     * GET /:resource/<path>: a custom route (`defineResource({ routes })`) as a typed query, keyed
     * under `keys.routes()`. The fetch goes through `api.invokeRoute` with the query's abort signal.
     *
     * @example
     * useQuery(iamQueries.route<Me>("/me", { organizationId: null }))   // token, no org header
     * useQuery(products.route<Stats>("/stats", { params: { from }, staleTime: 60_000 }))
     */
    route<TData = unknown>(path: string, opts: RouteQueryOpts = {}) {
      const { params, staleTime, ...ctx } = opts;
      const w = who(params ?? {}, ctx);
      const hasParams = Object.keys(w.rest).length > 0;
      return queryOptions({
        queryKey: keys.route(path, w.rest, w.scope),
        queryFn: ({ signal }) =>
          invokeRoute({
            method: "GET",
            path,
            ...(hasParams ? { params: w.rest } : {}),
            token: w.token,
            organizationId: w.org,
            ...fwd(ctx, signal),
          }) as Promise<TData>,
        ...(staleTime !== undefined ? { staleTime } : {}),
      });
    },

    /**
     * POST (or PATCH / PUT / DELETE) /:resource/<path>: a custom route as typed `mutationOptions`.
     * `path` is a template (`"/:id/approve"`) filled from `variables.pathParams`, so the mutation
     * key (`keys.routes()` + template + method) is the same for every call. What the write makes
     * stale is named by `invalidates`, never guessed.
     *
     * @example
     * useMutation(orders.routeMutation<Order>("/:id/approve", {
     *   invalidates: (order) => ({ op: "update", id: order._id }),
     * }))
     * // mutate({ pathParams: { id }, data: { note } })
     */
    routeMutation<TData = unknown, TBody = unknown>(
      path: string,
      opts: RouteMutationOpts<TData, TBody> = {},
    ) {
      const method = opts.method ?? "POST";
      return mutationOptions<TData, Error, RouteMutationVariables<TBody>>({
        mutationKey: [...keys.routes(), path, method],
        mutationFn: (vars) =>
          invokeRoute({
            method,
            path: fillPath(path, vars.pathParams),
            ...(vars.data !== undefined ? { data: vars.data } : {}),
            ...(vars.params !== undefined ? { params: vars.params } : {}),
            token: vars.token,
            organizationId: vars.organizationId,
            ...(opts.auth !== undefined ? { options: { auth: opts.auth } } : {}),
          }) as Promise<TData>,
        ...(opts.invalidates
          ? {
              onSuccess: async (data, vars, _result, context) => {
                const stale = opts.invalidates?.(data, vars);
                if (!stale) return;
                if (isKeyList(stale)) {
                  await Promise.all(
                    stale.map((queryKey) => context.client.invalidateQueries({ queryKey })),
                  );
                } else {
                  await invalidateForChange(context.client, keys, stale);
                }
              },
            }
          : {}),
      });
    },

    /**
     * POST /:resource. Shares `keys.write()` with every CRUD write, so
     * `useMutationState({ filters: { mutationKey: keys.write() } })` sees it.
     */
    create() {
      return mutationOptions<TDoc, Error, CreateVariables<TCreate>>({
        mutationKey: keys.write(),
        meta: write("create"),
        mutationFn: ({ data, token, organizationId }) =>
          create({ token, organizationId, data: data as never }) as Promise<TDoc>,
      });
    },

    /** PATCH /:resource/:id (with `If-Match` when `version` is set). */
    update() {
      return mutationOptions<TDoc, Error, UpdateVariables<TUpdate>>({
        mutationKey: keys.write(),
        meta: write("update"),
        mutationFn: ({ id, data, version, token, organizationId }) =>
          update({
            token,
            organizationId,
            id,
            data: data as never,
            ...(version != null ? { version } : {}),
          }) as Promise<TDoc>,
      });
    },

    /** DELETE /:resource/:id. */
    remove() {
      return mutationOptions<unknown, Error, DeleteVariables>({
        mutationKey: keys.write(),
        meta: write("delete"),
        mutationFn: ({ id, token, organizationId }) => remove({ token, organizationId, id }),
      });
    },
  };
}
