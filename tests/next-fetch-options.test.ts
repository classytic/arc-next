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
