import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  configureToast,
  useMutationWithTransition,
  useMutationWithOptimistic,
  QUERY_CONFIGS,
} from '../src/mutation.js';
import { configureClient } from '../src/client.js';

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

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children
    );
  };
}

// ============================================================================
// configureToast
// ============================================================================

describe('configureToast', () => {
  it('accepts custom toast handler', () => {
    const handler = {
      success: vi.fn(),
      error: vi.fn(),
    };
    expect(() => configureToast(handler)).not.toThrow();
  });
});

// ============================================================================
// QUERY_CONFIGS presets
// ============================================================================

describe('QUERY_CONFIGS', () => {
  it('has realtime preset with short stale time and refetch interval', () => {
    expect(QUERY_CONFIGS.realtime.staleTime).toBe(20_000);
    expect(QUERY_CONFIGS.realtime.refetchInterval).toBe(30_000);
  });

  it('has frequent preset', () => {
    expect(QUERY_CONFIGS.frequent.staleTime).toBe(60_000);
  });

  it('has stable preset', () => {
    expect(QUERY_CONFIGS.stable.staleTime).toBe(300_000);
  });

  it('has static preset with longest stale time', () => {
    expect(QUERY_CONFIGS.static.staleTime).toBe(600_000);
  });

  it('stale times are in ascending order', () => {
    expect(QUERY_CONFIGS.realtime.staleTime).toBeLessThan(QUERY_CONFIGS.frequent.staleTime);
    expect(QUERY_CONFIGS.frequent.staleTime).toBeLessThan(QUERY_CONFIGS.stable.staleTime);
    expect(QUERY_CONFIGS.stable.staleTime).toBeLessThan(QUERY_CONFIGS.static.staleTime);
  });
});

// ============================================================================
// useMutationWithTransition
// ============================================================================

describe('useMutationWithTransition', () => {
  let queryClient: QueryClient;
  const toastHandler = { success: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureToast(toastHandler);
    queryClient = createTestQueryClient();
    toastHandler.success.mockClear();
    toastHandler.error.mockClear();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('calls mutationFn and resolves', async () => {
    const mutationFn = vi.fn().mockResolvedValue({ id: '1' });

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        messages: { success: 'Done!' },
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({ name: 'Test' });
    });

    expect(mutationFn.mock.calls[0]![0]).toEqual({ name: 'Test' });
    expect(toastHandler.success).toHaveBeenCalledWith('Done!');
  });

  it('shows error toast on failure', async () => {
    const mutationFn = vi.fn().mockRejectedValue(new Error('Server error'));

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        messages: { error: 'Custom error message' },
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      try {
        await result.current.mutateAsync({ name: 'Test' });
      } catch {}
    });

    expect(toastHandler.error).toHaveBeenCalledWith('Custom error message');
  });

  it('uses default error message when no custom message', async () => {
    const mutationFn = vi.fn().mockRejectedValue(new Error('DB connection failed'));

    const { result } = renderHook(
      () => useMutationWithTransition({ mutationFn }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      try {
        await result.current.mutateAsync({});
      } catch {}
    });

    expect(toastHandler.error).toHaveBeenCalledWith('DB connection failed');
  });

  it('invalidates queries on success', async () => {
    const listKey = ['items', 'list'];
    queryClient.setQueryData(listKey, { docs: [] });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    const mutationFn = vi.fn().mockResolvedValue({ id: '1' });

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        invalidateQueries: [listKey],
        messages: { success: 'Created' },
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: listKey });
  });

  it('calls onSuccess callback', async () => {
    const onSuccess = vi.fn();
    const mutationFn = vi.fn().mockResolvedValue({ id: '1' });

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        onSuccess,
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({ name: 'X' });
    });

    expect(onSuccess).toHaveBeenCalledWith({ id: '1' }, { name: 'X' });
  });

  it('calls onError callback', async () => {
    const onError = vi.fn();
    const mutationFn = vi.fn().mockRejectedValue(new Error('fail'));

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        onError,
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      try {
        await result.current.mutateAsync({});
      } catch {}
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.anything());
  });

  it('calls onSettled callback on success', async () => {
    const onSettled = vi.fn();
    const mutationFn = vi.fn().mockResolvedValue({ ok: true });

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        onSettled,
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(onSettled).toHaveBeenCalledWith({ ok: true }, null, expect.anything());
  });

  it('suppresses toast when showToast is false', async () => {
    const mutationFn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        messages: { success: 'Done' },
        showToast: false,
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(toastHandler.success).not.toHaveBeenCalled();
  });

  it('uses instance toast handler over global', async () => {
    const instanceToast = { success: vi.fn(), error: vi.fn() };
    const mutationFn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        messages: { success: 'Instance toast' },
        toastHandler: instanceToast,
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(instanceToast.success).toHaveBeenCalledWith('Instance toast');
    expect(toastHandler.success).not.toHaveBeenCalled();
  });

  it('reports isPending during mutation', async () => {
    let resolve: (v: unknown) => void;
    const mutationFn = vi.fn().mockReturnValue(new Promise(r => { resolve = r; }));

    const { result } = renderHook(
      () => useMutationWithTransition({ mutationFn }),
      { wrapper: createWrapper(queryClient) }
    );

    expect(result.current.isPending).toBe(false);

    let promise: Promise<unknown>;
    act(() => {
      promise = result.current.mutateAsync({}).catch(() => {});
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    await act(async () => {
      resolve!({ ok: true });
      await promise;
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
  });

  it('exposes reset function', async () => {
    const mutationFn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(
      () => useMutationWithTransition({ mutationFn }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    act(() => {
      result.current.reset();
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(false);
    });
  });

  it('supports dynamic success message via function', async () => {
    const mutationFn = vi.fn().mockResolvedValue({ name: 'Widget' });

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        messages: {
          success: (data: unknown) => `Created: ${(data as { name: string }).name}`,
        },
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(toastHandler.success).toHaveBeenCalledWith('Created: Widget');
  });

  it('does not show success toast when message is undefined', async () => {
    const mutationFn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(
      () => useMutationWithTransition({
        mutationFn,
        messages: {},
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(toastHandler.success).not.toHaveBeenCalled();
  });
});

// ============================================================================
// useMutationWithOptimistic
// ============================================================================

describe('useMutationWithOptimistic', () => {
  let queryClient: QueryClient;
  const toastHandler = { success: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureToast(toastHandler);
    queryClient = createTestQueryClient();
    toastHandler.success.mockClear();
    toastHandler.error.mockClear();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('applies optimistic update before mutation resolves', async () => {
    const listKey = ['items', 'list'];
    queryClient.setQueryData(listKey, { docs: [{ _id: '1', name: 'Old' }] });

    let resolve: (v: unknown) => void;
    const mutationFn = vi.fn().mockReturnValue(new Promise(r => { resolve = r; }));

    const { result } = renderHook(
      () => useMutationWithOptimistic({
        mutationFn,
        queryKeys: [listKey],
        optimisticUpdate: (old, variables) => {
          const d = old as { docs: unknown[] };
          return { docs: [...d.docs, variables] };
        },
        messages: { success: 'Added' },
      }),
      { wrapper: createWrapper(queryClient) }
    );

    let promise: Promise<unknown>;
    act(() => {
      promise = result.current.mutateAsync({ _id: '2', name: 'New' }).catch(() => {});
    });

    // Optimistic update should be applied immediately
    await waitFor(() => {
      const data = queryClient.getQueryData(listKey) as { docs: unknown[] };
      expect(data.docs).toHaveLength(2);
    });

    await act(async () => {
      resolve!({ _id: '2', name: 'New' });
      await promise;
    });
  });

  it('rolls back optimistic update on error', async () => {
    const listKey = ['items', 'list'];
    const original = { docs: [{ _id: '1', name: 'Item 1' }] };
    queryClient.setQueryData(listKey, original);

    const mutationFn = vi.fn().mockRejectedValue(new Error('Server error'));

    const { result } = renderHook(
      () => useMutationWithOptimistic({
        mutationFn,
        queryKeys: [listKey],
        optimisticUpdate: (old) => {
          const d = old as { docs: unknown[] };
          return { docs: [...d.docs, { _id: '2', name: 'Optimistic' }] };
        },
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      try {
        await result.current.mutateAsync({});
      } catch {}
    });

    // Should be rolled back to original
    const data = queryClient.getQueryData(listKey) as { docs: unknown[] };
    expect(data.docs).toHaveLength(1);
    expect(data.docs[0]).toEqual({ _id: '1', name: 'Item 1' });
  });

  it('cancels in-flight queries before optimistic update', async () => {
    const listKey = ['items', 'list'];
    queryClient.setQueryData(listKey, { docs: [] });
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries');

    const mutationFn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(
      () => useMutationWithOptimistic({
        mutationFn,
        queryKeys: [listKey],
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: listKey });
  });

  it('invalidates queries on success', async () => {
    const listKey = ['items', 'list'];
    queryClient.setQueryData(listKey, { docs: [] });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    const mutationFn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(
      () => useMutationWithOptimistic({
        mutationFn,
        queryKeys: [listKey],
        messages: { success: 'OK' },
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: listKey });
  });

  it('shows error toast with default message on failure', async () => {
    const mutationFn = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const { result } = renderHook(
      () => useMutationWithOptimistic({ mutationFn }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      try {
        await result.current.mutateAsync({});
      } catch {}
    });

    expect(toastHandler.error).toHaveBeenCalledWith('Connection refused');
  });

  it('works without optimisticUpdate (just invalidates)', async () => {
    const listKey = ['items', 'list'];
    const original = { docs: [{ _id: '1' }] };
    queryClient.setQueryData(listKey, original);

    const mutationFn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(
      () => useMutationWithOptimistic({
        mutationFn,
        queryKeys: [listKey],
        messages: { success: 'Done' },
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    // Data unchanged (no optimistic update), but invalidation triggered
    expect(toastHandler.success).toHaveBeenCalledWith('Done');
  });

  it('handles multiple query keys', async () => {
    const listKey = ['items', 'list'];
    const detailKey = ['items', 'detail', '1'];
    queryClient.setQueryData(listKey, { docs: [] });
    queryClient.setQueryData(detailKey, { data: { _id: '1' } });
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries');

    const mutationFn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(
      () => useMutationWithOptimistic({
        mutationFn,
        queryKeys: [listKey, detailKey],
      }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: listKey });
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: detailKey });
  });
});
