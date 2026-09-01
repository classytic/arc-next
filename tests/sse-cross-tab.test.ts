/**
 * `isConnected` means "this tab is receiving events", not "this tab owns a
 * socket".
 *
 * Consumers switch polling off on it (`refetchInterval: isConnected ? false :
 * …`), so a follower reporting `false` polls despite being live — which would
 * restore exactly the request load that sharing the connection removes.
 * A follower must also NOT assume `true`: if no leader is listening, polling is
 * the only thing keeping the UI current.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useEventStream } from '../src/sse.js';
import { configureClient, configureAuth } from '../src/client.js';

/** Minimal same-realm BroadcastChannel: delivers to peers, never to the sender. */
class FakeChannel {
  static peers = new Map<string, Set<FakeChannel>>();
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public name: string) {
    if (!FakeChannel.peers.has(name)) FakeChannel.peers.set(name, new Set());
    FakeChannel.peers.get(name)!.add(this);
  }
  postMessage(data: unknown) {
    for (const p of FakeChannel.peers.get(this.name) ?? []) {
      if (p !== this) p.onmessage?.({ data: structuredClone(data) });
    }
  }
  close() {
    FakeChannel.peers.get(this.name)?.delete(this);
  }
  static reset() {
    FakeChannel.peers.clear();
  }
}

class OpenEventSource {
  static instances: OpenEventSource[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  /** 0.15.1 subscribes to NAMED events via addEventListener, not just onmessage. */
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) {
    OpenEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  emit(type: string, payload: unknown) {
    const ev = new MessageEvent(type, { data: JSON.stringify(payload) });
    const named = this.listeners.get(type);
    if (named) named(ev);
    else this.onmessage?.(ev);
  }
  close() {}
  static reset() {
    OpenEventSource.instances = [];
  }
  static latest() {
    return OpenEventSource.instances[OpenEventSource.instances.length - 1];
  }
}

function wrapperFor(qc: QueryClient) {
  return function W({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('useEventStream — cross-tab connection state', () => {
  let qc: QueryClient;
  const origES = globalThis.EventSource;
  const origBC = globalThis.BroadcastChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    FakeChannel.reset();
    OpenEventSource.reset();
    (globalThis as Record<string, unknown>).EventSource = OpenEventSource;
    (globalThis as Record<string, unknown>).BroadcastChannel = FakeChannel;
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 't', getOrgId: () => 'o' });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
    qc.clear();
    localStorage.clear();
    if (origES) (globalThis as Record<string, unknown>).EventSource = origES;
    if (origBC) (globalThis as Record<string, unknown>).BroadcastChannel = origBC;
  });

  it('only the leader opens a socket', () => {
    renderHook(() => useEventStream({ resource: 'n' }), { wrapper: wrapperFor(qc) });
    renderHook(() => useEventStream({ resource: 'n' }), { wrapper: wrapperFor(qc) });

    expect(OpenEventSource.instances).toHaveLength(1);
  });

  it('a follower reports CONNECTED once the leader says it is', () => {
    const leader = renderHook(() => useEventStream({ resource: 'n' }), { wrapper: wrapperFor(qc) });
    const follower = renderHook(() => useEventStream({ resource: 'n' }), {
      wrapper: wrapperFor(qc),
    });

    expect(follower.result.current.isConnected).toBe(false);

    act(() => {
      OpenEventSource.latest().onopen?.(new Event('open'));
    });

    expect(leader.result.current.isConnected).toBe(true);
    expect(follower.result.current.isConnected).toBe(true);
  });

  it('a follower goes DISCONNECTED when the shared socket drops', () => {
    renderHook(() => useEventStream({ resource: 'n' }), { wrapper: wrapperFor(qc) });
    const follower = renderHook(() => useEventStream({ resource: 'n' }), {
      wrapper: wrapperFor(qc),
    });

    act(() => {
      OpenEventSource.latest().onopen?.(new Event('open'));
    });
    expect(follower.result.current.isConnected).toBe(true);

    act(() => {
      OpenEventSource.latest().onerror?.(new Event('error'));
    });
    expect(follower.result.current.isConnected).toBe(false);
  });

  it('a follower receives relayed events without its own socket', () => {
    renderHook(() => useEventStream({ resource: 'n' }), { wrapper: wrapperFor(qc) });
    const follower = renderHook(() => useEventStream({ resource: 'n' }), {
      wrapper: wrapperFor(qc),
    });

    act(() => {
      OpenEventSource.latest().emit('n.created', {
        type: 'n.created',
        resource: 'n',
        data: {},
        timestamp: 'x',
      });
    });

    expect(OpenEventSource.instances).toHaveLength(1);
    expect(follower.result.current.eventCount).toBe(1);
    expect(follower.result.current.lastEvent?.type).toBe('n.created');
  });
});
