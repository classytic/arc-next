/**
 * v0.4.1 Bugfix Tests — Independent test suite
 *
 * Each describe block tests a specific fix in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { configureClient, configureAuth, handleApiRequest, isArcApiError, createClient } from '../src/client.js';
import { createCrudApi } from '../src/api.js';
import { withSoftDelete } from '../src/presets/soft-delete.js';
import { withBulk } from '../src/presets/bulk.js';
import { createCrudHooks } from '../src/hooks.js';
import { configureToast } from '../src/mutation.js';
import { useEventStream } from '../src/sse.js';
import type { CrudApi } from '../src/hooks.js';

// ============================================================================
// Shared helpers
// ============================================================================

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

function createMockApi(): CrudApi<{ _id: string; name: string }, { name: string }, { name: string }> {
  return {
    getAll: vi.fn().mockResolvedValue({
      success: true, data: [{ _id: '1', name: 'Item' }],
      total: 1, page: 1, limit: 10, pages: 1, hasNext: false, hasPrev: false,
    }),
    getById: vi.fn().mockResolvedValue({ success: true, data: { _id: '1', name: 'Item' } }),
    create: vi.fn().mockResolvedValue({ success: true, data: { _id: '1', name: 'New' } }),
    update: vi.fn().mockResolvedValue({ success: true, data: { _id: '1', name: 'Updated' } }),
    delete: vi.fn().mockResolvedValue({ success: true }),
  };
}

// ============================================================================
// Fix #1: token defaults to null in mutation methods
// ============================================================================

describe('Fix #1: token optional in mutation methods', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { _id: '1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => { fetchMock.mockRestore(); });

  it('create() works without token', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    await api.create({ data: { name: 'Test' } });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('update() works without token', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    await api.update({ id: '1', data: { name: 'Updated' } });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('delete() works without token', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    await api.delete({ id: '1' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('upload() works without token', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    await api.upload({ data: new FormData() });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('request() works without token', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    await api.request('POST', '/api/items/custom', { data: { action: 'test' } });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('restore() works without token', async () => {
    const api = withSoftDelete(createCrudApi('items', { basePath: '/api' }));
    await api.restore({ id: '1' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('bulkCreate() works without token', async () => {
    const api = withBulk(createCrudApi('items', { basePath: '/api' }));
    await api.bulkCreate({ data: [{ name: 'A' }] });
    expect(fetchMock).toHaveBeenCalled();
  });
});

// ============================================================================
// Fix #2: SSE close() → reconnect()
// ============================================================================

describe('Fix #2: SSE close → reconnect', () => {
  class MockES {
    static instances: MockES[] = [];
    url: string;
    withCredentials: boolean;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    readyState = 0;
    closed = false;

    constructor(url: string, opts?: { withCredentials?: boolean }) {
      this.url = url;
      this.withCredentials = opts?.withCredentials ?? false;
      MockES.instances.push(this);
      queueMicrotask(() => {
        if (!this.closed) { this.readyState = 1; this.onopen?.(new Event('open')); }
      });
    }
    addEventListener() { /* named-event subscriptions are tested elsewhere */ }
    removeEventListener() { /* same */ }
    close() { this.closed = true; this.readyState = 2; }
    static reset() { MockES.instances = []; }
    static latest() { return MockES.instances[MockES.instances.length - 1]; }
  }

  const origES = (globalThis as Record<string, unknown>).EventSource;

  beforeEach(() => {
    MockES.reset();
    (globalThis as Record<string, unknown>).EventSource = MockES;
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'tok', getOrgId: () => null });
  });

  afterEach(() => {
    if (origES) (globalThis as Record<string, unknown>).EventSource = origES;
    else delete (globalThis as Record<string, unknown>).EventSource;
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('reconnect after close creates new connection and receives events', async () => {
    const onEvent = vi.fn();
    const qc = createTestQueryClient();

    const { result } = renderHook(
      () => useEventStream({ resource: 'agents', onEvent }),
      { wrapper: createWrapper(qc) }
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => result.current.close());
    expect(result.current.isConnected).toBe(false);

    act(() => result.current.reconnect());
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    // Event on new connection works
    act(() => {
      MockES.latest()!.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({ type: 'test', resource: 'agents', data: {}, timestamp: '' }),
      }));
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    qc.clear();
  });
});

// ============================================================================
// Fix #3: Legacy signature detection — useList(null)
// ============================================================================

describe('Fix #3: useList(null) uses new signature', () => {
  let qc: QueryClient;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'auto-token', getOrgId: () => null });
    configureToast({ success: () => {}, error: () => {} });
    qc = createTestQueryClient();
  });

  afterEach(() => {
    qc.clear();
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('useList(null) auto-injects token (new signature)', async () => {
    const api = createMockApi();
    const hooks = createCrudHooks({
      api, entityKey: `fix3a-${Math.random()}`, singular: 'Item',
    });

    renderHook(() => hooks.useList(null), { wrapper: createWrapper(qc) });

    await waitFor(() => {
      expect(api.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'auto-token' })
      );
    });
  });

  it('useList(null, {}, opts) passes token=null (legacy)', async () => {
    const api = createMockApi();
    const hooks = createCrudHooks({
      api, entityKey: `fix3b-${Math.random()}`, singular: 'Item',
    });

    renderHook(() => hooks.useList(null, {}, { public: true }), { wrapper: createWrapper(qc) });

    await waitFor(() => {
      expect(api.getAll).toHaveBeenCalledWith(
        expect.objectContaining({ token: null })
      );
    });
  });
});

// ============================================================================
// Fix #5: Non-JSON error responses
// ============================================================================

describe('Fix #5: non-JSON error body captured', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => { fetchMock.mockRestore(); });

  it('HTML 502 captures body text', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502, statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/html' },
      })
    );

    try {
      await handleApiRequest('GET', '/test');
      expect.fail('Should throw');
    } catch (error: unknown) {
      expect(isArcApiError(error)).toBe(true);
      const e = error as { status: number; json: { rawBody?: string } };
      expect(e.status).toBe(502);
      expect(e.json?.rawBody).toContain('<html>');
    }
  });

  it('empty body falls back to statusText', async () => {
    fetchMock.mockResolvedValue(
      new Response('', { status: 500, statusText: 'Internal Server Error' })
    );

    try {
      await handleApiRequest('GET', '/test');
      expect.fail('Should throw');
    } catch (error: unknown) {
      expect((error as { message: string }).message).toBe('Internal Server Error');
    }
  });

  it('JSON error still works normally', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Validation failed' }), {
        status: 400, statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    try {
      await handleApiRequest('POST', '/test');
      expect.fail('Should throw');
    } catch (error: unknown) {
      expect((error as { message: string }).message).toBe('Validation failed');
    }
  });
});

// ============================================================================
// M2M API Key Auth
// ============================================================================

describe('M2M API key auth (service-to-service)', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('global header auth sends x-api-key', async () => {
    configureClient({ baseUrl: 'http://svc.internal', authMode: 'header' });
    configureAuth({ getToken: () => 'svc_key', headerName: 'x-api-key' });

    await handleApiRequest('GET', '/data', { token: 'svc_key' });

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('svc_key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('per-client header auth sends x-admin-key', async () => {
    configureClient({ baseUrl: 'http://default.test' });

    const admin = createClient({
      baseUrl: 'http://admin.internal',
      authMode: 'header',
      getToken: () => 'admin_key',
      headerName: 'x-admin-key',
    });

    await admin.request('GET', '/admin/stats');

    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://admin.internal/admin/stats');
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers['x-admin-key']).toBe('admin_key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('two services with different auth modes work side by side', async () => {
    // Need fresh Response per call
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
    );

    configureClient({ baseUrl: 'http://api.test', authMode: 'bearer' });

    const analytics = createClient({
      baseUrl: 'http://analytics.internal',
      authMode: 'header',
      getToken: () => 'analytics_key',
      headerName: 'x-analytics-key',
    });

    // Service A (bearer)
    await handleApiRequest('GET', '/users', { token: 'jwt_token' });
    const aHeaders = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(aHeaders['Authorization']).toBe('Bearer jwt_token');

    // Service B (api key)
    await analytics.request('GET', '/events');
    const bHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(bHeaders['x-analytics-key']).toBe('analytics_key');
    expect(bHeaders['Authorization']).toBeUndefined();
  });
});
