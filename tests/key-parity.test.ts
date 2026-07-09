/**
 * Query-key PARITY contract: client hooks and server prefetchers must produce
 * hash-identical keys for the same logical read, or SSR hydration silently
 * misses and the client refetches everything (the "prefetch that never
 * hydrates" bug).
 *
 * The trap this guards: TanStack's `hashKey` drops `undefined` object values
 * but KEEPS `null` — so `{ organizationId: null }` and `{}` are DIFFERENT
 * cache entries. Auth resolution yields `organizationId: null` for org-less
 * callers (public storefronts), while prefetchers conditionally omitted the
 * field. `withOrgParams` is the single normalizer both sides now share; these
 * tests pin the contract for every read surface.
 */
import { describe, it, expect } from 'vitest';
import { hashKey } from '@tanstack/react-query';
import { createQueryKeys, withOrgParams } from '../src/cache.js';
import { createEntityQueries, type EntityReadApi } from '../src/query-options.js';

const KEYS = createQueryKeys('products');

/** Hook-side key builders — mirror the EXACT construction in src/hooks.ts. */
const hookKeys = {
  list: (org: string | null, rest: Record<string, unknown>) =>
    KEYS.scopedList(org ? 'tenant' : 'super-admin', withOrgParams(org, rest)),
  infinite: (org: string | null, rest: Record<string, unknown>) => [
    ...KEYS.scopedList(org ? 'tenant' : 'super-admin', withOrgParams(org, rest)),
    'infinite',
  ],
  detail: (id: string, org: string | null, params?: Record<string, unknown>) => {
    const base = KEYS.scopedDetail(id, org ?? null);
    return params ? [...base, params] : base;
  },
  slug: (slug: string, params?: Record<string, unknown>) =>
    params ? KEYS.custom('slug', slug, params) : KEYS.custom('slug', slug),
  tree: (org: string | null, rest: Record<string, unknown>) =>
    KEYS.custom('tree', withOrgParams(org, rest)),
  deleted: (org: string | null, rest: Record<string, unknown>) =>
    KEYS.custom('deleted', withOrgParams(org, rest)),
  aggregation: (name: string, org: string | null, filter?: Record<string, unknown>) =>
    KEYS.aggregation(name, org ? { _org: org, ...(filter ?? {}) } : (filter ?? {})),
};

/** Prefetch-side key builders — mirror the EXACT construction in src/prefetch.ts. */
const prefetchKeys = {
  list: (org: string | null, rest: Record<string, unknown>) =>
    KEYS.scopedList(org ? 'tenant' : 'super-admin', withOrgParams(org, rest)),
  infinite: (org: string | null, rest: Record<string, unknown>) => [
    ...KEYS.scopedList(org ? 'tenant' : 'super-admin', withOrgParams(org, rest)),
    'infinite',
  ],
  detail: (id: string, org: string | null, params?: Record<string, unknown>) => {
    const base = KEYS.scopedDetail(id, org ?? null);
    return params ? [...base, params] : base;
  },
  slug: (slug: string, params?: Record<string, unknown>) =>
    params ? KEYS.custom('slug', slug, params) : KEYS.custom('slug', slug),
  tree: (org: string | null, rest: Record<string, unknown>) =>
    KEYS.custom('tree', withOrgParams(org, rest)),
  deleted: (org: string | null, rest: Record<string, unknown>) =>
    KEYS.custom('deleted', withOrgParams(org, rest)),
  aggregation: (name: string, org: string | null, filter?: Record<string, unknown>) =>
    KEYS.aggregation(name, org ? { _org: org, ...(filter ?? {}) } : (filter ?? {})),
};

const CASES: Array<{ label: string; org: string | null; rest: Record<string, unknown> }> = [
  { label: 'org-less (public storefront)', org: null, rest: {} },
  { label: 'org-less with params', org: null, rest: { limit: 20, status: 'active' } },
  { label: 'tenant-scoped', org: 'org_1', rest: {} },
  { label: 'tenant-scoped with params', org: 'org_1', rest: { limit: 20 } },
];

describe('hook ↔ prefetcher query-key parity', () => {
  for (const { label, org, rest } of CASES) {
    it(`list — ${label}`, () => {
      expect(hashKey(hookKeys.list(org, rest))).toBe(hashKey(prefetchKeys.list(org, rest)));
    });
    it(`infinite list — ${label}`, () => {
      expect(hashKey(hookKeys.infinite(org, rest))).toBe(hashKey(prefetchKeys.infinite(org, rest)));
    });
    it(`tree — ${label}`, () => {
      expect(hashKey(hookKeys.tree(org, rest))).toBe(hashKey(prefetchKeys.tree(org, rest)));
    });
    it(`deleted — ${label}`, () => {
      expect(hashKey(hookKeys.deleted(org, rest))).toBe(hashKey(prefetchKeys.deleted(org, rest)));
    });
    it(`aggregation — ${label}`, () => {
      expect(hashKey(hookKeys.aggregation('salesByDay', org, rest))).toBe(
        hashKey(prefetchKeys.aggregation('salesByDay', org, rest)),
      );
    });
  }

  it('detail — org-less, no params', () => {
    expect(hashKey(hookKeys.detail('p1', null))).toBe(hashKey(prefetchKeys.detail('p1', null)));
  });
  it('detail — tenant-scoped (the old prefetchDetail bug: unscoped seed never hydrated)', () => {
    expect(hashKey(hookKeys.detail('p1', 'org_1'))).toBe(hashKey(prefetchKeys.detail('p1', 'org_1')));
  });
  it('detail — with params variant', () => {
    const params = { select: 'name,price', populate: 'category' };
    expect(hashKey(hookKeys.detail('p1', null, params))).toBe(
      hashKey(prefetchKeys.detail('p1', null, params)),
    );
  });
  it('slug — with and without params', () => {
    expect(hashKey(hookKeys.slug('my-product'))).toBe(hashKey(prefetchKeys.slug('my-product')));
    expect(hashKey(hookKeys.slug('my-product', { select: 'name' }))).toBe(
      hashKey(prefetchKeys.slug('my-product', { select: 'name' })),
    );
  });
});

describe('withOrgParams normalization contract', () => {
  it('documents WHY normalization exists: null is hashed, undefined is dropped', () => {
    // The raw hazard withOrgParams neutralizes:
    expect(hashKey([{ organizationId: null }])).not.toBe(hashKey([{}]));
    expect(hashKey([{ organizationId: undefined }])).toBe(hashKey([{}]));
  });

  it('omits nullish org entirely', () => {
    expect(withOrgParams(null, { a: 1 })).toEqual({ a: 1 });
    expect(withOrgParams(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  it('keeps truthy org first, preserves params', () => {
    expect(withOrgParams('org_1', { a: 1 })).toEqual({ organizationId: 'org_1', a: 1 });
  });

  it('strips a caller-passed explicit organizationId (null OR value) from params', () => {
    // Explicit `organizationId: null` in params must not split the cache.
    expect(withOrgParams(null, { organizationId: null, a: 1 })).toEqual({ a: 1 });
    // The org ARG is authoritative — a conflicting param value is dropped.
    expect(withOrgParams('org_1', { organizationId: 'org_2', a: 1 })).toEqual({
      organizationId: 'org_1',
      a: 1,
    });
  });

  it('hook tree key for org-less caller now equals the omitted-field shape (regression)', () => {
    // Pre-fix hooks built { organizationId: null, ...rest } — a different hash.
    const fixed = KEYS.custom('tree', withOrgParams(null, { depth: 2 }));
    const prefetched = KEYS.custom('tree', { depth: 2 });
    expect(hashKey(fixed)).toBe(hashKey(prefetched));
  });
});

// ============================================================================
// queryOptions factories (createEntityQueries) — the SINGLE SOURCE the
// prefetchers consume. Factory keys must hash-equal the hook-side keys for
// every read surface, so a cache seeded via `prefetchQuery(products.list(...))`
// (or `ensureQueryData` in a router loader) always hydrates the hooks.
// ============================================================================

const stubApi: EntityReadApi = {
  getAll: async () => ({ data: [] }),
  getById: async () => ({}),
  getBySlug: async () => ({}),
  getDeleted: async () => ({ data: [] }),
  getTree: async () => [],
  getChildren: async () => ({ data: [] }),
  aggregate: async () => ({ rows: [] }),
};
const Q = createEntityQueries(stubApi, 'products');

describe('queryOptions factory ↔ hook key parity', () => {
  for (const { label, org, rest } of CASES) {
    it(`list — ${label}`, () => {
      expect(hashKey(Q.list(rest, { organizationId: org }).queryKey)).toBe(
        hashKey(hookKeys.list(org, rest)),
      );
    });
    it(`infinite list — ${label}`, () => {
      expect(hashKey(Q.infiniteList(rest, { organizationId: org }).queryKey)).toBe(
        hashKey(hookKeys.infinite(org, rest)),
      );
    });
    it(`tree — ${label}`, () => {
      expect(hashKey(Q.tree(rest, { organizationId: org }).queryKey)).toBe(
        hashKey(hookKeys.tree(org, rest)),
      );
    });
    it(`deleted — ${label}`, () => {
      expect(hashKey(Q.deleted(rest, { organizationId: org }).queryKey)).toBe(
        hashKey(hookKeys.deleted(org, rest)),
      );
    });
    it(`aggregation — ${label}`, () => {
      expect(hashKey(Q.aggregation('salesByDay', rest, { organizationId: org }).queryKey)).toBe(
        hashKey(hookKeys.aggregation('salesByDay', org, rest)),
      );
    });
  }

  it('detail — org-less / tenant-scoped / params variant', () => {
    expect(hashKey(Q.detail('p1').queryKey)).toBe(hashKey(hookKeys.detail('p1', null)));
    expect(hashKey(Q.detail('p1', { organizationId: 'org_1' }).queryKey)).toBe(
      hashKey(hookKeys.detail('p1', 'org_1')),
    );
    const params = { select: 'name,price' };
    expect(hashKey(Q.detail('p1', { params }).queryKey)).toBe(
      hashKey(hookKeys.detail('p1', null, params)),
    );
  });

  it('bySlug — with and without params', () => {
    expect(hashKey(Q.bySlug('my-product').queryKey)).toBe(hashKey(hookKeys.slug('my-product')));
    expect(hashKey(Q.bySlug('my-product', { params: { select: 'name' } }).queryKey)).toBe(
      hashKey(hookKeys.slug('my-product', { select: 'name' })),
    );
  });

  it('params-embedded organizationId wins over ctx (matches prefetcher precedence)', () => {
    expect(hashKey(Q.list({ organizationId: 'org_A', limit: 5 }, { organizationId: 'org_B' }).queryKey)).toBe(
      hashKey(hookKeys.list('org_A', { limit: 5 })),
    );
  });

  it('infiniteList carries real page semantics (offset hasNext -> page+1, keyset -> cursor)', () => {
    const opts = Q.infiniteList();
    expect(opts.initialPageParam).toBe(1);
    expect(opts.getNextPageParam({ method: 'offset', hasNext: true, page: 2 } as never, [] as never, 1 as never, [] as never)).toBe(3);
    expect(opts.getNextPageParam({ method: 'offset', hasNext: false, page: 9 } as never, [] as never, 1 as never, [] as never)).toBeUndefined();
    expect(opts.getNextPageParam({ method: 'keyset', hasMore: true, next: 'cur_9' } as never, [] as never, 1 as never, [] as never)).toBe('cur_9');
  });
});
