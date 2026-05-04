/**
 * v0.5.0 — real-time SDK additions:
 *   - subscribeToEvents() plain function (non-React SSE consumer)
 *   - connectWs() plain function with .on() listener API (non-React WS consumer)
 *   - useResourceSync() KEYS-aware auto-invalidation hook
 *   - CrudEvent<TDoc> generic type
 *
 * Existing useEventStream / useWebSocket regressions are covered by sse.test.ts /
 * ws.test.tsx — those hooks now delegate to the plain functions but the tests still pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  subscribeToEvents,
  type ArcServerEvent,
  type CrudEvent,
  type CrudOperation,
} from '../src/sse.js';
import { connectWs, type ArcWsMessage } from '../src/ws.js';
import { configureClient, configureAuth } from '../src/client.js';
import { createCrudHooks } from '../src/hooks.js';
import { createCrudApi } from '../src/api.js';

// ============================================================================
// Shared test infra
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

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  namedListeners = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    MockEventSource.instances.push(this);
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.(new Event('open'));
    });
  }
  close() { this.closed = true; }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    const list = this.namedListeners.get(type) ?? [];
    list.push(listener);
    this.namedListeners.set(type, list);
  }
  removeEventListener() { /* noop for tests */ }
  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
  simulateNamedEvent(type: string, payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const evt = new MessageEvent(type, { data });
    for (const l of this.namedListeners.get(type) ?? []) l(evt);
  }
  simulateError() { this.onerror?.(new Event('error')); }
  static reset() { MockEventSource.instances = []; }
  static latest() { return MockEventSource.instances[MockEventSource.instances.length - 1]; }
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  url: string;
  protocols?: string | string[];
  readyState = MockWebSocket.CONNECTING;
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
  inject(payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.(new MessageEvent('message', { data }));
  }
  static reset() { MockWebSocket.instances = []; }
  static latest() { return MockWebSocket.instances[MockWebSocket.instances.length - 1]!; }
}

// ============================================================================
// subscribeToEvents() — plain function, non-React
// ============================================================================

describe('subscribeToEvents (plain function)', () => {
  const originalES = globalThis.EventSource;

  beforeEach(() => {
    MockEventSource.reset();
    (globalThis as Record<string, unknown>).EventSource = MockEventSource;
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  afterEach(() => {
    if (originalES) (globalThis as Record<string, unknown>).EventSource = originalES;
    else delete (globalThis as Record<string, unknown>).EventSource;
  });

  it('opens an EventSource against the ssePlugin path with derived patterns', async () => {
    subscribeToEvents({ resource: 'todo' });

    expect(MockEventSource.instances).toHaveLength(1);
    const url = MockEventSource.latest()!.url;
    expect(url).toContain('http://api.test/events/stream');
    expect(url).toContain('patterns=todo.*');
  });

  it('exposes isConnected() — false before open, true after', async () => {
    const sub = subscribeToEvents({ resource: 'todo' });
    expect(sub.isConnected()).toBe(false);

    await new Promise<void>((r) => queueMicrotask(r));
    expect(sub.isConnected()).toBe(true);
  });

  it('forwards parsed JSON to onEvent on the message channel', async () => {
    const events: ArcServerEvent[] = [];
    subscribeToEvents({ resource: 'todo', onEvent: (e) => events.push(e) });
    await new Promise<void>((r) => queueMicrotask(r));

    MockEventSource.latest()!.simulateMessage({
      type: 'todo.created',
      resource: 'todo',
      data: { _id: 't1', title: 'a' },
      timestamp: '2026-01-01T00:00:00Z',
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('todo.created');
  });

  it('subscribes to derived named events for the resource', async () => {
    const events: ArcServerEvent[] = [];
    subscribeToEvents({ resource: 'todo', onEvent: (e) => events.push(e) });
    await new Promise<void>((r) => queueMicrotask(r));

    // Arc emits `event: todo.created\ndata: <doc>` style frames.
    MockEventSource.latest()!.simulateNamedEvent('todo.created', { _id: 't1', title: 'a' });
    MockEventSource.latest()!.simulateNamedEvent('todo.updated', { _id: 't1', title: 'b' });
    MockEventSource.latest()!.simulateNamedEvent('todo.deleted', { _id: 't1' });

    expect(events.map((e) => e.type)).toEqual([
      'todo.created',
      'todo.updated',
      'todo.deleted',
    ]);
  });

  it('honors explicit eventTypes: [] (opt out of named subscription)', async () => {
    const events: ArcServerEvent[] = [];
    subscribeToEvents({ resource: 'todo', eventTypes: [], onEvent: (e) => events.push(e) });
    await new Promise<void>((r) => queueMicrotask(r));

    // No named listeners should be attached.
    expect(MockEventSource.latest()!.namedListeners.size).toBe(0);
  });

  it('filters by patterns when set', async () => {
    const events: ArcServerEvent[] = [];
    subscribeToEvents({
      patterns: ['todo.created'], // only created
      onEvent: (e) => events.push(e),
    });
    await new Promise<void>((r) => queueMicrotask(r));

    MockEventSource.latest()!.simulateMessage({
      type: 'todo.created', resource: 'todo', data: {}, timestamp: '',
    });
    MockEventSource.latest()!.simulateMessage({
      type: 'todo.updated', resource: 'todo', data: {}, timestamp: '',
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('todo.created');
  });

  it('fires onConnectionChange(true) on open and (false) on close()', async () => {
    const states: boolean[] = [];
    const sub = subscribeToEvents({
      resource: 'todo',
      onConnectionChange: (c) => states.push(c),
    });
    await new Promise<void>((r) => queueMicrotask(r));
    sub.close();

    expect(states).toEqual([true, false]);
  });

  it('does NOT auto-reconnect after manual close()', async () => {
    const sub = subscribeToEvents({ resource: 'todo', reconnectDelay: 1 });
    await new Promise<void>((r) => queueMicrotask(r));
    sub.close();

    // Simulating an error after a manual close must not re-open.
    MockEventSource.latest()!.simulateError();
    await new Promise<void>((r) => setTimeout(r, 10));

    // Only one EventSource instance ever opened.
    expect(MockEventSource.instances.length).toBe(1);
  });

  it('reconnect() opens a fresh EventSource', async () => {
    const sub = subscribeToEvents({ resource: 'todo' });
    await new Promise<void>((r) => queueMicrotask(r));
    sub.close();
    sub.reconnect();
    await new Promise<void>((r) => queueMicrotask(r));

    expect(MockEventSource.instances.length).toBe(2);
    expect(sub.isConnected()).toBe(true);
  });

  it('CrudEvent<TDoc> narrows data via the generic parameter (compile-time)', () => {
    // Compile-only: this test exists to fail the build if the generic regresses.
    const e: CrudEvent<{ title: string }> = {
      type: 'todo.created',
      resource: 'todo',
      operation: 'created',
      data: { title: 'x' },
      timestamp: '2026-01-01',
    };
    const op: CrudOperation = e.operation;
    expect(e.data.title).toBe('x');
    expect(op).toBe('created');
  });
});

// ============================================================================
// connectWs() — plain function, non-React
// ============================================================================

describe('connectWs (plain function)', () => {
  const originalWs = (globalThis as Record<string, unknown>).WebSocket;

  beforeEach(() => {
    MockWebSocket.reset();
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  afterEach(() => {
    if (originalWs) (globalThis as Record<string, unknown>).WebSocket = originalWs;
    else delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it('opens a WebSocket against ws://<base>/ws and sends subscribe handshakes on open', async () => {
    connectWs({ subscribe: ['todo'] });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.latest().url).toBe('ws://api.test/ws');

    await new Promise<void>((r) => queueMicrotask(r));
    expect(MockWebSocket.latest().sent).toContain(JSON.stringify({ type: 'subscribe', resource: 'todo' }));
  });

  it('isConnected() flips after onopen fires', async () => {
    const ws = connectWs({});
    expect(ws.isConnected()).toBe(false);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ws.isConnected()).toBe(true);
  });

  it('onMessage receives parsed JSON; pattern filter applies', async () => {
    const messages: ArcWsMessage[] = [];
    connectWs({
      patterns: ['todo.'], // prefix match
      onMessage: (m) => messages.push(m),
    });
    await new Promise<void>((r) => queueMicrotask(r));

    MockWebSocket.latest().inject({ type: 'todo.created', data: { _id: 't1' } });
    MockWebSocket.latest().inject({ type: 'system.log', data: 'noise' });
    MockWebSocket.latest().inject({ type: 'todo.deleted', data: { _id: 't2' } });

    expect(messages.map((m) => m.type)).toEqual(['todo.created', 'todo.deleted']);
  });

  it('on(eventType, handler) fires only for that exact type and is unsubscribable', async () => {
    const created: ArcWsMessage[] = [];
    const updated: ArcWsMessage[] = [];

    const ws = connectWs<{ _id: string }>({});
    await new Promise<void>((r) => queueMicrotask(r));

    const offCreated = ws.on('todo.created', (m) => created.push(m));
    ws.on('todo.updated', (m) => updated.push(m));

    MockWebSocket.latest().inject({ type: 'todo.created', data: { _id: 't1' } });
    MockWebSocket.latest().inject({ type: 'todo.updated', data: { _id: 't1' } });
    MockWebSocket.latest().inject({ type: 'todo.created', data: { _id: 't2' } });

    expect(created).toHaveLength(2);
    expect(updated).toHaveLength(1);

    offCreated();
    MockWebSocket.latest().inject({ type: 'todo.created', data: { _id: 't3' } });
    expect(created).toHaveLength(2); // listener removed
  });

  it('on("*", handler) catches every message after pattern filtering', async () => {
    const all: ArcWsMessage[] = [];
    const ws = connectWs({});
    await new Promise<void>((r) => queueMicrotask(r));
    ws.on('*', (m) => all.push(m));

    MockWebSocket.latest().inject({ type: 'todo.created', data: 1 });
    MockWebSocket.latest().inject({ type: 'system.ping' });
    expect(all).toHaveLength(2);
  });

  it('subscribe() / unsubscribe() send proper frames; subscriptions persist across reconnect', async () => {
    const ws = connectWs({});
    await new Promise<void>((r) => queueMicrotask(r));

    ws.subscribe('todo');
    ws.subscribe('order');
    expect(MockWebSocket.latest().sent).toEqual([
      JSON.stringify({ type: 'subscribe', resource: 'todo' }),
      JSON.stringify({ type: 'subscribe', resource: 'order' }),
    ]);

    ws.unsubscribe('order');
    expect(MockWebSocket.latest().sent.at(-1)).toBe(
      JSON.stringify({ type: 'unsubscribe', resource: 'order' }),
    );

    // Reconnect — replays remaining subscriptions.
    ws.reconnect();
    await new Promise<void>((r) => queueMicrotask(r));
    expect(MockWebSocket.latest().sent).toContain(JSON.stringify({ type: 'subscribe', resource: 'todo' }));
    expect(MockWebSocket.latest().sent).not.toContain(JSON.stringify({ type: 'subscribe', resource: 'order' }));
  });

  it('send() returns false before OPEN and true after', async () => {
    const ws = connectWs({});
    expect(ws.send({ hi: 1 })).toBe(false);

    await new Promise<void>((r) => queueMicrotask(r));
    expect(ws.send({ hi: 1 })).toBe(true);
    expect(MockWebSocket.latest().sent.at(-1)).toBe(JSON.stringify({ hi: 1 }));
  });

  it('does NOT auto-reconnect after manual close()', async () => {
    const ws = connectWs({ reconnectDelay: 1 });
    await new Promise<void>((r) => queueMicrotask(r));
    ws.close();

    await new Promise<void>((r) => setTimeout(r, 10));
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('honors heartbeatInterval — sends {type:"ping"} periodically', async () => {
    vi.useFakeTimers();
    try {
      const ws = connectWs({ heartbeatInterval: 50 });
      // Drain microtasks so onopen fires.
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(160); // ≥ 3 ticks
      const pings = MockWebSocket.latest().sent.filter((s) => s === JSON.stringify({ type: 'ping' }));
      expect(pings.length).toBeGreaterThanOrEqual(3);
      ws.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ============================================================================
// useResourceSync — KEYS-aware auto-invalidation
// ============================================================================

describe('useResourceSync (WS source)', () => {
  let queryClient: QueryClient;
  const originalWs = (globalThis as Record<string, unknown>).WebSocket;

  beforeEach(() => {
    MockWebSocket.reset();
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });
    queryClient = createTestQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
    if (originalWs) (globalThis as Record<string, unknown>).WebSocket = originalWs;
    else delete (globalThis as Record<string, unknown>).WebSocket;
  });

  function buildHooks() {
    const api = createCrudApi<{ _id: string; title: string }>('todo', { basePath: '' });
    return createCrudHooks({ api, entityKey: 'todo', singular: 'todo' });
  }

  it('subscribes to entityKey on mount and reports isConnected', async () => {
    const { useResourceSync } = buildHooks();
    const wrapper = createWrapper(queryClient);

    const { result } = renderHook(() => useResourceSync(), { wrapper });
    expect(result.current.isConnected).toBe(false);

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });
    // Subscribe handshake sent.
    expect(MockWebSocket.latest().sent).toContain(
      JSON.stringify({ type: 'subscribe', resource: 'todo' }),
    );
  });

  it('invalidates KEYS.lists() on todo.created broadcast', async () => {
    const { KEYS, useResourceSync } = buildHooks();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = createWrapper(queryClient);

    renderHook(() => useResourceSync(), { wrapper });
    await new Promise<void>((r) => queueMicrotask(r));

    act(() => {
      MockWebSocket.latest().inject({
        type: 'todo.created',
        data: { resource: 'todo', operation: 'created', data: { _id: 't1', title: 'x' }, timestamp: '' },
      });
    });

    const calls = spy.mock.calls.map(([arg]) => arg);
    expect(calls).toContainEqual({ queryKey: KEYS.lists() });
  });

  it('invalidates KEYS.detail(id) on todo.updated', async () => {
    const { KEYS, useResourceSync } = buildHooks();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = createWrapper(queryClient);

    renderHook(() => useResourceSync(), { wrapper });
    await new Promise<void>((r) => queueMicrotask(r));

    act(() => {
      MockWebSocket.latest().inject({
        type: 'todo.updated',
        data: { resource: 'todo', operation: 'updated', data: { _id: 't42', title: 'y' }, timestamp: '' },
      });
    });

    const calls = spy.mock.calls.map(([arg]) => arg);
    expect(calls).toContainEqual({ queryKey: KEYS.detail('t42') });
    expect(calls).toContainEqual({ queryKey: KEYS.lists() });
  });

  it('invalidates lists + detail on todo.deleted', async () => {
    const { KEYS, useResourceSync } = buildHooks();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = createWrapper(queryClient);

    renderHook(() => useResourceSync(), { wrapper });
    await new Promise<void>((r) => queueMicrotask(r));

    act(() => {
      MockWebSocket.latest().inject({
        type: 'todo.deleted',
        data: { resource: 'todo', operation: 'deleted', data: { _id: 't9' }, timestamp: '' },
      });
    });

    const keys = spy.mock.calls.map(([arg]) => (arg as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(KEYS.lists());
    expect(keys).toContainEqual(KEYS.detail('t9'));
  });

  it('invalidates KEYS.aggregations() on every CRUD broadcast (dashboard freshness)', async () => {
    const { KEYS, useResourceSync } = buildHooks();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = createWrapper(queryClient);

    renderHook(() => useResourceSync(), { wrapper });
    await new Promise<void>((r) => queueMicrotask(r));

    // Created event — should invalidate aggregations.
    act(() => {
      MockWebSocket.latest().inject({
        type: 'todo.created',
        data: { resource: 'todo', operation: 'created', data: { _id: 'a1' }, timestamp: '' },
      });
    });
    let keys = spy.mock.calls.map(([arg]) => (arg as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(KEYS.aggregations());

    // Reset and try updated.
    spy.mockClear();
    act(() => {
      MockWebSocket.latest().inject({
        type: 'todo.updated',
        data: { resource: 'todo', operation: 'updated', data: { _id: 'a2' }, timestamp: '' },
      });
    });
    keys = spy.mock.calls.map(([arg]) => (arg as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(KEYS.aggregations());

    // Reset and try deleted.
    spy.mockClear();
    act(() => {
      MockWebSocket.latest().inject({
        type: 'todo.deleted',
        data: { resource: 'todo', operation: 'deleted', data: { _id: 'a3' }, timestamp: '' },
      });
    });
    keys = spy.mock.calls.map(([arg]) => (arg as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(KEYS.aggregations());
  });

  it('forwards parsed event to onEvent callback (operation + id + data)', async () => {
    const { useResourceSync } = buildHooks();
    const seen: Array<{ operation: string; id?: string }> = [];
    const wrapper = createWrapper(queryClient);

    renderHook(
      () => useResourceSync({ onEvent: (e) => seen.push({ operation: e.operation, id: e.id }) }),
      { wrapper },
    );
    await new Promise<void>((r) => queueMicrotask(r));

    act(() => {
      MockWebSocket.latest().inject({
        type: 'todo.updated',
        data: { resource: 'todo', operation: 'updated', data: { _id: 't1' }, timestamp: '' },
      });
      MockWebSocket.latest().inject({
        type: 'todo.deleted',
        data: { resource: 'todo', operation: 'deleted', data: { _id: 't2' }, timestamp: '' },
      });
    });

    expect(seen).toEqual([
      { operation: 'updated', id: 't1' },
      { operation: 'deleted', id: 't2' },
    ]);
  });

  it('ignores non-CRUD broadcast types (system.log, etc.)', async () => {
    const { useResourceSync } = buildHooks();
    const seen: Array<{ operation: string }> = [];
    const wrapper = createWrapper(queryClient);

    renderHook(() => useResourceSync({ onEvent: (e) => seen.push({ operation: e.operation }) }), { wrapper });
    await new Promise<void>((r) => queueMicrotask(r));

    act(() => {
      // type doesn't end in .created|.updated|.deleted
      MockWebSocket.latest().inject({ type: 'todo.exported', data: {} });
    });
    expect(seen).toHaveLength(0);
  });

  it('honors `resource` override (subscribe to a different channel)', async () => {
    const { useResourceSync } = buildHooks();
    const wrapper = createWrapper(queryClient);

    renderHook(() => useResourceSync({ resource: 'order' }), { wrapper });
    await new Promise<void>((r) => queueMicrotask(r));

    expect(MockWebSocket.latest().sent).toContain(
      JSON.stringify({ type: 'subscribe', resource: 'order' }),
    );
    expect(MockWebSocket.latest().sent).not.toContain(
      JSON.stringify({ type: 'subscribe', resource: 'todo' }),
    );
  });

  it('enabled: false skips connection entirely', async () => {
    const { useResourceSync } = buildHooks();
    const wrapper = createWrapper(queryClient);

    renderHook(() => useResourceSync({ enabled: false }), { wrapper });
    await new Promise<void>((r) => queueMicrotask(r));

    expect(MockWebSocket.instances.length).toBe(0);
  });

  it('respects custom idField when extracting the id from broadcasts', async () => {
    const api = createCrudApi<{ sku: string }>('product', { basePath: '' });
    const { KEYS, useResourceSync } = createCrudHooks({
      api,
      entityKey: 'product',
      singular: 'product',
      idField: 'sku',
    });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = createWrapper(queryClient);

    renderHook(() => useResourceSync(), { wrapper });
    await new Promise<void>((r) => queueMicrotask(r));

    act(() => {
      MockWebSocket.latest().inject({
        type: 'product.updated',
        data: { resource: 'product', operation: 'updated', data: { sku: 'ABC-123' }, timestamp: '' },
      });
    });

    const keys = spy.mock.calls.map(([arg]) => (arg as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(KEYS.detail('ABC-123'));
  });
});

describe('useResourceSync (SSE source)', () => {
  let queryClient: QueryClient;
  const originalES = globalThis.EventSource;

  beforeEach(() => {
    MockEventSource.reset();
    (globalThis as Record<string, unknown>).EventSource = MockEventSource;
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });
    queryClient = createTestQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
    if (originalES) (globalThis as Record<string, unknown>).EventSource = originalES;
    else delete (globalThis as Record<string, unknown>).EventSource;
  });

  it('subscribes via SSE and invalidates lists + detail on named CrudEvent', async () => {
    const api = createCrudApi<{ _id: string }>('todo', { basePath: '' });
    const { KEYS, useResourceSync } = createCrudHooks({ api, entityKey: 'todo', singular: 'todo' });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = createWrapper(queryClient);

    renderHook(() => useResourceSync({ source: 'sse' }), { wrapper });
    await new Promise<void>((r) => queueMicrotask(r));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.latest()!.url).toContain('/events/stream');

    // Arc emits named SSE frames `event: todo.updated\ndata: <doc>`.
    act(() => {
      MockEventSource.latest()!.simulateNamedEvent('todo.updated', { _id: 't1' });
    });

    const keys = spy.mock.calls.map(([arg]) => (arg as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(KEYS.lists());
    expect(keys).toContainEqual(KEYS.detail('t1'));
  });
});
