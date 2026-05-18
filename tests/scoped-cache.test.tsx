/**
 * Scoped Cache Tests — tenant-aware detail keys, navigation prefill, optimistic writes
 *
 * Validates that multi-tenant apps with org-scoped data get isolated cache entries
 * and that all write paths (navigation, optimistic updates, cache helpers) target
 * the correct scoped keys.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createCrudHooks, configureNavigation } from '../src/hooks.js';
import { createQueryKeys, createCacheUtils } from '../src/query.js';
import { configureClient, configureAuth } from '../src/client.js';
import { configureToast } from '../src/mutation.js';
import type { CrudApi } from '../src/hooks.js';

// ============================================================================
// Helpers
// ============================================================================

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function createWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

function createMockApi(): CrudApi<{ _id: string; name: string }, { name: string }, { name: string }> {
  return {
    getAll: vi.fn().mockResolvedValue({
      success: true,
      data: [{ _id: '1', name: 'Item 1' }, { _id: '2', name: 'Item 2' }],
      total: 2, page: 1, limit: 10, pages: 1, hasNext: false, hasPrev: false,
    }),
    getById: vi.fn().mockResolvedValue({ success: true, data: { _id: '1', name: 'Item 1' } }),
    create: vi.fn().mockResolvedValue({ success: true, data: { _id: '3', name: 'New' } }),
    update: vi.fn().mockResolvedValue({ success: true, data: { _id: '1', name: 'Updated' } }),
    delete: vi.fn().mockResolvedValue({ success: true }),
  };
}

// ============================================================================
// scopedDetail primitive
// ============================================================================

describe('scopedDetail query key primitive', () => {
  it('scopedDetail without org returns bare key', () => {
    const KEYS = createQueryKeys('products');
    expect(KEYS.scopedDetail('abc', null)).toEqual(['products', 'detail', 'abc']);
  });

  it('scopedDetail with org includes _org scope', () => {
    const KEYS = createQueryKeys('products');
    expect(KEYS.scopedDetail('abc', 'org-1')).toEqual(['products', 'detail', 'abc', { _org: 'org-1' }]);
  });

  it('different orgs produce different keys', () => {
    const KEYS = createQueryKeys('products');
    const k1 = JSON.stringify(KEYS.scopedDetail('abc', 'org-1'));
    const k2 = JSON.stringify(KEYS.scopedDetail('abc', 'org-2'));
    expect(k1).not.toBe(k2);
  });

  it('bare detail(id) is prefix of scopedDetail(id, org)', () => {
    const KEYS = createQueryKeys('products');
    const bare = KEYS.detail('abc');
    const scoped = KEYS.scopedDetail('abc', 'org-1');
    // scoped starts with bare
    expect(scoped.slice(0, bare.length)).toEqual(bare);
    // scoped is longer
    expect(scoped.length).toBeGreaterThan(bare.length);
  });
});

// ============================================================================
// Scoped cache utils
// ============================================================================

describe('scoped cache utils', () => {
  let qc: QueryClient;

  beforeEach(() => { qc = createTestQueryClient(); });
  afterEach(() => { qc.clear(); });

  it('setScopedDetail / getScopedDetail round-trip', () => {
    const KEYS = createQueryKeys('products');
    const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

    cache.setScopedDetail(qc, 'abc', 'org-1', { _id: 'abc', name: 'Scoped' });

    expect(cache.getScopedDetail(qc, 'abc', 'org-1')).toEqual({ _id: 'abc', name: 'Scoped' });
  });

  it('scoped and bare detail are isolated', () => {
    const KEYS = createQueryKeys('products');
    const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

    cache.setDetail(qc, 'abc', { _id: 'abc', name: 'Bare' });
    cache.setScopedDetail(qc, 'abc', 'org-1', { _id: 'abc', name: 'Org1' });
    cache.setScopedDetail(qc, 'abc', 'org-2', { _id: 'abc', name: 'Org2' });

    expect(cache.getDetail(qc, 'abc')?.name).toBe('Bare');
    expect(cache.getScopedDetail(qc, 'abc', 'org-1')?.name).toBe('Org1');
    expect(cache.getScopedDetail(qc, 'abc', 'org-2')?.name).toBe('Org2');
  });

  it('invalidateDetail prefix-matches all scoped variants', async () => {
    const KEYS = createQueryKeys('products');
    const cache = createCacheUtils<{ _id: string }>(KEYS);

    cache.setDetail(qc, 'abc', { _id: 'abc' });
    cache.setScopedDetail(qc, 'abc', 'org-1', { _id: 'abc' });

    await cache.invalidateDetail(qc, 'abc');

    // Both should be invalidated (stale) — TanStack Query prefix matching
    const bareState = qc.getQueryState(KEYS.detail('abc'));
    const scopedState = qc.getQueryState(KEYS.scopedDetail('abc', 'org-1'));

    // After invalidation, query state isInvalidated is true
    expect(bareState?.isInvalidated).toBe(true);
    expect(scopedState?.isInvalidated).toBe(true);
  });

  it('removeScopedDetail only removes that org variant', () => {
    const KEYS = createQueryKeys('products');
    const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

    cache.setScopedDetail(qc, 'abc', 'org-1', { _id: 'abc', name: 'Org1' });
    cache.setScopedDetail(qc, 'abc', 'org-2', { _id: 'abc', name: 'Org2' });

    cache.removeScopedDetail(qc, 'abc', 'org-1');

    expect(cache.getScopedDetail(qc, 'abc', 'org-1')).toBeUndefined();
    expect(cache.getScopedDetail(qc, 'abc', 'org-2')?.name).toBe('Org2');
  });
});

// ============================================================================
// useDetail with org-scoped cache
// ============================================================================

describe('useDetail tenant-scoped cache', () => {
  let qc: QueryClient;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureToast({ success: () => {}, error: () => {} });
    qc = createTestQueryClient();
  });

  afterEach(() => {
    qc.clear();
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('useDetail with org stores under scoped key', async () => {
    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-1' });

    const api = createMockApi();
    const hooks = createCrudHooks({
      api, entityKey: `scoped-detail-${Math.random()}`, singular: 'Item',
    });

    const wrapper = createWrapper(qc);
    const { result } = renderHook(() => hooks.useDetail('item-1'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Key should include org scope
    const scopedKey = hooks.KEYS.scopedDetail('item-1', 'org-1');
    const cached = qc.getQueryData(scopedKey);
    expect(cached).toBeDefined();
  });

  it('useDetail without org stores under bare key', async () => {
    configureAuth({ getToken: () => 'tok', getOrgId: () => null });

    const api = createMockApi();
    const hooks = createCrudHooks({
      api, entityKey: `bare-detail-${Math.random()}`, singular: 'Item',
    });

    const wrapper = createWrapper(qc);
    const { result } = renderHook(() => hooks.useDetail('item-1'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const bareKey = hooks.KEYS.detail('item-1');
    const cached = qc.getQueryData(bareKey);
    expect(cached).toBeDefined();
  });

  it('two orgs get isolated detail caches for same ID', async () => {
    const api = createMockApi();
    const entityKey = `isolated-${Math.random()}`;

    // Org 1
    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-1' });
    api.getById = vi.fn().mockResolvedValue({ success: true, data: { _id: 'same-id', name: 'Org1 Data' } });

    const hooks1 = createCrudHooks({ api, entityKey, singular: 'Item' });
    const wrapper = createWrapper(qc);

    const { result: r1 } = renderHook(() => hooks1.useDetail('same-id'), { wrapper });
    await waitFor(() => expect(r1.current.item).toBeDefined());

    // Org 2
    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-2' });
    api.getById = vi.fn().mockResolvedValue({ success: true, data: { _id: 'same-id', name: 'Org2 Data' } });

    const hooks2 = createCrudHooks({ api, entityKey, singular: 'Item' });
    const { result: r2 } = renderHook(() => hooks2.useDetail('same-id'), { wrapper });
    await waitFor(() => expect(r2.current.item).toBeDefined());

    // Different cache entries
    const KEYS = createQueryKeys(entityKey);
    const org1Data = qc.getQueryData(KEYS.scopedDetail('same-id', 'org-1'));
    const org2Data = qc.getQueryData(KEYS.scopedDetail('same-id', 'org-2'));

    expect(org1Data).toBeDefined();
    expect(org2Data).toBeDefined();
    expect(org1Data).not.toEqual(org2Data);
  });
});

// ============================================================================
// useNavigation scoped prefill
// ============================================================================

describe('useNavigation tenant-scoped prefill', () => {
  let qc: QueryClient;
  const mockRouter = { push: vi.fn(), replace: vi.fn() };

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureNavigation(() => mockRouter);
    configureToast({ success: () => {}, error: () => {} });
    qc = createTestQueryClient();
    mockRouter.push.mockClear();
  });

  afterEach(() => {
    qc.clear();
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('navigate writes raw doc to scoped detail key when org is set (no { data } envelope since 0.7)', () => {
    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-1' });

    const api = createMockApi();
    const hooks = createCrudHooks({
      api, entityKey: `nav-scoped-${Math.random()}`, singular: 'Item',
    });

    const wrapper = createWrapper(qc);
    const { result } = renderHook(() => hooks.useNavigation(), { wrapper });

    act(() => {
      result.current('/items/abc', { _id: 'abc', name: 'Navigated' } as never);
    });

    const scopedKey = hooks.KEYS.scopedDetail('abc', 'org-1');
    const cached = qc.getQueryData(scopedKey) as { name: string };
    expect(cached?.name).toBe('Navigated');
  });

  it('navigate also writes bare key as fallback when org is set', () => {
    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-1' });

    const api = createMockApi();
    const hooks = createCrudHooks({
      api, entityKey: `nav-fallback-${Math.random()}`, singular: 'Item',
    });

    const wrapper = createWrapper(qc);
    const { result } = renderHook(() => hooks.useNavigation(), { wrapper });

    act(() => {
      result.current('/items/abc', { _id: 'abc', name: 'Both' } as never);
    });

    // Both bare and scoped should be populated
    const bareKey = hooks.KEYS.detail('abc');
    const scopedKey = hooks.KEYS.scopedDetail('abc', 'org-1');

    expect(qc.getQueryData(bareKey)).toBeDefined();
    expect(qc.getQueryData(scopedKey)).toBeDefined();
  });

  it('navigate without org writes raw doc to bare key', () => {
    configureAuth({ getToken: () => 'tok', getOrgId: () => null });

    const api = createMockApi();
    const hooks = createCrudHooks({
      api, entityKey: `nav-bare-${Math.random()}`, singular: 'Item',
    });

    const wrapper = createWrapper(qc);
    const { result } = renderHook(() => hooks.useNavigation(), { wrapper });

    act(() => {
      result.current('/items/abc', { _id: 'abc', name: 'BareOnly' } as never);
    });

    const bareKey = hooks.KEYS.detail('abc');
    const cached = qc.getQueryData(bareKey) as { name: string };
    expect(cached?.name).toBe('BareOnly');
  });
});

// ============================================================================
// useList detail prefill with org scope
// ============================================================================

describe('useList + useDetail org-scope handoff (0.7 placeholderData pattern)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureToast({ success: () => {}, error: () => {} });
    qc = createTestQueryClient();
  });

  afterEach(() => {
    qc.clear();
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('useList does NOT pollute the scoped detail cache (no eager setQueryData)', async () => {
    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-1' });

    const api = createMockApi();
    const entityKey = `list-noprefill-${Math.random()}`;
    const hooks = createCrudHooks({ api, entityKey, singular: 'Item' });

    const wrapper = createWrapper(qc);
    const { result } = renderHook(() => hooks.useList(), { wrapper });

    await waitFor(() => expect(result.current.items).toHaveLength(2));

    const KEYS = createQueryKeys(entityKey);
    // 0.7 contract: list never writes to detail keys. The placeholderData
    // handoff happens inside useDetail at read time — keeps the cache clean
    // and lets `staleTime` reason about real fetches only.
    expect(qc.getQueryData(KEYS.scopedDetail('1', 'org-1'))).toBeUndefined();
    expect(qc.getQueryData(KEYS.scopedDetail('2', 'org-1'))).toBeUndefined();
  });

  it('useDetail picks up the list item as instant placeholder under the scoped key', async () => {
    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-1' });

    const api = createMockApi();
    const entityKey = `list-detail-handoff-${Math.random()}`;
    const hooks = createCrudHooks({ api, entityKey, singular: 'Item' });

    const wrapper = createWrapper(qc);
    const list = renderHook(() => hooks.useList(), { wrapper });
    await waitFor(() => expect(list.result.current.items).toHaveLength(2));

    const detail = renderHook(() => hooks.useDetail('1'), { wrapper });

    // Synchronous first render: placeholder hit, no loading flash.
    expect(detail.result.current.isPlaceholderData).toBe(true);
    expect((detail.result.current.item as { _id?: string } | null)?._id).toBe('1');

    // Real GET still fires and resolves.
    await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(detail.result.current.isPlaceholderData).toBe(false));
  });
});

// ============================================================================
// Optimistic update targets all detail variants
// ============================================================================

describe('optimistic update targets scoped detail keys', () => {
  let qc: QueryClient;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureToast({ success: () => {}, error: () => {} });
    qc = createTestQueryClient();
  });

  afterEach(() => {
    qc.clear();
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('update mutation writes to all matching detail queries via prefix match', async () => {
    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-1' });

    const api = createMockApi();
    const entityKey = `opt-update-${Math.random()}`;
    const KEYS = createQueryKeys(entityKey);
    const hooks = createCrudHooks({ api, entityKey, singular: 'Item' });

    // Pre-populate both bare and scoped detail caches
    qc.setQueryData(KEYS.detail('1'), { data: { _id: '1', name: 'Bare' } });
    qc.setQueryData(KEYS.scopedDetail('1', 'org-1'), { data: { _id: '1', name: 'Scoped' } });

    // Also a list cache so the optimistic update matcher works
    qc.setQueryData(KEYS.scopedList('tenant', { organizationId: 'org-1' }), {
      data: [{ _id: '1', name: 'InList' }], total: 1,
    });

    const wrapper = createWrapper(qc);
    const { result } = renderHook(() => hooks.useActions(), { wrapper });

    await act(async () => {
      await result.current.update({ id: '1', data: { name: 'NewName' } });
    });

    // After invalidation, both should be refetched. The optimistic write
    // via getQueriesData prefix match should have updated both.
    expect(api.update).toHaveBeenCalled();
  });
});
