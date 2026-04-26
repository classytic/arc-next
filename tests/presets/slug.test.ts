import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureClient } from '../../src/client.js';
import { createCrudApi } from '../../src/api.js';
import { withSlugLookup } from '../../src/presets/slug.js';

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configureClient({ baseUrl: 'http://api.test' });
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => fetchMock.mockRestore());

describe('withSlugLookup', () => {
  it('GETs /:resource/slug/:slug', async () => {
    const api = withSlugLookup(createCrudApi('articles', { basePath: '/api' }));
    await api.getBySlug({ slug: 'my-article' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/articles/slug/my-article'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('appends select/populate params', async () => {
    const api = withSlugLookup(createCrudApi('articles', { basePath: '/api' }));
    await api.getBySlug({ slug: 'my-article', params: { select: 'title,body' } });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('select=title%2Cbody');
  });

  it('throws when slug is empty', async () => {
    const api = withSlugLookup(createCrudApi('articles', { basePath: '/api' }));
    await expect(api.getBySlug({ slug: '' })).rejects.toThrow('Slug is required');
  });

  it('vanilla createCrudApi has no getBySlug', () => {
    const vanilla = createCrudApi('articles', { basePath: '/api' });
    // @ts-expect-error
    void vanilla.getBySlug;
  });
});
