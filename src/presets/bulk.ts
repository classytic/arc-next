import type {
  BulkCreateResult,
  DeleteManyResult,
  UpdateManyResult,
} from '@classytic/repo-core/repository';
import type { AnyBaseApi, CreateOf, DocOf, ScopedArgs, UpdateOf } from '../api.js';

// ============================================================================
// Methods added by the bulk preset
// ============================================================================

export interface BulkMethods<TDoc, TCreate = Partial<TDoc>, TUpdate = Partial<TDoc>> {
  /** Insert many docs in one round-trip. Backend mounts `POST /:resource/bulk`. */
  bulkCreate(args: ScopedArgs & { data: TCreate[] }): Promise<BulkCreateResult<TDoc>>;

  /**
   * Update all docs matching `filter` with `data`.
   * Backend mounts `PATCH /:resource/bulk`.
   */
  bulkUpdate(args: ScopedArgs & {
    filter: Record<string, unknown>;
    data: TUpdate;
  }): Promise<UpdateManyResult>;

  /**
   * Delete all docs matching `filter`.
   * Backend mounts `DELETE /:resource/bulk`.
   */
  bulkDelete(args: ScopedArgs & {
    filter: Record<string, unknown>;
  }): Promise<DeleteManyResult>;
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
export function withBulk<TApi extends AnyBaseApi>(
  api: TApi,
): TApi & BulkMethods<DocOf<TApi>, CreateOf<TApi>, UpdateOf<TApi>> {
  type TDoc = DocOf<TApi>;
  type TCreate = CreateOf<TApi>;
  type TUpdate = UpdateOf<TApi>;
  const ext: BulkMethods<TDoc, TCreate, TUpdate> = {
    async bulkCreate({ token = null, organizationId = null, data, options = {} }) {
      // Wire shape (arc bulk preset): `POST /:resource/bulk { items: [...] }`.
      // Sending the raw array is rejected with `400 Bulk create requires a
      // non-empty items array`, masking the genuine `ORG_CONTEXT_REQUIRED`
      // tenant-scope error hosts actually need to see.
      return api.request<BulkCreateResult<TDoc>>('POST', `${api.baseUrl}/bulk`, {
        token,
        organizationId,
        data: { items: data },
        options,
      });
    },
    async bulkUpdate({ token = null, organizationId = null, filter, data, options = {} }) {
      return api.request<UpdateManyResult>('PATCH', `${api.baseUrl}/bulk`, {
        token,
        organizationId,
        data: { filter, data },
        options,
      });
    },
    async bulkDelete({ token = null, organizationId = null, filter, options = {} }) {
      return api.request<DeleteManyResult>('DELETE', `${api.baseUrl}/bulk`, {
        token,
        organizationId,
        data: { filter },
        options,
      });
    },
  };
  return Object.assign(api, ext) as TApi &
    BulkMethods<DocOf<TApi>, CreateOf<TApi>, UpdateOf<TApi>>;
}
