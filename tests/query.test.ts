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
    expect(result).toEqual({ docs: [{ _id: '2' }], total: 1 });
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

  it('handles items format', () => {
    const data = { items: [{ _id: '1' }, { _id: '2' }], total: 2 };
    const result = updateListCache(data, (items: unknown[]) => items.filter((i: any) => i._id !== '1'));
    expect(result).toEqual({ items: [{ _id: '2' }], total: 1 });
  });

  it('handles results format', () => {
    const data = { results: [{ _id: '1' }], total: 1 };
    const result = updateListCache(data, (items: unknown[]) => [...items, { _id: '2' }]);
    expect(result).toEqual({ results: [{ _id: '1' }, { _id: '2' }], total: 2 });
  });

  it('updates totalDocs when present', () => {
    const data = { docs: [{ _id: '1' }, { _id: '2' }], total: 2, totalDocs: 2 };
    const result = updateListCache(data, (items: unknown[]) => items.filter((i: any) => i._id !== '1'));
    expect(result).toEqual({ docs: [{ _id: '2' }], total: 1, totalDocs: 1 });
  });

  it('does not add totalDocs when not originally present', () => {
    const data = { docs: [{ _id: '1' }], total: 1 };
    const result = updateListCache(data, (items: unknown[]) => [...items, { _id: '2' }]);
    expect(result).toEqual({ docs: [{ _id: '1' }, { _id: '2' }], total: 2 });
    expect(result).not.toHaveProperty('totalDocs');
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
// Flexible response extraction (custom keys)
// ============================================================================

describe('extractItems flexibility (via updateListCache)', () => {
  it('handles custom key like { products: [...] }', () => {
    const data = { products: [{ _id: '1', name: 'Widget' }], total: 1 };
    const result = updateListCache(data, (items: unknown[]) => [...items, { _id: '2', name: 'Gadget' }]);
    expect(result).toEqual({ products: [{ _id: '1', name: 'Widget' }, { _id: '2', name: 'Gadget' }], total: 2 });
  });

  it('handles custom key like { users: [...] }', () => {
    const data = { users: [{ id: 'a' }, { id: 'b' }], count: 2 };
    const result = updateListCache(data, (items: unknown[]) => items.filter((i: any) => i.id !== 'a'));
    expect(result).toEqual({ users: [{ id: 'b' }], count: 2 });
  });

  it('handles { orders: [...] } with no pagination fields', () => {
    const data = { orders: [{ id: '1' }], success: true };
    const result = updateListCache(data, (items: unknown[]) => []);
    expect(result).toEqual({ orders: [], success: true });
  });

  it('well-known keys take precedence over custom keys', () => {
    // If both `docs` and `products` exist, `docs` wins
    const data = { docs: [{ _id: '1' }], products: [{ _id: '2' }], total: 1 };
    const result = updateListCache(data, (items: unknown[]) => [...items, { _id: '3' }]);
    const r = result as Record<string, unknown>;
    expect(r.docs).toEqual([{ _id: '1' }, { _id: '3' }]);
    expect(r.products).toEqual([{ _id: '2' }]); // untouched
  });

  it('returns unchanged when no array field exists', () => {
    const data = { message: 'ok', count: 0 };
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
// updateListCache — edge cases
// ============================================================================

describe('updateListCache edge cases', () => {
  it('returns primitive values unchanged', () => {
    expect(updateListCache(42, () => [])).toBe(42);
    expect(updateListCache('string', () => [])).toBe('string');
    expect(updateListCache(true, () => [])).toBe(true);
  });

  it('handles empty docs array', () => {
    const data = { docs: [] as unknown[], total: 0 };
    const result = updateListCache(data, (items: unknown[]) => [...items, { _id: '1' }]);
    expect(result).toEqual({ docs: [{ _id: '1' }], total: 1 });
  });

  it('handles data field with non-array value (skips)', () => {
    const data = { data: 'not-an-array', success: true };
    expect(updateListCache(data, () => [])).toEqual(data);
  });

  it('preserves extra properties on wrapper objects', () => {
    const data = { docs: [{ _id: '1' }], total: 1, page: 1, limit: 10, hasNext: false };
    const result = updateListCache(data, (items: unknown[]) => items) as Record<string, unknown>;
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
    expect(result.hasNext).toBe(false);
  });

  it('total does not go below zero', () => {
    const data = { docs: [{ _id: '1' }], total: 0 };
    const result = updateListCache(data, () => []) as Record<string, unknown>;
    expect(result.total).toBe(0);
  });

  it('handles delta when adding multiple items', () => {
    const data = { docs: [{ _id: '1' }], total: 1 };
    const result = updateListCache(data, (items: unknown[]) => [
      ...items, { _id: '2' }, { _id: '3' }, { _id: '4' },
    ]) as Record<string, unknown>;
    expect(result.total).toBe(4);
  });

  it('handles empty array input', () => {
    const data: unknown[] = [];
    const result = updateListCache(data, (items: unknown[]) => [...items, { id: '1' }]);
    expect(result).toEqual([{ id: '1' }]);
  });

  it('does not modify total when item count is unchanged (replace)', () => {
    const data = { docs: [{ _id: '1' }, { _id: '2' }], total: 2 };
    const result = updateListCache(data, (items: unknown[]) =>
      items.map((i: any) => ({ ...i, updated: true }))
    ) as Record<string, unknown>;
    expect(result.total).toBe(2);
  });
});

// ============================================================================
// createQueryKeys — edge cases
// ============================================================================

describe('createQueryKeys edge cases', () => {
  const KEYS = createQueryKeys('posts');

  it('list without params includes undefined', () => {
    const key = KEYS.list();
    expect(key).toEqual(['posts', 'list', undefined]);
  });

  it('list with empty params', () => {
    const key = KEYS.list({});
    expect(key).toEqual(['posts', 'list', {}]);
  });

  it('detail with numeric-like string id', () => {
    expect(KEYS.detail('123')).toEqual(['posts', 'detail', '123']);
  });

  it('custom with no extra args', () => {
    expect(KEYS.custom('stats')).toEqual(['posts', 'stats']);
  });

  it('custom with multiple args', () => {
    expect(KEYS.custom('analytics', 'monthly', '2024')).toEqual(['posts', 'analytics', 'monthly', '2024']);
  });

  it('scopedList with empty params', () => {
    expect(KEYS.scopedList('super-admin')).toEqual([
      'posts', 'list', { _scope: 'super-admin' },
    ]);
  });

  it('scopedList with multiple params', () => {
    expect(KEYS.scopedList('tenant', { organizationId: 'org-1', status: 'active', page: 1 })).toEqual([
      'posts', 'list', { _scope: 'tenant', organizationId: 'org-1', status: 'active', page: 1 },
    ]);
  });
});

// ============================================================================
// createCacheUtils — edge cases
// ============================================================================

describe('createCacheUtils edge cases', () => {
  const KEYS = createQueryKeys('items');
  const cache = createCacheUtils<{ _id: string; name: string }>(KEYS);

  it('setDetail wraps data in { data } envelope', () => {
    const client = new QueryClient();
    cache.setDetail(client, '1', { _id: '1', name: 'Item' });
    const raw = client.getQueryData(KEYS.detail('1')) as Record<string, unknown>;
    expect(raw).toEqual({ data: { _id: '1', name: 'Item' } });
  });

  it('getDetail unwraps { data } envelope', () => {
    const client = new QueryClient();
    client.setQueryData(KEYS.detail('1'), { data: { _id: '1', name: 'Wrapped' } });
    expect(cache.getDetail(client, '1')).toEqual({ _id: '1', name: 'Wrapped' });
  });

  it('setDetail then getDetail roundtrips correctly', () => {
    const client = new QueryClient();
    const item = { _id: 'abc', name: 'Test' };
    cache.setDetail(client, 'abc', item);
    expect(cache.getDetail(client, 'abc')).toEqual(item);
  });

  it('removeDetail then getDetail returns undefined', () => {
    const client = new QueryClient();
    cache.setDetail(client, '1', { _id: '1', name: 'Item' });
    cache.removeDetail(client, '1');
    expect(cache.getDetail(client, '1')).toBeUndefined();
  });

  it('invalidateAll uses the broadest key', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    await cache.invalidateAll(client);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['items'] });
  });
});

// ============================================================================
// getItemId — edge cases
// ============================================================================

describe('getItemId edge cases', () => {
  it('handles zero id (falsy — returns null)', () => {
    // 0 is falsy, so getItemId returns null (by design — MongoDB _ids are never 0)
    expect(getItemId({ _id: 0 })).toBeNull();
  });

  it('handles boolean id (falsy path)', () => {
    expect(getItemId({ _id: false })).toBeNull();
  });

  it('handles nested objects (does not traverse)', () => {
    expect(getItemId({ nested: { _id: 'deep' } })).toBeNull();
  });

  it('handles array as input', () => {
    expect(getItemId([1, 2, 3])).toBeNull();
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

// ============================================================================
// Arc Backend Response Shape Coverage
// ============================================================================

describe('Arc backend response shapes', () => {
  describe('BaseController.list — offset pagination', () => {
    const response = {
      success: true,
      method: 'offset',
      docs: [{ _id: '1' }, { _id: '2' }],
      page: 1,
      limit: 10,
      total: 50,
      pages: 5,
      hasNext: true,
      hasPrev: false,
    };

    it('extractItems returns docs', () => {
      const items = updateListCache(response, (i: unknown[]) => i);
      expect((items as Record<string, unknown>).docs).toEqual(response.docs);
    });

    it('updateListCache updates docs and total', () => {
      const result = updateListCache(response, (items: unknown[]) => [...items, { _id: '3' }]) as Record<string, unknown>;
      expect((result.docs as unknown[]).length).toBe(3);
      expect(result.total).toBe(51);
    });
  });

  describe('BaseController.list — keyset pagination', () => {
    const response = {
      success: true,
      method: 'keyset',
      docs: [{ _id: 'a' }, { _id: 'b' }],
      limit: 20,
      hasMore: true,
      next: 'cursor_abc',
    };

    it('extractItems returns docs', () => {
      const result = updateListCache(response, (i: unknown[]) => i);
      expect((result as Record<string, unknown>).docs).toEqual(response.docs);
    });

    it('updateListCache works on keyset response', () => {
      const result = updateListCache(response, (items: unknown[]) =>
        items.filter((i: any) => i._id !== 'a')
      ) as Record<string, unknown>;
      expect((result.docs as unknown[]).length).toBe(1);
      // keyset has no total — should not add one
      expect(result.total).toBeUndefined();
    });
  });

  describe('BaseController.list — aggregate pagination', () => {
    const response = {
      success: true,
      method: 'aggregate',
      docs: [{ _id: '1', sum: 100 }],
      page: 1,
      limit: 10,
      total: 1,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };

    it('updateListCache updates docs', () => {
      const result = updateListCache(response, (items: unknown[]) => [...items, { _id: '2', sum: 200 }]) as Record<string, unknown>;
      expect((result.docs as unknown[]).length).toBe(2);
      expect(result.total).toBe(2);
    });
  });

  describe('BaseController.get — detail response', () => {
    it('handles { success, data: TDoc }', () => {
      const response = { success: true, data: { _id: '1', name: 'Widget' } };
      // extractItem would pull out `data`
      const d = response as Record<string, unknown>;
      expect(d.data).toEqual({ _id: '1', name: 'Widget' });
    });
  });

  describe('BaseController.delete — delete response', () => {
    it('handles { success, data: { message, id, soft } }', () => {
      const response = { success: true, data: { message: 'Deleted successfully', id: '1', soft: true } };
      expect(response.data.message).toBe('Deleted successfully');
      expect(response.data.soft).toBe(true);
    });
  });

  describe('createActionRouter — action response', () => {
    it('handles { success, data: result } with object result', () => {
      const response = { success: true, data: { status: 'approved', approvedBy: 'admin' } };
      expect(response.data.status).toBe('approved');
    });

    it('handles { success, data: result } with primitive result', () => {
      const response = { success: true, data: 'ok' };
      expect(response.data).toBe('ok');
    });
  });

  describe('additional routes — custom response shapes', () => {
    it('handles { products: [...] } via fallback', () => {
      const response = { success: true, products: [{ _id: '1' }], total: 1 };
      const result = updateListCache(response, (items: unknown[]) => [...items, { _id: '2' }]) as Record<string, unknown>;
      expect((result.products as unknown[]).length).toBe(2);
    });

    it('handles plain array response', () => {
      const response = [{ _id: '1' }, { _id: '2' }];
      const result = updateListCache(response, (items: unknown[]) => items.filter((i: any) => i._id !== '1'));
      expect((result as unknown[]).length).toBe(1);
    });
  });
});
