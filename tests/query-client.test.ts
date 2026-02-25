import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// We need to test the module fresh each time since it uses module-level singleton
describe('getQueryClient', () => {
  it('returns a QueryClient instance', async () => {
    const { getQueryClient } = await import('../src/query-client.js');
    const client = getQueryClient();
    expect(client).toBeInstanceOf(QueryClient);
  });

  it('returns same instance on repeated calls (browser singleton)', async () => {
    const { getQueryClient } = await import('../src/query-client.js');
    const a = getQueryClient();
    const b = getQueryClient();
    expect(a).toBe(b);
  });

  it('has correct default options', async () => {
    const { getQueryClient } = await import('../src/query-client.js');
    const client = getQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(5 * 60 * 1000);
    expect(defaults.queries?.gcTime).toBe(30 * 60 * 1000);
    expect(defaults.queries?.retry).toBe(0);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });
});
