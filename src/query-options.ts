// Server-safe queryOptions factories — the TanStack v5 "query factory" convention.
//
// ONE place where an entity's { queryKey, queryFn } pair is assembled, usable
// everywhere TanStack accepts options objects:
//
//   const products = createEntityQueries(productApi, 'products');
//
//   useQuery(products.list({ limit: 20 }))                    // client hook
//   useSuspenseQuery(products.detail('p1'))                   // suspense
//   queryClient.prefetchQuery(products.list({}, { token }))   // RSC prefetch
//   queryClient.ensureQueryData(products.detail('p1'))        // router loader
//   queryClient.setQueryData(products.detail('p1').queryKey, next)
//
// Keys are built from the SAME primitives the CRUD hooks use
// (`createQueryKeys` + `withOrgParams`), so a factory-seeded cache always
// hydrates the corresponding hook — pinned by tests/key-parity.test.ts.
//
// This module has no `"use client"` directive on purpose: `queryOptions` /
// `infiniteQueryOptions` are pure helpers, so Server Components can import
// this file to prefetch during RSC rendering (same rule as ./cache.ts and
// ./prefetch.ts, which consumes these factories).
//
// AUTH: the client CRUD hooks resolve token/org per render from the
// configured auth context. These factories are also used from the SERVER,
// where no ambient auth exists — pass `{ token, organizationId }` explicitly
// via the `ctx` argument there. On the client you may omit `ctx` only for
// public (`allowPublic`) endpoints.

import type { PaginatedResult } from "@classytic/repo-core/pagination";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { isKeysetPagination, isOffsetPagination } from "./api.js";
import { createQueryKeys, withOrgParams } from "./cache.js";

// ============================================================================
// Types
// ============================================================================

/** Per-call request context: auth + Next.js fetch caching passthrough. */
export interface QueryFnContext {
  /** Bearer token for protected endpoints (required server-side for non-public reads). */
  token?: string | null;
  /** Organization ID for multi-tenant reads. Also becomes part of the cache key. */
  organizationId?: string | null;
  /** Extra headers (e.g. x-api-key). */
  headers?: Record<string, string>;
  /** Next.js fetch caching forwarded to the API call (ISR-friendly prefetch). */
  cache?: RequestCache;
  revalidate?: number | false;
  tags?: string[];
}

type ForwardedApiOptions = {
  headerOptions?: Record<string, string>;
  cache?: RequestCache;
  revalidate?: number | false;
  tags?: string[];
  signal?: AbortSignal;
};

/** Structural read-API contract (BaseApi satisfies this; presets add the optionals). */
export interface EntityReadApi {
  getAll: (opts: {
    params?: Record<string, unknown>;
    token?: string | null;
    organizationId?: string | null;
    options?: ForwardedApiOptions;
  }) => Promise<unknown>;
  getById: (opts: {
    id: string;
    token?: string | null;
    organizationId?: string | null;
    params?: Record<string, unknown>;
    options?: ForwardedApiOptions;
  }) => Promise<unknown>;
  getBySlug?: (opts: {
    slug: string;
    token?: string | null;
    organizationId?: string | null;
    params?: Record<string, unknown>;
    options?: ForwardedApiOptions;
  }) => Promise<unknown>;
  getDeleted?: (opts: {
    params?: Record<string, unknown>;
    token?: string | null;
    organizationId?: string | null;
    options?: ForwardedApiOptions;
  }) => Promise<unknown>;
  getTree?: (opts: {
    params?: Record<string, unknown>;
    token?: string | null;
    organizationId?: string | null;
    options?: ForwardedApiOptions;
  }) => Promise<unknown>;
  getChildren?: (opts: {
    parentId: string;
    params?: Record<string, unknown>;
    token?: string | null;
    organizationId?: string | null;
    options?: ForwardedApiOptions;
  }) => Promise<unknown>;
  aggregate?: (opts: {
    name: string;
    filter?: Record<string, unknown>;
    token?: string | null;
    organizationId?: string | null;
    options?: ForwardedApiOptions;
  }) => Promise<unknown>;
}

export interface DetailQueryOpts extends QueryFnContext {
  /** Query params (select, populate) — becomes part of the key, matching useDetail. */
  params?: { select?: string; populate?: string | string[] };
}

// ============================================================================
// Factory
// ============================================================================

export type EntityQueries = ReturnType<typeof createEntityQueries>;

/**
 * Build queryOptions factories for one entity. Server-safe; keys are
 * hash-identical to the corresponding `createCrudHooks` hooks.
 *
 * @example
 * // queries/products.ts — colocate next to the api definition
 * export const productQueries = createEntityQueries(productApi, 'products');
 *
 * // RSC / route loader
 * await queryClient.ensureQueryData(productQueries.detail(id, { token }));
 */
export function createEntityQueries(api: EntityReadApi, entityKey: string) {
  const KEYS = createQueryKeys(entityKey);

  const fwd = (ctx: QueryFnContext, signal?: AbortSignal): { options?: ForwardedApiOptions } => {
    const opt: ForwardedApiOptions = {};
    if (ctx.headers) opt.headerOptions = ctx.headers;
    if (ctx.cache !== undefined) opt.cache = ctx.cache;
    if (ctx.revalidate !== undefined) opt.revalidate = ctx.revalidate;
    if (ctx.tags !== undefined) opt.tags = ctx.tags;
    if (signal) opt.signal = signal;
    return Object.keys(opt).length ? { options: opt } : {};
  };

  const resolveOrg = (
    params: Record<string, unknown>,
    ctx: QueryFnContext,
  ): { org: string | null; rest: Record<string, unknown> } => {
    const { organizationId: paramOrg, ...rest } = params;
    return { org: (paramOrg as string | null) ?? ctx.organizationId ?? null, rest };
  };

  return {
    /** The entity's key factory — for invalidation / setQueryData at call sites. */
    keys: KEYS,

    /** GET /:resource — mirrors `useList`'s key (scoped, org-normalized). */
    list(params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const { org, rest } = resolveOrg(params, ctx);
      const scope = org ? "tenant" : "super-admin";
      return queryOptions({
        queryKey: KEYS.scopedList(scope, withOrgParams(org, rest)),
        queryFn: ({ signal }) =>
          api.getAll({
            params: rest,
            token: ctx.token ?? null,
            organizationId: org,
            ...fwd(ctx, signal),
          }),
      });
    },

    /** GET /:resource/:id — mirrors `useDetail`'s scoped key (+ params variant). */
    detail(id: string, opts: DetailQueryOpts = {}) {
      const { params, ...ctx } = opts;
      const baseKey = KEYS.scopedDetail(id, ctx.organizationId ?? null);
      return queryOptions({
        queryKey: params ? [...baseKey, params] : baseKey,
        queryFn: ({ signal }) =>
          api.getById({
            id,
            token: ctx.token ?? null,
            organizationId: ctx.organizationId ?? null,
            ...(params ? { params } : {}),
            ...fwd(ctx, signal),
          }),
      });
    },

    /** GET /:resource/slug/:slug — mirrors `useDetailBySlug`'s key. */
    bySlug(slug: string, opts: DetailQueryOpts = {}) {
      const { params, ...ctx } = opts;
      return queryOptions({
        queryKey: params ? KEYS.custom("slug", slug, params) : KEYS.custom("slug", slug),
        queryFn: ({ signal }) => {
          if (!api.getBySlug) {
            return Promise.reject(
              new Error(
                `[arc-next] "${entityKey}" api does not define getBySlug (slugLookup preset)`,
              ),
            );
          }
          return api.getBySlug({
            slug,
            token: ctx.token ?? null,
            organizationId: ctx.organizationId ?? null,
            ...(params ? { params } : {}),
            ...fwd(ctx, signal),
          });
        },
      });
    },

    /** GET /:resource/deleted — mirrors `useDeleted`'s key. */
    deleted(params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const { org, rest } = resolveOrg(params, ctx);
      return queryOptions({
        queryKey: KEYS.custom("deleted", withOrgParams(org, rest)),
        queryFn: ({ signal }) => {
          if (!api.getDeleted) {
            return Promise.reject(
              new Error(
                `[arc-next] "${entityKey}" api does not define getDeleted (softDelete preset)`,
              ),
            );
          }
          return api.getDeleted({
            params: rest,
            token: ctx.token ?? null,
            organizationId: org,
            ...fwd(ctx, signal),
          });
        },
      });
    },

    /** GET /:resource/tree — mirrors `useTree`'s key. */
    tree(params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const { org, rest } = resolveOrg(params, ctx);
      return queryOptions({
        queryKey: KEYS.custom("tree", withOrgParams(org, rest)),
        queryFn: ({ signal }) => {
          if (!api.getTree) {
            return Promise.reject(
              new Error(`[arc-next] "${entityKey}" api does not define getTree (tree preset)`),
            );
          }
          return api.getTree({
            params: rest,
            token: ctx.token ?? null,
            organizationId: org,
            ...fwd(ctx, signal),
          });
        },
      });
    },

    /** GET /:resource/:parentId/children — mirrors `useChildren`'s key. */
    children(parentId: string, params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const { org, rest } = resolveOrg(params, ctx);
      return queryOptions({
        queryKey: KEYS.custom("children", parentId, withOrgParams(org, rest)),
        queryFn: ({ signal }) => {
          if (!api.getChildren) {
            return Promise.reject(
              new Error(`[arc-next] "${entityKey}" api does not define getChildren (tree preset)`),
            );
          }
          return api.getChildren({
            parentId,
            params: rest,
            token: ctx.token ?? null,
            organizationId: org,
            ...fwd(ctx, signal),
          });
        },
      });
    },

    /** GET /:resource/aggregations/:name — mirrors `useAggregation`'s tenant-scoped key. */
    aggregation(name: string, filter?: Record<string, unknown>, ctx: QueryFnContext = {}) {
      const org = ctx.organizationId ?? null;
      const filterKey = org ? { _org: org, ...(filter ?? {}) } : (filter ?? {});
      return queryOptions({
        queryKey: KEYS.aggregation(name, filterKey),
        queryFn: ({ signal }) => {
          if (!api.aggregate) {
            return Promise.reject(
              new Error(`[arc-next] "${entityKey}" api does not define aggregate (arc 2.13+)`),
            );
          }
          return api.aggregate({
            name,
            filter,
            token: ctx.token ?? null,
            organizationId: org,
            ...fwd(ctx, signal),
          });
        },
      });
    },

    /**
     * Infinite list — mirrors `useInfiniteList`'s key (`scopedList + 'infinite'`)
     * and its page-param semantics (keyset cursor or offset page + 1).
     */
    infiniteList(params: Record<string, unknown> = {}, ctx: QueryFnContext = {}) {
      const { org, rest } = resolveOrg(params, ctx);
      const scope = org ? "tenant" : "super-admin";
      return infiniteQueryOptions({
        queryKey: [...KEYS.scopedList(scope, withOrgParams(org, rest)), "infinite"],
        queryFn: ({ pageParam, signal }) =>
          api.getAll({
            params: { ...rest, ...(pageParam ? { page: pageParam } : {}) },
            token: ctx.token ?? null,
            organizationId: org,
            ...fwd(ctx, signal),
          }),
        initialPageParam: 1 as unknown,
        getNextPageParam: (lastPage: unknown) => {
          if (isKeysetPagination(lastPage as PaginatedResult<unknown>)) {
            return (lastPage as { hasMore: boolean; next?: unknown }).hasMore
              ? (lastPage as { next?: unknown }).next
              : undefined;
          }
          if (isOffsetPagination(lastPage as PaginatedResult<unknown>)) {
            const p = lastPage as { hasNext: boolean; page: number };
            return p.hasNext ? p.page + 1 : undefined;
          }
          const p = lastPage as Record<string, unknown> | null;
          if (p && typeof p.hasNext === "boolean" && typeof p.page === "number") {
            return p.hasNext ? (p.page as number) + 1 : undefined;
          }
          return undefined;
        },
      });
    },
  };
}
