import type {
  BaseApi,
  ScopedArgs,
} from '../api.js';

// ============================================================================
// Methods added by the slug-lookup preset
// ============================================================================

export interface SlugLookupMethods<TDoc> {
  /** Fetch a single doc by slug. Backend mounts `GET /:resource/slug/:slug`. */
  getBySlug(args: ScopedArgs & {
    slug: string;
    params?: { select?: string; populate?: string | string[] };
  }): Promise<TDoc>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Adds slug-lookup preset methods to a BaseApi.
 *
 * Mirrors arc's `slugLookup` preset — exposes `getBySlug` for resources keyed
 * by URL-friendly slugs alongside the canonical id.
 *
 * @example
 * import { withSlugLookup } from '@classytic/arc-next/presets/slug';
 * const categories = withSlugLookup(createCrudApi<Category>('categories'));
 *
 * const cat = await categories.getBySlug({ slug: 'engineering' });
 */
export function withSlugLookup<TDoc, TCreate, TUpdate>(
  api: BaseApi<TDoc, TCreate, TUpdate>,
): BaseApi<TDoc, TCreate, TUpdate> & SlugLookupMethods<TDoc> {
  const ext: SlugLookupMethods<TDoc> = {
    async getBySlug({ token = null, organizationId = null, slug, params = {}, options = {} }) {
      if (!slug) throw new Error('Slug is required');
      return api.request<TDoc>('GET', `${api.baseUrl}/slug/${slug}`, {
        token,
        organizationId,
        params,
        options,
      });
    },
  };
  return Object.assign(api, ext);
}
