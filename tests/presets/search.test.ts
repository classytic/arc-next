import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureClient } from '../../src/client.js';
import { createCrudApi } from '../../src/api.js';
import { withSearchPreset } from '../../src/presets/search.js';

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configureClient({ baseUrl: 'http://api.test' });
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => fetchMock.mockRestore());

describe('withSearchPreset', () => {
  it('searchEngine POSTs to /search with body.query', async () => {
    const api = withSearchPreset(createCrudApi('places', { basePath: '/api/v1' }));
    await api.searchEngine({ query: 'park' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/places/search');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ query: 'park' });
  });

  it('searchEngine merges body fields with query', async () => {
    const api = withSearchPreset(createCrudApi('places', { basePath: '/api/v1' }));
    await api.searchEngine({ query: 'park', body: { filter: { category: 'park' }, topK: 10 } });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ filter: { category: 'park' }, topK: 10, query: 'park' });
  });

  it('searchSimilar POSTs to /search-similar with vector', async () => {
    const api = withSearchPreset(createCrudApi('places', { basePath: '/api/v1' }));
    await api.searchSimilar({ vector: [0.1, 0.2, 0.3] });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/places/search-similar');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ vector: [0.1, 0.2, 0.3] });
  });

  it('searchSimilar accepts query + vector together', async () => {
    const api = withSearchPreset(createCrudApi('places', { basePath: '/api/v1' }));
    await api.searchSimilar({ query: 'q', vector: [1, 2], body: { topK: 3 } });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ topK: 3, query: 'q', vector: [1, 2] });
  });

  it('embed POSTs to /embed with input', async () => {
    const api = withSearchPreset(createCrudApi('places', { basePath: '/api/v1' }));
    await api.embed({ input: 'hello world' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/api/v1/places/embed');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ input: 'hello world' });
  });

  it('embed accepts array input + extra body fields', async () => {
    const api = withSearchPreset(createCrudApi('places', { basePath: '/api/v1' }));
    await api.embed({ input: ['a', 'b'], body: { model: 'small' } });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ input: ['a', 'b'], model: 'small' });
  });

  it('custom path overrides default route', async () => {
    const api = withSearchPreset(createCrudApi('places', { basePath: '/api/v1' }));
    await api.searchEngine({ query: 'q', path: '/custom-search' });

    expect(fetchMock.mock.calls[0]![0]).toBe('http://api.test/api/v1/places/custom-search');
  });

  it('vanilla createCrudApi has no search preset methods', () => {
    const vanilla = createCrudApi('places', { basePath: '/api/v1' });
    // @ts-expect-error
    void vanilla.searchEngine;
    // @ts-expect-error
    void vanilla.searchSimilar;
    // @ts-expect-error
    void vanilla.embed;
  });
});

// ============================================================================
// Composition — multiple presets stack via nested function calls
// ============================================================================

describe('preset composition', () => {
  it('stacks withSoftDelete + withBulk + withSearchPreset on one api', async () => {
    const { withSoftDelete } = await import('../../src/presets/soft-delete.js');
    const { withBulk } = await import('../../src/presets/bulk.js');

    const api = withSearchPreset(
      withBulk(withSoftDelete(createCrudApi('items', { basePath: '/api' }))),
    );

    // All three preset surfaces present + typed
    expect(typeof api.getDeleted).toBe('function');
    expect(typeof api.restore).toBe('function');
    expect(typeof api.bulkCreate).toBe('function');
    expect(typeof api.bulkUpdate).toBe('function');
    expect(typeof api.bulkDelete).toBe('function');
    expect(typeof api.searchEngine).toBe('function');
    expect(typeof api.searchSimilar).toBe('function');
    expect(typeof api.embed).toBe('function');

    // Plus the always-on backbone
    expect(typeof api.getAll).toBe('function');
    expect(typeof api.dispatchAction).toBe('function');
    expect(typeof api.invokeRoute).toBe('function');
  });
});
