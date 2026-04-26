import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useApiQuery, QUERY_CONFIGS } from '../src/query.js';

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
      children,
    );
  };
}

// ============================================================================
// useApiQuery
// ============================================================================

describe('useApiQuery', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('auto-unwraps Arc envelope { success, data }', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue({
      success: true,
      data: { totalRevenue: 9999, customers: 42 },
    });

    const { result } = renderHook(
      () =>
        useApiQuery<{ success: true; data: { totalRevenue: number; customers: number } }>({
          queryKey: ['dashboard', 'stats'],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual({ totalRevenue: 9999, customers: 42 });
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('passes through non-envelope responses unchanged', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue([1, 2, 3]);

    const { result } = renderHook(
      () =>
        useApiQuery<number[]>({
          queryKey: ['raw', 'array'],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual([1, 2, 3]);
  });

  it('does NOT unwrap when only `data` is present (no `success`)', async () => {
    // Stricter detector: chart-style { data, labels } stays intact.
    const wrapper = createWrapper(queryClient);
    const response = { data: [1, 2], labels: ['a', 'b'] };
    const queryFn = vi.fn().mockResolvedValue(response);

    const { result } = renderHook(
      () =>
        useApiQuery<{ data: number[]; labels: string[] }>({
          queryKey: ['chart'],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual(response);
  });

  it('does NOT unwrap when only `success` is present (no `data`)', async () => {
    const wrapper = createWrapper(queryClient);
    const response = { success: true, message: 'ok' };
    const queryFn = vi.fn().mockResolvedValue(response);

    const { result } = renderHook(
      () =>
        useApiQuery<{ success: boolean; message: string }>({
          queryKey: ['ack'],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual(response);
  });

  it('custom select wins over auto-unwrap and receives raw response', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue({
      success: true,
      data: { entries: [{ amount: 100 }, { amount: 200 }] },
    });
    const select = vi.fn((res: { data: { entries: { amount: number }[] } }) =>
      res.data.entries.map(e => e.amount),
    );

    const { result } = renderHook(
      () =>
        useApiQuery<{ success: true; data: { entries: { amount: number }[] } }, number[]>({
          queryKey: ['ledger'],
          queryFn,
          select,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual([100, 200]);
    expect(select).toHaveBeenCalledWith({
      success: true,
      data: { entries: [{ amount: 100 }, { amount: 200 }] },
    });
  });

  it('applies freshness preset (realtime → 20s stale)', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue({ success: true, data: 1 });

    renderHook(
      () =>
        useApiQuery<{ success: true; data: number }>({
          queryKey: ['rt'],
          queryFn,
          freshness: 'realtime',
        }),
      { wrapper },
    );

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    const cached = queryClient.getQueryCache().find({ queryKey: ['rt'] });
    expect(cached?.options.staleTime).toBe(QUERY_CONFIGS.realtime.staleTime);
    expect(cached?.options.refetchInterval).toBe(QUERY_CONFIGS.realtime.refetchInterval);
  });

  it('options override freshness preset', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue({ success: true, data: 1 });

    renderHook(
      () =>
        useApiQuery<{ success: true; data: number }>({
          queryKey: ['override'],
          queryFn,
          freshness: 'static',
          options: { staleTime: 1234 },
        }),
      { wrapper },
    );

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    const cached = queryClient.getQueryCache().find({ queryKey: ['override'] });
    expect(cached?.options.staleTime).toBe(1234);
  });

  it('respects enabled: false', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn();

    const { result } = renderHook(
      () =>
        useApiQuery<unknown>({
          queryKey: ['disabled'],
          queryFn,
          enabled: false,
        }),
      { wrapper },
    );

    expect(queryFn).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it('exposes refetch function', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: 'first' })
      .mockResolvedValueOnce({ success: true, data: 'second' });

    const { result } = renderHook(
      () =>
        useApiQuery<{ success: true; data: string }>({
          queryKey: ['refetch'],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBe('first'));

    await result.current.refetch();

    await waitFor(() => expect(result.current.data).toBe('second'));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('forwards AbortSignal to queryFn', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return { success: true, data: 'ok' };
    });

    renderHook(
      () =>
        useApiQuery<{ success: true; data: string }>({
          queryKey: ['signal'],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    expect(queryFn.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces errors via { error, isError }', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockRejectedValue(new Error('boom'));

    const { result } = renderHook(
      () =>
        useApiQuery<unknown>({
          queryKey: ['err'],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.data).toBeNull();
  });

  it('handles primitive (number) response from envelope', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue({ success: true, data: 42 });

    const { result } = renderHook(
      () =>
        useApiQuery<{ success: true; data: number }>({
          queryKey: ['count'],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toBe(42);
  });

  it('handles null data field in envelope (returns null)', async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue({ success: true, data: null });

    const { result } = renderHook(
      () =>
        useApiQuery<{ success: true; data: null }>({
          queryKey: ['null-data'],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toBeNull();
  });
});
