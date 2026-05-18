/**
 * SSE auth-recovery — 0.7 wires EventSource errors through a pre-flight
 * fetch probe, then through the shared `onAuthError` cycle when the probe
 * comes back 401 (or 403 with `retryOn403`). Verifies:
 *
 *  - error + probe returns 401 → handler runs → reconnect with new auth
 *  - error + probe returns 200 → handler NOT called, normal backoff
 *  - error + probe returns 500 → handler NOT called, normal backoff
 *  - 403 + retryOn403:true → handler runs (matches fetch + WS + upload contract)
 *  - 'skip' decision → no immediate reconnect via auth path (falls back to backoff)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureAuth,
  configureClient,
  createAuthRefreshHandler,
  _resetAuthRecovery,
  _resetAuthWarnings,
} from '../src/client.js';
import { subscribeToEvents } from '../src/sse.js';

// ── MockEventSource — doesn't auto-open; tests control timing.
class MockES {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockES[] = [];

  url: string;
  withCredentials: boolean;
  readyState = 0;
  closed = false;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    MockES.instances.push(this);
  }

  close(): void { this.closed = true; this.readyState = 2; }
  addEventListener(): void { /* not exercised here */ }
  removeEventListener(): void { /* not exercised here */ }

  triggerOpen(): void { this.readyState = 1; this.onopen?.(new Event('open')); }
  triggerError(): void { this.onerror?.(new Event('error')); }

  static reset(): void { MockES.instances = []; }
  static all(): MockES[] { return MockES.instances; }
  static latest(): MockES {
    const x = MockES.instances[MockES.instances.length - 1];
    if (!x) throw new Error('no MockES opened');
    return x;
  }
}

const originalES = (globalThis as Record<string, unknown>).EventSource;

function mockProbeFetch(status: number): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((
    _input: string | URL | Request,
    _init?: RequestInit,
  ) =>
    Promise.resolve(
      new Response(JSON.stringify({}), { status, headers: { 'Content-Type': 'application/json' } }),
    )) as typeof globalThis.fetch);
}

beforeEach(() => {
  MockES.reset();
  (globalThis as Record<string, unknown>).EventSource = MockES;
  configureClient({ baseUrl: 'http://api.test' });
  configureAuth({ getToken: () => null, getOrgId: () => null });
  _resetAuthRecovery();
  _resetAuthWarnings();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (originalES) (globalThis as Record<string, unknown>).EventSource = originalES;
  else delete (globalThis as Record<string, unknown>).EventSource;
  vi.restoreAllMocks();
});

describe('subscribeToEvents — auth-recovery via pre-flight probe', () => {
  it('error + probe returns 401 → handler refreshes → reconnect with new token', async () => {
    let cached = 'stale-tok';
    const refresh = vi.fn(async () => {
      cached = 'fresh-tok';
      return 'fresh-tok';
    });
    configureAuth({
      getToken: () => cached,
      onAuthError: createAuthRefreshHandler({ refresh }),
    });
    mockProbeFetch(401);

    const handle = subscribeToEvents({ resource: 'todo' });

    expect(MockES.all()).toHaveLength(1);
    MockES.latest().triggerOpen();
    MockES.latest().triggerError(); // simulates server kick

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
    expect(MockES.all()[1]!.url).toContain('token=fresh-tok');

    handle.close();
  });

  it('error + probe returns 200 → handler NOT called, normal backoff reconnect', async () => {
    const refresh = vi.fn();
    configureAuth({
      getToken: () => 'tok',
      onAuthError: createAuthRefreshHandler({ refresh }),
    });
    mockProbeFetch(200);

    const handle = subscribeToEvents({ resource: 'todo', reconnectDelay: 10 });
    MockES.latest().triggerOpen();
    MockES.latest().triggerError();

    // Backoff reconnect schedules a new EventSource after delay.
    await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
    expect(refresh).not.toHaveBeenCalled();

    handle.close();
  });

  it('error + probe returns 500 → handler NOT called, normal backoff reconnect', async () => {
    const refresh = vi.fn();
    configureAuth({
      getToken: () => 'tok',
      onAuthError: createAuthRefreshHandler({ refresh }),
    });
    mockProbeFetch(500);

    const handle = subscribeToEvents({ resource: 'todo', reconnectDelay: 10 });
    MockES.latest().triggerOpen();
    MockES.latest().triggerError();

    await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
    expect(refresh).not.toHaveBeenCalled();

    handle.close();
  });

  it('error + probe returns 403 + retryOn403:true → handler runs', async () => {
    const refresh = vi.fn(async () => 'fresh');
    configureAuth({
      getToken: () => 'tok',
      retryOn403: true,
      onAuthError: createAuthRefreshHandler({ refresh }),
    });
    mockProbeFetch(403);

    const handle = subscribeToEvents({ resource: 'todo' });
    MockES.latest().triggerOpen();
    MockES.latest().triggerError();

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    handle.close();
  });

  it('error + probe returns 403 + retryOn403:false (default) → handler NOT called', async () => {
    const refresh = vi.fn();
    configureAuth({
      getToken: () => 'tok',
      onAuthError: createAuthRefreshHandler({ refresh }),
    });
    mockProbeFetch(403);

    const handle = subscribeToEvents({ resource: 'todo', reconnectDelay: 10 });
    MockES.latest().triggerOpen();
    MockES.latest().triggerError();

    await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
    expect(refresh).not.toHaveBeenCalled();

    handle.close();
  });

  it("'skip' decision → no immediate reconnect via auth path (backoff still kicks in eventually)", async () => {
    configureAuth({
      getToken: () => 'tok',
      onAuthError: async () => 'skip',
    });
    mockProbeFetch(401);

    const handle = subscribeToEvents({ resource: 'todo', reconnectDelay: 50 });
    MockES.latest().triggerOpen();
    MockES.latest().triggerError();

    // Wait long enough for ONLY the auth path to settle (probe ~instant).
    // Auth path returned 'skip' → falls through to backoff (50ms delay).
    await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));

    handle.close();
  });

  it('probe network failure (fetch throws) → falls back to backoff reconnect (transient classification)', async () => {
    const refresh = vi.fn();
    configureAuth({
      getToken: () => 'tok',
      onAuthError: createAuthRefreshHandler({ refresh }),
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));

    const handle = subscribeToEvents({ resource: 'todo', reconnectDelay: 10 });
    MockES.latest().triggerOpen();
    MockES.latest().triggerError();

    await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
    expect(refresh).not.toHaveBeenCalled();

    handle.close();
  });
});
