import type {
  BaseApi,
  ApiResponse,
  PaginatedResponse,
  QueryParams,
  ScopedArgs,
} from '../api.js';

// ============================================================================
// Methods added by the soft-delete preset
// ============================================================================

export interface SoftDeleteMethods<TDoc> {
  /** List soft-deleted docs. Backend mounts `GET /:resource/deleted`. */
  getDeleted(args?: ScopedArgs & { params?: QueryParams }): Promise<PaginatedResponse<TDoc>>;

  /** Undo a soft-delete. Backend mounts `POST /:resource/:id/restore`. */
  restore(args: ScopedArgs & { id: string }): Promise<ApiResponse<TDoc>>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Adds soft-delete preset methods to a BaseApi.
 *
 * Mirrors arc's server-side `softDelete` preset routes. Use when your resource
 * is registered with `presets: ['softDelete']`. With this preset, `delete()`
 * becomes soft-delete on the backend and {@link SoftDeleteMethods.restore}
 * undoes it; {@link SoftDeleteMethods.getDeleted} lists the tombstones.
 *
 * @example
 * import { createCrudApi } from '@classytic/arc-next/api';
 * import { withSoftDelete } from '@classytic/arc-next/presets/soft-delete';
 *
 * const todos = withSoftDelete(createCrudApi<Todo>('todos'));
 * await todos.delete({ id });             // soft delete (backend)
 * await todos.restore({ id });            // undo
 * const trash = await todos.getDeleted();
 */
export function withSoftDelete<TDoc, TCreate, TUpdate>(
  api: BaseApi<TDoc, TCreate, TUpdate>,
): BaseApi<TDoc, TCreate, TUpdate> & SoftDeleteMethods<TDoc> {
  const ext: SoftDeleteMethods<TDoc> = {
    async getDeleted({ token = null, organizationId = null, params = {}, options = {} } = {}) {
      const merged = { ...api.config.defaultParams, ...params };
      return api.request<PaginatedResponse<TDoc>>('GET', `${api.baseUrl}/deleted`, {
        token,
        organizationId,
        params: merged,
        options,
      });
    },
    async restore({ token = null, organizationId = null, id, options = {} }) {
      if (!id) throw new Error('ID is required');
      return api.request<ApiResponse<TDoc>>('POST', `${api.baseUrl}/${id}/restore`, {
        token,
        organizationId,
        options,
      });
    },
  };
  return Object.assign(api, ext);
}
