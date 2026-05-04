import type { PaginatedResult } from '@classytic/repo-core/pagination';
import type {
  BaseApi,
  ScopedArgs,
} from '../api.js';

// ============================================================================
// Methods added by the search preset
// ============================================================================

export interface SearchPresetMethods<TDoc> {
  /**
   * Engine-backed full-text search (Elastic, Algolia, Typesense...).
   * Backend mounts `POST /:resource/search` via `searchPreset()`.
   */
  searchEngine<TResult = TDoc, TBody extends Record<string, unknown> = Record<string, unknown>>(
    args?: ScopedArgs & {
      /** Free-text query forwarded as `body.query`. */
      query?: string;
      /** Engine-specific options merged into the request body. */
      body?: TBody;
      /** Override path (default `/search`). */
      path?: string;
    },
  ): Promise<TResult[] | PaginatedResult<TResult>>;

  /**
   * Vector / semantic similarity (Atlas, Pinecone, Qdrant...).
   * Backend mounts `POST /:resource/search-similar`.
   */
  searchSimilar<TResult = TDoc, TBody extends Record<string, unknown> = Record<string, unknown>>(
    args?: ScopedArgs & {
      /** Text query — backend embeds and searches for nearest neighbors. */
      query?: string;
      /** Pre-computed embedding vector — used directly for similarity search. */
      vector?: number[];
      /** Vector-engine options (`topK`, `filter`, `index`, ...). */
      body?: TBody;
      /** Override path (default `/search-similar`). */
      path?: string;
    },
  ): Promise<TResult[]>;

  /**
   * Convert text/media to a vector embedding via the engine the resource is wired to.
   * Backend mounts `POST /:resource/embed`.
   */
  embed(args: ScopedArgs & {
    /** Text or array of texts to embed. */
    input: string | string[];
    /** Embed-engine options (`model`, `dimensions`, ...). */
    body?: Record<string, unknown>;
    /** Override path (default `/embed`). */
    path?: string;
  }): Promise<number[] | number[][]>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Adds search preset methods to a BaseApi.
 *
 * Mirrors arc's `searchPreset()` — three POST routes for engine-backed search,
 * vector similarity, and embedding generation. Each route is independently
 * permission-gated on the backend.
 *
 * Differs from {@link BaseApi.search} (a GET against the list endpoint with
 * filter params) — that's the legacy filtered-list pattern. These methods hit
 * the new POST routes the preset mounts.
 *
 * @example
 * import { withSearchPreset } from '@classytic/arc-next/presets/search';
 * const places = withSearchPreset(createCrudApi<Place>('places'));
 *
 * await places.searchEngine({ query: 'park', body: { filter: { category: 'park' } } });
 * await places.searchSimilar({ vector: [0.1, 0.2, ...], body: { topK: 5 } });
 * await places.embed({ input: 'hello world' });
 */
export function withSearchPreset<TDoc, TCreate, TUpdate>(
  api: BaseApi<TDoc, TCreate, TUpdate>,
): BaseApi<TDoc, TCreate, TUpdate> & SearchPresetMethods<TDoc> {
  const ext: SearchPresetMethods<TDoc> = {
    async searchEngine({ token = null, organizationId = null, query, body, path = '/search', options = {} } = {}) {
      const requestBody: Record<string, unknown> = { ...(body ?? {}) };
      if (query !== undefined) requestBody.query = query;
      return api.request('POST', `${api.baseUrl}${path}`, {
        token,
        organizationId,
        data: requestBody,
        options,
      });
    },
    async searchSimilar({ token = null, organizationId = null, query, vector, body, path = '/search-similar', options = {} } = {}) {
      const requestBody: Record<string, unknown> = { ...(body ?? {}) };
      if (query !== undefined) requestBody.query = query;
      if (vector !== undefined) requestBody.vector = vector;
      return api.request('POST', `${api.baseUrl}${path}`, {
        token,
        organizationId,
        data: requestBody,
        options,
      });
    },
    async embed({ token = null, organizationId = null, input, body, path = '/embed', options = {} }) {
      const requestBody: Record<string, unknown> = { input, ...(body ?? {}) };
      return api.request('POST', `${api.baseUrl}${path}`, {
        token,
        organizationId,
        data: requestBody,
        options,
      });
    },
  };
  return Object.assign(api, ext);
}
