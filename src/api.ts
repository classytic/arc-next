import { handleApiRequest, createQueryString } from './client.js';
import type { ApiRequestOptions, ArcClient } from './client.js';

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

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
}

export interface OffsetPaginationResponse<T = unknown> {
  success: boolean;
  method: 'offset';
  docs: T[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
  warning?: string;
}

export interface KeysetPaginationResponse<T = unknown> {
  success: boolean;
  method: 'keyset';
  docs: T[];
  limit: number;
  hasMore: boolean;
  next: string | null;
}

export interface AggregatePaginationResponse<T = unknown> {
  success: boolean;
  method: 'aggregate';
  docs: T[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
  warning?: string;
}

export type PaginatedResponse<T = unknown> =
  | OffsetPaginationResponse<T>
  | KeysetPaginationResponse<T>
  | AggregatePaginationResponse<T>;

export interface DeleteResponse {
  success: boolean;
  data?: {
    message?: string;
    id?: string;
    soft?: boolean;
  };
}

export interface BulkCreateResponse<T = unknown> {
  success: boolean;
  data?: T[];
  count?: number;
}

export interface BulkUpdateResponse {
  success: boolean;
  modifiedCount?: number;
}

export interface BulkDeleteResponse {
  success: boolean;
  deletedCount?: number;
}

// ============================================================================
// Request Types
// ============================================================================

export type SortDirection = 1 | -1 | 'asc' | 'desc';
export type SortSpec = Record<string, SortDirection> | string;

export type FilterOperator =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'nin'
  | 'contains' | 'startsWith' | 'endsWith' | 'regex'
  | 'like' | 'exists' | 'size' | 'type';

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
  revalidate?: number;
  tags?: string[];
  headerOptions?: Record<string, string>;
  responseType?: 'json' | 'blob' | 'text';
  signal?: AbortSignal;
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
          if (value.length > 1) {
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
  } = {}): Promise<PaginatedResponse<TDoc>> {
    const mergedParams = { ...this.config.defaultParams, ...params };
    const processedParams = this.prepareParams(mergedParams);
    const queryString = this.createQueryString(processedParams);

    const requestOptions: ApiRequestOptions = {
      cache: this.config.cache,
      ...options,
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
  }): Promise<ApiResponse<TDoc>> {
    if (!id) throw new Error('ID is required');

    const queryString = this.createQueryString(params);
    const url = queryString ? `${this.baseUrl}/${id}?${queryString}` : `${this.baseUrl}/${id}`;

    const requestOptions: ApiRequestOptions = {
      cache: this.config.cache,
      ...options,
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
  }): Promise<ApiResponse<TDoc>> {
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
  }): Promise<ApiResponse<TDoc>> {
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
  }): Promise<DeleteResponse> {
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
  }: {
    token?: string | null;
    organizationId?: string | null;
    data: FormData;
    /** Resource ID — shorthand for path, appended as `baseUrl/{id}/upload` */
    id?: string;
    /** Custom sub-path appended as `baseUrl/{path}`. Takes precedence over `id`. */
    path?: string;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<ApiResponse<TDoc>> {
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

  async search({
    token = null,
    organizationId = null,
    searchParams = {},
    params = {},
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    searchParams?: Record<string, unknown>;
    params?: QueryParams;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  } = {}): Promise<PaginatedResponse<TDoc>> {
    const queryParams = { ...this.config.defaultParams, ...params, ...searchParams };
    const processedParams = this.prepareParams(queryParams);
    const queryString = this.createQueryString(processedParams);

    const requestOptions: ApiRequestOptions = {
      cache: this.config.cache,
      ...options,
    };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('GET', `${this.baseUrl}?${queryString}`, this.withHeaders(requestOptions));
  }

  async findBy({
    token = null,
    organizationId = null,
    field,
    value,
    operator,
    params = {},
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    field: string;
    value: unknown;
    operator?: FilterOperator;
    params?: QueryParams;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<PaginatedResponse<TDoc>> {
    if (!field || value === undefined) {
      throw new Error('Field and value are required');
    }

    const queryParams: QueryParams = { ...this.config.defaultParams, ...params };

    if (operator) {
      queryParams[`${field}[${operator}]`] = Array.isArray(value) ? value.join(',') : value;
    } else {
      queryParams[field] = value;
    }

    const processedParams = this.prepareParams(queryParams);
    const queryString = this.createQueryString(processedParams);

    const requestOptions: ApiRequestOptions = {
      cache: this.config.cache,
      ...options,
    };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('GET', `${this.baseUrl}?${queryString}`, this.withHeaders(requestOptions));
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
    }: {
      token?: string | null;
      organizationId?: string | null;
      data?: unknown;
      params?: QueryParams;
      options?: Omit<RequestOptions, 'token' | 'organizationId'>;
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
      cache: this.config.cache,
      ...options,
    };

    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn(method, url, this.withHeaders(requestOptions));
  }

  // ==========================================================================
  // Soft Delete Preset
  // ==========================================================================

  async getDeleted({
    token = null,
    organizationId = null,
    params = {},
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    params?: QueryParams;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  } = {}): Promise<PaginatedResponse<TDoc>> {
    const mergedParams = { ...this.config.defaultParams, ...params };
    const processedParams = this.prepareParams(mergedParams);
    const queryString = this.createQueryString(processedParams);

    const requestOptions: ApiRequestOptions = { cache: this.config.cache, ...options };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('GET', `${this.baseUrl}/deleted?${queryString}`, this.withHeaders(requestOptions));
  }

  async restore({
    token = null,
    organizationId = null,
    id,
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    id: string;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<ApiResponse<TDoc>> {
    if (!id) throw new Error('ID is required');

    const requestOptions: ApiRequestOptions = { ...options };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('POST', `${this.baseUrl}/${id}/restore`, this.withHeaders(requestOptions));
  }

  // ==========================================================================
  // Bulk Preset
  // ==========================================================================

  async bulkCreate({
    token = null,
    organizationId = null,
    data,
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    data: TCreate[];
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<BulkCreateResponse<TDoc>> {
    const requestOptions: ApiRequestOptions = { body: data, ...options };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('POST', `${this.baseUrl}/bulk`, this.withHeaders(requestOptions));
  }

  async bulkUpdate({
    token = null,
    organizationId = null,
    filter,
    data,
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    filter: Record<string, unknown>;
    data: TUpdate;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<BulkUpdateResponse> {
    const requestOptions: ApiRequestOptions = { body: { filter, data }, ...options };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('PATCH', `${this.baseUrl}/bulk`, this.withHeaders(requestOptions));
  }

  async bulkDelete({
    token = null,
    organizationId = null,
    filter,
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    filter: Record<string, unknown>;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<BulkDeleteResponse> {
    const requestOptions: ApiRequestOptions = { body: { filter }, ...options };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('DELETE', `${this.baseUrl}/bulk`, this.withHeaders(requestOptions));
  }

  // ==========================================================================
  // Slug Lookup Preset
  // ==========================================================================

  async getBySlug({
    token = null,
    organizationId = null,
    slug,
    params = {},
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    slug: string;
    params?: { select?: string; populate?: string | string[] };
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<ApiResponse<TDoc>> {
    if (!slug) throw new Error('Slug is required');

    const queryString = this.createQueryString(params);
    const url = queryString ? `${this.baseUrl}/slug/${slug}?${queryString}` : `${this.baseUrl}/slug/${slug}`;

    const requestOptions: ApiRequestOptions = { cache: this.config.cache, ...options };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('GET', url, this.withHeaders(requestOptions));
  }

  // ==========================================================================
  // Tree Preset
  // ==========================================================================

  async getTree({
    token = null,
    organizationId = null,
    params = {},
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    params?: QueryParams;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  } = {}): Promise<ApiResponse<TDoc[]>> {
    const processedParams = this.prepareParams(params);
    const queryString = this.createQueryString(processedParams);

    const requestOptions: ApiRequestOptions = { cache: this.config.cache, ...options };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('GET', `${this.baseUrl}/tree?${queryString}`, this.withHeaders(requestOptions));
  }

  async getChildren({
    token = null,
    organizationId = null,
    parentId,
    params = {},
    options = {},
  }: {
    token?: string | null;
    organizationId?: string | null;
    parentId: string;
    params?: QueryParams;
    options?: Omit<RequestOptions, 'token' | 'organizationId'>;
  }): Promise<PaginatedResponse<TDoc>> {
    if (!parentId) throw new Error('Parent ID is required');

    const mergedParams = { ...this.config.defaultParams, ...params };
    const processedParams = this.prepareParams(mergedParams);
    const queryString = this.createQueryString(processedParams);

    const requestOptions: ApiRequestOptions = { cache: this.config.cache, ...options };
    if (token) requestOptions.token = token;
    if (organizationId) requestOptions.organizationId = organizationId;

    return this.requestFn('GET', `${this.baseUrl}/${parentId}/children?${queryString}`, this.withHeaders(requestOptions));
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

export type ExtractDoc<T> = T extends PaginatedResponse<infer D> ? D : never;

export function isOffsetPagination<T>(
  response: PaginatedResponse<T>
): response is OffsetPaginationResponse<T> {
  return response.method === 'offset';
}

export function isKeysetPagination<T>(
  response: PaginatedResponse<T>
): response is KeysetPaginationResponse<T> {
  return response.method === 'keyset';
}

export function isAggregatePagination<T>(
  response: PaginatedResponse<T>
): response is AggregatePaginationResponse<T> {
  return response.method === 'aggregate';
}
