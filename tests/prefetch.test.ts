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
        docs: [{ _id: '1', name: 'Item 1' }],
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
      expect.objectContaining({ params: { limit: 20 } })
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
    expect(mockApi.getById).toHaveBeenCalledWith({ id: 'prod-1' });
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
});
