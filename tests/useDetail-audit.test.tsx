/**
 * useDetail audit — does it actually fail to fire GET requests in the
 * scenarios people complain about?
 *
 * Spans the documented hypotheses:
 *  1. Public detail call (logged out) — `useDetail(id, { public: true })`
 *  2. Bearer-mode admin call             — `useDetail(id, { enabled: true })`
 *  3. Async getToken (Promise return)    — `getToken: () => Promise<...>`
 *  4. Cache prefill from useList         — list mounts, then detail mounts
 *  5. Cookie auth mode                    — `useDetail(id)` with no token
 *  6. hasStaticAuth (internalApiKey)     — public read with API key
 *  7. Cold-load via direct route          — only useDetail mounts, no list
 *
 * Each test asserts on `mockApi.getById.mock.calls.length` — that is the
 * single signal "did the SDK fire a GET request?" the consumer cares about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createCrudHooks } from '../src/hooks.js';
import { configureClient, configureAuth, _resetAuthWarnings } from '../src/client.js';
import type { CrudApi } from '../src/hooks.js';

function createQc() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function Wrap(qc: QueryClient) {
  return function Provider({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

type Item = { _id: string; title: string; body?: string };

function mockApi(): CrudApi<Item> {
  return {
    getAll: vi.fn().mockResolvedValue({
      data: [
        { _id: 'a', title: 'A from list' }, // intentionally NO `body` — list payload is lighter than detail
        { _id: 'b', title: 'B from list' },
      ],
      total: 2,
      page: 1,
      limit: 10,
      pages: 1,
      hasNext: false,
      hasPrev: false,
    }),
    getById: vi.fn().mockResolvedValue({ _id: 'a', title: 'A from detail', body: 'full body' }),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

describe('useDetail audit — does the request actually fire?', () => {
  beforeEach(() => {
    _resetAuthWarnings();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 1. Public detail call from a logged-out user
  // ──────────────────────────────────────────────────────────────────────
  it('FIRES GET for useDetail(id, {public:true}) when logged out', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'chapters', singular: 'Chapter' });
    const qc = createQc();

    const { result } = renderHook(() => hooks.useDetail('chap-1', { public: true }), {
      wrapper: Wrap(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getById).toHaveBeenCalledTimes(1);
    expect(api.getById).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chap-1', token: null }),
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 2. Bearer-mode admin call
  // ──────────────────────────────────────────────────────────────────────
  it('FIRES GET for useDetail(id) in bearer mode when token is present', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'bearer' });
    configureAuth({ getToken: () => 'admin-token', getOrgId: () => null });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'cms', singular: 'CMS' });
    const qc = createQc();

    const { result } = renderHook(() => hooks.useDetail('home'), { wrapper: Wrap(qc) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getById).toHaveBeenCalledTimes(1);
    expect(api.getById).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'home', token: 'admin-token' }),
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // 3. Async getToken (the silent killer)
  // ──────────────────────────────────────────────────────────────────────
  it('DOES NOT fire GET when getToken returns a Promise (silent failure)', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'bearer' });
    configureAuth({
      // Misuse: returning Promise<string>. readToken() drops it, warns once, returns null.
      getToken: (() => Promise.resolve('admin-token')) as unknown as () => string,
      getOrgId: () => null,
    });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'cms', singular: 'CMS' });
    const qc = createQc();

    const { result } = renderHook(() => hooks.useDetail('home'), { wrapper: Wrap(qc) });

    await new Promise((r) => setTimeout(r, 50));
    expect(api.getById).not.toHaveBeenCalled();
    // react-query reports `isLoading: false` when the query is `enabled: false`
    // (which is what happens when token is null in bearer mode). So the consumer
    // sees `{ isLoading: false, item: null }` — looks like an empty success state.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.item).toBeNull();
  });

  it('USER FIX for async token: pass {public:true} OR switch to cookie mode', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'bearer' });
    configureAuth({
      getToken: (() => Promise.resolve('admin-token')) as unknown as () => string,
      getOrgId: () => null,
    });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'cms', singular: 'CMS' });
    const qc = createQc();

    const { result } = renderHook(() => hooks.useDetail('home', { public: true }), {
      wrapper: Wrap(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getById).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 4. FIXED (0.7): useList in cache → useDetail uses it as placeholderData,
  //                 always fires the real detail GET, returns rich payload
  // ──────────────────────────────────────────────────────────────────────
  it('FIRES detail GET even when useList already has the item — list payload becomes placeholderData, not cached truth', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'chapters', singular: 'Chapter' });
    const qc = createQc();

    // Mount useList first — calls api.getAll. Does NOT pollute the detail cache.
    const listHook = renderHook(() => hooks.useList(undefined, { public: true }), {
      wrapper: Wrap(qc),
    });
    await waitFor(() => expect(listHook.result.current.isLoading).toBe(false));
    expect(api.getAll).toHaveBeenCalledTimes(1);
    expect(api.getById).not.toHaveBeenCalled();

    // Mount useDetail for an item that was in the list. The hook reads the
    // list item via placeholderData (instant render with `_id` + `title`),
    // then fires the real GET in the background.
    const detailHook = renderHook(() => hooks.useDetail('a', { public: true }), {
      wrapper: Wrap(qc),
    });

    // Synchronous first render: list item shown as placeholder.
    expect(detailHook.result.current.isPlaceholderData).toBe(true);
    expect(detailHook.result.current.item).toEqual({ _id: 'a', title: 'A from list' });

    // Then the real detail GET fires and resolves with the rich payload.
    await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(detailHook.result.current.isPlaceholderData).toBe(false));
    expect(detailHook.result.current.item).toEqual({
      _id: 'a',
      title: 'A from detail',
      body: 'full body',
    });
  });

  it('FIRES detail GET when useList stays mounted alongside detail (master/detail layout)', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'chapters', singular: 'Chapter' });
    const qc = createQc();

    // List stays mounted (layout pattern, master/detail view, etc.) — no
    // prefill effect means no unstable-ref clobber loop.
    renderHook(() => hooks.useList(undefined, { public: true }), { wrapper: Wrap(qc) });
    await waitFor(() => expect(api.getAll).toHaveBeenCalledTimes(1));

    const detailHook = renderHook(() => hooks.useDetail('a', { public: true }), {
      wrapper: Wrap(qc),
    });

    await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(detailHook.result.current.isFetching).toBe(false));

    // Result is the rich detail payload — placeholder swap is final.
    expect(detailHook.result.current.item).toEqual({
      _id: 'a',
      title: 'A from detail',
      body: 'full body',
    });
  });

  it('FIRES detail GET on cold cache (no prior list) — no regression', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'chapters', singular: 'Chapter' });
    const qc = createQc();

    const detailHook = renderHook(() => hooks.useDetail('a', { public: true }), {
      wrapper: Wrap(qc),
    });

    // No list → no placeholderData → straight to loading.
    expect(detailHook.result.current.isPlaceholderData).toBe(false);
    expect(detailHook.result.current.item).toBeNull();

    await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(detailHook.result.current.isLoading).toBe(false));
    expect(detailHook.result.current.item?.body).toBe('full body');
  });

  // ──────────────────────────────────────────────────────────────────────
  // 5. Cookie auth mode
  // ──────────────────────────────────────────────────────────────────────
  it('FIRES GET in cookie mode regardless of token', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });
    configureAuth({ getToken: () => null, getOrgId: () => null });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'cms', singular: 'CMS' });
    const qc = createQc();

    const { result } = renderHook(() => hooks.useDetail('home'), { wrapper: Wrap(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getById).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6. hasStaticAuth via internalApiKey on per-client config
  // ──────────────────────────────────────────────────────────────────────
  it('FIRES GET when client has internalApiKey (hasStaticAuth path)', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });

    const api = mockApi();
    const hooks = createCrudHooks({
      api,
      entityKey: 'cms',
      singular: 'CMS',
      // Per-client config carries the API key — flips hasStaticAuth to true.
      client: {
        request: vi.fn(),
        config: { baseUrl: 'http://api.test', internalApiKey: 'srv-key' },
      },
    });
    const qc = createQc();

    const { result } = renderHook(() => hooks.useDetail('home'), { wrapper: Wrap(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getById).toHaveBeenCalledTimes(1);
  });

  it('FIRES GET when global configureClient has internalApiKey (gap closed in 0.7)', async () => {
    // Before 0.7, `hasStaticAuth` only inspected per-client config — a global
    // `internalApiKey` left queries permanently disabled. `hasGlobalStaticAuth`
    // now also reads the singleton, so apps that authenticate via a global
    // key (most of them) get enabled queries without per-call ceremony.
    configureClient({ baseUrl: 'http://api.test', internalApiKey: 'srv-key' });
    configureAuth({ getToken: () => null, getOrgId: () => null });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'cms', singular: 'CMS' });
    const qc = createQc();

    const { result } = renderHook(() => hooks.useDetail('home'), { wrapper: Wrap(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getById).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 7. Cold-load detail page (no list mounted first)
  // ──────────────────────────────────────────────────────────────────────
  it('FIRES GET when detail page is loaded directly (no prior list)', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'chapters', singular: 'Chapter' });
    const qc = createQc();

    const { result } = renderHook(() => hooks.useDetail('chap-1', { public: true }), {
      wrapper: Wrap(qc),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(api.getById).toHaveBeenCalledTimes(1);
    expect(result.current.item?.body).toBe('full body'); // full payload from the GET
  });

  // ──────────────────────────────────────────────────────────────────────
  // 8. Edge case the user actually claimed was broken: id flips null→'home'
  // ──────────────────────────────────────────────────────────────────────
  it('FIRES GET once id flips from null to a value', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });

    const api = mockApi();
    const hooks = createCrudHooks({ api, entityKey: 'cms', singular: 'CMS' });
    const qc = createQc();

    const { result, rerender } = renderHook(({ id }: { id: string | null }) => hooks.useDetail(id), {
      wrapper: Wrap(qc),
      initialProps: { id: null as string | null },
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(api.getById).not.toHaveBeenCalled(); // disabled — id is null

    rerender({ id: 'home' });
    await waitFor(() => expect(api.getById).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.item).toEqual({ _id: 'a', title: 'A from detail', body: 'full body' });
  });
});
