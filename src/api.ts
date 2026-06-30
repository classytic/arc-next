import type {
  AggregatePaginationResult,
  KeysetPaginationResult,
  OffsetPaginationResult,
  PaginatedResult,
} from '@classytic/repo-core/pagination';
import type {
  AggResult,
  AggRow,
  BulkCreateResult,
  DeleteManyResult,
  DeleteResult,
  UpdateManyResult,
} from '@classytic/repo-core/repository';
import { handleApiRequest, createQueryString } from './client.js';
import type { ApiRequestOptions, ArcClient, NextFetchOptions } from './client.js';

// ============================================================================
// Populate Types
// ============================================================================

export interface PopulateOption {
  path: string;
  select?: string;
  match?: Record<string, unknown>;
}

// ============================================================================
// Response Types
// ============================================================================
//
// Pagination shapes (`OffsetPaginationResult`, `KeysetPaginationResult`,
// `AggregatePaginationResult`, `BareListResult`, `PaginatedResult`) come
// from `@classytic/repo-core/pagination` — the same module arc's
// server-side `fastifyAdapter` emits through `toCanonicalList()`. Data
// shape and wire shape are intentionally identical (no envelope; HTTP
// status discriminates success vs error). Consumers should import these
// types from `@classytic/repo-core/pagination` directly rather than from
// `@classytic/arc-next/api` (no re-exports here).

// CRUD response shapes flow from `@classytic/repo-core/repository`:
//
//   getById/create/update/upload/restore/dispatchAction → TDoc directly
//   delete → DeleteResult (or thrown ArcApiError on error)
//   bulkCreate → BulkCreateResult<TDoc>
//   bulkUpdate → UpdateManyResult
//   bulkDelete → DeleteManyResult
//
// HTTP status discriminates success (2xx) vs error (4xx/5xx). Errors come
// back as `ErrorContract` from `@classytic/repo-core/errors`, surfaced as
// a thrown `ArcApiError` by the client.

// Re-export the canonical wire types so consumers that prefer importing
// from `@classytic/arc-next/api` (single-import ergonomics) keep working.
export type {
  AggResult,
  AggRow,
  BulkCreateResult,
  DeleteManyResult,
  DeleteResult,
  UpdateManyResult,
};

// ============================================================================
// Request Types
// ============================================================================

export type SortDirection = 1 | -1 | 'asc' | 'desc';
export type SortSpec = Record<string, SortDirection> | string;

// Re-export the canonical bracket operator union from `@classytic/repo-core/query-parser`
// so arc-next's URL-emission grammar stays locked to what the server-side
// parser accepts. Adding a new bracket operator now requires a repo-core
// release — prevents silent grammar drift between the SDK encoder and the
// kit decoders (mongokit's QueryParser, sqlitekit's parse, etc.).
export type { BracketOperator } from '@classytic/repo-core/query-parser';
import type { BracketOperator } from '@classytic/repo-core/query-parser';

/**
 * Filter operators supported by arc-next URL emission.
 *
 * Composes:
 *  - **Canonical** ({@link BracketOperator}) — every operator repo-core's
 *    `parseUrl` reverses. Cross-kit portable: mongokit, sqlitekit, prismakit,
 *    and any future kit that consumes the canonical Filter IR all support
 *    these out of the box.
 *  - **Driver-specific extensions** — operators that require kit-native
 *    support. Geo (`near`, `nearSphere`, `geoWithin`, `withinRadius`) is
 *    mongokit + sqlitekit-spatialite. `size` / `type` are mongokit
 *    array/BSON helpers. Hosts using kits without these features just
 *    don't emit them; the union stays open with `(string & {})` so custom
 *    domain operators still satisfy the type.
 */
export type FilterOperator =
  | BracketOperator
  // mongokit array/BSON helpers
  | 'size'
  | 'type'
  // Geo — coordinate-list operators. mongokit native, sqlitekit-spatialite friendly.
  // `near` / `nearSphere`: `lng,lat[,maxDistanceMeters]` (sort by distance).
  // `geoWithin`: `minLng,minLat,maxLng,maxLat` (bounding box).
  // `withinRadius`: `lng,lat,radiusMeters` (count-compatible $centerSphere).
  | 'near'
  | 'nearSphere'
  | 'geoWithin'
  | 'withinRadius'
  // Domain extensions / future operators.
  | (string & {});


export interface QueryParams {
  page?: number;
  limit?: number;
  after?: string;
  cursor?: string;
  sort?: string;
  select?: string;
  populate?: string | string[];
  populateOptions?: PopulateOption[];
  lean?: boolean | 'true' | 'false';
  /** Database-agnostic joins. Maps alias → collection or full lookup config. */
  lookup?: Record<string, string | {
    from: string;
    localField: string;
    foreignField: string;
    select?: string;
  }>;
  [key: string]: unknown;
}

export interface RequestOptions {
  token?: string | null;
  organizationId?: string | null;
  cache?: RequestCache;
  /** Flattened Next `revalidate`. `false` = cache indefinitely. */
  revalidate?: number | false;
  tags?: string[];
  /**
   * Idiomatic Next App Router fetch config — passed to `fetch(url, { next })`.
   * Merged with the flattened `revalidate`/`tags`. Prefer this from Next hosts.
   */
  next?: NextFetchOptions;
  headerOptions?: Record<string, string>;
  responseType?: 'json' | 'blob' | 'text';
  signal?: AbortSignal;
}

/**
 * Common args every BaseApi-style method accepts: `token`, `organizationId`,
 * and `options` (per-request RequestOptions minus the auth fields).
 *
 * Preset method signatures extend this so the auth-injection contract stays
 * uniform across every call (BaseApi method, preset method, custom user wrapper).
 */
export interface ScopedArgs {
  token?: string | null;
  organizationId?: string | null;
  options?: Omit<RequestOptions, 'token' | 'organizationId'>;
}

export interface BaseApiConfig {
  basePath?: string;
  defaultParams?: {
    limit?: number;
    page?: number;
    [key: string]: unknown;
  };
  cache?: RequestCache;
  headers?: Record<string, string>;
  client?: ArcClient;
}

// ============================================================================
// Request Function Type
// ============================================================================

type RequestFn = <T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  endpoint: string,
  options?: ApiRequestOptions,
) => Promise<T>;

// ============================================================================
// Base API Class
// ============================================================================

export class BaseApi<
  TDoc = Record<string, unknown>,
  TCreate = Partial<TDoc>,
  TUpdate = Partial<TDoc>
> {
  readonly entity: string;
  readonly config: Required<Omit<BaseApiConfig, 'client'>>;
  readonly baseUrl: string;
  private readonly requestFn: RequestFn;

  constructor(entity: string, config: BaseApiConfig = {}) {
    this.entity = entity;
    this.requestFn = config.client?.request ?? handleApiRequest;
    this.config = {
      basePath: config.basePath ?? '/api/v1',
      defaultParams: {
        limit: 10,
        page: 1,
        ...(config.defaultParams || {}),
      },
      cache: config.cache ?? 'no-store',
      headers: {
        ...(config.headers || {}),
      },
    };

    this.baseUrl = `${this.config.basePath}/${this.entity}`;
  }

  /** Merge per-instance headers into request options */
  private withHeaders(options: ApiRequestOptions): ApiRequestOptions {
    const instanceHeaders = this.config.headers;
    if (!instanceHeaders || Object.keys(instanceHeaders).length === 0) return options;
    return {
      ...options,
      headerOptions: { ...instanceHeaders, ...(options.headerOptions ?? {}) },
    };
  }

  /**
   * Apply the instance's default `cache` to a per-call options object — but
   * ONLY when the caller expressed no caching intent of their own.
   *
   * A per-call `revalidate`/`next` (time-based ISR) or an explicit `cache`
   * takes precedence. The default is `no-store`; forcing it alongside a
   * `revalidate` makes Next.js throw ("cache: 'no-store' and revalidate are
   * contradictory") and otherwise silently pins the route to dynamic
   * rendering — so a consumer can never opt a single read into ISR. Gating the
   * default here lets `getBySlug({ slug, options: { revalidate: 60 } })` become
   * statically cacheable without every other call losing its no-store default.
   *
   * Framework-agnostic: `cache` / `revalidate` / `next` are inert pass-throughs
   * on runtimes (React Native, plain browser fetch) that don't implement the
   * Next.js fetch extensions, so this never assumes a Next host.
   */
  private withCacheDefault(
    options: Omit<RequestOptions, 'token' | 'organizationId'> = {},
  ): Omit<RequestOptions, 'token' | 'organizationId'> {
    if (
      options.cache !== undefined ||
      options.revalidate !== undefined ||
      options.next !== undefined
    ) {
      return options;
    }
    return { cache: this.config.cache, ...options };
  }

  createQueryString(params: Record<string, unknown> = {}): string {
    return createQueryString(params);
  }

  prepareParams(params: QueryParams = {}): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const CRITICAL_FILTERS = ['organizationId', 'ownerId'];

    Object.entries(params).forEach(([key, value]) => {
      if (CRITICAL_FILTERS.includes(key)) {
        result[key] = value || null;
        return;
      }

      if (key === 'populateOptions') {
        if (Array.isArray(value) && value.length > 0) {
          result[key] = value;
        }
        return;
      }

      if (key === 'lookup') {
        if (typeof value === 'object' && value !== null) {
          Object.entries(value as Record<string, unknown>).forEach(([alias, lv]) => {
            if (typeof lv === 'string') {
              result[`lookup[${alias}]`] = lv;
            } else if (typeof lv === 'object' && lv !== null) {
              const cfg = lv as { from: string; localField: string; foreignField: string; select?: string };
              result[`lookup[${alias}][from]`] = cfg.from;
              result[`lookup[${alias}][localField]`] = cfg.localField;
              result[`lookup[${alias}][foreignField]`] = cfg.foreignField;
              if (cfg.select) result[`lookup[${alias}][select]`] = cfg.select;
            }
          });
        }
        return;
      }

      if (value !== undefined && value !== '') {
        if (['page', 'limit'].includes(key)) {
          result[key] = parseInt(String(value)) || (key === 'page' ? 1 : 10);
        } else if (Array.isArray(value)) {
          // Two cases:
          // 1. Key is already operator-keyed (`status[in]`, `location[withinRadius]`,
          //    `createdAt[between]`, etc.) — keep the comma-joined value AS-IS.
          //    The operator was chosen by the caller; don't append another `[in]`.
          // 2. Plain field name (`status`) — rewrite to `field[in]=a,b` (mongokit
          //    URL grammar's default array shorthand).
          const hasOperator = /\[([^\]]+)\]$/.test(key);
          if (hasOperator) {
            result[key] = value.join(',');
          } else if (value.length > 1) {
            result[`${key}[in]`] = value.join(',');
          } else if (value.length === 1) {
            result[key] = value[0];
          }
        } else {
          result[key] = value;
        }
      }
    });

    return result;
  }

  async getAll({
    token = null,
    organizationId = null,
    params = {},
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    params?: QueryParams;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  } = {}): Promise<PaginatedResult<TDoc>> {
    const mergedParams = { ...this.config.defaultParams, ...params };
    const processedParams = this.prepareParams(mergedParams);
    const queryString = this.createQueryString(processedParams);

    const requestOptions: ApiRequestOptions = {
      ...this.withCacheDefault(options),
    };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('GET', `${this.baseUrl}?${queryString}`, this.withHeaders(requestOptions));
  }

  async getById({
    token = null,
    organizationId = null,
    id,
    params = {},
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    id: string;
    params?: { select?: string; populate?: string | string[] };
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<TDoc> {
    if (!id) throw new Error('ID is required');

    const queryString = this.createQueryString(params);
    const url = queryString ? `${this.baseUrl}/${id}?${queryString}` : `${this.baseUrl}/${id}`;

    const requestOptions: ApiRequestOptions = {
      ...this.withCacheDefault(options),
    };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('GET', url, this.withHeaders(requestOptions));
  }

  async create({
    token = null,
    organizationId = null,
    data,
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    data: TCreate;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<TDoc> {
    const requestOptions: ApiRequestOptions = {
      body: data,
      ...options,
    };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('POST', this.baseUrl, this.withHeaders(requestOptions));
  }

  async update({
    token = null,
    organizationId = null,
    id,
    data,
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    id: string;
    data: TUpdate;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<TDoc> {
    if (!id) throw new Error('ID is required');

    const requestOptions: ApiRequestOptions = {
      body: data,
      ...options,
    };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('PATCH', `${this.baseUrl}/${id}`, this.withHeaders(requestOptions));
  }

  async delete({
    token = null,
    organizationId = null,
    id,
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    id: string;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<DeleteResult> {
    if (!id) throw new Error('ID is required');

    const requestOptions: ApiRequestOptions = { ...options };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('DELETE', `${this.baseUrl}/${id}`, this.withHeaders(requestOptions));
  }

  async upload({
    token = null,
    organizationId = null,
    data,
    id,
    path,
    options = {},
  }: ScopedArgs & {
    data: FormData;
    /** Resource ID — shorthand for path, appended as `baseUrl/{id}/upload` */
    id?: string;
    /** Custom sub-path appended as `baseUrl/{path}`. Takes precedence over `id`. */
    path?: string;
  }): Promise<TDoc> {
    const suffix = path ?? (id ? `${id}/upload` : undefined);
    const url = suffix ? `${this.baseUrl}/${suffix}` : this.baseUrl;

    const requestOptions: ApiRequestOptions = {
      body: data,
      ...options,
    };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('POST', url, this.withHeaders(requestOptions));
  }


  async request<TResponse = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    {
      token = null,
      organizationId = null,
      data,
      params,
      options = {},
    }: ScopedArgs & {
      data?: unknown;
      params?: QueryParams;
    } = {}
  ): Promise<TResponse> {
    let url = endpoint;

    if (params) {
      const processedParams = this.prepareParams(params);
      const queryString = this.createQueryString(processedParams);
      url = `${endpoint}?${queryString}`;
    }

    const requestOptions: ApiRequestOptions = {
      body: data,
      ...this.withCacheDefault(options),
    };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn(method, url, this.withHeaders(requestOptions));
  }

  /**
   * Invoke a custom route mounted on this resource (e.g. `/todos/stats`,
   * `/todos/recent`). Resource-relative wrapper around {@link request} that
   * prepends `this.baseUrl` so callers don't have to remember the prefix.
   *
   * Use this for `defineResource({ routes: [{ method, path, handler }] })` —
   * Arc's escape hatch for endpoints that don't fit CRUD or actions.
   *
   * For aggregates / reports, prefer the response-aware {@link useApiQuery} hook
   * and pass `invokeRoute` as the queryFn — arc 2.13+ emits raw payloads, so
   * the response IS the data.
   *
   * @example
   * // GET /todos/stats → { total, byStatus }
   * const stats = await api.invokeRoute<{ total: number; byStatus: Record<string, number> }>({
   *   method: 'GET',
   *   path: '/stats',
   * });
   *
   * // GET /todos/recent?limit=5 → paginated shape spread to root
   * const recent = await api.invokeRoute<PaginatedResult<Todo>>({
   *   method: 'GET',
   *   path: '/recent',
   *   params: { limit: 5 },
   * });
   *
   * // POST /products/import — body + path
   * await api.invokeRoute({
   *   method: 'POST',
   *   path: '/import',
   *   data: { source: 'csv', items: [...] },
   * });
   */
  async invokeRoute<TResponse = unknown>({
    token = null,
    organizationId = null,
    method = 'GET',
    path,
    data,
    params,
    options = {},
  }: ScopedArgs & {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    /** Path relative to the resource baseUrl. Leading slash optional. */
    path: string;
    data?: unknown;
    params?: QueryParams;
  }): Promise<TResponse> {
    if (!path) throw new Error('path is required');
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const endpoint = `${this.baseUrl}${normalized}`;
    return this.request<TResponse>(method, endpoint, { token, organizationId, data, params, options });
  }

  // ==========================================================================
  // Aggregations (arc v2.13+)
  //
  // Hosts declare `aggregations: { [name]: AggregationConfig }` on the arc
  // resource and arc generates `GET /:resource/aggregations/:name` per entry.
  // The wire shape is `AggResult<TRow> = { rows: TRow[] }` — the same canonical
  // envelope every kit emits, so dashboards switch backends without touching
  // consumer code. Filters from the URL query string shallow-merge with the
  // host's base filter + tenant scope on the server.
  //
  // For dynamic / one-off aggregations (no resource declaration) callers can
  // hit any custom route via `invokeRoute` and type the response themselves.
  // This method is the canonical path for **declared** aggregations — the
  // query-key-friendly arg shape (`{ name, filter }`) maps cleanly onto a
  // TanStack Query factory in `useAggregation`.
  // ==========================================================================

  /**
   * Fetch a declared aggregation by name.
   *
   * @example
   * const { rows } = await api.aggregate<{ day: string; total: number }>({
   *   name: 'salesByDay',
   *   filter: { from: '2025-01-01', to: '2025-12-31' },
   * });
   */
  async aggregate<TRow extends AggRow = AggRow>({
    token = null,
    organizationId = null,
    name,
    filter,
    options = {},
  }: ScopedArgs & {
    /** Aggregation name as declared on the resource. */
    name: string;
    /**
     * URL-encoded filter narrows + dimension args. Reserved keys (`page`,
     * `limit`, etc.) are stripped server-side; everything else flows into
     * the AggRequest filter via shallow merge with the host's base filter.
     */
    filter?: Record<string, unknown>;
  }): Promise<AggResult<TRow>> {
    if (!name) throw new Error('Aggregation name is required');
    const queryString = filter ? this.createQueryString(filter) : '';
    const endpoint = `${this.baseUrl}/aggregations/${name}${queryString ? `?${queryString}` : ''}`;
    const requestOptions: ApiRequestOptions = { ...options };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;
    return this.requestFn('GET', endpoint, this.withHeaders(requestOptions));
  }

  // ==========================================================================
  // Action Router (arc v2.8+)
  //
  // Unified action endpoint: `POST /:id/action` with body `{ action, ...payload }`.
  // The server discriminates on `body.action` and applies per-action permissions.
  // Always-on in arc 2.8+, so it lives on BaseApi rather than a preset wrapper.
  //
  // NB: named `dispatchAction` (not `action`) so consumer SDKs can keep their
  // own `action()` methods on subclasses without inheritance collisions —
  // `action` is a common verb on state-machine resources.
  // ==========================================================================

  async dispatchAction<TResult = unknown, TBody extends Record<string, unknown> = Record<string, unknown>>({
    token = null,
    organizationId = null,
    id,
    action,
    data,
    options = {},
  }: ScopedArgs & {
    id: string;
    action: string;
    data?: TBody;
  }): Promise<TResult> {
    if (!id) throw new Error('ID is required');
    if (!action) throw new Error('Action name is required');

    const requestOptions: ApiRequestOptions = {
      body: { action, ...(data ?? {}) },
      ...options,
    };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('POST', `${this.baseUrl}/${id}/action`, this.withHeaders(requestOptions));
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createCrudApi<
  TDoc = Record<string, unknown>,
  TCreate = Partial<TDoc>,
  TUpdate = Partial<TDoc>
>(entity: string, config: BaseApiConfig = {}): BaseApi<TDoc, TCreate, TUpdate> {
  return new BaseApi<TDoc, TCreate, TUpdate>(entity, config);
}

// ============================================================================
// Type Helpers
// ============================================================================

export type ExtractDoc<T> = T extends PaginatedResult<infer D> ? D : never;

// ----------------------------------------------------------------------------
// Preset composition helpers — extract the doc/create/update types from a
// (possibly preset-augmented) BaseApi so `withX()` can PRESERVE the input type
// instead of widening it back to a bare `BaseApi`. This is what lets presets
// chain: `withSearch(withBulk(withSlug(api)))` keeps every prior preset's
// methods AND the resource's own custom methods.
// ----------------------------------------------------------------------------

/** Any preset-augmented BaseApi — the constraint preset factories accept. */
// biome-ignore lint/suspicious/noExplicitAny: positional inference placeholders
export type AnyBaseApi = BaseApi<any, any, any>;
/** Document type of a (possibly augmented) BaseApi. */
// biome-ignore lint/suspicious/noExplicitAny: positional inference placeholders
export type DocOf<A> = A extends BaseApi<infer D, any, any> ? D : never;
/** Create-payload type of a (possibly augmented) BaseApi. */
// biome-ignore lint/suspicious/noExplicitAny: positional inference placeholders
export type CreateOf<A> = A extends BaseApi<any, infer C, any> ? C : never;
/** Update-payload type of a (possibly augmented) BaseApi. */
// biome-ignore lint/suspicious/noExplicitAny: positional inference placeholders
export type UpdateOf<A> = A extends BaseApi<any, any, infer U> ? U : never;

// `PaginatedResult` includes a `BareListResult<T>` branch (no `method`
// field — for endpoints that don't paginate). The predicates below narrow
// against the full union, so they `'method' in response &&` first to
// satisfy TypeScript before comparing the literal.

export function isOffsetPagination<T>(
  response: PaginatedResult<T>,
): response is OffsetPaginationResult<T> {
  return 'method' in response && response.method === 'offset';
}

export function isKeysetPagination<T>(
  response: PaginatedResult<T>,
): response is KeysetPaginationResult<T> {
  return 'method' in response && response.method === 'keyset';
}

export function isAggregatePagination<T>(
  response: PaginatedResult<T>,
): response is AggregatePaginationResult<T> {
  return 'method' in response && response.method === 'aggregate';
}
