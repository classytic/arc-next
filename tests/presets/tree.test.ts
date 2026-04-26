import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureClient } from '../../src/client.js';
import { createCrudApi } from '../../src/api.js';
import { withTree } from '../../src/presets/tree.js';

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

describe('withTree', () => {
  it('getTree GETs /:resource/tree', async () => {
    const api = withTree(createCrudApi('categories', { basePath: '/api' }));
    await api.getTree();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/categories/tree'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getChildren GETs /:resource/:parentId/children', async () => {
    const api = withTree(createCrudApi('categories', { basePath: '/api' }));
    await api.getChildren({ parentId: 'parent-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/categories/parent-1/children'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('getChildren throws when parentId is empty', async () => {
    const api = withTree(createCrudApi('categories', { basePath: '/api' }));
    await expect(api.getChildren({ parentId: '' })).rejects.toThrow('Parent ID is required');
  });

  it('getChildren merges defaultParams', async () => {
    const api = withTree(
      createCrudApi('categories', { basePath: '/api', defaultParams: { limit: 7 } }),
    );
    await api.getChildren({ parentId: 'p' });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('limit=7');
  });

  it('vanilla createCrudApi has no tree methods', () => {
    const vanilla = createCrudApi('categories', { basePath: '/api' });
    // @ts-expect-error
    void vanilla.getTree;
    // @ts-expect-error
    void vanilla.getChildren;
  });
});
