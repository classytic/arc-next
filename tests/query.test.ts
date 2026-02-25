import { describe, it, expect, vi } from 'vitest';
import { getItemId, updateListCache, createQueryKeys, createCacheUtils, DEFAULT_QUERY_CONFIG } from '../src/query.js';
import { QueryClient } from '@tanstack/react-query';

// ============================================================================
// getItemId
// ============================================================================

describe('getItemId', () => {
  it('extracts _id', () => {
    expect(getItemId({ _id: 'abc' })).toBe('abc');
  });

  it('extracts id', () => {
    expect(getItemId({ id: 'xyz' })).toBe('xyz');
  });

  it('prefers _id over id', () => {
    expect(getItemId({ _id: 'abc', id: 'xyz' })).toBe('abc');
  });

  it('converts numeric id to string', () => {
    expect(getItemId({ _id: 123 })).toBe('123');
  });

  it('returns null for missing id', () => {
    expect(getItemId({})).toBeNull();
    expect(getItemId({ name: 'test' })).toBeNull();
  });

  it('returns null for non-objects', () => {
    expect(getItemId(null)).toBeNull();
    expect(getItemId(undefined)).toBeNull();
    expect(getItemId('string')).toBeNull();
    expect(getItemId(42)).toBeNull();
  });
});

// ============================================================================
// updateListCache
// ============================================================================

describe('updateListCache', () => {
  it('handles docs format', () => {
    const data = { docs: [{ _id: '1' }, { _id: '2' }], total: 2 };
    const result = updateListCache(data, (items: unknown[]) => items.filter((i: any) => i._id !== '1'));
    expect(result).toEqual({ docs: [{ _id: '2' }], total: 1, totalDocs: 1 });
  });

  it('handles array format', () => {
    const data = [{ id: '1' }, { id: '2' }];
    const result = updateListCache(data, (items: unknown[]) => [...items, { id: '3' }]);
    expect(result).toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
  });

  it('handles data format', () => {
    const data = { data: [{ id: '1' }], success: true };
    const result = updateListCache(data, (items: unknown[]) => []);
    expect(result).toEqual({ data: [], success: true });
  });

  it('returns unchanged for null/undefined', () => {
    expect(updateListCache(null, (items: unknown[]) => items)).toBeNull();
    expect(updateListCache(undefined, (items: unknown[]) => [])).toBeUndefined();
  });

  it('returns unchanged for unrecognized format', () => {
    const data = { other: 'value' };
    expect(updateListCache(data, () => [])).toEqual(data);
  });
});

// ============================================================================
// createQueryKeys
// ============================================================================

describe('createQueryKeys', () => {
  const KEYS = createQueryKeys('posts');

  it('creates all key', () => {
    expect(KEYS.all).toEqual(['posts']);
  });

  it('creates lists key', () => {
    expect(KEYS.lists()).toEqual(['posts', 'list']);
  });

  it('creates list key with params', () => {
    expect(KEYS.list({ page: 1 })).toEqual(['posts', 'list', { page: 1 }]);
  });

  it('creates details key', () => {
    expect(KEYS.details()).toEqual(['posts', 'detail']);
  });

  it('creates detail key with id', () => {
    expect(KEYS.detail('abc')).toEqual(['posts', 'detail', 'abc']);
  });

  it('creates custom key', () => {
    expect(KEYS.custom('capabilities')).toEqual(['posts', 'capabilities']);
    expect(KEYS.custom('stats', 'monthly')).toEqual(['posts', 'stats', 'monthly']);
  });

  it('creates scoped list key', () => {
    expect(KEYS.scopedList('tenant', { organizationId: 'org-1' })).toEqual([
      'posts', 'list', { _scope: 'tenant', organizationId: 'org-1' },
    ]);
  });
});

// ============================================================================
// createCacheUtils
// ============================================================================

describe('createCacheUtils', () => {
  const KEYS = createQueryKeys('items');
  const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

  it('setDetail and getDetail', () => {
    const client = new QueryClient();
    const item = { _id: '1', name: 'Item 1' };

    cache.setDetail(client, '1', item);
    expect(cache.getDetail(client, '1')).toEqual(item);
  });

  it('getDetail returns undefined for missing', () => {
    const client = new QueryClient();
    expect(cache.getDetail(client, 'nonexistent')).toBeUndefined();
  });

  it('removeDetail clears cache', () => {
    const client = new QueryClient();
    cache.setDetail(client, '1', { _id: '1', name: 'Item' });
    cache.removeDetail(client, '1');
    expect(cache.getDetail(client, '1')).toBeUndefined();
  });

  it('invalidateAll calls invalidateQueries', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    await cache.invalidateAll(client);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['items'] });
  });

  it('invalidateLists calls invalidateQueries', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    await cache.invalidateLists(client);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['items', 'list'] });
  });

  it('invalidateDetail calls invalidateQueries with id', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    await cache.invalidateDetail(client, '42');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['items', 'detail', '42'] });
  });
});

// ============================================================================
// DEFAULT_QUERY_CONFIG
// ============================================================================

describe('DEFAULT_QUERY_CONFIG', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_QUERY_CONFIG.staleTime).toBe(300_000);
    expect(DEFAULT_QUERY_CONFIG.gcTime).toBe(1_800_000);
    expect(DEFAULT_QUERY_CONFIG.refetchOnWindowFocus).toBe(false);
    expect(DEFAULT_QUERY_CONFIG.retry).toBe(0);
  });
});
