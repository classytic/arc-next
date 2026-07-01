import type { PaginatedResult } from '@classytic/repo-core/pagination';
import type {
  AnyBaseApi,
  DocOf,
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
export function withTree<TApi extends AnyBaseApi>(
  api: TApi,
): TApi & TreeMethods<DocOf<TApi>> {
  type TDoc = DocOf<TApi>;
  const ext: TreeMethods<TDoc> = {
    async getTree({ token = null, organizationId = null, params = {}, options = {} } = {}) {
      // A tree is the FULL hierarchy, not a paginated list — so do NOT merge the
      // list `defaultParams` (limit/page). Those have no meaning here: at best
      // they're dead query string (`?limit=10&page=1`), at worst a backend that
      // honours them silently truncates the tree to the first page. Pass ONLY
      // the caller's explicit params (e.g. a `depth`/filter, if the resource
      // supports one). `getChildren` below is a real paginated level and keeps
      // the merge.
      return api.request<TDoc[]>('GET', `${api.baseUrl}/tree`, {
        token,
        organizationId,
        params,
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
  return Object.assign(api, ext) as TApi & TreeMethods<DocOf<TApi>>;
}
