/**
 * `arcFetch` + `arc.{get,post,patch,put,delete}` + `arcAuthHeaders` — the
 * non-hook authenticated-fetch surface. Spec verifications:
 *
 *  - Auto-injects Authorization + x-organization-id + content-type
 *  - Body sniffing: plain object → JSON; FormData/Blob/etc. → pass through
 *  - Throws ArcApiError on non-2xx (with parsed body + status)
 *  - Protected headers — caller can't override Authorization
 *  - Composes with `onAuthError` (401 → refresh → retry, same dedup)
 *  - `arcAuthHeaders()` escape hatch returns the same headers
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  arc,
  arcAuthHeaders,
  arcFetch,
  configureAuth,
  configureClient,
  createAuthRefreshHandler,
  isArcApiError,
  _resetArcFetchClient,
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

function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

beforeEach(() => {
  configureClient({ baseUrl: 'http://api.test' });
  configureAuth({ getToken: () => null, getOrgId: () => null });
  _resetAuthRecovery();
  _resetAuthWarnings();
  _resetArcFetchClient();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// arcFetch — header injection
// ============================================================================

describe('arcFetch — auto-injected headers', () => {
  it('injects Authorization + x-organization-id when both configured', async () => {
    configureAuth({ getToken: () => 'tok-123', getOrgId: () => 'org-abc' });
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/items');

    expect(getHeader(calls[0]!.init, 'Authorization')).toBe('Bearer tok-123');
    expect(getHeader(calls[0]!.init, 'x-organization-id')).toBe('org-abc');
  });

  it('omits Authorization when no token (public endpoint)', async () => {
    configureAuth({ getToken: () => null, getOrgId: () => null });
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/public');

    expect(getHeader(calls[0]!.init, 'Authorization')).toBeUndefined();
    expect(getHeader(calls[0]!.init, 'x-organization-id')).toBeUndefined();
  });

  it('omits Authorization in cookie mode (cookies carry auth, not headers)', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });
    configureAuth({ getToken: () => 'unused', getOrgId: () => null });
    _resetArcFetchClient();
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/items');

    expect(getHeader(calls[0]!.init, 'Authorization')).toBeUndefined();
    expect(calls[0]!.init?.credentials).toBe('include');
  });

  it('uses custom auth header when authMode: "header"', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'header' });
    configureAuth({ getToken: () => 'srv-key', headerName: 'x-api-key' });
    _resetArcFetchClient();
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/items');

    expect(getHeader(calls[0]!.init, 'x-api-key')).toBe('srv-key');
    // Should NOT also set Authorization — header-mode tokens go in the
    // custom header only, otherwise the backend sees both.
    expect(getHeader(calls[0]!.init, 'Authorization')).toBeUndefined();
  });
});

// ============================================================================
// Body handling — JSON sniffing
// ============================================================================

describe('arcFetch — body type sniffing', () => {
  it('plain object → JSON.stringify + Content-Type: application/json', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/items', { method: 'POST', body: { name: 'widget' } });

    expect(getHeader(calls[0]!.init, 'Content-Type')).toBe('application/json');
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ name: 'widget' }));
  });

  it('array → JSON.stringify + application/json', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/bulk', { method: 'POST', body: [{ a: 1 }, { b: 2 }] });

    expect(getHeader(calls[0]!.init, 'Content-Type')).toBe('application/json');
    expect(calls[0]!.init?.body).toBe(JSON.stringify([{ a: 1 }, { b: 2 }]));
  });

  it('FormData → passes through, NO Content-Type forced (browser sets boundary)', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);
    const fd = new FormData();
    fd.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hi.txt');

    await arcFetch('/api/upload', { method: 'POST', body: fd });

    // FormData → arc-next must NOT set Content-Type; the browser computes
    // multipart boundary at send time. Setting it strips the boundary.
    expect(getHeader(calls[0]!.init, 'Content-Type')).toBeUndefined();
    expect(calls[0]!.init?.body).toBe(fd);
  });

  it('Blob → passes through, NO JSON Content-Type override', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);
    const blob = new Blob(['hello'], { type: 'text/plain' });

    await arcFetch('/api/raw', { method: 'POST', body: blob });

    expect(getHeader(calls[0]!.init, 'Content-Type')).toBeUndefined();
    expect(calls[0]!.init?.body).toBe(blob);
  });

  it('URLSearchParams → passes through (form-urlencoded)', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);
    const params = new URLSearchParams({ a: '1', b: '2' });

    await arcFetch('/api/form', { method: 'POST', body: params });

    expect(getHeader(calls[0]!.init, 'Content-Type')).toBeUndefined();
    expect(calls[0]!.init?.body).toBe(params);
  });

  it('string body → passes through (caller controls Content-Type)', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/raw', {
      method: 'POST',
      body: '<xml/>',
      headers: { 'Content-Type': 'application/xml' },
    });

    expect(getHeader(calls[0]!.init, 'Content-Type')).toBe('application/xml');
    expect(calls[0]!.init?.body).toBe('<xml/>');
  });

  it('null / undefined body → no body sent, no Content-Type', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/items'); // default method GET, no body

    expect(getHeader(calls[0]!.init, 'Content-Type')).toBeUndefined();
    expect(calls[0]!.init?.body).toBeUndefined();
  });
});

// ============================================================================
// Response handling
// ============================================================================

describe('arcFetch — response parsing', () => {
  it('2xx JSON → returns parsed body', async () => {
    mockFetchSequence([json({ id: 1, name: 'widget' })]);

    const result = await arcFetch<{ id: number; name: string }>('/api/items/1');

    expect(result).toEqual({ id: 1, name: 'widget' });
  });

  it('4xx → throws ArcApiError with parsed body, status, endpoint, method', async () => {
    mockFetchSequence([
      json({ code: 'arc.not_found', message: 'No such widget' }, 404),
    ]);

    try {
      await arcFetch('/api/items/missing');
      expect.fail('should have thrown');
    } catch (err) {
      expect(isArcApiError(err)).toBe(true);
      if (isArcApiError(err)) {
        expect(err.status).toBe(404);
        expect(err.code).toBe('arc.not_found');
        expect(err.endpoint).toBe('/api/items/missing');
        expect(err.method).toBe('GET');
      }
    }
  });

  it('5xx with non-JSON body → captures rawBody', async () => {
    const htmlError = new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
    mockFetchSequence([htmlError]);

    try {
      await arcFetch('/api/items');
      expect.fail('should have thrown');
    } catch (err) {
      expect(isArcApiError(err)).toBe(true);
      if (isArcApiError(err)) {
        expect(err.status).toBe(502);
        expect((err.json as { rawBody?: string }).rawBody).toContain('502 Bad Gateway');
      }
    }
  });
});

// ============================================================================
// Protected headers
// ============================================================================

describe('arcFetch — protected headers (caller can never override auth)', () => {
  it("user-passed `Authorization` is dropped — arc-injected wins", async () => {
    configureAuth({ getToken: () => 'arc-token', getOrgId: () => null });
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/items', {
      headers: { Authorization: 'Bearer attacker-token', 'X-Custom': 'allowed' },
    });

    expect(getHeader(calls[0]!.init, 'Authorization')).toBe('Bearer arc-token');
    expect(getHeader(calls[0]!.init, 'X-Custom')).toBe('allowed'); // non-protected pass through
  });

  it('user-passed `authorization` (lowercase) is dropped — case-insensitive protection', async () => {
    configureAuth({ getToken: () => 'arc-token', getOrgId: () => null });
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/items', { headers: { authorization: 'Bearer ATTACK' } });

    expect(getHeader(calls[0]!.init, 'Authorization')).toBe('Bearer arc-token');
  });

  it('user-passed `x-organization-id` is dropped — single source of truth is configureAuth', async () => {
    configureAuth({ getToken: () => 'tok', getOrgId: () => 'real-org' });
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/items', { headers: { 'x-organization-id': 'attacker-org' } });

    expect(getHeader(calls[0]!.init, 'x-organization-id')).toBe('real-org');
  });

  it('user-passed `x-api-key` (when authMode: header) is dropped', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'header' });
    configureAuth({ getToken: () => 'real-key', headerName: 'x-api-key' });
    _resetArcFetchClient();
    const { calls } = mockFetchSequence([json({ ok: true })]);

    await arcFetch('/api/items', { headers: { 'x-api-key': 'attacker-key' } });

    expect(getHeader(calls[0]!.init, 'x-api-key')).toBe('real-key');
  });
});

// ============================================================================
// Method shorthands
// ============================================================================

describe('arc.{get,post,patch,put,delete} — method shorthands', () => {
  it('arc.get → method: GET, no body', async () => {
    const { calls } = mockFetchSequence([json({ items: [] })]);

    await arc.get<{ items: unknown[] }>('/api/items');

    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it('arc.post → method: POST, body as 2nd positional arg', async () => {
    const { calls } = mockFetchSequence([json({ id: 'new' })]);

    await arc.post<{ id: string }>('/api/items', { name: 'widget' });

    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ name: 'widget' }));
  });

  it('arc.patch → method: PATCH', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);
    await arc.patch('/api/items/1', { name: 'renamed' });
    expect(calls[0]!.init?.method).toBe('PATCH');
  });

  it('arc.put → method: PUT', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);
    await arc.put('/api/items/1', { name: 'replaced' });
    expect(calls[0]!.init?.method).toBe('PUT');
  });

  it('arc.delete → method: DELETE, no body slot', async () => {
    const { calls } = mockFetchSequence([json({ ok: true })]);
    await arc.delete('/api/items/1');
    expect(calls[0]!.init?.method).toBe('DELETE');
    expect(calls[0]!.init?.body).toBeUndefined();
  });
});

// ============================================================================
// Composition with onAuthError
// ============================================================================

describe('arcFetch — composes with onAuthError refresh loop', () => {
  it('401 → handler refreshes → retry succeeds', async () => {
    let cachedToken = 'stale';
    configureAuth({
      getToken: () => cachedToken,
      onAuthError: createAuthRefreshHandler({
        refresh: async () => {
          cachedToken = 'fresh';
          return 'fresh';
        },
      }),
    });
    _resetArcFetchClient();
    const { calls } = mockFetchSequence([json({}, 401), json({ ok: true })]);

    const result = await arcFetch('/api/items');

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(getHeader(calls[0]!.init, 'Authorization')).toBe('Bearer stale');
    expect(getHeader(calls[1]!.init, 'Authorization')).toBe('Bearer fresh');
  });

  it('10 concurrent arcFetch 401s collapse to ONE refresh (shared dedup with all other transports)', async () => {
    let cachedToken = 'stale';
    const refreshSpy = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      cachedToken = 'fresh';
      return 'fresh';
    });
    configureAuth({
      getToken: () => cachedToken,
      onAuthError: createAuthRefreshHandler({ refresh: refreshSpy }),
    });
    _resetArcFetchClient();

    const responses: Response[] = [];
    for (let i = 0; i < 10; i++) responses.push(json({}, 401));
    for (let i = 0; i < 10; i++) responses.push(json({ ok: true, i }));
    mockFetchSequence(responses);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => arcFetch(`/api/items/${i}`)),
    );

    expect(results).toHaveLength(10);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// arcAuthHeaders — escape hatch
// ============================================================================

describe('arcAuthHeaders — escape hatch for full Response control', () => {
  it('returns Authorization + x-organization-id matching what arcFetch would send', async () => {
    configureAuth({ getToken: () => 'tok-x', getOrgId: () => 'org-y' });

    const headers = arcAuthHeaders();

    expect(headers).toEqual({
      Authorization: 'Bearer tok-x',
      'x-organization-id': 'org-y',
    });
  });

  it('uses custom header name in authMode: header', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'header' });
    configureAuth({ getToken: () => 'key-z', headerName: 'x-api-key' });

    const headers = arcAuthHeaders();

    expect(headers).toEqual({ 'x-api-key': 'key-z' });
  });

  it('omits Authorization in cookie mode', () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });
    configureAuth({ getToken: () => 'unused', getOrgId: () => 'org-y' });

    const headers = arcAuthHeaders();

    expect(headers).toEqual({ 'x-organization-id': 'org-y' });
  });

  it('includes x-internal-api-key when configureClient sets it', () => {
    configureClient({ baseUrl: 'http://api.test', internalApiKey: 'srv-key' });
    configureAuth({ getToken: () => 'tok', getOrgId: () => null });

    const headers = arcAuthHeaders();

    expect(headers['x-internal-api-key']).toBe('srv-key');
    expect(headers.Authorization).toBe('Bearer tok');
  });
});
