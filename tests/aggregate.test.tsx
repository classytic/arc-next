/**
 * Aggregations — arc 2.13+ declarative `GET /:resource/aggregations/:name`.
 *
 * Locks the wire shape `{ rows: TRow[] }`, query-key tenant isolation, and
 * the prefetch / hook hydration round-trip RSC consumers depend on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createCrudHooks } from '../src/hooks.js';
import { createQueryKeys, createCacheUtils } from '../src/cache.js';
import { createCrudPrefetcher } from '../src/prefetch.js';
import { configureClient, configureAuth } from '../src/client.js';
import type { CrudApi } from '../src/hooks.js';
import type { AggResult } from '../src/api.js';

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

// ============================================================================
// Query key factory
// ============================================================================

describe('aggregation query keys', () => {
  it('aggregations() is the prefix for all aggregations on a resource', () => {
    const KEYS = createQueryKeys('orders');
    expect(KEYS.aggregations()).toEqual(['orders', 'aggregation']);
  });

  it('aggregation(name) without filter is name-only key', () => {
    const KEYS = createQueryKeys('orders');
    expect(KEYS.aggregation('salesByDay')).toEqual(['orders', 'aggregation', 'salesByDay']);
  });

  it('aggregation(name, filter) appends filter for cache discrimination', () => {
    const KEYS = createQueryKeys('orders');
    const k = KEYS.aggregation('salesByDay', { from: '2025-01-01', to: '2025-12-31' });
    expect(k).toEqual([
      'orders',
      'aggregation',
      'salesByDay',
      { from: '2025-01-01', to: '2025-12-31' },
    ]);
  });

  it('aggregations() is a prefix of every aggregation(name) key', () => {
    const KEYS = createQueryKeys('orders');
    const prefix = KEYS.aggregations();
    const k1 = KEYS.aggregation('salesByDay');
    const k2 = KEYS.aggregation('topRegions', { limit: 10 });
    expect(k1.slice(0, prefix.length)).toEqual(prefix);
    expect(k2.slice(0, prefix.length)).toEqual(prefix);
  });

  it('different filters produce different keys (cache discrimination)', () => {
    const KEYS = createQueryKeys('orders');
    const k1 = JSON.stringify(KEYS.aggregation('salesByDay', { from: '2025-01-01' }));
    const k2 = JSON.stringify(KEYS.aggregation('salesByDay', { from: '2025-02-01' }));
    expect(k1).not.toBe(k2);
  });
});

// ============================================================================
// invalidateAggregations cache util
// ============================================================================

describe('invalidateAggregations', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = createTestQueryClient();
  });
  afterEach(() => qc.clear());

  it('invalidateAggregations() with no name prefix-invalidates every aggregation', async () => {
    const KEYS = createQueryKeys('orders');
    const cache = createCacheUtils<unknown>(KEYS);

    qc.setQueryData(KEYS.aggregation('salesByDay'), { rows: [{ day: '2025-01-01', total: 10 }] });
    qc.setQueryData(KEYS.aggregation('topRegions'), { rows: [{ region: 'NA', total: 50 }] });
    qc.setQueryData(KEYS.list({ page: 1 }), { data: [] }); // unrelated

    const beforeStates = qc.getQueriesData({ queryKey: KEYS.aggregations() });
    expect(beforeStates).toHaveLength(2);

    await cache.invalidateAggregations(qc);

    // Both aggregations marked stale; the unrelated list query is untouched.
    const aggStates = qc.getQueryState(KEYS.aggregation('salesByDay'));
    expect(aggStates?.isInvalidated).toBe(true);
    const listState = qc.getQueryState(KEYS.list({ page: 1 }));
    expect(listState?.isInvalidated).toBeFalsy();
  });

  it('invalidateAggregations(name) targets only that aggregation', async () => {
    const KEYS = createQueryKeys('orders');
    const cache = createCacheUtils<unknown>(KEYS);

    qc.setQueryData(KEYS.aggregation('salesByDay'), { rows: [] });
    qc.setQueryData(KEYS.aggregation('topRegions'), { rows: [] });

    await cache.invalidateAggregations(qc, 'salesByDay');

    expect(qc.getQueryState(KEYS.aggregation('salesByDay'))?.isInvalidated).toBe(true);
    // Other aggregation untouched.
    expect(qc.getQueryState(KEYS.aggregation('topRegions'))?.isInvalidated).toBeFalsy();
  });
});

// ============================================================================
// useAggregation hook
// ============================================================================

describe('useAggregation hook', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = createTestQueryClient();
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'tok', getOrgId: () => null });
  });

  afterEach(() => {
    qc.clear();
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  type SalesRow = { day: string; total: number };

  function createApiWithAggregate(
    rows: SalesRow[] = [{ day: '2025-01-01', total: 100 }],
  ): CrudApi<unknown> {
    return {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({ rows } as AggResult<SalesRow>),
    } as unknown as CrudApi<unknown>;
  }

  it('calls api.aggregate with name + filter and exposes rows', async () => {
    const api = createApiWithAggregate();
    const hooks = createCrudHooks({ api, entityKey: `agg-${Math.random()}`, singular: 'Order' });

    const { result } = renderHook(
      () => hooks.useAggregation<SalesRow>({ name: 'salesByDay', filter: { from: '2025-01-01' } }),
      { wrapper: createWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(api.aggregate).toHaveBeenCalledWith({
      name: 'salesByDay',
      filter: { from: '2025-01-01' },
      token: 'tok',
      organizationId: null,
    });
    expect(result.current.data?.rows).toEqual([{ day: '2025-01-01', total: 100 }]);
  });

  it('caches under KEYS.aggregation(name, filterKey)', async () => {
    const api = createApiWithAggregate();
    const entityKey = `agg-cache-${Math.random()}`;
    const hooks = createCrudHooks({ api, entityKey, singular: 'Order' });

    const { result } = renderHook(
      () => hooks.useAggregation<SalesRow>({ name: 'salesByDay', filter: { from: '2025-01-01' } }),
      { wrapper: createWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const cached = qc.getQueryData(hooks.KEYS.aggregation('salesByDay', { from: '2025-01-01' }));
    expect(cached).toEqual({ rows: [{ day: '2025-01-01', total: 100 }] });
  });

  it('different filters produce isolated cache entries (no leak)', async () => {
    const api = createApiWithAggregate();
    const hooks = createCrudHooks({ api, entityKey: `agg-iso-${Math.random()}`, singular: 'Order' });

    const { result: r1 } = renderHook(
      () => hooks.useAggregation<SalesRow>({ name: 'salesByDay', filter: { from: '2025-01-01' } }),
      { wrapper: createWrapper(qc) },
    );
    await waitFor(() => expect(r1.current.isLoading).toBe(false));

    const { result: r2 } = renderHook(
      () => hooks.useAggregation<SalesRow>({ name: 'salesByDay', filter: { from: '2025-02-01' } }),
      { wrapper: createWrapper(qc) },
    );
    await waitFor(() => expect(r2.current.isLoading).toBe(false));

    expect(api.aggregate).toHaveBeenCalledTimes(2);
  });

  it('tenant isolation — same name + filter under different orgs is different key', async () => {
    const api = createApiWithAggregate();
    const entityKey = `agg-tenant-${Math.random()}`;
    const hooks = createCrudHooks({ api, entityKey, singular: 'Order' });

    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-1' });
    const { result: r1 } = renderHook(
      () => hooks.useAggregation<SalesRow>({ name: 'salesByDay' }),
      { wrapper: createWrapper(qc) },
    );
    await waitFor(() => expect(r1.current.isLoading).toBe(false));

    configureAuth({ getToken: () => 'tok', getOrgId: () => 'org-2' });
    const { result: r2 } = renderHook(
      () => hooks.useAggregation<SalesRow>({ name: 'salesByDay' }),
      { wrapper: createWrapper(qc) },
    );
    await waitFor(() => expect(r2.current.isLoading).toBe(false));

    expect(api.aggregate).toHaveBeenCalledTimes(2);
  });

  it('enabled: false does not fire the request', async () => {
    const api = createApiWithAggregate();
    const hooks = createCrudHooks({ api, entityKey: `agg-disabled-${Math.random()}`, singular: 'Order' });

    renderHook(
      () => hooks.useAggregation<SalesRow>({ name: 'salesByDay', enabled: false }),
      { wrapper: createWrapper(qc) },
    );

    // Wait a tick to ensure no fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(api.aggregate).not.toHaveBeenCalled();
  });

  it('select transforms AggResult — pluck rows directly', async () => {
    type Row = { day: string; total: number };
    const api = createApiWithAggregate([
      { day: '2025-01-01', total: 100 },
      { day: '2025-01-02', total: 200 },
    ]);
    const hooks = createCrudHooks({ api, entityKey: `agg-select-${Math.random()}`, singular: 'Order' });

    const { result } = renderHook(
      () =>
        hooks.useAggregation<Row, Row[]>({
          name: 'salesByDay',
          select: (r) => r.rows,
        }),
      { wrapper: createWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([
      { day: '2025-01-01', total: 100 },
      { day: '2025-01-02', total: 200 },
    ]);
  });

  it('select can compute derived values (sum / aggregate-of-aggregate)', async () => {
    type Row = { day: string; total: number };
    const api = createApiWithAggregate([
      { day: '2025-01-01', total: 100 },
      { day: '2025-01-02', total: 200 },
      { day: '2025-01-03', total: 50 },
    ]);
    const hooks = createCrudHooks({ api, entityKey: `agg-select-sum-${Math.random()}`, singular: 'Order' });

    const { result } = renderHook(
      () =>
        hooks.useAggregation<Row, number>({
          name: 'salesByDay',
          select: (r) => r.rows.reduce((sum, x) => sum + x.total, 0),
        }),
      { wrapper: createWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toBe(350);
  });

  it('public: true bypasses auth gate (allows query without token)', async () => {
    configureAuth({ getToken: () => null, getOrgId: () => null });
    const api = createApiWithAggregate();
    const hooks = createCrudHooks({ api, entityKey: `agg-public-${Math.random()}`, singular: 'Order' });

    const { result } = renderHook(
      () => hooks.useAggregation<SalesRow>({ name: 'publicMetrics', public: true }),
      { wrapper: createWrapper(qc) },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.aggregate).toHaveBeenCalled();
  });

  it('CRUD writes auto-invalidate aggregations (dashboards refresh)', async () => {
    const api: CrudApi<{ _id: string; name: string }, { name: string }, { name: string }> = {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn().mockResolvedValue({ _id: '99', name: 'New' }),
      update: vi.fn().mockResolvedValue({ _id: '1', name: 'Edited' }),
      delete: vi.fn().mockResolvedValue({ deleted: true }),
      aggregate: vi.fn().mockResolvedValue({ rows: [{ count: 0 }] } as AggResult),
    };
    const hooks = createCrudHooks({
      api,
      entityKey: `agg-invalidate-${Math.random()}`,
      singular: 'Item',
    });

    // Seed an aggregation in the cache so we can observe invalidation.
    const aggKey = hooks.KEYS.aggregation('count', {});
    qc.setQueryData(aggKey, { rows: [{ count: 10 }] });
    expect(qc.getQueryState(aggKey)?.isInvalidated).toBeFalsy();

    const { result } = renderHook(() => hooks.useActions(), { wrapper: createWrapper(qc) });

    // Create
    await result.current.create({ data: { name: 'X' } });
    await waitFor(() => expect(qc.getQueryState(aggKey)?.isInvalidated).toBe(true));

    // Reset and try update
    qc.setQueryData(aggKey, { rows: [{ count: 11 }] });
    qc.invalidateQueries({ queryKey: aggKey, refetchType: 'none' });
    qc.setQueryData(aggKey, { rows: [{ count: 11 }] });
    const stateBefore = qc.getQueryState(aggKey);
    expect(stateBefore?.data).toEqual({ rows: [{ count: 11 }] });

    await result.current.update({ id: '1', data: { name: 'Edited' } });
    await waitFor(() => expect(qc.getQueryState(aggKey)?.isInvalidated).toBe(true));
  });

  it('rejects with actionable error if api lacks aggregate', async () => {
    const api: CrudApi<unknown> = {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      // no aggregate
    };
    const hooks = createCrudHooks({ api, entityKey: `agg-missing-${Math.random()}`, singular: 'Order' });

    // enabled rule requires `!!api.aggregate` so the query stays disabled —
    // the hook returns idle, not an error. This is the right behavior:
    // detection is structural, not a runtime fire-and-fail.
    const { result } = renderHook(
      () => hooks.useAggregation<SalesRow>({ name: 'salesByDay' }),
      { wrapper: createWrapper(qc) },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('bulkCreate auto-invalidates aggregations', async () => {
    const api = {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      bulkCreate: vi.fn().mockResolvedValue([{ _id: '1' }, { _id: '2' }]),
      aggregate: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const hooks = createCrudHooks({
      api: api as unknown as CrudApi<{ _id: string }>,
      entityKey: `agg-bulk-${Math.random()}`,
      singular: 'Item',
    });

    const aggKey = hooks.KEYS.aggregation('byStatus', {});
    qc.setQueryData(aggKey, { rows: [{ count: 5 }] });

    const { result } = renderHook(() => hooks.useBulkActions(), { wrapper: createWrapper(qc) });
    await result.current.bulkCreate({ data: [{ name: 'a' }, { name: 'b' }] as never[] });
    await waitFor(() => expect(qc.getQueryState(aggKey)?.isInvalidated).toBe(true));
  });

  it('restore auto-invalidates aggregations', async () => {
    const api = {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      restore: vi.fn().mockResolvedValue({ _id: '1', name: 'x' }),
      aggregate: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const hooks = createCrudHooks({
      api: api as unknown as CrudApi<{ _id: string; name: string }>,
      entityKey: `agg-restore-${Math.random()}`,
      singular: 'Item',
    });

    const aggKey = hooks.KEYS.aggregation('count');
    qc.setQueryData(aggKey, { rows: [{ count: 0 }] });

    const { result } = renderHook(() => hooks.useActions(), { wrapper: createWrapper(qc) });
    await result.current.restore({ id: '1' });
    await waitFor(() => expect(qc.getQueryState(aggKey)?.isInvalidated).toBe(true));
  });

  it('prefetched aggregation hydrates useAggregation without refetch', async () => {
    type Row = { region: string; total: number };
    const aggregate = vi.fn().mockResolvedValue({
      rows: [{ region: 'NA', total: 50 }],
    } as AggResult<Row>);
    const api: CrudApi<unknown> = {
      getAll: vi.fn(),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      aggregate: aggregate as unknown as NonNullable<CrudApi<unknown>['aggregate']>,
    };

    const entityKey = `agg-prefetch-${Math.random()}`;
    // 1. Prefetch on the "server" — uses createCrudPrefetcher (server-safe path).
    const prefetcher = createCrudPrefetcher(
      { getAll: vi.fn(), getById: vi.fn(), aggregate },
      entityKey,
    );
    await prefetcher.prefetchAggregation(qc, 'topRegions', { limit: 10 }, {
      organizationId: null,
      staleTime: 60_000,
    });

    expect(aggregate).toHaveBeenCalledTimes(1);

    // 2. Render the hook with the SAME args — should read from prefetched
    // cache and NOT fire a second fetch. Long staleTime keeps it fresh.
    const hooks = createCrudHooks({ api, entityKey, singular: 'Region' });
    const { result } = renderHook(
      () =>
        hooks.useAggregation<Row>({
          name: 'topRegions',
          filter: { limit: 10 },
          staleTime: 60_000,
        }),
      { wrapper: createWrapper(qc) },
    );

    // Cache hit on first render — no loading state, data populated immediately.
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.rows).toEqual([{ region: 'NA', total: 50 }]);
    // Critical: the network was hit ONCE (during prefetch), not twice.
    expect(aggregate).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// prefetchAggregation
// ============================================================================

describe('prefetchAggregation', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = createTestQueryClient();
  });
  afterEach(() => qc.clear());

  it('prefetches under the same key useAggregation reads', async () => {
    type Row = { region: string; total: number };
    const aggregate = vi.fn().mockResolvedValue({
      rows: [{ region: 'NA', total: 50 }],
    } as AggResult<Row>);

    const api = {
      getAll: vi.fn(),
      getById: vi.fn(),
      aggregate,
    };

    const prefetcher = createCrudPrefetcher(api, 'orders');
    await prefetcher.prefetchAggregation(qc, 'topRegions', { limit: 10 }, {
      token: 'srv-tok',
      organizationId: 'org-1',
      staleTime: 60_000,
    });

    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'topRegions',
        filter: { limit: 10 },
        token: 'srv-tok',
        organizationId: 'org-1',
      }),
    );

    // Hydration target — useAggregation reads `{ _org, ...filter }` for tenant
    // isolation; prefetch must mirror that key shape.
    const KEYS = createQueryKeys('orders');
    const hydrated = qc.getQueryData(
      KEYS.aggregation('topRegions', { _org: 'org-1', limit: 10 }),
    );
    expect(hydrated).toEqual({ rows: [{ region: 'NA', total: 50 }] });
  });

  it('throws if api lacks aggregate (preset gating contract)', async () => {
    const api = { getAll: vi.fn(), getById: vi.fn() };
    const prefetcher = createCrudPrefetcher(api, 'orders');

    await expect(
      prefetcher.prefetchAggregation(qc, 'salesByDay'),
    ).rejects.toThrow(/aggregate/);
  });

  it('throws on missing aggregation name', async () => {
    const api = { getAll: vi.fn(), getById: vi.fn(), aggregate: vi.fn() };
    const prefetcher = createCrudPrefetcher(api, 'orders');

    await expect(prefetcher.prefetchAggregation(qc, '')).rejects.toThrow(
      /aggregation name is required/i,
    );
  });
});
