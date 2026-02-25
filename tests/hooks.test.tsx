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
        expect(mockApi.getAll).toHaveBeenCalledWith({
          token: null,
          organizationId: 'org-1',
          params: { status: 'active' },
          options: expect.objectContaining({ signal: expect.any(AbortSignal) }),
        });
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
              signal: expect.any(AbortSignal),
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
              signal: expect.any(AbortSignal),
            }),
          })
        );
      });

      configureAuth({ getToken: () => null, getOrgId: () => null });
    });
  });

  describe('signal passthrough', () => {
    it('useList passes AbortSignal from React Query to api.getAll', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useList(null, {}, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getAll).toHaveBeenCalledWith(
          expect.objectContaining({
            options: expect.objectContaining({
              signal: expect.any(AbortSignal),
            }),
          })
        );
      });
    });

    it('useDetail passes AbortSignal from React Query to api.getById', async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () => hooks.useDetail('1', null, { public: true }),
        { wrapper }
      );

      await waitFor(() => {
        expect(mockApi.getById).toHaveBeenCalledWith(
          expect.objectContaining({
            options: expect.objectContaining({
              signal: expect.any(AbortSignal),
            }),
          })
        );
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
});
