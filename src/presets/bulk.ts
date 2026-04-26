import type {
  BaseApi,
  BulkCreateResponse,
  BulkUpdateResponse,
  BulkDeleteResponse,
  ScopedArgs,
} from '../api.js';

// ============================================================================
// Methods added by the bulk preset
// ============================================================================

export interface BulkMethods<TDoc, TCreate = Partial<TDoc>, TUpdate = Partial<TDoc>> {
  /** Insert many docs in one round-trip. Backend mounts `POST /:resource/bulk`. */
  bulkCreate(args: ScopedArgs & { data: TCreate[] }): Promise<BulkCreateResponse<TDoc>>;

  /**
   * Update all docs matching `filter` with `data`.
   * Backend mounts `PATCH /:resource/bulk`.
   */
  bulkUpdate(args: ScopedArgs & {
    filter: Record<string, unknown>;
    data: TUpdate;
  }): Promise<BulkUpdateResponse>;

  /**
   * Delete all docs matching `filter`.
   * Backend mounts `DELETE /:resource/bulk`.
   */
  bulkDelete(args: ScopedArgs & {
    filter: Record<string, unknown>;
  }): Promise<BulkDeleteResponse>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Adds bulk preset methods to a BaseApi.
 *
 * Mirrors arc's `bulk` preset — three /bulk routes for batch ops. Bulk endpoints
 * require explicit per-resource permissions on the backend (the standard CRUD
 * `allowPublic()` doesn't cover them).
 *
 * @example
 * import { withBulk } from '@classytic/arc-next/presets/bulk';
 * const todos = withBulk(createCrudApi<Todo>('todos'));
 *
 * await todos.bulkCreate({ data: [{ title: 'A' }, { title: 'B' }] });
 * await todos.bulkUpdate({ filter: { status: 'pending' }, data: { status: 'archived' } });
 * await todos.bulkDelete({ filter: { archivedBefore: '2024-01-01' } });
 */
export function withBulk<TDoc, TCreate, TUpdate>(
  api: BaseApi<TDoc, TCreate, TUpdate>,
): BaseApi<TDoc, TCreate, TUpdate> & BulkMethods<TDoc, TCreate, TUpdate> {
  const ext: BulkMethods<TDoc, TCreate, TUpdate> = {
    async bulkCreate({ token = null, organizationId = null, data, options = {} }) {
      // Wire shape (arc bulk preset): `POST /:resource/bulk { items: [...] }`.
      // Sending the raw array is rejected with `400 Bulk create requires a
      // non-empty items array`, masking the genuine `ORG_CONTEXT_REQUIRED`
      // tenant-scope error hosts actually need to see.
      return api.request<BulkCreateResponse<TDoc>>('POST', `${api.baseUrl}/bulk`, {
        token,
        organizationId,
        data: { items: data },
        options,
      });
    },
    async bulkUpdate({ token = null, organizationId = null, filter, data, options = {} }) {
      return api.request<BulkUpdateResponse>('PATCH', `${api.baseUrl}/bulk`, {
        token,
        organizationId,
        data: { filter, data },
        options,
      });
    },
    async bulkDelete({ token = null, organizationId = null, filter, options = {} }) {
      return api.request<BulkDeleteResponse>('DELETE', `${api.baseUrl}/bulk`, {
        token,
        organizationId,
        data: { filter },
        options,
      });
    },
  };
  return Object.assign(api, ext);
}
