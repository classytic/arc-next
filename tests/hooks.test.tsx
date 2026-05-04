import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createCrudHooks, configureNavigation } from '../src/hooks.js';
import { createQueryKeys, createCacheUtils } from '../src/query.js';
import { configureClient, configureAuth, createClient, getAuthMode } from '../src/client.js';
import { configureToast } from '../src/mutation.js';
import type { CrudApi } from '../src/hooks.js';

// ============================================================================
// Test setup
// ============================================================================

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children
    );
  };
}

function createMockApi(): CrudApi<{ _id: string; name: string }, { name: string }, { name: string }> {
  return {
    getAll: vi.fn().mockResolvedValue({
      success: true,
      data: [
        { _id: '1', name: 'Item 1' },
        { _id: '2', name: 'Item 2' },
      ],
      total: 2,
      page: 1,
      limit: 10,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    }),
    getById: vi.fn().mockResolvedValue({ _id: '1', name: 'Item 1' }),
    create: vi.fn().mockResolvedValue({ _id: '3', name: 'New Item' }),
    update: vi.fn().mockResolvedValue({ _id: '1', name: 'Updated Item' }),
    delete: vi.fn().mockResolvedValue({
      message: 'Deleted',
      id: '1',
    }),
  };
}

// ============================================================================
// createCrudHooks
// ============================================================================

describe('createCrudHooks', () => {
  let queryClient: QueryClient;
  let mockApi: ReturnType<typeof createMockApi>;
  let hooks: ReturnType<typeof createCrudHooks<{ _id: string; name: string }, { name: string }, { name: string }>>;
  const toastHandler = { success: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureToast(toastHandler);
    queryClient = createTestQueryClient();
    mockApi = createMockApi();
    hooks = createCrudHooks({
      api: mockApi,
      entityKey: 'items',
      singular: 'Item',
    });
    toastHandler.success.mockClear();
    toastHandler.error.mockClear();
  });

  afterEach(() => {
    queryClient.clear();
  });

  describe('KEYS', () => {
    it('returns query keys', () => {
      expect(hooks.KEYS.all).toEqual(['items']);
      expect(hooks.KEYS.detail('1')).toEqual(['items', 'detail', '1']);
    });
  });

  describe('cache', () => {
    it('provides cache utilities', () => {
      expect(hooks.cache).toBeDefined();
      expect(typeof hooks.cache.setDetail).toBe('function');
      expect(typeof hooks.cache.getDetail).toBe('function');
    });
  });

  describe('useList', () => {
    it('fetches list data', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items).toHaveLength(2);
      expect(result.current.items[0]!._id).toBe('1');
      expect(result.current.pagination).not.toBeNull();
      expect(result.current.pagination?.total).toBe(2);
    });

    it('calls api.getAll with correct params', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList(null, { organizationId: 'org-1', status: 'active' }, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalledWith(
          expect.objectContaining({
            token: null,
            organizationId: 'org-1',
            params: { status: 'active' },
            options: expect.objectContaining({}),
          })
        );
      });
    });

    it('respects enabled option', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList(null, {}, { public: true, enabled: false }),
        { wrapper }
      );

      expect(mockApi.getAll).not.toHaveBeenCalled();
    });

    it('disables query without token for protected endpoints', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList(null, {}, { public: false }),
        { wrapper }
      );

      expect(mockApi.getAll).not.toHaveBeenCalled();
    });

    it('enables query with token for protected endpoints', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList('my-token', {}),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalled();
      });
    });

    it('prefills detail cache from list results', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useList(null, {}, { public: true }),
        { wrapper }
      );

      // Wait for the list query to finish first
      await waitFor(() => {
        expect(result.current.items).toHaveLength(2);
      });

      // Then the useEffect prefill runs on the next tick
      await waitFor(() => {
        const cached = queryClient.getQueryData(hooks.KEYS.detail('1'));
        expect(cached).toEqual({ data: { _id: '1', name: 'Item 1' } });
      });
    });
  });

  describe('useList with custom response keys', () => {
    it('extracts items from custom key like { products: [...] }', async () => {
      const customApi = createMockApi();
      customApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        products: [{ _id: '1', name: 'Widget' }, { _id: '2', name: 'Gadget' }],
        total: 2,
        page: 1,
        pages: 1,
      });

      const customHooks = createCrudHooks({
        api: customApi,
        entityKey: 'products',
        singular: 'Product',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(
        () => customHooks.useList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items).toHaveLength(2);
      expect(result.current.items[0]!._id).toBe('1');
      expect(result.current.pagination?.total).toBe(2);
    });

    it('extracts items from { users: [...] } with no standard key', async () => {
      const customApi = createMockApi();
      customApi.getAll = vi.fn().mockResolvedValue({
        users: [{ _id: 'u1', name: 'Alice' }],
        totalDocs: 1,
        pages: 1,
      });

      const customHooks = createCrudHooks({
        api: customApi,
        entityKey: 'users',
        singular: 'User',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(
        () => customHooks.useList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.items).toHaveLength(1);
      });

      expect(result.current.items[0]!._id).toBe('u1');
    });

    it('handles plain array response', async () => {
      const customApi = createMockApi();
      customApi.getAll = vi.fn().mockResolvedValue([
        { _id: '1', name: 'A' },
        { _id: '2', name: 'B' },
      ]);

      const customHooks = createCrudHooks({
        api: customApi,
        entityKey: 'plain',
        singular: 'Plain',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(
        () => customHooks.useList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.items).toHaveLength(2);
      });

      expect(result.current.pagination).toBeNull();
    });
  });

  describe('useDetail with custom response keys', () => {
    it('extracts item from { product: {...} }', async () => {
      const customApi = createMockApi();
      customApi.getById = vi.fn().mockResolvedValue({ _id: '1', name: 'Widget' });

      const customHooks = createCrudHooks({
        api: customApi,
        entityKey: 'products',
        singular: 'Product',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(
        () => customHooks.useDetail('1', null, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // The extractItem fallback finds the first object value
      expect(result.current.item).toBeDefined();
    });

    it('extracts item from standard { data: {...} }', async () => {
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(
        () => hooks.useDetail('1', null, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.item).toEqual({ _id: '1', name: 'Item 1' });
    });
  });

  describe('useDetail', () => {
    it('fetches single item', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useDetail('1', null, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.item).toEqual({ _id: '1', name: 'Item 1' });
    });

    it('does not fetch without id', () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useDetail(null, null, { public: true }),
        { wrapper }
      );

      expect(mockApi.getById).not.toHaveBeenCalled();
    });
  });

  describe('useActions', () => {
    it('create calls api.create and shows toast', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'New' } });
      });

      expect(mockApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { name: 'New' } })
      );
      expect(toastHandler.success).toHaveBeenCalledWith('Item created successfully');
    });

    it('update calls api.update', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.update({ id: '1', data: { name: 'Updated' } });
      });

      expect(mockApi.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: '1', data: { name: 'Updated' } })
      );
    });

    it('remove calls api.delete', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.remove({ id: '1' });
      });

      expect(mockApi.delete).toHaveBeenCalledWith(
        expect.objectContaining({ id: '1' })
      );
      expect(toastHandler.success).toHaveBeenCalledWith('Item deleted successfully');
    });

    it('reports isPending states', async () => {
      const wrapper = createWrapper(queryClient);
      let resolveCreate: (value: unknown) => void;
      mockApi.create = vi.fn().mockReturnValue(new Promise(r => { resolveCreate = r; }));

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      expect(result.current.isCreating).toBe(false);
      expect(result.current.isMutating).toBe(false);

      let createPromise: Promise<unknown>;
      act(() => {
        createPromise = result.current.create({ data: { name: 'X' } }).catch(() => {});
      });

      await waitFor(() => {
        expect(result.current.isCreating).toBe(true);
        expect(result.current.isMutating).toBe(true);
      });

      await act(async () => {
        resolveCreate!({ _id: '99', name: 'X' });
        await createPromise;
      });

      await waitFor(() => {
        expect(result.current.isCreating).toBe(false);
      });
    });

    it('calls per-call onSuccess callback', async () => {
      const wrapper = createWrapper(queryClient);
      const onSuccess = vi.fn();

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'New' } }, { onSuccess });
      });

      expect(onSuccess).toHaveBeenCalled();
    });

    it('calls per-call onError callback on failure', async () => {
      const wrapper = createWrapper(queryClient);
      const onError = vi.fn();
      mockApi.create = vi.fn().mockRejectedValue(new Error('fail'));

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.create({ data: { name: 'New' } }, { onError });
        } catch {}
      });

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(toastHandler.error).toHaveBeenCalled();
    });

    it('shows error toast on failure', async () => {
      const wrapper = createWrapper(queryClient);
      mockApi.delete = vi.fn().mockRejectedValue(new Error('server error'));

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.remove({ id: '1' });
        } catch {}
      });

      expect(toastHandler.error).toHaveBeenCalled();
    });
  });

  describe('useNavigation', () => {
    it('sets detail cache on navigate', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useNavigation(),
        { wrapper }
      );

      act(() => {
        result.current('/items/1', { _id: '1', name: 'Item 1' });
      });

      const cached = queryClient.getQueryData(hooks.KEYS.detail('1'));
      expect(cached).toEqual({ data: { _id: '1', name: 'Item 1' } });
    });

    it('calls router.push when configured', async () => {
      const mockPush = vi.fn();
      const mockReplace = vi.fn();
      // Configure navigation BEFORE creating hooks (resolved at factory time)
      configureNavigation(() => ({ push: mockPush, replace: mockReplace }));

      const navHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'items',
        singular: 'Item',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => navHooks.useNavigation(),
        { wrapper }
      );

      act(() => {
        result.current('/items/1', { _id: '1', name: 'Item 1' });
      });

      expect(mockPush).toHaveBeenCalledWith('/items/1', { scroll: true });

      // Reset
      configureNavigation(null as unknown as () => { push: () => void; replace: () => void });
    });

    it('calls router.replace when replace option set', async () => {
      const mockPush = vi.fn();
      const mockReplace = vi.fn();
      // Configure navigation BEFORE creating hooks (resolved at factory time)
      configureNavigation(() => ({ push: mockPush, replace: mockReplace }));

      const navHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'items',
        singular: 'Item',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => navHooks.useNavigation(),
        { wrapper }
      );

      act(() => {
        result.current('/items/1', { _id: '1', name: 'Item 1' }, { replace: true });
      });

      expect(mockReplace).toHaveBeenCalledWith('/items/1', { scroll: true });

      configureNavigation(null as unknown as () => { push: () => void; replace: () => void });
    });

    it('does not throw when navigation not configured', async () => {
      configureNavigation(null as unknown as () => { push: () => void; replace: () => void });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useNavigation(),
        { wrapper }
      );

      // Should not throw, just sets cache
      act(() => {
        result.current('/items/1', { _id: '1', name: 'Item 1' });
      });

      const cached = queryClient.getQueryData(hooks.KEYS.detail('1'));
      expect(cached).toEqual({ data: { _id: '1', name: 'Item 1' } });
    });
  });

  describe('custom messages', () => {
    it('uses custom success messages', async () => {
      const customHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'custom',
        singular: 'Custom',
        defaults: {
          messages: {
            createSuccess: 'Custom created!',
            deleteSuccess: 'Custom removed!',
          },
        },
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => customHooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'X' } });
      });

      expect(toastHandler.success).toHaveBeenCalledWith('Custom created!');
    });
  });

  describe('configureAuth / auto-injection', () => {
    afterEach(() => {
      // Reset auth context after each test
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('useList auto-injects token/orgId from auth context (new signature)', async () => {
      configureAuth({
        getToken: () => 'auto-token',
        getOrgId: () => 'auto-org',
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList({ status: 'active' }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalledWith(
          expect.objectContaining({
            token: 'auto-token',
            organizationId: 'auto-org',
            params: { status: 'active' },
          })
        );
      });
    });

    it('useList new signature works without params', async () => {
      configureAuth({
        getToken: () => 'token-1',
        getOrgId: () => 'org-1',
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList(),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalledWith(
          expect.objectContaining({
            token: 'token-1',
            organizationId: 'org-1',
          })
        );
      });
    });

    it('useDetail auto-injects token from auth context (new signature)', async () => {
      configureAuth({
        getToken: () => 'detail-token',
        getOrgId: () => 'detail-org',
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useDetail('1'),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getById).toHaveBeenCalledWith(
          expect.objectContaining({
            id: '1',
            token: 'detail-token',
            organizationId: 'detail-org',
          })
        );
      });
    });

    it('explicit token overrides auth context (legacy signature)', async () => {
      configureAuth({
        getToken: () => 'auto-token',
        getOrgId: () => 'auto-org',
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList('explicit-token', { organizationId: 'explicit-org' }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalledWith(
          expect.objectContaining({
            token: 'explicit-token',
            organizationId: 'explicit-org',
          })
        );
      });
    });

    it('legacy useList(null, params, options) still works after configureAuth', async () => {
      configureAuth({
        getToken: () => 'should-not-use',
        getOrgId: () => 'should-not-use',
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList(null, { organizationId: 'legacy-org' }, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalledWith(
          expect.objectContaining({
            token: null,
            organizationId: 'legacy-org',
          })
        );
      });
    });

    it('useActions.create auto-injects token/orgId from auth context', async () => {
      configureAuth({
        getToken: () => 'action-token',
        getOrgId: () => 'action-org',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'Auto' } });
      });

      expect(mockApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'action-token',
          organizationId: 'action-org',
          data: { name: 'Auto' },
        })
      );
    });

    it('useActions explicit params override auth context', async () => {
      configureAuth({
        getToken: () => 'auto-token',
        getOrgId: () => 'auto-org',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.update({
          id: '1',
          token: 'override-token',
          organizationId: 'override-org',
          data: { name: 'Override' },
        });
      });

      expect(mockApi.update).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'override-token',
          organizationId: 'override-org',
        })
      );
    });
  });

  describe('request options passthrough', () => {
    it('useList passes request options through to api', async () => {
      configureAuth({
        getToken: () => 'tok',
        getOrgId: () => null,
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList({}, {
          request: { cache: 'force-cache', tags: ['items'], headerOptions: { 'X-Test': '1' } },
        }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalledWith(
          expect.objectContaining({
            options: expect.objectContaining({
              cache: 'force-cache',
              tags: ['items'],
              headerOptions: { 'X-Test': '1' },
            }),
          })
        );
      });

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('useDetail passes request options through to api', async () => {
      configureAuth({
        getToken: () => 'tok',
        getOrgId: () => null,
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useDetail('1', {
          request: { revalidate: 60 },
        }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getById).toHaveBeenCalledWith(
          expect.objectContaining({
            options: expect.objectContaining({
              revalidate: 60,
            }),
          })
        );
      });

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });
  });

  describe('signal passthrough', () => {
    it('useList forwards AbortSignal to api.getAll for request cancellation', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalled();
        const callOptions = mockApi.getAll.mock.calls[0]![0].options;
        expect(callOptions.signal).toBeInstanceOf(AbortSignal);
      });
    });

    it('useDetail forwards AbortSignal to api.getById for request cancellation', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useDetail('1', null, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getById).toHaveBeenCalled();
        const callOptions = mockApi.getById.mock.calls[0]![0].options;
        expect(callOptions.signal).toBeInstanceOf(AbortSignal);
      });
    });
  });

  describe('useInfiniteList', () => {
    it('fetches first page and flattens items (offset pagination)', async () => {
      const infiniteApi = createMockApi();
      infiniteApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        method: 'offset',
        data: [
          { _id: '1', name: 'Item 1' },
          { _id: '2', name: 'Item 2' },
        ],
        page: 1,
        limit: 10,
        total: 5,
        pages: 3,
        hasNext: true,
        hasPrev: false,
      });

      const infiniteHooks = createCrudHooks({
        api: infiniteApi,
        entityKey: 'infinite-items',
        singular: 'InfiniteItem',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => infiniteHooks.useInfiniteList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items).toHaveLength(2);
      expect(result.current.items[0]!._id).toBe('1');
      expect(result.current.hasNextPage).toBe(true);
    });

    it('hasNextPage is false when no more pages (offset)', async () => {
      const infiniteApi = createMockApi();
      infiniteApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        method: 'offset',
        data: [{ _id: '1', name: 'Item 1' }],
        page: 1,
        limit: 10,
        total: 1,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      });

      const infiniteHooks = createCrudHooks({
        api: infiniteApi,
        entityKey: 'finite-items',
        singular: 'FiniteItem',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => infiniteHooks.useInfiniteList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.hasNextPage).toBe(false);
    });

    it('keyset pagination auto-detects cursor', async () => {
      const infiniteApi = createMockApi();
      infiniteApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        method: 'keyset',
        data: [{ _id: '1', name: 'Item 1' }],
        limit: 10,
        hasMore: true,
        next: 'cursor-abc',
      });

      const infiniteHooks = createCrudHooks({
        api: infiniteApi,
        entityKey: 'keyset-items',
        singular: 'KeysetItem',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => infiniteHooks.useInfiniteList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items).toHaveLength(1);
      expect(result.current.hasNextPage).toBe(true);
    });

    it('keyset pagination returns no more pages when hasMore is false', async () => {
      const infiniteApi = createMockApi();
      infiniteApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        method: 'keyset',
        data: [{ _id: '1', name: 'Item 1' }],
        limit: 10,
        hasMore: false,
        next: null,
      });

      const infiniteHooks = createCrudHooks({
        api: infiniteApi,
        entityKey: 'keyset-done-items',
        singular: 'KeysetDoneItem',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => infiniteHooks.useInfiniteList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.hasNextPage).toBe(false);
    });

    it('useInfiniteList auto-injects token from auth context (new signature)', async () => {
      configureAuth({
        getToken: () => 'infinite-token',
        getOrgId: () => 'infinite-org',
      });

      const infiniteApi = createMockApi();
      infiniteApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        method: 'offset',
        data: [{ _id: '1', name: 'Item 1' }],
        page: 1,
        limit: 10,
        total: 1,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      });

      const infiniteHooks = createCrudHooks({
        api: infiniteApi,
        entityKey: 'auth-infinite-items',
        singular: 'AuthInfiniteItem',
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => infiniteHooks.useInfiniteList({ status: 'active' }),
        { wrapper }
      );

      await waitFor(() => {
        expect(infiniteApi.getAll).toHaveBeenCalledWith(
          expect.objectContaining({
            token: 'infinite-token',
            organizationId: 'infinite-org',
          })
        );
      });

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('fetchNextPage loads next page for offset pagination', async () => {
      let callCount = 0;
      const infiniteApi = createMockApi();
      infiniteApi.getAll = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            success: true,
            method: 'offset',
            data: [{ _id: '1', name: 'Page 1' }],
            page: 1,
            limit: 1,
            total: 2,
            pages: 2,
            hasNext: true,
            hasPrev: false,
          });
        }
        return Promise.resolve({
          success: true,
          method: 'offset',
          data: [{ _id: '2', name: 'Page 2' }],
          page: 2,
          limit: 1,
          total: 2,
          pages: 2,
          hasNext: false,
          hasPrev: true,
        });
      });

      const infiniteHooks = createCrudHooks({
        api: infiniteApi,
        entityKey: 'paginated-items',
        singular: 'PaginatedItem',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => infiniteHooks.useInfiniteList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.items).toHaveLength(1);
        expect(result.current.hasNextPage).toBe(true);
      });

      act(() => {
        result.current.fetchNextPage();
      });

      await waitFor(() => {
        expect(result.current.items).toHaveLength(2);
        expect(result.current.hasNextPage).toBe(false);
      });

      expect(result.current.items[0]!._id).toBe('1');
      expect(result.current.items[1]!._id).toBe('2');
    });

    // NOTE: Multi-page scroll (4+ pages), filter switching, maxPages eviction,
    // and keyset cursor navigation are tested comprehensively in the integration
    // test suite (arc-next-test-api/tests/infinite-scroll.test.ts) against a real
    // Arc backend with real HTTP requests and MongoDB pagination.
  });

  describe('cookie auth mode', () => {
    afterEach(() => {
      // Reset to bearer mode
      configureClient({ baseUrl: 'http://api.test' });
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('useList enables query without token in cookie mode', async () => {
      configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });
      configureAuth({ getOrgId: () => 'org-1' });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList({ status: 'active' }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalled();
      });
    });

    it('useDetail enables query without token in cookie mode', async () => {
      configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useDetail('1'),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getById).toHaveBeenCalled();
      });
    });

    it('cookie mode + enabled: false still disables query', async () => {
      configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList({}, { enabled: false }),
        { wrapper }
      );

      expect(mockApi.getAll).not.toHaveBeenCalled();
    });
  });

  describe('polling and refetch configuration', () => {
    // ---- useList polling ----
    it('useList respects custom staleTime', async () => {
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useList(null, {}, { public: true, staleTime: 1000 }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    it('useList respects refetchInterval for polling', async () => {
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useList(null, {}, { public: true, refetchInterval: 5000 }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    it('useList respects refetchIntervalInBackground', async () => {
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useList(null, {}, { public: true, refetchInterval: 5000, refetchIntervalInBackground: true }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    it('useList respects refetchOnWindowFocus override', async () => {
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useList(null, {}, { public: true, refetchOnWindowFocus: true }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    it('useList disables polling with refetchInterval: false', async () => {
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useList(null, {}, { public: true, refetchInterval: false }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalledTimes(1); });
    });

    it('useList respects custom gcTime', async () => {
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useList(null, {}, { public: true, gcTime: 60_000 }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    // ---- useDetail polling ----
    it('useDetail respects refetchInterval for polling', async () => {
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useDetail('1', null, { public: true, refetchInterval: 3000 }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getById).toHaveBeenCalled(); });
    });

    it('useDetail respects refetchOnWindowFocus', async () => {
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useDetail('1', null, { public: true, refetchOnWindowFocus: true }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getById).toHaveBeenCalled(); });
    });

    it('useDetail respects refetchIntervalInBackground', async () => {
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useDetail('1', null, { public: true, refetchInterval: 2000, refetchIntervalInBackground: true }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getById).toHaveBeenCalled(); });
    });

    // ---- useInfiniteList polling ----
    it('useInfiniteList respects refetchInterval', async () => {
      mockApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        method: 'offset',
        data: [{ _id: '1' }],
        page: 1, limit: 10, total: 1, pages: 1,
        hasNext: false, hasPrev: false,
      });
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useInfiniteList(null, {}, { public: true, refetchInterval: 10_000 }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    it('useInfiniteList respects refetchOnWindowFocus', async () => {
      mockApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        method: 'offset',
        data: [{ _id: '1' }],
        page: 1, limit: 10, total: 1, pages: 1,
        hasNext: false, hasPrev: false,
      });
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => hooks.useInfiniteList(null, {}, { public: true, refetchOnWindowFocus: true }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    // ---- Defaults from createCrudHooks config ----
    it('createCrudHooks defaults.refetchOnWindowFocus is passed to useList', async () => {
      const customHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'polling-items',
        singular: 'Polling Item',
        defaults: { refetchOnWindowFocus: true, staleTime: 1000 },
      });
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => customHooks.useList(null, {}, { public: true }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    it('per-call options override createCrudHooks defaults', async () => {
      const customHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'override-items',
        singular: 'Override Item',
        defaults: { staleTime: 60_000, refetchOnWindowFocus: true },
      });
      const wrapper = createWrapper(queryClient);
      // Per-call override: disable refetchOnWindowFocus
      renderHook(
        () => customHooks.useList(null, {}, { public: true, refetchOnWindowFocus: false, staleTime: 1000 }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    // ---- QUERY_CONFIGS presets integration ----
    it('QUERY_CONFIGS.realtime preset works with useList', async () => {
      const { QUERY_CONFIGS } = await import('../src/query.js');
      const realtimeHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'realtime-items',
        singular: 'Realtime Item',
        defaults: { staleTime: QUERY_CONFIGS.realtime.staleTime },
      });
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => realtimeHooks.useList(null, {}, {
          public: true,
          refetchInterval: QUERY_CONFIGS.realtime.refetchInterval,
        }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getAll).toHaveBeenCalled(); });
    });

    it('QUERY_CONFIGS.stable preset works with useDetail', async () => {
      const { QUERY_CONFIGS } = await import('../src/query.js');
      const stableHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'stable-items',
        singular: 'Stable Item',
        defaults: { staleTime: QUERY_CONFIGS.stable.staleTime },
      });
      const wrapper = createWrapper(queryClient);
      renderHook(
        () => stableHooks.useDetail('1', null, { public: true }),
        { wrapper }
      );
      await waitFor(() => { expect(mockApi.getById).toHaveBeenCalled(); });
    });
  });

  describe('useDetail with params', () => {
    it('passes select param to api.getById', async () => {
      configureAuth({
        getToken: () => 'tok',
        getOrgId: () => null,
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useDetail('1', {
          params: { select: 'name email', populate: 'author' },
        }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getById).toHaveBeenCalledWith(
          expect.objectContaining({
            id: '1',
            params: { select: 'name email', populate: 'author' },
          })
        );
      });

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('adds params to query key for cache separation', async () => {
      configureAuth({
        getToken: () => 'tok',
        getOrgId: () => null,
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useDetail('1', {
          params: { select: 'name' },
        }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getById).toHaveBeenCalled();
      });

      // Verify different param combos don't share cache
      const keyWithParams = [...hooks.KEYS.detail('1'), { select: 'name' }];
      // The query data should be stored under the key with params
      const cached = queryClient.getQueryData(keyWithParams);
      expect(cached).toBeDefined();

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });
  });

  describe('useActions silent option', () => {
    it('shows toast by default', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'New' } });
      });

      expect(toastHandler.success).toHaveBeenCalled();
    });

    it('suppresses toast when silent: true on create', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'Silent' } }, { silent: true });
      });

      expect(toastHandler.success).not.toHaveBeenCalled();
    });

    it('suppresses toast when silent: true on update', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.update({ id: '1', data: { name: 'Silent' } }, { silent: true });
      });

      expect(toastHandler.success).not.toHaveBeenCalled();
    });

    it('suppresses toast when silent: true on remove', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.remove({ id: '1' }, { silent: true });
      });

      expect(toastHandler.success).not.toHaveBeenCalled();
    });

    it('suppresses error toast when silent: true on failure', async () => {
      const failApi = createMockApi();
      failApi.create = vi.fn().mockRejectedValue(new Error('fail'));

      const silentHooks = createCrudHooks({
        api: failApi,
        entityKey: 'silent-fail-items',
        singular: 'SilentFailItem',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => silentHooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.create({ data: { name: 'Fail' } }, { silent: true });
        } catch {}
      });

      expect(toastHandler.error).not.toHaveBeenCalled();
    });

    it('resets silent flag after mutation completes', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      // First call: silent
      await act(async () => {
        await result.current.create({ data: { name: 'Silent' } }, { silent: true });
      });
      expect(toastHandler.success).not.toHaveBeenCalled();

      toastHandler.success.mockClear();

      // Second call: not silent — toast should fire
      await act(async () => {
        await result.current.create({ data: { name: 'Loud' } });
      });
      expect(toastHandler.success).toHaveBeenCalled();
    });
  });

  describe('useActions update invalidates detail cache', () => {
    it('invalidates detail cache after successful update', async () => {
      const wrapper = createWrapper(queryClient);

      // Pre-populate detail cache
      queryClient.setQueryData(hooks.KEYS.detail('1'), { data: { _id: '1', name: 'Old' } });
      const spy = vi.spyOn(queryClient, 'invalidateQueries');

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.update({ id: '1', data: { name: 'Updated' } });
      });

      // Should invalidate the detail key for the updated item
      expect(spy).toHaveBeenCalledWith({ queryKey: hooks.KEYS.detail('1') });
    });
  });

  describe('useActions delete removes detail cache', () => {
    it('removes detail cache entry on delete when list is cached', async () => {
      const wrapper = createWrapper(queryClient);

      // Pre-populate BOTH list and detail cache (optimistic update runs against list queries)
      const listKey = hooks.KEYS.scopedList('super-admin', {});
      queryClient.setQueryData(listKey, {
        data: [{ _id: '1', name: 'Item' }, { _id: '2', name: 'Other' }],
        total: 2,
      });
      queryClient.setQueryData(hooks.KEYS.detail('1'), { data: { _id: '1', name: 'Item' } });

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.remove({ id: '1' });
      });

      // Detail cache should be removed by optimistic update side effect
      const cached = queryClient.getQueryData(hooks.KEYS.detail('1'));
      expect(cached).toBeUndefined();
    });
  });

  describe('select transform', () => {
    afterEach(() => {
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('useList applies select transform to query data', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useList(null, {}, {
          public: true,
          select: (data: unknown) => {
            const d = data as { data: Array<{ _id: string; name: string }> };
            return {
              ...d,
              data: d.data.map((item) => ({ ...item, name: item.name.toUpperCase() })),
            };
          },
        }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items[0]!.name).toBe('ITEM 1');
      expect(result.current.items[1]!.name).toBe('ITEM 2');
    });

    it('useDetail applies select transform to query data', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useDetail('1', null, {
          public: true,
          select: (data: unknown) => {
            const d = data as { _id: string; name: string };
            return { ...d, name: d.name.toUpperCase() };
          },
        }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.item!.name).toBe('ITEM 1');
    });

    it('useList select with new signature works', async () => {
      configureAuth({
        getToken: () => 'tok',
        getOrgId: () => null,
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useList({}, {
          select: (data: unknown) => {
            const d = data as { data: Array<{ _id: string; name: string }> };
            return { ...d, data: d.data.filter((item) => item._id === '1') };
          },
        }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0]!._id).toBe('1');
    });
  });

  describe('onSettled callbacks', () => {
    it('calls onSettled after successful create (with extracted entity, not raw ApiResponse)', async () => {
      const onSettled = vi.fn();
      const hooksWithCallbacks = createCrudHooks({
        api: mockApi,
        entityKey: 'settled-items',
        singular: 'SettledItem',
        callbacks: {
          onCreate: { onSettled },
        },
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooksWithCallbacks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'New' } });
      });

      // extractItem unwraps { data: T } → T
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ _id: '3', name: 'New Item' }),
        null,
        expect.objectContaining({ data: { name: 'New' } }),
        undefined,
      );
    });

    it('calls onSettled after failed create', async () => {
      const onSettled = vi.fn();
      const failApi = createMockApi();
      failApi.create = vi.fn().mockRejectedValue(new Error('create failed'));

      const hooksWithCallbacks = createCrudHooks({
        api: failApi,
        entityKey: 'settled-fail-items',
        singular: 'SettledFailItem',
        callbacks: {
          onCreate: { onSettled },
        },
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooksWithCallbacks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.create({ data: { name: 'Fail' } });
        } catch {}
      });

      expect(onSettled).toHaveBeenCalledWith(
        undefined,
        expect.any(Error),
        expect.objectContaining({ data: { name: 'Fail' } }),
        undefined,
      );
    });

    it('calls onSettled after successful update', async () => {
      const onSettled = vi.fn();
      const hooksWithCallbacks = createCrudHooks({
        api: mockApi,
        entityKey: 'settled-update-items',
        singular: 'SettledUpdateItem',
        callbacks: {
          onUpdate: { onSettled },
        },
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooksWithCallbacks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.update({ id: '1', data: { name: 'Updated' } });
      });

      expect(onSettled).toHaveBeenCalledWith(
        expect.anything(),
        null,
        expect.objectContaining({ id: '1', data: { name: 'Updated' } }),
        undefined,
      );
    });

    it('calls onSettled after successful delete', async () => {
      const onSettled = vi.fn();
      const hooksWithCallbacks = createCrudHooks({
        api: mockApi,
        entityKey: 'settled-delete-items',
        singular: 'SettledDeleteItem',
        callbacks: {
          onDelete: { onSettled },
        },
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooksWithCallbacks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.remove({ id: '1' });
      });

      expect(onSettled).toHaveBeenCalledWith(
        expect.anything(),
        null,
        expect.objectContaining({ id: '1' }),
        undefined,
      );
    });
  });

  describe('prefillDetailCache control', () => {
    it('does not prefill detail cache when prefillDetailCache is false', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useList(null, {}, { public: true, prefillDetailCache: false }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.items).toHaveLength(2);
      });

      // Wait a tick to ensure no useEffect fires
      await new Promise((r) => setTimeout(r, 50));

      const cached = queryClient.getQueryData(hooks.KEYS.detail('1'));
      expect(cached).toBeUndefined();
    });
  });

  describe('optimistic update rollback', () => {
    it('rolls back list cache on create failure', async () => {
      const failApi = createMockApi();
      failApi.create = vi.fn().mockRejectedValue(new Error('create failed'));

      const rollbackHooks = createCrudHooks({
        api: failApi,
        entityKey: 'rollback-items',
        singular: 'RollbackItem',
      });

      const wrapper = createWrapper(queryClient);

      // Pre-populate list cache
      const listKey = rollbackHooks.KEYS.scopedList('super-admin', {});
      queryClient.setQueryData(listKey, {
        data: [{ _id: '1', name: 'Existing' }],
        total: 1,
      });

      const { result } = renderHook(
        () => rollbackHooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.create({ data: { name: 'Will Fail' } });
        } catch {}
      });

      // Cache should be rolled back to original
      const cached = queryClient.getQueryData(listKey) as { data: unknown[] };
      expect(cached.data).toHaveLength(1);
      expect((cached.data[0] as { _id: string })._id).toBe('1');
    });

    it('rolls back list cache on update failure', async () => {
      const failApi = createMockApi();
      failApi.update = vi.fn().mockRejectedValue(new Error('update failed'));

      const rollbackHooks = createCrudHooks({
        api: failApi,
        entityKey: 'rollback-update-items',
        singular: 'RollbackUpdateItem',
      });

      const wrapper = createWrapper(queryClient);

      const listKey = rollbackHooks.KEYS.scopedList('super-admin', {});
      queryClient.setQueryData(listKey, {
        data: [{ _id: '1', name: 'Original' }],
        total: 1,
      });

      const { result } = renderHook(
        () => rollbackHooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.update({ id: '1', data: { name: 'Changed' } });
        } catch {}
      });

      const cached = queryClient.getQueryData(listKey) as { data: Array<{ name: string }> };
      expect(cached.data[0]!.name).toBe('Original');
    });
  });

  describe('cache utilities', () => {
    it('setDetail and getDetail round-trip correctly', () => {
      hooks.cache.setDetail(queryClient, '1', { _id: '1', name: 'Cached' });
      const retrieved = hooks.cache.getDetail(queryClient, '1');
      expect(retrieved).toEqual({ _id: '1', name: 'Cached' });
    });

    it('removeDetail clears detail cache', () => {
      hooks.cache.setDetail(queryClient, '1', { _id: '1', name: 'Cached' });
      hooks.cache.removeDetail(queryClient, '1');
      const retrieved = hooks.cache.getDetail(queryClient, '1');
      expect(retrieved).toBeUndefined();
    });

    it('invalidateLists marks all list queries stale', async () => {
      const spy = vi.spyOn(queryClient, 'invalidateQueries');
      await hooks.cache.invalidateLists(queryClient);
      expect(spy).toHaveBeenCalledWith({ queryKey: hooks.KEYS.lists() });
    });

    it('invalidateAll marks everything stale', async () => {
      const spy = vi.spyOn(queryClient, 'invalidateQueries');
      await hooks.cache.invalidateAll(queryClient);
      expect(spy).toHaveBeenCalledWith({ queryKey: hooks.KEYS.all });
    });
  });

  describe('infinite list signal passthrough', () => {
    it('useInfiniteList forwards AbortSignal to api.getAll', async () => {
      const infiniteApi = createMockApi();
      infiniteApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        method: 'offset',
        data: [{ _id: '1', name: 'Item 1' }],
        page: 1, limit: 10, total: 1, pages: 1,
        hasNext: false, hasPrev: false,
      });

      const infiniteHooks = createCrudHooks({
        api: infiniteApi,
        entityKey: 'signal-infinite-items',
        singular: 'SignalInfiniteItem',
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => infiniteHooks.useInfiniteList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(infiniteApi.getAll).toHaveBeenCalled();
        const callOptions = (infiniteApi.getAll as ReturnType<typeof vi.fn>).mock.calls[0]![0].options;
        expect(callOptions.signal).toBeInstanceOf(AbortSignal);
      });
    });
  });

  describe('query key structure', () => {
    it('scopedList includes _scope in key', () => {
      const key = hooks.KEYS.scopedList('tenant', { organizationId: 'org-1', status: 'active' });
      expect(key).toEqual(['items', 'list', { _scope: 'tenant', organizationId: 'org-1', status: 'active' }]);
    });

    it('lists() returns base list key', () => {
      expect(hooks.KEYS.lists()).toEqual(['items', 'list']);
    });

    it('custom key builder works', () => {
      const key = hooks.KEYS.custom('stats', 'monthly');
      expect(key).toEqual(['items', 'stats', 'monthly']);
    });
  });

  describe('multi-client support', () => {
    it('uses client toast handler instead of global', async () => {
      const clientToast = { success: vi.fn(), error: vi.fn() };
      const client = createClient({
        baseUrl: 'http://other.test',
        toast: clientToast,
      });

      const clientHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'client-items',
        singular: 'ClientItem',
        client,
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => clientHooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'New' } });
      });

      // Client toast should be called, not global
      expect(clientToast.success).toHaveBeenCalledWith('ClientItem created successfully');
      expect(toastHandler.success).not.toHaveBeenCalled();
    });

    it('uses client navigation hook instead of global', async () => {
      const clientPush = vi.fn();
      const clientReplace = vi.fn();
      const clientNavigation = () => ({ push: clientPush, replace: clientReplace });

      const client = createClient({
        baseUrl: 'http://other.test',
        navigation: clientNavigation,
      });

      // Ensure global navigation is null
      configureNavigation(null as unknown as () => { push: () => void; replace: () => void });

      const clientHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'nav-items',
        singular: 'NavItem',
        client,
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => clientHooks.useNavigation(),
        { wrapper }
      );

      act(() => {
        result.current('/items/1', { _id: '1', name: 'Item 1' });
      });

      expect(clientPush).toHaveBeenCalledWith('/items/1', { scroll: true });
    });

    it('falls back to global toast when client has no toast', async () => {
      const client = createClient({ baseUrl: 'http://other.test' });

      const clientHooks = createCrudHooks({
        api: mockApi,
        entityKey: 'fallback-items',
        singular: 'FallbackItem',
        client,
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => clientHooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'New' } });
      });

      // Global toast should be used as fallback
      expect(toastHandler.success).toHaveBeenCalledWith('FallbackItem created successfully');
    });

    it('client error toast works on failure', async () => {
      const clientToast = { success: vi.fn(), error: vi.fn() };
      const client = createClient({
        baseUrl: 'http://other.test',
        toast: clientToast,
      });

      const failingApi = createMockApi();
      failingApi.create = vi.fn().mockRejectedValue(new Error('client error'));

      const clientHooks = createCrudHooks({
        api: failingApi,
        entityKey: 'error-items',
        singular: 'ErrorItem',
        client,
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => clientHooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.create({ data: { name: 'Fail' } });
        } catch {}
      });

      expect(clientToast.error).toHaveBeenCalled();
      expect(toastHandler.error).not.toHaveBeenCalled();
    });
  });

  describe('CallOptions.onSettled', () => {
    it('calls per-call onSettled after successful create (with extracted entity)', async () => {
      const wrapper = createWrapper(queryClient);
      const onSettled = vi.fn();

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'New' } }, { onSettled });
      });

      // extractItem unwraps { data: T } → T
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ _id: '3', name: 'New Item' }),
        null,
      );
    });

    it('calls per-call onSettled after failed create', async () => {
      const failApi = createMockApi();
      failApi.create = vi.fn().mockRejectedValue(new Error('fail'));

      const failHooks = createCrudHooks({
        api: failApi,
        entityKey: 'settled-call-items',
        singular: 'SettledCallItem',
      });

      const wrapper = createWrapper(queryClient);
      const onSettled = vi.fn();

      const { result } = renderHook(
        () => failHooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.create({ data: { name: 'Fail' } }, { onSettled });
        } catch {}
      });

      expect(onSettled).toHaveBeenCalledWith(undefined, expect.any(Error));
    });

    it('calls per-call onSettled after successful update', async () => {
      const wrapper = createWrapper(queryClient);
      const onSettled = vi.fn();

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.update({ id: '1', data: { name: 'Updated' } }, { onSettled });
      });

      expect(onSettled).toHaveBeenCalledWith(expect.anything(), null);
    });

    it('calls per-call onSettled after successful remove', async () => {
      const wrapper = createWrapper(queryClient);
      const onSettled = vi.fn();

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.remove({ id: '1' }, { onSettled });
      });

      expect(onSettled).toHaveBeenCalledWith(expect.anything(), null);
    });
  });

  describe('useUpload', () => {
    it('rejects when api has no upload method', async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(() => hooks.useUpload(), { wrapper });

      await act(async () => {
        await expect(
          result.current.mutateAsync({ data: new FormData() })
        ).rejects.toThrow('[arc-next] "items" api does not define an upload method');
      });
    });

    it('calls upload api and shows toast', async () => {
      const uploadApi = createMockApi();
      uploadApi.upload = vi.fn().mockResolvedValue({ url: '/uploads/file.png' });

      const uploadHooks = createCrudHooks({
        api: uploadApi,
        entityKey: 'upload-items',
        singular: 'Upload',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => uploadHooks.useUpload(),
        { wrapper }
      );

      const formData = new FormData();

      await act(async () => {
        await result.current.mutateAsync({ data: formData });
      });

      expect(uploadApi.upload).toHaveBeenCalledWith(
        expect.objectContaining({ data: formData }),
      );
      expect(toastHandler.success).toHaveBeenCalledWith('Upload uploaded successfully');
    });

    it('calls upload api with custom messages', async () => {
      const uploadApi = createMockApi();
      uploadApi.upload = vi.fn().mockResolvedValue({ url: '/uploads/file.png' });

      const uploadHooks = createCrudHooks({
        api: uploadApi,
        entityKey: 'upload-msg-items',
        singular: 'File',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => uploadHooks.useUpload({
          messages: { success: 'File uploaded!', error: 'Upload failed!' },
        }),
        { wrapper }
      );

      await act(async () => {
        await result.current.mutateAsync({ data: new FormData() });
      });

      expect(toastHandler.success).toHaveBeenCalledWith('File uploaded!');
    });

    it('passes id to upload api when provided', async () => {
      const uploadApi = createMockApi();
      uploadApi.upload = vi.fn().mockResolvedValue({ url: '/uploads/file.png' });

      const uploadHooks = createCrudHooks({
        api: uploadApi,
        entityKey: 'upload-id-items',
        singular: 'Attachment',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => uploadHooks.useUpload(),
        { wrapper }
      );

      const formData = new FormData();

      await act(async () => {
        await result.current.mutateAsync({ data: formData, id: 'doc-123' });
      });

      expect(uploadApi.upload).toHaveBeenCalledWith(
        expect.objectContaining({ data: formData, id: 'doc-123' }),
      );
    });
  });

  // useSearch removed in 0.5.0 — replaced by useList({ q: query, ...filters }).
  // Free-text search is not a backend-distinct route; arc has no /search endpoint.

  describe('useCustomMutation', () => {
    it('calls custom mutation fn and shows toast', async () => {
      const customFn = vi.fn().mockResolvedValue({ result: 'ok' });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useCustomMutation({
          mutationFn: customFn,
          messages: { success: 'Custom done!' },
        }),
        { wrapper }
      );

      await act(async () => {
        await result.current.mutateAsync({ action: 'custom' });
      });

      expect(customFn.mock.calls[0]![0]).toEqual({ action: 'custom' });
      expect(toastHandler.success).toHaveBeenCalledWith('Custom done!');
    });

    it('calls onSuccess callback', async () => {
      const onSuccess = vi.fn();
      const customFn = vi.fn().mockResolvedValue({ id: '1' });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useCustomMutation({
          mutationFn: customFn,
          onSuccess,
        }),
        { wrapper }
      );

      await act(async () => {
        await result.current.mutateAsync({ x: 1 });
      });

      expect(onSuccess).toHaveBeenCalledWith({ id: '1' }, { x: 1 });
    });

    it('calls onError callback on failure', async () => {
      const onError = vi.fn();
      const customFn = vi.fn().mockRejectedValue(new Error('custom fail'));

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useCustomMutation({
          mutationFn: customFn,
          onError,
        }),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.mutateAsync({});
        } catch {}
      });

      expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.anything());
    });

    it('invalidates default list keys', async () => {
      const customFn = vi.fn().mockResolvedValue({});
      const spy = vi.spyOn(queryClient, 'invalidateQueries');

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useCustomMutation({ mutationFn: customFn }),
        { wrapper }
      );

      await act(async () => {
        await result.current.mutateAsync({});
      });

      expect(spy).toHaveBeenCalledWith({ queryKey: hooks.KEYS.lists() });
    });
  });

  // ==========================================================================
  // Bug fix: useUpload passes id and path through to upload API
  // ==========================================================================

  describe('useUpload id and path passthrough', () => {
    it('passes path to upload api', async () => {
      const uploadApi = createMockApi();
      uploadApi.upload = vi.fn().mockResolvedValue({ url: '/uploads/file.png' });

      const uploadHooks = createCrudHooks({
        api: uploadApi,
        entityKey: 'upload-path-items',
        singular: 'UploadPath',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => uploadHooks.useUpload(), { wrapper });

      const formData = new FormData();
      await act(async () => {
        await result.current.mutateAsync({ data: formData, path: 'bulk-import' });
      });

      expect(uploadApi.upload).toHaveBeenCalledWith(
        expect.objectContaining({ data: formData, path: 'bulk-import' }),
      );
    });

    it('passes both id and path — api decides precedence', async () => {
      const uploadApi = createMockApi();
      uploadApi.upload = vi.fn().mockResolvedValue({ url: '/uploads/file.png' });

      const uploadHooks = createCrudHooks({
        api: uploadApi,
        entityKey: 'upload-both-items',
        singular: 'UploadBoth',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => uploadHooks.useUpload(), { wrapper });

      const formData = new FormData();
      await act(async () => {
        await result.current.mutateAsync({ data: formData, id: 'doc-1', path: 'override' });
      });

      expect(uploadApi.upload).toHaveBeenCalledWith(
        expect.objectContaining({ data: formData, id: 'doc-1', path: 'override' }),
      );
    });
  });

  // ==========================================================================
  // Bug fix: useSearch includes organizationId in query key for cache isolation
  // ==========================================================================

  // useSearch tenant cache isolation — removed in 0.5.0 along with useSearch.
  // useList already scopes its cache key by organizationId from configureAuth.

  // ==========================================================================
  // Bug fix: onUpdate.onSuccess receives actual update payload
  // ==========================================================================

  describe('onUpdate.onSuccess receives actual variables', () => {
    it('passes the real update data to onSuccess callback', async () => {
      const onSuccess = vi.fn();
      const hooksWithCallbacks = createCrudHooks({
        api: mockApi,
        entityKey: 'update-cb-items',
        singular: 'UpdateCbItem',
        callbacks: {
          onUpdate: { onSuccess },
        },
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooksWithCallbacks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.update({ id: '1', data: { name: 'Updated Name' } });
      });

      expect(onSuccess).toHaveBeenCalledWith(
        expect.anything(),                                          // response data
        expect.objectContaining({ id: '1', data: { name: 'Updated Name' } }), // actual variables
        undefined,                                                  // context
      );
    });

    it('onError also receives the actual update data', async () => {
      const onError = vi.fn();
      const failApi = createMockApi();
      failApi.update = vi.fn().mockRejectedValue(new Error('update failed'));

      const hooksWithCallbacks = createCrudHooks({
        api: failApi,
        entityKey: 'update-err-items',
        singular: 'UpdateErrItem',
        callbacks: {
          onUpdate: { onError },
        },
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooksWithCallbacks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.update({ id: '1', data: { name: 'Fail' } });
        } catch {}
      });

      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ id: '1', data: { name: 'Fail' } }),
        undefined,
      );
    });
  });

  // ==========================================================================
  // v0.2.1 — Regression tests for critical fixes
  // ==========================================================================

  describe('v0.2.1 detail cache rollback on update failure', () => {
    it('rolls back detail cache when update mutation fails', async () => {
      const failApi = createMockApi();
      failApi.update = vi.fn().mockRejectedValue(new Error('update failed'));

      const failHooks = createCrudHooks({
        api: failApi,
        entityKey: 'rollback-items',
        singular: 'RollbackItem',
      });

      const wrapper = createWrapper(queryClient);

      // Pre-populate list and detail caches
      const listKey = failHooks.KEYS.scopedList('super-admin', {});
      queryClient.setQueryData(listKey, {
        data: [{ _id: '1', name: 'Original' }],
        total: 1,
      });
      queryClient.setQueryData(failHooks.KEYS.detail('1'), {
        data: { _id: '1', name: 'Original' },
      });

      const { result } = renderHook(
        () => failHooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        try {
          await result.current.update({ id: '1', data: { name: 'Changed' } });
        } catch {}
      });

      // Detail cache should be rolled back to original value
      const cached = queryClient.getQueryData(failHooks.KEYS.detail('1')) as any;
      expect(cached?.data?.name).toBe('Original');
    });
  });

  describe('v0.2.1 useNavigation noop safety', () => {
    it('does not throw when no router is configured', () => {
      // Reset navigation config
      configureNavigation(null as any);

      const wrapper = createWrapper(queryClient);

      // Should not throw
      const { result } = renderHook(
        () => hooks.useNavigation(),
        { wrapper }
      );

      // Navigate should be a function that doesn't crash
      expect(typeof result.current).toBe('function');
      expect(() => result.current('/test', { _id: '1', name: 'Test' })).not.toThrow();
    });
  });

  describe('v0.2.1 useActions returns functions', () => {
    it('create/update/remove are callable functions', () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      expect(typeof result.current.create).toBe('function');
      expect(typeof result.current.update).toBe('function');
      expect(typeof result.current.remove).toBe('function');
      expect(typeof result.current.isCreating).toBe('boolean');
      expect(typeof result.current.isUpdating).toBe('boolean');
      expect(typeof result.current.isDeleting).toBe('boolean');
      expect(typeof result.current.isMutating).toBe('boolean');
    });
  });

  // ==========================================================================
  // Type compatibility: BaseApi ↔ CrudApi (compile-time + runtime)
  //
  // These tests serve as COMPILE-TIME guards. If CrudApi ever drifts from
  // BaseApi (the bug that caused v0.3.0 TS errors), TypeScript will reject
  // these tests before publishing — not in downstream user code.
  // ==========================================================================

  describe('CrudApi type compatibility', () => {
    it('createCrudApi result is assignable to CrudApi (no cast needed)', async () => {
      const { createCrudApi } = await import('../src/api.js');
      const api = createCrudApi<{ _id: string; name: string }>('products', {
        basePath: '/api',
      });

      // Pass directly to createCrudHooks — no `as CrudApi<...>` cast required.
      // If CrudApi drifts from BaseApi, this line fails at compile time.
      const result = createCrudHooks({
        api,
        entityKey: 'products',
        singular: 'Product',
      });

      expect(result).toHaveProperty('useList');
      expect(result).toHaveProperty('useDetail');
      expect(result).toHaveProperty('useActions');
      expect(result).toHaveProperty('KEYS');
      expect(result).toHaveProperty('cache');
    });

    it('createCrudApi with full generics is assignable to CrudHooksConfig', async () => {
      const { createCrudApi } = await import('../src/api.js');

      interface Product { _id: string; name: string; price: number }
      interface CreateProduct { name: string; price: number }
      interface UpdateProduct { name?: string; price?: number }

      const api = createCrudApi<Product, CreateProduct, UpdateProduct>('products', {
        basePath: '/api',
      });

      // All three generics threaded — must compile without casts
      const result = createCrudHooks<Product, CreateProduct, UpdateProduct>({
        api,
        entityKey: 'products',
        singular: 'Product',
      });

      expect(result.KEYS.all).toEqual(['products']);
    });

    it('BaseApi exposes all methods required by CrudApi', async () => {
      const { createCrudApi } = await import('../src/api.js');
      const api = createCrudApi('items');

      // Required methods (Pick<BaseApi, ...> guarantees these)
      expect(typeof api.getAll).toBe('function');
      expect(typeof api.getById).toBe('function');
      expect(typeof api.create).toBe('function');
      expect(typeof api.update).toBe('function');
      expect(typeof api.delete).toBe('function');

      // Optional method (available on BaseApi, optional on CrudApi)
      expect(typeof api.upload).toBe('function');

      // Universal helpers (always-on backbone)
      expect(typeof api.dispatchAction).toBe('function');
      expect(typeof api.invokeRoute).toBe('function');
      expect(typeof api.request).toBe('function');
    });

    it('CrudApi generic defaults match CrudHooksConfig defaults (Partial<T>)', async () => {
      // CrudApi<Product> should resolve TCreate=Partial<Product>, TUpdate=Partial<Product>
      // matching CrudHooksConfig<Product> which also defaults to Partial<T>.
      // If these defaults diverge, single-generic usage like createCrudHooks<Product>({api})
      // would require explicit casts.
      const { createCrudApi } = await import('../src/api.js');

      interface Product { _id: string; name: string; price: number }

      // Single generic — TCreate and TUpdate inferred as Partial<Product> on both sides
      const api = createCrudApi<Product>('products', { basePath: '/api' });
      const result = createCrudHooks<Product>({ api, entityKey: 'products', singular: 'Product' });

      expect(result.KEYS.all).toEqual(['products']);
    });

    it('CrudApi without optional methods still satisfies CrudHooksConfig', () => {
      // A minimal object with only required methods (no upload/search)
      type MinimalApi = CrudApi<{ _id: string; name: string }, { name: string }, { name: string }>;
      const api: MinimalApi = {
        getAll: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10, pages: 0, hasNext: false, hasPrev: false }),
        getById: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ _id: '1', name: 'Minimal' }),
        update: vi.fn().mockResolvedValue({ _id: '1', name: 'Minimal' }),
        delete: vi.fn().mockResolvedValue({ message: 'Deleted', id: '1' }),
        // no upload, no search
      };

      const result = createCrudHooks({
        api,
        entityKey: 'minimal',
        singular: 'Minimal',
      });

      expect(result).toHaveProperty('useList');
      expect(result).toHaveProperty('useActions');
    });
  });

  // ==========================================================================
  // v0.3.1 bug fix regression tests
  // ==========================================================================

  describe('v0.3.1 bug fixes', () => {
    // --- FIX 1: create/update extract entity from ApiResponse ---

    it('create() returns extracted entity T, not raw ApiResponse', async () => {
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      let returned: unknown;
      await act(async () => {
        returned = await result.current.create({ data: { name: 'New' } });
      });

      // Should be { _id: '3', name: 'New Item' }, NOT { success: true, data: { ... } }
      expect(returned).toEqual({ _id: '3', name: 'New Item' });
      expect(returned).not.toHaveProperty('success');
      expect(returned).not.toHaveProperty('data');
    });

    it('update() returns extracted entity T, not raw ApiResponse', async () => {
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      let returned: unknown;
      await act(async () => {
        returned = await result.current.update({ id: '1', data: { name: 'Updated' } });
      });

      expect(returned).toEqual({ _id: '1', name: 'Updated Item' });
      expect(returned).not.toHaveProperty('success');
    });

    it('create() onSuccess callback receives entity T, not ApiResponse', async () => {
      const onSuccess = vi.fn();
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      await act(async () => {
        await result.current.create({ data: { name: 'New' } }, { onSuccess });
      });

      expect(onSuccess).toHaveBeenCalledWith({ _id: '3', name: 'New Item' });
    });

    // --- Detail keys: _id is globally unique, no tenant scoping needed ---
    // Backend enforces tenant isolation via middleware (orgScoped, permissions).
    // Frontend cache keys use [entity, "detail", id] — simple and correct.

    it('detail query key uses simple [entity, detail, id] (no tenant scoping)', () => {
      const keys = createQueryKeys('products');
      expect(keys.detail('123')).toEqual(['products', 'detail', '123']);
    });

    it('detail cache set/get round-trips correctly', () => {
      const keys = createQueryKeys('products');
      const cache = createCacheUtils<{ _id: string }>(keys);

      cache.setDetail(queryClient, '1', { _id: '1' });
      expect(cache.getDetail(queryClient, '1')).toEqual({ _id: '1' });
    });

    // --- FIX 3: defaultParams merged into requests ---
    // Tested in api.test.ts (defaultParams merge into getAll/search/findBy).
    // Smoke test here to confirm hooks surface the behavior.

    it('defaultParams are stored on BaseApi config', async () => {
      const { createCrudApi } = await import('../src/api.js');
      const api = createCrudApi('items', {
        basePath: '/api',
        defaultParams: { limit: 25, page: 1 },
      });

      expect(api.config.defaultParams).toEqual({ limit: 25, page: 1 });
    });

    // --- FIX 4: multi-client auth mode ---

    it('cookie-mode client enables queries without token even when global is bearer', async () => {
      // Global is bearer (default)
      configureClient({ baseUrl: 'http://api.test' });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const cookieClient = {
        request: vi.fn(),
        config: { baseUrl: 'http://cookie-api.test', authMode: 'cookie' as const },
        toast: undefined,
        navigation: undefined,
      };

      const cookieApi = createMockApi();
      const cookieHooks = createCrudHooks({
        api: cookieApi,
        entityKey: 'cookie-items',
        singular: 'CookieItem',
        client: cookieClient,
      });

      const wrapper = createWrapper(queryClient);
      renderHook(() => cookieHooks.useList({}), { wrapper });

      await waitFor(() => {
        expect(cookieApi.getAll).toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // Preset hooks: useDeleted, useDetailBySlug, useTree, useChildren, useFindBy
  // ==========================================================================

  describe('useDeleted', () => {
    it('fetches soft-deleted items', async () => {
      const deletedApi = {
        ...createMockApi(),
        getDeleted: vi.fn().mockResolvedValue({
          success: true,
          data: [{ _id: 'del-1', name: 'Deleted Item', deletedAt: '2024-01-01' }],
          total: 1, page: 1, limit: 10, pages: 1, hasNext: false, hasPrev: false,
        }),
      };

      const deletedHooks = createCrudHooks({
        api: deletedApi,
        entityKey: 'items',
        singular: 'Item',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(
        () => deletedHooks.useDeleted({}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0]!._id).toBe('del-1');
      expect(deletedApi.getDeleted).toHaveBeenCalled();
    });

    it('disables query when api lacks getDeleted', () => {
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useDeleted({}, { public: true }), { wrapper });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.items).toHaveLength(0);
    });
  });

  describe('useDetailBySlug', () => {
    it('fetches item by slug', async () => {
      const slugApi = {
        ...createMockApi(),
        getBySlug: vi.fn().mockResolvedValue({ _id: '1', name: 'My Article', slug: 'my-article' }),
      };

      const slugHooks = createCrudHooks({
        api: slugApi,
        entityKey: 'articles',
        singular: 'Article',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(
        () => slugHooks.useDetailBySlug('my-article', { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.item).toBeDefined();
      expect(result.current.item!.name).toBe('My Article');
      expect(slugApi.getBySlug).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'my-article' })
      );
    });

    it('is disabled when slug is null', async () => {
      const slugApi = {
        ...createMockApi(),
        getBySlug: vi.fn(),
      };

      const slugHooks = createCrudHooks({
        api: slugApi,
        entityKey: 'articles',
        singular: 'Article',
      });

      const wrapper = createWrapper(queryClient);
      renderHook(
        () => slugHooks.useDetailBySlug(null, { public: true }),
        { wrapper }
      );

      // Should not fetch
      expect(slugApi.getBySlug).not.toHaveBeenCalled();
    });

    it('disables query when api lacks getBySlug', () => {
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useDetailBySlug('test', { public: true }), { wrapper });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.item).toBeNull();
    });
  });

  describe('useTree', () => {
    it('fetches tree data', async () => {
      const treeApi = {
        ...createMockApi(),
        getTree: vi.fn().mockResolvedValue([
          { _id: 'root', name: 'Root', children: [{ _id: 'child', name: 'Child' }] },
        ]),
      };

      const treeHooks = createCrudHooks({
        api: treeApi,
        entityKey: 'categories',
        singular: 'Category',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(
        () => treeHooks.useTree({}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items).toHaveLength(1);
      expect(treeApi.getTree).toHaveBeenCalled();
    });

    it('disables query when api lacks getTree', () => {
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useTree({}, { public: true }), { wrapper });

      expect(result.current.isLoading).toBe(false);
      expect(result.current.items).toHaveLength(0);
    });
  });

  describe('useChildren', () => {
    it('fetches children of a parent', async () => {
      const treeApi = {
        ...createMockApi(),
        getChildren: vi.fn().mockResolvedValue({
          success: true,
          data: [{ _id: 'child-1', name: 'Child 1' }, { _id: 'child-2', name: 'Child 2' }],
          total: 2, page: 1, limit: 10, pages: 1, hasNext: false, hasPrev: false,
        }),
      };

      const treeHooks = createCrudHooks({
        api: treeApi,
        entityKey: 'categories',
        singular: 'Category',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(
        () => treeHooks.useChildren('parent-1', {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.items).toHaveLength(2);
      expect(treeApi.getChildren).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'parent-1' })
      );
    });

    it('is disabled when parentId is null', async () => {
      const treeApi = {
        ...createMockApi(),
        getChildren: vi.fn(),
      };

      const treeHooks = createCrudHooks({
        api: treeApi,
        entityKey: 'categories',
        singular: 'Category',
      });

      const wrapper = createWrapper(queryClient);
      renderHook(
        () => treeHooks.useChildren(null, {}, { public: true }),
        { wrapper }
      );

      expect(treeApi.getChildren).not.toHaveBeenCalled();
    });
  });

  // useFindBy removed in 0.5.0 — single-field filters use:
  //   useList({ status: 'active' })                    // direct equality
  //   useList({ 'price[gte]': 50 })                    // bracket-key operator
  //   useList({ 'location[withinRadius]': [lng, lat, m] }) // geo

  // ==========================================================================
  // useActions — restore
  // ==========================================================================

  describe('useActions — restore', () => {
    it('calls api.restore and shows success toast', async () => {
      const restoreApi = {
        ...createMockApi(),
        restore: vi.fn().mockResolvedValue({ _id: 'del-1', name: 'Restored Item' }),
      };

      const restoreHooks = createCrudHooks({
        api: restoreApi,
        entityKey: 'items',
        singular: 'Item',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => restoreHooks.useActions(), { wrapper });

      await act(async () => {
        await result.current.restore({ id: 'del-1' });
      });

      expect(restoreApi.restore).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'del-1' })
      );
      expect(toastHandler.success).toHaveBeenCalledWith('Item restored successfully');
    });

    it('restore returns extracted entity', async () => {
      const restoreApi = {
        ...createMockApi(),
        restore: vi.fn().mockResolvedValue({ _id: 'del-1', name: 'Restored Item' }),
      };

      const restoreHooks = createCrudHooks({
        api: restoreApi,
        entityKey: 'items',
        singular: 'Item',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => restoreHooks.useActions(), { wrapper });

      let returned: unknown;
      await act(async () => {
        returned = await result.current.restore({ id: 'del-1' });
      });

      expect(returned).toEqual({ _id: 'del-1', name: 'Restored Item' });
    });

    it('shows error toast when restore fails', async () => {
      const restoreApi = {
        ...createMockApi(),
        restore: vi.fn().mockRejectedValue(new Error('Cannot restore')),
      };

      const restoreHooks = createCrudHooks({
        api: restoreApi,
        entityKey: 'items',
        singular: 'Item',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => restoreHooks.useActions(), { wrapper });

      await act(async () => {
        try { await result.current.restore({ id: '1' }); } catch {}
      });

      expect(toastHandler.error).toHaveBeenCalled();
    });

    it('rejects when api lacks restore', async () => {
      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useActions(), { wrapper });

      await act(async () => {
        try {
          await result.current.restore({ id: '1' });
          expect.fail('Should have thrown');
        } catch (error) {
          expect((error as Error).message).toContain('restore');
        }
      });
    });
  });

  // ==========================================================================
  // useBulkActions
  // ==========================================================================

  describe('useBulkActions', () => {
    it('bulkCreate calls api.bulkCreate and returns items', async () => {
      const bulkApi = {
        ...createMockApi(),
        bulkCreate: vi.fn().mockResolvedValue({
          success: true,
          data: [{ _id: '10', name: 'A' }, { _id: '11', name: 'B' }],
          count: 2,
        }),
      };

      const bulkHooks = createCrudHooks({
        api: bulkApi,
        entityKey: 'items',
        singular: 'Item',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => bulkHooks.useBulkActions(), { wrapper });

      let returned: unknown;
      await act(async () => {
        returned = await result.current.bulkCreate({ data: [{ name: 'A' }, { name: 'B' }] });
      });

      expect(bulkApi.bulkCreate).toHaveBeenCalled();
      expect(returned).toHaveLength(2);
      expect(toastHandler.success).toHaveBeenCalledWith('Items created successfully');
    });

    it('bulkUpdate calls api.bulkUpdate', async () => {
      const bulkApi = {
        ...createMockApi(),
        bulkUpdate: vi.fn().mockResolvedValue({ modifiedCount: 5 }),
      };

      const bulkHooks = createCrudHooks({
        api: bulkApi,
        entityKey: 'items',
        singular: 'Item',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => bulkHooks.useBulkActions(), { wrapper });

      await act(async () => {
        await result.current.bulkUpdate({
          filter: { status: 'draft' },
          data: { status: 'published' },
        });
      });

      expect(bulkApi.bulkUpdate).toHaveBeenCalled();
      expect(toastHandler.success).toHaveBeenCalledWith('Items updated successfully');
    });

    it('bulkRemove calls api.bulkDelete', async () => {
      const bulkApi = {
        ...createMockApi(),
        bulkDelete: vi.fn().mockResolvedValue({ deletedCount: 3 }),
      };

      const bulkHooks = createCrudHooks({
        api: bulkApi,
        entityKey: 'items',
        singular: 'Item',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => bulkHooks.useBulkActions(), { wrapper });

      await act(async () => {
        await result.current.bulkRemove({ filter: { archived: true } });
      });

      expect(bulkApi.bulkDelete).toHaveBeenCalled();
      expect(toastHandler.success).toHaveBeenCalledWith('Items deleted successfully');
    });

    it('uses custom plural name in messages', async () => {
      const bulkApi = {
        ...createMockApi(),
        bulkCreate: vi.fn().mockResolvedValue({ success: true, data: [{ _id: '1', name: 'A' }] }),
      };

      const bulkHooks = createCrudHooks({
        api: bulkApi,
        entityKey: 'people',
        singular: 'Person',
        plural: 'People',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => bulkHooks.useBulkActions(), { wrapper });

      await act(async () => {
        await result.current.bulkCreate({ data: [{ name: 'A' }] });
      });

      expect(toastHandler.success).toHaveBeenCalledWith('People created successfully');
    });
  });

  // ==========================================================================
  // authMode: 'header' — hook enablement
  // ==========================================================================

  describe('authMode: header', () => {
    afterEach(() => {
      configureClient({ baseUrl: 'http://api.test' });
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('disables queries until token is available (same as bearer)', async () => {
      configureClient({ baseUrl: 'http://api.test', authMode: 'header' });
      configureAuth({ getToken: () => null, headerName: 'x-api-key' });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => hooks.useList(), { wrapper });

      // Should not fetch — no token
      expect(result.current.isLoading).toBe(false);
      expect(result.current.items).toHaveLength(0);
      expect(mockApi.getAll).not.toHaveBeenCalled();
    });

    it('enables queries when token is available', async () => {
      configureClient({ baseUrl: 'http://api.test', authMode: 'header' });
      configureAuth({ getToken: () => 'snr_key_123', headerName: 'x-api-key' });

      const wrapper = createWrapper(queryClient);
      renderHook(() => hooks.useList(), { wrapper });

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // Custom idField
  // ==========================================================================

  describe('custom idField', () => {
    it('resolveItemId uses idField for optimistic create', async () => {
      const skuApi = createMockApi();
      skuApi.create = vi.fn().mockResolvedValue({ _id: 'mongo-1', sku: 'SKU-001', name: 'Product' });

      const skuHooks = createCrudHooks({
        api: skuApi,
        entityKey: 'products',
        singular: 'Product',
        idField: 'sku',
      });

      const wrapper = createWrapper(queryClient);
      const { result } = renderHook(() => skuHooks.useActions(), { wrapper });

      await act(async () => {
        await result.current.create({ data: { name: 'Product' } });
      });

      expect(skuApi.create).toHaveBeenCalled();
    });

    it('detail cache prefill uses idField', async () => {
      const skuApi = createMockApi();
      skuApi.getAll = vi.fn().mockResolvedValue({
        success: true,
        data: [
          { _id: 'mongo-1', sku: 'SKU-001', name: 'A' },
          { _id: 'mongo-2', sku: 'SKU-002', name: 'B' },
        ],
        total: 2, page: 1, limit: 10, pages: 1, hasNext: false, hasPrev: false,
      });

      const skuHooks = createCrudHooks({
        api: skuApi,
        entityKey: `sku-products-${Math.random()}`,
        singular: 'Product',
        idField: 'sku',
      });

      const localQc = createTestQueryClient();
      const localWrapper = createWrapper(localQc);

      const { result } = renderHook(
        () => skuHooks.useList(null, {}, { public: true }),
        { wrapper: localWrapper }
      );

      await waitFor(() => {
        expect(result.current.items).toHaveLength(2);
      });

      // Detail cache should be keyed by SKU, not _id
      const keys = skuHooks.KEYS;
      const cachedBySku1 = localQc.getQueryData(keys.detail('SKU-001'));
      const cachedBySku2 = localQc.getQueryData(keys.detail('SKU-002'));

      expect(cachedBySku1).toBeDefined();
      expect(cachedBySku2).toBeDefined();
      expect((cachedBySku1 as { data: { name: string } }).data.name).toBe('A');

      localQc.clear();
    });

    it('optimistic delete uses idField to match items', async () => {
      const skuApi = createMockApi();
      skuApi.delete = vi.fn().mockResolvedValue({ message: 'Deleted', id: 'DEL-001' });

      const skuHooks = createCrudHooks({
        api: skuApi,
        entityKey: 'sku-del',
        singular: 'Product',
        idField: 'sku',
      });

      const wrapper = createWrapper(queryClient);

      // Pre-populate list cache with SKU-keyed items
      queryClient.setQueryData(['sku-del', 'list', { _scope: 'super-admin' }], {
        data: [
          { _id: 'a', sku: 'DEL-001', name: 'Delete Me' },
          { _id: 'b', sku: 'KEEP-001', name: 'Keep Me' },
        ],
        total: 2,
      });

      const { result } = renderHook(() => skuHooks.useActions(), { wrapper });

      await act(async () => {
        // Delete by SKU — optimistic update should remove by sku match
        await result.current.remove({ id: 'DEL-001' });
      });

      expect(skuApi.delete).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'DEL-001' })
      );
    });
  });

  // ==========================================================================
  // Per-client auth in hooks
  // ==========================================================================

  describe('per-client auth in hooks', () => {
    afterEach(() => {
      configureClient({ baseUrl: 'http://api.test' });
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('hooks use per-client auth when client has getToken', async () => {
      configureAuth({ getToken: () => 'global-token', getOrgId: () => null });

      const clientWithAuth = {
        request: vi.fn().mockResolvedValue({
          success: true, data: [{ _id: '1', name: 'Item' }],
          total: 1, page: 1, limit: 10, pages: 1, hasNext: false, hasPrev: false,
        }),
        config: { baseUrl: 'http://other.test' } as const,
        auth: { getToken: () => 'per-client-token', getOrgId: () => 'per-client-org' },
      };

      const clientApi = createMockApi();
      const clientHooks = createCrudHooks({
        api: clientApi,
        entityKey: `client-auth-${Math.random()}`,
        singular: 'ClientItem',
        client: clientWithAuth,
      });

      const wrapper = createWrapper(queryClient);
      renderHook(() => clientHooks.useList(), { wrapper });

      await waitFor(() => {
        expect(clientApi.getAll).toHaveBeenCalledWith(
          expect.objectContaining({
            token: 'per-client-token',
            organizationId: 'per-client-org',
          })
        );
      });
    });
  });
});
