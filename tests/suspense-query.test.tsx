import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useSuspenseListQuery, useSuspenseDetailQuery } from '../src/query.js';

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

/** Wrapper with a Suspense boundary — required because these hooks suspend. */
function createSuspenseWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        React.Suspense,
        { fallback: React.createElement('div', null, 'loading') },
        children,
      ),
    );
  };
}

/** Minimal error boundary so we can assert errors throw to the boundary. */
class TestErrorBoundary extends React.Component<
  { onError: (e: Error) => void; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.hasError
      ? React.createElement('div', null, 'error')
      : this.props.children;
  }
}

// ============================================================================
// useSuspenseListQuery
// ============================================================================

describe('useSuspenseListQuery', () => {
  let queryClient: QueryClient;
  beforeEach(() => {
    queryClient = createTestQueryClient();
  });
  afterEach(() => {
    queryClient.clear();
  });

  it('suspends, then resolves with items + pagination and isLoading=false', async () => {
    const wrapper = createSuspenseWrapper(queryClient);
    const payload = {
      method: 'offset',
      data: [
        { _id: '1', name: 'A' },
        { _id: '2', name: 'B' },
      ],
      total: 2,
      page: 1,
      limit: 20,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    };
    const queryFn = vi.fn().mockResolvedValue(payload);

    const { result } = renderHook(
      () =>
        useSuspenseListQuery<{ _id: string; name: string }>({
          queryKey: ['thing', 'list'],
          queryFn,
        }),
      { wrapper },
    );

    // Suspended on first render — the hook hasn't produced a value yet.
    expect(result.current).toBeNull();

    await waitFor(() => expect(result.current?.items.length).toBe(2));
    expect(result.current.items).toEqual(payload.data);
    expect(result.current.pagination?.total).toBe(2);
    expect(result.current.pagination?.method).toBe('offset');
    // Suspense guarantees data before render → no loading branch ever.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.error).toBeNull();
    expect(queryFn).toHaveBeenCalledTimes(1);
    // queryFn receives an AbortSignal (cancellation support preserved).
    expect(queryFn.mock.calls[0][0]).toHaveProperty('signal');
  });

  it('applies the select projection', async () => {
    const wrapper = createSuspenseWrapper(queryClient);
    const payload = { data: [{ _id: '1' }, { _id: '2' }], total: 2 };
    const queryFn = vi.fn().mockResolvedValue(payload);

    const { result } = renderHook(
      () =>
        useSuspenseListQuery({
          queryKey: ['thing', 'list', 'sel'],
          queryFn,
          select: (d: unknown) => ({
            data: (d as { data: unknown[] }).data.slice(0, 1),
            total: 1,
          }),
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current?.items.length).toBe(1));
    expect(result.current.items).toEqual([{ _id: '1' }]);
  });
});

// ============================================================================
// useSuspenseDetailQuery
// ============================================================================

describe('useSuspenseDetailQuery', () => {
  let queryClient: QueryClient;
  beforeEach(() => {
    queryClient = createTestQueryClient();
  });
  afterEach(() => {
    queryClient.clear();
  });

  it('suspends, then resolves with item, isLoading=false, isPlaceholderData=false', async () => {
    const wrapper = createSuspenseWrapper(queryClient);
    const doc = { _id: '1', name: 'A' };
    const queryFn = vi.fn().mockResolvedValue(doc);

    const { result } = renderHook(
      () =>
        useSuspenseDetailQuery<{ _id: string; name: string }>({
          queryKey: ['thing', 'detail', '1'],
          queryFn,
        }),
      { wrapper },
    );

    expect(result.current).toBeNull();

    await waitFor(() => expect(result.current?.item).toEqual(doc));
    expect(result.current.isLoading).toBe(false);
    // Suspense has no placeholder phase — always false (unlike useDetailQuery).
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.error).toBeNull();
  });
});

// ============================================================================
// Error propagation
// ============================================================================

describe('suspense query error handling', () => {
  let queryClient: QueryClient;
  beforeEach(() => {
    queryClient = createTestQueryClient();
  });
  afterEach(() => {
    queryClient.clear();
  });

  it('throws a rejected queryFn to the nearest error boundary (not isError)', async () => {
    const onError = vi.fn();
    function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          TestErrorBoundary,
          { onError },
          React.createElement(
            React.Suspense,
            { fallback: React.createElement('div', null, 'loading') },
            children,
          ),
        ),
      );
    }
    const queryFn = vi.fn().mockRejectedValue(new Error('boom'));

    renderHook(
      () => useSuspenseListQuery({ queryKey: ['thing', 'list', 'err'], queryFn }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(onError).toHaveBeenCalled());
    const err = onError.mock.calls[0][0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
  });
});
