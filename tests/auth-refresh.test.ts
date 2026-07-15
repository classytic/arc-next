/**
 * 401 → refresh → retry interceptor — spec from the mentora ticket.
 *
 * Every test here drives `configureAuth({ onAuthError })` against a mocked
 * fetch so the wire behavior is fully observable. Concurrent dedup is the
 * load-bearing part: N parallel 401s must collapse onto one handler call,
 * not stampede the refresh endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureAuth,
  configureClient,
  handleApiRequest,
  isArcApiError,
  createAuthRefreshHandler,
  _resetAuthRecovery,
  _resetAuthWarnings,
} from '../src/client.js';

function mockFetchSequence(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const queue = [...responses];
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`mockFetchSequence: out of responses (call #${calls.length})`);
    const r = typeof next === 'function' ? next() : next;
    return Promise.resolve(r as Response);
  }) as typeof globalThis.fetch);
  return { spy, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  configureClient({ baseUrl: 'http://api.test' });
  configureAuth({ getToken: () => null, getOrgId: () => null });
  _resetAuthRecovery();
  _resetAuthWarnings();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('configureAuth({ onAuthError }) — lazy 401 recovery', () => {
  it('200 response → handler is NOT called', async () => {
    const onAuthError = vi.fn();
    configureAuth({ getToken: () => 'tok-a', onAuthError });
    const { spy } = mockFetchSequence([json({ ok: true })]);

    const result = await handleApiRequest('GET', '/items');

    expect(result).toEqual({ ok: true });
    expect(onAuthError).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('401 + retry → request re-issued with the setToken-injected token, second response delivered', async () => {
    // Drive through createClient so the per-client auth injection mirrors
    // what real consumers wire. (The global `handleApiRequest` now ALSO
    // auto-injects from configureAuth — see global-auth-injection.test.ts —
    // but per-client `getToken` re-reads on every request, which is also
    // what re-fires after recovery.)
    const { createClient } = await import('../src/client.js');
    configureAuth({
      getToken: () => 'stale-token',
      onAuthError: async ({ setToken }) => {
        setToken('fresh-token');
        return 'retry';
      },
    });
    const client = createClient({
      baseUrl: 'http://api.test',
      getToken: () => 'stale-token', // per-client; mirrors createAuthAwareClient
    });
    const { calls } = mockFetchSequence([
      json({ error: 'expired' }, 401),
      json({ ok: true, value: 42 }),
    ]);

    const result = await client.request<{ value: number }>('GET', '/items');

    expect(result).toEqual({ ok: true, value: 42 });
    expect(calls).toHaveLength(2);
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer stale-token');
    // Retry carries the injected fresh token — setToken trumps both per-client
    // and global getToken (handler knows best at refresh time).
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
  });

  it('401 + retry without setToken → retry re-reads getToken() (out-of-band refresh path)', async () => {
    let cached = 'stale-token';
    configureAuth({
      getToken: () => cached,
      onAuthError: async () => {
        // Simulate the consumer mutating their own auth lib's cache out-of-band
        // (signal write, store update, etc.) instead of using setToken.
        cached = 'fresh-token';
        return 'retry';
      },
    });
    const { calls } = mockFetchSequence([json({ error: 'expired' }, 401), json({ ok: true })]);

    await handleApiRequest('GET', '/items');

    expect(calls).toHaveLength(2);
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
  });

  it("401, handler returns 'skip' → original 401 surfaces; no retry fetched", async () => {
    const onAuthError = vi.fn().mockResolvedValue('skip' as const);
    configureAuth({ getToken: () => 'tok', onAuthError });
    const { calls } = mockFetchSequence([json({ error: 'expired' }, 401)]);

    await expect(handleApiRequest('GET', '/items')).rejects.toMatchObject({
      name: 'ArcApiError',
      status: 401,
    });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('401, handler throws → thrown error propagates, no retry fetched', async () => {
    const refreshFailure = new Error('refresh endpoint 500');
    configureAuth({
      getToken: () => 'tok',
      onAuthError: async () => { throw refreshFailure; },
    });
    const { calls } = mockFetchSequence([json({ error: 'expired' }, 401)]);

    await expect(handleApiRequest('GET', '/items')).rejects.toBe(refreshFailure);
    expect(calls).toHaveLength(1);
  });

  it('401, no onAuthError configured → default behavior (401 surfaces immediately, no extra fetches)', async () => {
    configureAuth({ getToken: () => 'tok' }); // no onAuthError
    const { calls } = mockFetchSequence([json({ error: 'expired' }, 401)]);

    await expect(handleApiRequest('GET', '/items')).rejects.toMatchObject({
      status: 401,
    });
    expect(calls).toHaveLength(1);
  });

  it('maxAuthRetries:1 (default) — second 401 surfaces, no infinite loop', async () => {
    const onAuthError = vi.fn(async ({ setToken }: { setToken: (t: string | null) => void }) => {
      setToken('next-token');
      return 'retry' as const;
    });
    configureAuth({ getToken: () => 'tok', onAuthError });
    // First 401 → handler → retry. Retry also 401 → cap hit → surface.
    const { calls } = mockFetchSequence([
      json({ error: 'expired' }, 401),
      json({ error: 'still expired' }, 401),
    ]);

    await expect(handleApiRequest('GET', '/items')).rejects.toMatchObject({
      status: 401,
    });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('maxAuthRetries:0 → handler is never invoked even with onAuthError configured', async () => {
    const onAuthError = vi.fn();
    configureAuth({ getToken: () => 'tok', onAuthError, maxAuthRetries: 0 });
    const { calls } = mockFetchSequence([json({ error: 'expired' }, 401)]);

    await expect(handleApiRequest('GET', '/items')).rejects.toMatchObject({ status: 401 });
    expect(onAuthError).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('403 does NOT trigger handler when retryOn403 is false (default)', async () => {
    const onAuthError = vi.fn();
    configureAuth({ getToken: () => 'tok', onAuthError });
    const { calls } = mockFetchSequence([json({ error: 'denied' }, 403)]);

    await expect(handleApiRequest('GET', '/items')).rejects.toMatchObject({ status: 403 });
    expect(onAuthError).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('403 DOES trigger handler when retryOn403:true', async () => {
    configureAuth({
      getToken: () => 'tok',
      retryOn403: true,
      onAuthError: async ({ setToken }) => {
        setToken('fresh');
        return 'retry';
      },
    });
    const { calls } = mockFetchSequence([json({ error: 'denied' }, 403), json({ ok: true })]);

    const result = await handleApiRequest('GET', '/items');
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('2xx, 4xx (non-auth), 5xx never trigger the handler', async () => {
    const onAuthError = vi.fn();
    configureAuth({ getToken: () => 'tok', onAuthError });

    for (const status of [200, 400, 404, 422, 500, 503]) {
      _resetAuthRecovery();
      const { spy } = mockFetchSequence([json({ status }, status)]);
      const p = handleApiRequest('GET', '/items');
      if (status >= 400) {
        await expect(p).rejects.toBeDefined();
      } else {
        await p;
      }
      spy.mockRestore();
    }

    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('aborted request does NOT call onAuthError (caller abandoned the request)', async () => {
    const onAuthError = vi.fn().mockResolvedValue('retry' as const);
    configureAuth({ getToken: () => 'tok', onAuthError });
    mockFetchSequence([json({ error: 'expired' }, 401)]);

    const controller = new AbortController();
    const p = handleApiRequest('GET', '/items', { signal: controller.signal });
    controller.abort();

    await expect(p).rejects.toBeDefined();
    // Either the abort fired before the 401 (no handler) or after (also no
    // handler — we honor the abort and skip the retry). Either way: 0 calls.
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('CRITICAL — 10 concurrent 401s collapse to ONE handler call; all 10 retry with the same fresh token', async () => {
    const onAuthError = vi.fn(async ({ setToken }: { setToken: (t: string | null) => void }) => {
      // Simulate a non-trivial refresh delay so all 10 requests pile up
      // behind the same in-flight promise.
      await new Promise((r) => setTimeout(r, 30));
      setToken('shared-fresh-token');
      return 'retry' as const;
    });
    configureAuth({ getToken: () => 'stale', onAuthError });

    // Mock: every call returns 401, retry returns 200. We need 20 responses
    // total (10 initial 401s + 10 retries).
    const responses: Response[] = [];
    for (let i = 0; i < 10; i++) responses.push(json({ error: 'expired' }, 401));
    for (let i = 0; i < 10; i++) responses.push(json({ ok: true, i }));
    const { calls } = mockFetchSequence(responses);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => handleApiRequest(`GET`, `/items/${i}`)),
    );

    // Every request succeeded.
    expect(results).toHaveLength(10);
    results.forEach((r) => expect(r).toMatchObject({ ok: true }));

    // The handler fired ONCE despite 10 concurrent 401s — this is the dedup
    // contract; without it, every concurrent 401 would hit the refresh
    // endpoint and stampede.
    expect(onAuthError).toHaveBeenCalledTimes(1);

    // 20 fetches total: 10 initial 401s, 10 retries.
    expect(calls).toHaveLength(20);
    // All 10 retries carry the SAME fresh token from the single refresh.
    const retryHeaders = calls.slice(10).map(
      (c) => (c.init?.headers as Record<string, string>).Authorization,
    );
    expect(new Set(retryHeaders)).toEqual(new Set(['Bearer shared-fresh-token']));
  });

  it('after dedup settles, a LATER 401 starts a fresh recovery cycle (no stale decision replay)', async () => {
    const onAuthError = vi.fn(async ({ setToken }: { setToken: (t: string | null) => void }) => {
      setToken('first-refresh');
      return 'retry' as const;
    });
    configureAuth({ getToken: () => 'stale', onAuthError });
    mockFetchSequence([json({ error: 'expired' }, 401), json({ ok: 1 })]);

    await handleApiRequest('GET', '/a');
    expect(onAuthError).toHaveBeenCalledTimes(1);

    // Second request — token has gone stale again (e.g. another long pause).
    onAuthError.mockClear();
    onAuthError.mockImplementation(async ({ setToken }: { setToken: (t: string | null) => void }) => {
      setToken('second-refresh');
      return 'retry' as const;
    });
    const { calls } = mockFetchSequence([json({ error: 'expired' }, 401), json({ ok: 2 })]);

    await handleApiRequest('GET', '/b');

    // Handler ran AGAIN (not stuck on the first refresh's promise).
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer second-refresh');
  });

  it('handler receives ArcApiError carrying the 401 contract (status, json, endpoint, method)', async () => {
    let captured: Parameters<NonNullable<Parameters<typeof configureAuth>[0]['onAuthError']>>[0] | null = null;
    configureAuth({
      getToken: () => 'tok',
      onAuthError: async (ctx) => {
        captured = ctx;
        return 'skip';
      },
    });
    mockFetchSequence([json({ code: 'unauthorized', message: 'token expired' }, 401)]);

    await expect(handleApiRequest('POST', '/items')).rejects.toBeDefined();

    expect(captured).toBeDefined();
    expect(captured!.error.status).toBe(401);
    expect(captured!.error.code).toBe('unauthorized');
    expect(captured!.request).toEqual({ method: 'POST', endpoint: '/items' });
    expect(captured!.attempt).toBe(1);
  });
});

describe('createAuthRefreshHandler — generic adapter for any refresh fn', () => {
  it('refresh returns a token → setToken + retry', async () => {
    const refresh = vi.fn().mockResolvedValue('newly-minted');
    configureAuth({
      getToken: () => 'stale',
      onAuthError: createAuthRefreshHandler({ refresh }),
    });
    const { calls } = mockFetchSequence([json({}, 401), json({ ok: true })]);

    const result = await handleApiRequest('GET', '/items');

    expect(result).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer newly-minted');
  });

  it('refresh returns null (session truly expired) → skip; original 401 surfaces', async () => {
    configureAuth({
      getToken: () => 'stale',
      onAuthError: createAuthRefreshHandler({ refresh: async () => null }),
    });
    const { calls } = mockFetchSequence([json({}, 401)]);

    await expect(handleApiRequest('GET', '/items')).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('refresh throws → default skips (consumer sees the original 401, not a misleading refresh trace)', async () => {
    configureAuth({
      getToken: () => 'stale',
      onAuthError: createAuthRefreshHandler({
        refresh: async () => { throw new Error('refresh network down'); },
      }),
    });
    mockFetchSequence([json({}, 401)]);

    await expect(handleApiRequest('GET', '/items')).rejects.toMatchObject({ status: 401 });
  });

  it('onRefreshError: "throw" propagates the refresh failure', async () => {
    const refreshFail = new Error('refresh endpoint dead');
    configureAuth({
      getToken: () => 'stale',
      onAuthError: createAuthRefreshHandler({
        refresh: async () => { throw refreshFail; },
        onRefreshError: 'throw',
      }),
    });
    mockFetchSequence([json({}, 401)]);

    await expect(handleApiRequest('GET', '/items')).rejects.toBe(refreshFail);
  });
});
