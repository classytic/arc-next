/**
 * Next.js App Router fetch options — the host-facing data-fetching contract.
 *
 * A Next host can pass the idiomatic `next: { revalidate, tags }` object (1:1
 * with what they'd hand to `fetch`), the flattened `revalidate`/`tags`, or
 * both (merged). `revalidate: false` caches indefinitely. `cache` passes
 * straight through. All land on the underlying `fetch(url, init)` call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCrudApi } from '../src/api.js';
import { configureClient } from '../src/client.js';

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configureClient({ baseUrl: 'http://api.test' });
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});
afterEach(() => fetchMock.mockRestore());

function lastInit(): RequestInit & { next?: { revalidate?: number | false; tags?: string[] } } {
  return fetchMock.mock.calls.at(-1)![1] as never;
}

describe('Next.js fetch options', () => {
  const api = () => createCrudApi('things', { basePath: '/api' });

  it('forwards the idiomatic next:{revalidate,tags} object to fetch', async () => {
    await api().getAll({ options: { next: { revalidate: 60, tags: ['things'] } } });
    expect(lastInit().next).toEqual({ revalidate: 60, tags: ['things'] });
  });

  it('supports revalidate:false (cache indefinitely)', async () => {
    await api().getAll({ options: { revalidate: false } });
    expect(lastInit().next).toEqual({ revalidate: false });
  });

  it('merges flattened tags with next.tags (union, no drop)', async () => {
    await api().getAll({ options: { next: { tags: ['a'] }, tags: ['b'] } });
    expect(lastInit().next?.tags).toEqual(['a', 'b']);
  });

  it('flattened revalidate wins over next.revalidate', async () => {
    await api().getAll({ options: { next: { revalidate: 10 }, revalidate: 99 } });
    expect(lastInit().next?.revalidate).toBe(99);
  });

  it('passes cache through to fetch', async () => {
    await api().getAll({ options: { cache: 'force-cache' } });
    expect(lastInit().cache).toBe('force-cache');
  });

  it('omits next entirely when no cache directives are given', async () => {
    await api().getAll({ options: { cache: undefined } });
    expect(lastInit().next).toBeUndefined();
  });
});

/**
 * Regression: the instance `cache` default (`no-store`) must be ISR-aware.
 *
 * A bare read defaults to `no-store` (correct — dynamic by default). But a
 * caller asking for `revalidate` is opting into ISR, and forcing `no-store`
 * alongside it makes Next.js throw ("cache: 'no-store' and revalidate are
 * contradictory") and otherwise pins the route dynamic — so a single read can
 * never be cached. `withCacheDefault` gates the default on caller intent. This
 * is what lets a storefront product page's per-call `revalidate` produce an
 * actually-cacheable fetch instead of a silently-dynamic one.
 */
describe('no-store default is revalidate-aware (withCacheDefault)', () => {
  const api = () => createCrudApi('things', { basePath: '/api' });

  it('a bare read defaults to cache:no-store (dynamic) with no next', async () => {
    await api().getAll({});
    expect(lastInit().cache).toBe('no-store');
    expect(lastInit().next).toBeUndefined();
  });

  it('per-call revalidate is NOT clobbered by the no-store default → ISR', async () => {
    await api().getAll({ options: { revalidate: 60 } });
    expect(lastInit().cache).toBeUndefined(); // the fix — never no-store here
    expect(lastInit().next).toEqual({ revalidate: 60 });
  });

  it('explicit cache wins over the no-store default', async () => {
    await api().getAll({ options: { cache: 'force-cache' } });
    expect(lastInit().cache).toBe('force-cache');
  });

  it('request() (the path getBySlug/custom routes use) is ISR-aware too', async () => {
    // getBySlug rides BaseApi.request via the slugLookup preset; this is the
    // exact call shape the product detail page issues.
    await api().request('GET', '/api/things/slug/widget', { options: { revalidate: 300 } });
    expect(lastInit().cache).toBeUndefined();
    expect(lastInit().next).toEqual({ revalidate: 300 });
  });

  it('request() with no options stays no-store (dynamic) by default', async () => {
    await api().request('GET', '/api/things/slug/widget');
    expect(lastInit().cache).toBe('no-store');
    expect(lastInit().next).toBeUndefined();
  });
});
