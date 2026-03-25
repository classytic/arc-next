import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// Each test gets a fresh module to avoid singleton leakage between tests.
async function loadFresh() {
  vi.resetModules();
  return import('../src/query-client.js');
}

describe('getQueryClient', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns a QueryClient instance', async () => {
    const { getQueryClient } = await loadFresh();
    const client = getQueryClient();
    expect(client).toBeInstanceOf(QueryClient);
  });

  it('returns same instance on repeated calls (browser singleton)', async () => {
    const { getQueryClient } = await loadFresh();
    const a = getQueryClient();
    const b = getQueryClient();
    expect(a).toBe(b);
  });

  it('has correct default options', async () => {
    const { getQueryClient } = await loadFresh();
    const client = getQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(5 * 60 * 1000);
    expect(defaults.queries?.gcTime).toBe(30 * 60 * 1000);
    expect(defaults.queries?.retry).toBe(0);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });

  it('applies overrides on first call', async () => {
    const { getQueryClient } = await loadFresh();
    const client = getQueryClient({ staleTime: 1_000, gcTime: 5_000 });
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(1_000);
    expect(defaults.queries?.gcTime).toBe(5_000);
    // Non-overridden values keep defaults
    expect(defaults.queries?.retry).toBe(0);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });

  it('ignores overrides on subsequent calls and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getQueryClient } = await loadFresh();

    const first = getQueryClient({ staleTime: 1_000 });
    const second = getQueryClient({ staleTime: 99_000 });

    // Same singleton returned
    expect(second).toBe(first);

    // First call's overrides win
    expect(first.getDefaultOptions().queries?.staleTime).toBe(1_000);

    // Warning emitted
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('overrides are ignored'),
    );

    warnSpy.mockRestore();
  });

  it('does not warn when second call has no overrides', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getQueryClient } = await loadFresh();

    getQueryClient({ staleTime: 1_000 });
    getQueryClient(); // no overrides

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns the singleton even without overrides', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getQueryClient } = await loadFresh();

    const first = getQueryClient();
    const second = getQueryClient();
    const third = getQueryClient({ staleTime: 50_000 }); // ignored

    expect(first).toBe(second);
    expect(first).toBe(third);
    warnSpy.mockRestore();
  });

  it('dehydrate config includes pending queries', async () => {
    const { getQueryClient } = await loadFresh();
    const client = getQueryClient();
    const dehydrateOpts = client.getDefaultOptions().dehydrate;
    expect(dehydrateOpts?.shouldDehydrateQuery).toBeDefined();
  });
});
