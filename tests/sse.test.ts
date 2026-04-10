import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useEventStream } from '../src/sse.js';
import { configureClient, configureAuth } from '../src/client.js';

// ============================================================================
// Test setup
// ============================================================================

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
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

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  closed = false;

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    MockEventSource.instances.push(this);

    // Auto-connect after microtask
    queueMicrotask(() => {
      if (!this.closed) {
        this.readyState = 1;
        this.onopen?.(new Event('open'));
      }
    });
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', {
      data: JSON.stringify(data),
    }));
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }

  static reset() {
    MockEventSource.instances = [];
  }

  static latest(): MockEventSource | undefined {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('useEventStream', () => {
  let queryClient: QueryClient;

  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    MockEventSource.reset();
    // Assign directly — vi.stubGlobal can be flaky in jsdom for EventSource
    (globalThis as Record<string, unknown>).EventSource = MockEventSource;
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'test-token', getOrgId: () => 'org-1' });
    queryClient = createTestQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
    if (originalEventSource) {
      (globalThis as Record<string, unknown>).EventSource = originalEventSource;
    } else {
      delete (globalThis as Record<string, unknown>).EventSource;
    }
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('connects to SSE endpoint on mount', async () => {
    const wrapper = createWrapper(queryClient);

    renderHook(
      () => useEventStream({ resource: 'agents' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const es = MockEventSource.latest()!;
    expect(es.url).toContain('http://api.test/events/stream');
    expect(es.url).toContain('token=test-token');
    expect(es.url).toContain('organizationId=org-1');
  });

  it('reports connected state after open', async () => {
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({ resource: 'agents' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });
  });

  it('uses custom url when provided', async () => {
    const wrapper = createWrapper(queryClient);

    renderHook(
      () => useEventStream({ url: '/custom/stream' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    expect(MockEventSource.latest()!.url).toBe('/custom/stream');
  });

  it('includes patterns in URL', async () => {
    const wrapper = createWrapper(queryClient);

    renderHook(
      () => useEventStream({
        resource: 'agents',
        patterns: ['agents.created', 'agents.updated'],
      }),
      { wrapper }
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    expect(MockEventSource.latest()!.url).toContain('patterns=agents.created%2Cagents.updated');
  });

  it('calls onEvent callback when message is received', async () => {
    const onEvent = vi.fn();
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({ resource: 'agents', onEvent }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    const es = MockEventSource.latest()!;
    act(() => {
      es.simulateMessage({
        type: 'agents.created',
        resource: 'agents',
        data: { _id: '1', name: 'New Agent' },
        timestamp: '2024-01-01T00:00:00Z',
      });
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agents.created',
        resource: 'agents',
      })
    );
  });

  it('increments eventCount on each message', async () => {
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({ resource: 'agents' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    const es = MockEventSource.latest()!;
    act(() => {
      es.simulateMessage({ type: 'agents.created', resource: 'agents', data: {}, timestamp: '' });
    });

    expect(result.current.eventCount).toBe(1);

    act(() => {
      es.simulateMessage({ type: 'agents.updated', resource: 'agents', data: {}, timestamp: '' });
    });

    expect(result.current.eventCount).toBe(2);
  });

  it('invalidates queries on event', async () => {
    const listKey = ['agents', 'list'];
    queryClient.setQueryData(listKey, { docs: [] });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({
        resource: 'agents',
        invalidateQueries: [listKey],
      }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    act(() => {
      MockEventSource.latest()!.simulateMessage({
        type: 'agents.created',
        resource: 'agents',
        data: {},
        timestamp: '',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: listKey })
    );
  });

  it('filters by patterns when specified', async () => {
    const onEvent = vi.fn();
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({
        resource: 'agents',
        patterns: ['agents.created'],
        onEvent,
      }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    const es = MockEventSource.latest()!;

    act(() => {
      es.simulateMessage({ type: 'agents.created', resource: 'agents', data: {}, timestamp: '' });
    });

    expect(onEvent).toHaveBeenCalledTimes(1);

    // Non-matching pattern — should be filtered
    act(() => {
      es.simulateMessage({ type: 'agents.deleted', resource: 'agents', data: {}, timestamp: '' });
    });

    expect(onEvent).toHaveBeenCalledTimes(1); // Still 1
  });

  it('does not connect when enabled is false', async () => {
    const wrapper = createWrapper(queryClient);

    renderHook(
      () => useEventStream({ resource: 'agents', enabled: false }),
      { wrapper }
    );

    // Wait a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('closes connection on unmount', async () => {
    const wrapper = createWrapper(queryClient);

    const { result, unmount } = renderHook(
      () => useEventStream({ resource: 'agents' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    const es = MockEventSource.latest()!;
    unmount();

    expect(es.closed).toBe(true);
  });

  it('close() manually disconnects and reports state', async () => {
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({ resource: 'agents' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    act(() => {
      result.current.close();
    });

    expect(result.current.isConnected).toBe(false);
  });

  it('calls onConnectionChange on connect/disconnect', async () => {
    const onConnectionChange = vi.fn();
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({ resource: 'agents', onConnectionChange }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    expect(onConnectionChange).toHaveBeenCalledWith(true);

    act(() => {
      result.current.close();
    });

    expect(onConnectionChange).toHaveBeenCalledWith(false);
  });

  it('passes withCredentials for cookie auth', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });

    const wrapper = createWrapper(queryClient);

    renderHook(
      () => useEventStream({ resource: 'agents' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    expect(MockEventSource.latest()!.withCredentials).toBe(true);
  });

  it('uses custom basePath', async () => {
    const wrapper = createWrapper(queryClient);

    renderHook(
      () => useEventStream({ resource: 'agents', path: '/api/v2/events/stream' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    expect(MockEventSource.latest()!.url).toContain('http://api.test/api/v2/events/stream');
  });

  it('stores lastEvent from most recent message', async () => {
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({ resource: 'agents' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    expect(result.current.lastEvent).toBeNull();

    const event = { type: 'agents.created', resource: 'agents', data: { _id: '1' }, timestamp: '2024-01-01' };
    act(() => {
      MockEventSource.latest()!.simulateMessage(event);
    });

    expect(result.current.lastEvent).toEqual(event);
  });

  it('reconnect() after close() creates new connection', async () => {
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({ resource: 'agents' }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    const firstEs = MockEventSource.latest()!;

    // Close
    act(() => result.current.close());
    expect(result.current.isConnected).toBe(false);

    // Reconnect
    act(() => result.current.reconnect());

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });

    // Should be a NEW EventSource instance
    const secondEs = MockEventSource.latest()!;
    expect(secondEs).not.toBe(firstEs);
    expect(secondEs.url).toContain('http://api.test/events/stream');
  });

  it('events after reconnect still trigger callbacks', async () => {
    const onEvent = vi.fn();
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(
      () => useEventStream({ resource: 'agents', onEvent }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));

    // Close and reconnect
    act(() => result.current.close());
    act(() => result.current.reconnect());

    await waitFor(() => expect(result.current.isConnected).toBe(true));

    // Send event on new connection
    act(() => {
      MockEventSource.latest()!.simulateMessage({
        type: 'agents.created', resource: 'agents', data: { _id: '99' }, timestamp: '',
      });
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agents.created' })
    );
  });
});
