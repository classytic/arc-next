import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureClient } from '../../src/client.js';
import { createCrudApi } from '../../src/api.js';
import { withSoftDelete } from '../../src/presets/soft-delete.js';

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configureClient({ baseUrl: 'http://api.test' });
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: [], total: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => fetchMock.mockRestore());

describe('withSoftDelete', () => {
  it('adds getDeleted method that GETs /:resource/deleted', async () => {
    const api = withSoftDelete(createCrudApi('items', { basePath: '/api' }));
    await api.getDeleted();

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/items/deleted?');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('GET');
  });

  it('getDeleted passes pagination params', async () => {
    const api = withSoftDelete(createCrudApi('items', { basePath: '/api' }));
    await api.getDeleted({ params: { page: 2, limit: 5 } });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('page=2');
    expect(url).toContain('limit=5');
  });

  it('getDeleted merges defaultParams', async () => {
    const api = withSoftDelete(
      createCrudApi('items', { basePath: '/api', defaultParams: { limit: 25 } }),
    );
    await api.getDeleted();

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('limit=25');
  });

  it('adds restore method that POSTs to /:id/restore', async () => {
    const api = withSoftDelete(createCrudApi('items', { basePath: '/api' }));
    await api.restore({ id: 'abc' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/items/abc/restore'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('restore throws when id is empty', async () => {
    const api = withSoftDelete(createCrudApi('items', { basePath: '/api' }));
    await expect(api.restore({ id: '' })).rejects.toThrow('ID is required');
  });

  it('restore forwards token + organizationId headers', async () => {
    const api = withSoftDelete(createCrudApi('items', { basePath: '/api' }));
    await api.restore({ id: 'x', token: 'tok', organizationId: 'org-1' });

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok');
    expect(headers['x-organization-id']).toBe('org-1');
  });

  it('vanilla createCrudApi has no getDeleted/restore (autocomplete clarity)', () => {
    const vanilla = createCrudApi('items', { basePath: '/api' });
    // @ts-expect-error — getDeleted only exists after withSoftDelete()
    void vanilla.getDeleted;
    // @ts-expect-error — restore only exists after withSoftDelete()
    void vanilla.restore;
  });
});
