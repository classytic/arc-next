import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useWebSocket, buildWsUrl } from '../src/ws.js';
import { configureClient, configureAuth } from '../src/client.js';

// ============================================================================
// Test setup
// ============================================================================

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// Minimal MockWebSocket — mirrors the bits of the real API the hook touches.
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  protocols?: string | string[];
  readyState: number = MockWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);

    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event('open'));
      }
    });
  }

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('not open');
    this.sent.push(data);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  /** Simulate inbound JSON message. */
  inject(payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  static reset() { MockWebSocket.instances = []; }
  static latest() { return MockWebSocket.instances[MockWebSocket.instances.length - 1]; }
}

// ============================================================================
// useWebSocket
// ============================================================================

describe('useWebSocket', () => {
  let queryClient: QueryClient;
  const originalWs = (globalThis as Record<string, unknown>).WebSocket;

  beforeEach(() => {
    MockWebSocket.reset();
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'tok-1', getOrgId: () => 'org-1' });
    queryClient = createTestQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
    if (originalWs) (globalThis as Record<string, unknown>).WebSocket = originalWs;
    else delete (globalThis as Record<string, unknown>).WebSocket;
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('connects to ws://<baseUrl>/ws by default', async () => {
    renderHook(() => useWebSocket({}), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));

    const ws = MockWebSocket.latest()!;
    expect(ws.url.startsWith('ws://api.test/ws')).toBe(true);
    expect(ws.url).toContain('token=tok-1');
    expect(ws.url).toContain('organizationId=org-1');
  });

  it('uses wss:// when baseUrl is https', async () => {
    configureClient({ baseUrl: 'https://api.test' });
    renderHook(() => useWebSocket({}), { wrapper: createWrapper(queryClient) });

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    expect(MockWebSocket.latest()!.url.startsWith('wss://api.test/ws')).toBe(true);
  });

  it('reports isConnected after open', async () => {
    const { result } = renderHook(
      () => useWebSocket({}),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));
  });

  it('auto-sends subscribe frames for `subscribe` array on open', async () => {
    renderHook(
      () => useWebSocket({ subscribe: ['todo', 'product'] }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(MockWebSocket.latest()?.readyState).toBe(MockWebSocket.OPEN));

    const ws = MockWebSocket.latest()!;
    expect(ws.sent).toContain(JSON.stringify({ type: 'subscribe', resource: 'todo' }));
    expect(ws.sent).toContain(JSON.stringify({ type: 'subscribe', resource: 'product' }));
  });

  it('routes inbound messages to onMessage', async () => {
    const onMessage = vi.fn();
    const { result } = renderHook(
      () => useWebSocket({ onMessage }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => {
      MockWebSocket.latest()!.inject({ type: 'todo.created', data: { _id: 'a' } });
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'todo.created', data: { _id: 'a' } }),
    );
    expect(result.current.messageCount).toBe(1);
    expect(result.current.lastMessage?.type).toBe('todo.created');
  });

  it('filters by patterns (exact and prefix)', async () => {
    const onMessage = vi.fn();
    const { result } = renderHook(
      () => useWebSocket({ patterns: ['todo.', 'order.completed'], onMessage }),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    const ws = MockWebSocket.latest()!;

    act(() => ws.inject({ type: 'todo.created' }));
    act(() => ws.inject({ type: 'product.created' })); // no prefix match
    act(() => ws.inject({ type: 'order.completed' })); // exact match
    act(() => ws.inject({ type: 'order.placed' }));    // does not match

    const types = onMessage.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(['todo.created', 'order.completed']);
  });

  it('invalidates query keys on every received message', async () => {
    const listKey = ['todo', 'list'];
    queryClient.setQueryData(listKey, { data: [] });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(
      () => useWebSocket({ subscribe: ['todo'], invalidateQueries: [listKey] }),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => MockWebSocket.latest()!.inject({ type: 'todo.created', data: { _id: '1' } }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: listKey }));
  });

  it('send() returns false when not connected', () => {
    const { result } = renderHook(
      () => useWebSocket({ enabled: false }),
      { wrapper: createWrapper(queryClient) },
    );
    expect(result.current.send({ ping: 1 })).toBe(false);
  });

  it('send() serializes JSON when connected', async () => {
    const { result } = renderHook(
      () => useWebSocket({}),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => {
      const ok = result.current.send({ type: 'chat.message', text: 'hi' });
      expect(ok).toBe(true);
    });

    expect(MockWebSocket.latest()!.sent).toContain(
      JSON.stringify({ type: 'chat.message', text: 'hi' }),
    );
  });

  it('subscribe() persists across reconnects', async () => {
    const { result } = renderHook(
      () => useWebSocket({}),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => result.current.subscribe('chat'));
    const first = MockWebSocket.latest()!;
    expect(first.sent).toContain(JSON.stringify({ type: 'subscribe', resource: 'chat' }));

    // Force reconnect
    act(() => result.current.close());
    act(() => result.current.reconnect());
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    const second = MockWebSocket.latest()!;
    expect(second).not.toBe(first);
    expect(second.sent).toContain(JSON.stringify({ type: 'subscribe', resource: 'chat' }));
  });

  it('unsubscribe() removes resource from replay set + sends frame', async () => {
    const { result } = renderHook(
      () => useWebSocket({ subscribe: ['todo'] }),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    const first = MockWebSocket.latest()!;
    expect(first.sent).toContain(JSON.stringify({ type: 'subscribe', resource: 'todo' }));

    act(() => result.current.unsubscribe('todo'));
    expect(first.sent).toContain(JSON.stringify({ type: 'unsubscribe', resource: 'todo' }));

    // After reconnect, todo subscription should NOT be replayed.
    act(() => result.current.close());
    act(() => result.current.reconnect());
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(2));
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    const second = MockWebSocket.latest()!;
    const subscribeFrames = second.sent.filter((s) => s.includes('"subscribe"'));
    expect(subscribeFrames).toHaveLength(0);
  });

  it('does not connect when enabled: false', async () => {
    renderHook(
      () => useWebSocket({ enabled: false }),
      { wrapper: createWrapper(queryClient) },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('non-JSON inbound message is wrapped as { type: "message", data }', async () => {
    const onMessage = vi.fn();
    const { result } = renderHook(
      () => useWebSocket({ onMessage }),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => {
      MockWebSocket.latest()!.onmessage?.(new MessageEvent('message', { data: 'plain text' }));
    });

    expect(onMessage).toHaveBeenCalledWith({ type: 'message', data: 'plain text' });
  });

  it('passes WebSocket subprotocols through', async () => {
    renderHook(
      () => useWebSocket({ protocols: ['arc-v1'] }),
      { wrapper: createWrapper(queryClient) },
    );
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    expect(MockWebSocket.latest()!.protocols).toEqual(['arc-v1']);
  });
});

// ============================================================================
// buildWsUrl
// ============================================================================

describe('buildWsUrl', () => {
  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'tok-99', getOrgId: () => 'org-Z' });
  });

  afterEach(() => configureAuth({ getToken: () => null, getOrgId: () => null }));

  it('converts http://… to ws://…', () => {
    expect(buildWsUrl('/ws').startsWith('ws://api.test/ws')).toBe(true);
  });

  it('converts https://… to wss://…', () => {
    configureClient({ baseUrl: 'https://api.test' });
    expect(buildWsUrl('/ws').startsWith('wss://api.test/ws')).toBe(true);
  });

  it('attaches token + organizationId in bearer mode', () => {
    const url = buildWsUrl('/ws');
    expect(url).toContain('token=tok-99');
    expect(url).toContain('organizationId=org-Z');
  });

  it('omits token in cookie mode', () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });
    const url = buildWsUrl('/ws');
    expect(url).not.toContain('token=');
    expect(url).toContain('organizationId=org-Z');
  });

  it('merges custom params alongside auth', () => {
    const url = buildWsUrl('/ws', { roomId: 'r-1' });
    expect(url).toContain('roomId=r-1');
    expect(url).toContain('token=tok-99');
  });

  it('caller params win over derived auth params', () => {
    const url = buildWsUrl('/ws', { token: 'override' });
    expect(url).toContain('token=override');
    expect(url).not.toContain('token=tok-99');
  });

  it('default path is /ws when omitted', () => {
    const url = buildWsUrl();
    expect(url).toContain('/ws');
  });

  it('emits clean URL with no query string when nothing to attach', () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });
    configureAuth({ getToken: () => null, getOrgId: () => null });
    expect(buildWsUrl('/ws')).toBe('ws://api.test/ws');
  });
});
