import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createCrudHooks, configureNavigation } from '../src/hooks.js';
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
      docs: [
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
    getById: vi.fn().mockResolvedValue({
      success: true,
      data: { _id: '1', name: 'Item 1' },
    }),
    create: vi.fn().mockResolvedValue({
      success: true,
      data: { _id: '3', name: 'New Item' },
    }),
    update: vi.fn().mockResolvedValue({
      success: true,
      data: { _id: '1', name: 'Updated Item' },
    }),
    delete: vi.fn().mockResolvedValue({
      success: true,
      deleted: true,
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
        resolveCreate!({ success: true, data: { _id: '99', name: 'X' } });
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
      configureNavigation(() => ({ push: mockPush, replace: mockReplace }));

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useNavigation(),
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
      configureNavigation(() => ({ push: mockPush, replace: mockReplace }));

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => hooks.useNavigation(),
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
        docs: [
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
        docs: [{ _id: '1', name: 'Item 1' }],
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
        docs: [{ _id: '1', name: 'Item 1' }],
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
        docs: [{ _id: '1', name: 'Item 1' }],
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
        docs: [{ _id: '1', name: 'Item 1' }],
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
            docs: [{ _id: '1', name: 'Page 1' }],
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
          docs: [{ _id: '2', name: 'Page 2' }],
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

  describe('custom staleTime and gcTime', () => {
    it('useList respects custom staleTime', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList(null, {}, { public: true, staleTime: 1000 }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalled();
      });
    });

    it('useList respects refetchInterval', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList(null, {}, { public: true, refetchInterval: 5000 }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalled();
      });
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
        docs: [{ _id: '1', name: 'Item' }, { _id: '2', name: 'Other' }],
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
            const d = data as { docs: Array<{ _id: string; name: string }> };
            return {
              ...d,
              docs: d.docs.map((item) => ({ ...item, name: item.name.toUpperCase() })),
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
            const d = data as { data: { _id: string; name: string } };
            return { data: { ...d.data, name: d.data.name.toUpperCase() } };
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
            const d = data as { docs: Array<{ _id: string; name: string }> };
            return { ...d, docs: d.docs.filter((item) => item._id === '1') };
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
    it('calls onSettled after successful create', async () => {
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

      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ data: { _id: '3', name: 'New Item' } }),
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
        docs: [{ _id: '1', name: 'Existing' }],
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
      const cached = queryClient.getQueryData(listKey) as { docs: unknown[] };
      expect(cached.docs).toHaveLength(1);
      expect((cached.docs[0] as { _id: string })._id).toBe('1');
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
        docs: [{ _id: '1', name: 'Original' }],
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

      const cached = queryClient.getQueryData(listKey) as { docs: Array<{ name: string }> };
      expect(cached.docs[0]!.name).toBe('Original');
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
        docs: [{ _id: '1', name: 'Item 1' }],
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
    it('calls per-call onSettled after successful create', async () => {
      const wrapper = createWrapper(queryClient);
      const onSettled = vi.fn();

      const { result } = renderHook(
        () => hooks.useActions(),
        { wrapper }
      );

      await act(async () => {
        await result.current.create({ data: { name: 'New' } }, { onSettled });
      });

      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ data: { _id: '3', name: 'New Item' } }),
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
    it('throws when api has no upload method', () => {
      const wrapper = createWrapper(queryClient);

      expect(() => {
        renderHook(() => hooks.useUpload(), { wrapper });
      }).toThrow('[arc-next] "items" api does not define an upload method');
    });

    it('calls upload api and shows toast', async () => {
      const uploadApi = createMockApi();
      uploadApi.upload = vi.fn().mockResolvedValue({ success: true, url: '/uploads/file.png' });

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
      uploadApi.upload = vi.fn().mockResolvedValue({ success: true });

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
      uploadApi.upload = vi.fn().mockResolvedValue({ success: true });

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

  describe('useSearch', () => {
    it('throws when api has no search method', () => {
      const wrapper = createWrapper(queryClient);

      expect(() => {
        renderHook(() => hooks.useSearch('test'), { wrapper });
      }).toThrow('[arc-next] "items" api does not define a search method');
    });

    it('calls search api with query param', async () => {
      configureAuth({ getToken: () => 'search-token', getOrgId: () => null });

      const searchApi = createMockApi();
      searchApi.search = vi.fn().mockResolvedValue({
        success: true,
        docs: [{ _id: '1', name: 'Found' }],
        total: 1,
        page: 1,
        limit: 10,
        pages: 1,
        hasNext: false,
        hasPrev: false,
      });

      const searchHooks = createCrudHooks({
        api: searchApi,
        entityKey: 'search-items',
        singular: 'SearchItem',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => searchHooks.useSearch('test query'),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(searchApi.search).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'search-token',
          params: expect.objectContaining({ q: 'test query' }),
        }),
      );
      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0]!.name).toBe('Found');

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('disables query when search string is empty', async () => {
      configureAuth({ getToken: () => 'tok', getOrgId: () => null });

      const searchApi = createMockApi();
      searchApi.search = vi.fn().mockResolvedValue({ docs: [] });

      const searchHooks = createCrudHooks({
        api: searchApi,
        entityKey: 'search-empty-items',
        singular: 'SearchEmptyItem',
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => searchHooks.useSearch(''),
        { wrapper }
      );

      // Wait a tick — query should NOT fire
      await new Promise((r) => setTimeout(r, 50));
      expect(searchApi.search).not.toHaveBeenCalled();

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });
  });

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
      uploadApi.upload = vi.fn().mockResolvedValue({ success: true });

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
      uploadApi.upload = vi.fn().mockResolvedValue({ success: true });

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

  describe('useSearch tenant cache isolation', () => {
    it('includes organizationId in query key when provided', async () => {
      configureAuth({ getToken: () => 'tok', getOrgId: () => null });

      const searchApi = createMockApi();
      searchApi.search = vi.fn().mockResolvedValue({
        success: true,
        docs: [{ _id: '1', name: 'Org1 Result' }],
        total: 1, page: 1, limit: 10, pages: 1, hasNext: false, hasPrev: false,
      });

      const searchHooks = createCrudHooks({
        api: searchApi,
        entityKey: 'search-org-items',
        singular: 'SearchOrgItem',
      });

      const wrapper = createWrapper(queryClient);

      // Search with org-1
      renderHook(
        () => searchHooks.useSearch('widget', { organizationId: 'org-1' }),
        { wrapper }
      );

      await waitFor(() => {
        expect(searchApi.search).toHaveBeenCalledTimes(1);
      });

      // Search with org-2 (same query text)
      renderHook(
        () => searchHooks.useSearch('widget', { organizationId: 'org-2' }),
        { wrapper }
      );

      await waitFor(() => {
        expect(searchApi.search).toHaveBeenCalledTimes(2);
      });

      // Both calls should have fired — different query keys due to different orgId
      expect(searchApi.search).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1' }),
      );
      expect(searchApi.search).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-2' }),
      );

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('works without organizationId for single-tenant apps', async () => {
      configureAuth({ getToken: () => 'tok', getOrgId: () => null });

      const searchApi = createMockApi();
      searchApi.search = vi.fn().mockResolvedValue({
        success: true,
        docs: [{ _id: '1', name: 'Result' }],
        total: 1, page: 1, limit: 10, pages: 1, hasNext: false, hasPrev: false,
      });

      const searchHooks = createCrudHooks({
        api: searchApi,
        entityKey: 'search-no-org-items',
        singular: 'SearchNoOrgItem',
      });

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => searchHooks.useSearch('widget'),
        { wrapper }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(searchApi.search).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: null,
          params: expect.objectContaining({ q: 'widget' }),
        }),
      );
      expect(result.current.items).toHaveLength(1);

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it('auto-injects organizationId from configureAuth into search query key', async () => {
      configureAuth({ getToken: () => 'tok', getOrgId: () => 'auto-org' });

      const searchApi = createMockApi();
      searchApi.search = vi.fn().mockResolvedValue({
        success: true,
        docs: [],
        total: 0, page: 1, limit: 10, pages: 0, hasNext: false, hasPrev: false,
      });

      const searchHooks = createCrudHooks({
        api: searchApi,
        entityKey: 'search-auto-org-items',
        singular: 'SearchAutoOrgItem',
      });

      const wrapper = createWrapper(queryClient);

      renderHook(
        () => searchHooks.useSearch('test'),
        { wrapper }
      );

      await waitFor(() => {
        expect(searchApi.search).toHaveBeenCalledTimes(1);
      });

      expect(searchApi.search).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'auto-org' }),
      );

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });
  });

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
});
