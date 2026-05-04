import type { PaginatedResult } from '@classytic/repo-core/pagination';
import type {
  BaseApi,
  QueryParams,
  ScopedArgs,
} from '../api.js';

// ============================================================================
// Methods added by the tree preset
// ============================================================================

export interface TreeMethods<TDoc> {
  /** Fetch the full hierarchy. Backend mounts `GET /:resource/tree`. */
  getTree(args?: ScopedArgs & { params?: QueryParams }): Promise<TDoc[]>;

  /** Fetch direct children of a node. Backend mounts `GET /:resource/:id/children`. */
  getChildren(args: ScopedArgs & {
    parentId: string;
    params?: QueryParams;
  }): Promise<PaginatedResult<TDoc>>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Adds tree preset methods to a BaseApi.
 *
 * Mirrors arc's `tree` preset — for resources with a `parentId` field, exposes
 * `getTree` (full hierarchy) and `getChildren` (one level deep). Backend caps
 * tree depth via the preset config.
 *
 * @example
 * import { withTree } from '@classytic/arc-next/presets/tree';
 * const categories = withTree(createCrudApi<Category>('categories'));
 *
 * const root = await categories.getTree();
 * const kids = await categories.getChildren({ parentId: 'engineering' });
 */
export function withTree<TDoc, TCreate, TUpdate>(
  api: BaseApi<TDoc, TCreate, TUpdate>,
): BaseApi<TDoc, TCreate, TUpdate> & TreeMethods<TDoc> {
  const ext: TreeMethods<TDoc> = {
    async getTree({ token = null, organizationId = null, params = {}, options = {} } = {}) {
      // Tree endpoint can return many nodes — merge defaultParams (limit/page)
      // for parity with getChildren and the always-on getAll.
      const merged = { ...api.config.defaultParams, ...params };
      return api.request<TDoc[]>('GET', `${api.baseUrl}/tree`, {
        token,
        organizationId,
        params: merged,
        options,
      });
    },
    async getChildren({ token = null, organizationId = null, parentId, params = {}, options = {} }) {
      if (!parentId) throw new Error('Parent ID is required');
      const merged = { ...api.config.defaultParams, ...params };
      return api.request<PaginatedResult<TDoc>>(
        'GET',
        `${api.baseUrl}/${parentId}/children`,
        { token, organizationId, params: merged, options },
      );
    },
  };
  return Object.assign(api, ext);
}
