import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createCrudPrefetcher, dehydrate } from '../src/prefetch.js';

// ============================================================================
// createCrudPrefetcher
// ============================================================================

describe('createCrudPrefetcher', () => {
  let queryClient: QueryClient;
  let mockApi: {
    getAll: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    mockApi = {
      getAll: vi.fn().mockResolvedValue({
        success: true,
        data: [{ _id: '1', name: 'Item 1' }],
        total: 1,
      }),
      getById: vi.fn().mockResolvedValue({
        success: true,
        data: { _id: '1', name: 'Item 1' },
      }),
    };
  });

  it('prefetchList stores data under correct scoped key (super-admin)', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    await prefetcher.prefetchList(queryClient, { limit: 20 });

    const key = ['products', 'list', { _scope: 'super-admin', limit: 20 }];
    const cached = queryClient.getQueryData(key);
    expect(cached).toBeDefined();
    expect(mockApi.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ params: { limit: 20 }, token: null, organizationId: null })
    );
  });

  it('prefetchList uses tenant scope with organizationId', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    await prefetcher.prefetchList(queryClient, { organizationId: 'org-1', limit: 10 });

    const key = ['products', 'list', { _scope: 'tenant', organizationId: 'org-1', limit: 10 }];
    const cached = queryClient.getQueryData(key);
    expect(cached).toBeDefined();
    expect(mockApi.getAll).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { limit: 10 },
        token: null,
        organizationId: 'org-1',
      })
    );
  });

  it('prefetchDetail stores under detail key', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    await prefetcher.prefetchDetail(queryClient, 'prod-1');

    const key = ['products', 'detail', 'prod-1'];
    const cached = queryClient.getQueryData(key);
    expect(cached).toBeDefined();
    expect(mockApi.getById).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'prod-1', token: null, organizationId: null })
    );
  });

  it('query keys match createQueryKeys format', async () => {
    // Import createQueryKeys to verify key format alignment
    const { createQueryKeys } = await import('../src/query.js');
    const KEYS = createQueryKeys('products');

    const prefetcher = createCrudPrefetcher(mockApi, 'products');
    await prefetcher.prefetchList(queryClient, { organizationId: 'org-1', status: 'active' });

    // The scoped list key should match what createQueryKeys generates
    const expectedKey = KEYS.scopedList('tenant', { organizationId: 'org-1', status: 'active' });
    const cached = queryClient.getQueryData(expectedKey);
    expect(cached).toBeDefined();
  });

  it('prefetchList passes staleTime option', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    // Just verify it doesn't throw — staleTime is used internally by prefetchQuery
    await prefetcher.prefetchList(queryClient, {}, { staleTime: 60_000 });

    expect(mockApi.getAll).toHaveBeenCalled();
  });

  it('re-exports dehydrate', () => {
    expect(typeof dehydrate).toBe('function');
  });

  it('prefetchList sends null token/orgId by default (allows explicit auth via options)', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    await prefetcher.prefetchList(queryClient, {});

    const callArgs = mockApi.getAll.mock.calls[0]![0];
    expect(callArgs.token).toBeNull();
    expect(callArgs.organizationId).toBeNull();
  });

  it('prefetchList with explicit token for protected routes', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    await prefetcher.prefetchList(queryClient, { limit: 10 }, { token: 'server-token' });

    const callArgs = mockApi.getAll.mock.calls[0]![0];
    expect(callArgs.token).toBe('server-token');
  });

  it('prefetchDetail sends null token/orgId by default', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    await prefetcher.prefetchDetail(queryClient, 'prod-1');

    const callArgs = mockApi.getById.mock.calls[0]![0];
    expect(callArgs.id).toBe('prod-1');
    expect(callArgs.token).toBeNull();
    expect(callArgs.organizationId).toBeNull();
  });

  it('prefetchDetail with explicit auth for protected routes', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    await prefetcher.prefetchDetail(queryClient, 'prod-1', { token: 'srv-tok', organizationId: 'org-1' });

    const callArgs = mockApi.getById.mock.calls[0]![0];
    expect(callArgs.token).toBe('srv-tok');
    expect(callArgs.organizationId).toBe('org-1');
  });

  it('prefetchList with multiple params', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    await prefetcher.prefetchList(queryClient, {
      organizationId: 'org-1',
      status: 'active',
      limit: 50,
    });

    expect(mockApi.getAll).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { status: 'active', limit: 50 },
        organizationId: 'org-1',
      })
    );
  });

  it('prefetchList and client-side query share cache via same key', async () => {
    const { createQueryKeys } = await import('../src/query.js');
    const KEYS = createQueryKeys('products');

    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    // Prefetch on server
    await prefetcher.prefetchList(queryClient, { limit: 20 });

    // Should be available under the same scoped key the client useList would use
    const superAdminKey = KEYS.scopedList('super-admin', { limit: 20 });
    const cached = queryClient.getQueryData(superAdminKey);
    expect(cached).toBeDefined();
    expect((cached as { data: unknown[] }).data).toHaveLength(1);
  });

  it('dehydrate produces serializable state', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');
    await prefetcher.prefetchList(queryClient, {});

    const dehydratedState = dehydrate(queryClient);
    expect(dehydratedState).toBeDefined();
    expect(dehydratedState.queries).toBeInstanceOf(Array);
    expect(dehydratedState.queries.length).toBeGreaterThan(0);
  });

  // ========== v0.3.1: prefetchDetail with params and organizationId ==========

  it('prefetchDetail passes params to getById', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');

    await prefetcher.prefetchDetail(queryClient, 'prod-1', {
      params: { select: 'name,price', populate: 'category' },
    });

    const callArgs = mockApi.getById.mock.calls[0]![0];
    expect(callArgs.id).toBe('prod-1');
    expect(callArgs.params).toEqual({ select: 'name,price', populate: 'category' });
  });

  it('prefetchDetail with params uses extended key (matches useDetail)', async () => {
    const { createQueryKeys } = await import('../src/query.js');
    const KEYS = createQueryKeys('products');

    const prefetcher = createCrudPrefetcher(mockApi, 'products');
    const params = { select: 'name', populate: 'category' };
    await prefetcher.prefetchDetail(queryClient, 'prod-1', { params });

    // Key should be [entity, "detail", id, params] — same shape as useDetail with params
    const key = [...KEYS.detail('prod-1'), params];
    const cached = queryClient.getQueryData(key);
    expect(cached).toBeDefined();
  });

  // ========== prefetchBySlug ==========

  it('prefetchBySlug stores under correct key', async () => {
    const slugApi = { ...mockApi, getBySlug: vi.fn().mockResolvedValue({ success: true, data: { _id: '1', slug: 'my-product' } }) };
    const prefetcher = createCrudPrefetcher(slugApi, 'products');

    await prefetcher.prefetchBySlug(queryClient, 'my-product');

    const key = ['products', 'slug', 'my-product'];
    const cached = queryClient.getQueryData(key);
    expect(cached).toBeDefined();
    expect(slugApi.getBySlug).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'my-product', token: null, organizationId: null })
    );
  });

  it('prefetchBySlug throws when api lacks getBySlug', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');
    await expect(prefetcher.prefetchBySlug(queryClient, 'test')).rejects.toThrow('getBySlug');
  });

  // ========== prefetchDeleted ==========

  it('prefetchDeleted stores under correct key', async () => {
    const deletedApi = { ...mockApi, getDeleted: vi.fn().mockResolvedValue({ success: true, data: [] }) };
    const prefetcher = createCrudPrefetcher(deletedApi, 'products');

    await prefetcher.prefetchDeleted(queryClient, { limit: 10 });

    const key = ['products', 'deleted', { limit: 10 }];
    const cached = queryClient.getQueryData(key);
    expect(cached).toBeDefined();
    expect(deletedApi.getDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ params: { limit: 10 }, token: null, organizationId: null })
    );
  });

  it('prefetchDeleted scopes by organizationId', async () => {
    const deletedApi = { ...mockApi, getDeleted: vi.fn().mockResolvedValue({ success: true, data: [] }) };
    const prefetcher = createCrudPrefetcher(deletedApi, 'products');

    await prefetcher.prefetchDeleted(queryClient, { organizationId: 'org-1' });

    expect(deletedApi.getDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', token: null })
    );
  });

  it('prefetchDeleted throws when api lacks getDeleted', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');
    await expect(prefetcher.prefetchDeleted(queryClient)).rejects.toThrow('getDeleted');
  });

  // ========== prefetchTree ==========

  it('prefetchTree stores under correct key', async () => {
    const treeApi = { ...mockApi, getTree: vi.fn().mockResolvedValue({ success: true, data: [] }) };
    const prefetcher = createCrudPrefetcher(treeApi, 'categories');

    await prefetcher.prefetchTree(queryClient);

    const key = ['categories', 'tree', {}];
    const cached = queryClient.getQueryData(key);
    expect(cached).toBeDefined();
    expect(treeApi.getTree).toHaveBeenCalled();
  });

  it('prefetchTree throws when api lacks getTree', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'categories');
    await expect(prefetcher.prefetchTree(queryClient)).rejects.toThrow('getTree');
  });

  // A shared layout that prefetches with the default (no-store) forces EVERY
  // page under it to dynamic rendering, silently disabling ISR. Forwarding
  // `revalidate` to the underlying API call is what keeps the storefront
  // ISR-eligible — guard it.
  it('prefetchTree forwards revalidate to the underlying API call (ISR-eligible)', async () => {
    const treeApi = { ...mockApi, getTree: vi.fn().mockResolvedValue([]) };
    const prefetcher = createCrudPrefetcher(treeApi, 'categories');

    await prefetcher.prefetchTree(queryClient, {}, { revalidate: 300 });

    expect(treeApi.getTree).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ revalidate: 300 }) }),
    );
  });

  it('prefetchTree omits options entirely when no caching directive is given', async () => {
    const treeApi = { ...mockApi, getTree: vi.fn().mockResolvedValue([]) };
    const prefetcher = createCrudPrefetcher(treeApi, 'categories');

    await prefetcher.prefetchTree(queryClient);

    expect(treeApi.getTree).toHaveBeenCalledWith(expect.not.objectContaining({ options: expect.anything() }));
  });

  it('prefetchList forwards revalidate too (generic passthrough)', async () => {
    const prefetcher = createCrudPrefetcher(mockApi, 'products');
    await prefetcher.prefetchList(queryClient, { limit: 5 }, { revalidate: 120 });
    expect(mockApi.getAll).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ revalidate: 120 }) }),
    );
  });
});
