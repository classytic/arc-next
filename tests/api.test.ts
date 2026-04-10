import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaseApi, createCrudApi, isOffsetPagination, isKeysetPagination, isAggregatePagination } from '../src/api.js';
import { configureClient, createClient } from '../src/client.js';

describe('BaseApi', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, docs: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe('constructor', () => {
    it('creates with default config', () => {
      const api = new BaseApi('products');
      expect(api.entity).toBe('products');
      expect(api.baseUrl).toBe('/api/v1/products');
    });

    it('accepts custom basePath', () => {
      const api = new BaseApi('products', { basePath: '/api' });
      expect(api.baseUrl).toBe('/api/products');
    });

    it('merges default params', () => {
      const api = new BaseApi('products', { defaultParams: { limit: 20 } });
      expect(api.config.defaultParams.limit).toBe(20);
      expect(api.config.defaultParams.page).toBe(1);
    });
  });

  describe('prepareParams', () => {
    const api = new BaseApi('test');

    it('always includes critical filters', () => {
      const result = api.prepareParams({ organizationId: undefined as unknown as string });
      expect(result.organizationId).toBeNull();
    });

    it('keeps organizationId value when provided', () => {
      const result = api.prepareParams({ organizationId: 'org-1' });
      expect(result.organizationId).toBe('org-1');
    });

    it('parses page and limit as integers', () => {
      const result = api.prepareParams({ page: '3' as unknown as number, limit: '25' as unknown as number });
      expect(result.page).toBe(3);
      expect(result.limit).toBe(25);
    });

    it('defaults page to 1 and limit to 10 on invalid', () => {
      const result = api.prepareParams({ page: 'abc' as unknown as number, limit: 'xyz' as unknown as number });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('converts multi-element arrays to [in] syntax', () => {
      const result = api.prepareParams({ status: ['active', 'pending'] });
      expect(result['status[in]']).toBe('active,pending');
    });

    it('converts single-element arrays to plain value', () => {
      const result = api.prepareParams({ status: ['active'] });
      expect(result.status).toBe('active');
    });

    it('skips undefined and empty strings', () => {
      const result = api.prepareParams({ a: undefined, b: '' });
      expect(result).not.toHaveProperty('a');
      expect(result).not.toHaveProperty('b');
    });

    it('passes populateOptions through', () => {
      const opts = [{ path: 'author', select: 'name' }];
      const result = api.prepareParams({ populateOptions: opts });
      expect(result.populateOptions).toEqual(opts);
    });

    it('skips empty populateOptions', () => {
      const result = api.prepareParams({ populateOptions: [] });
      expect(result).not.toHaveProperty('populateOptions');
    });
  });

  describe('CRUD methods', () => {
    it('getAll sends GET with query params', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.getAll({ params: { page: 2, limit: 5 } });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/items?'),
        expect.objectContaining({ method: 'GET' })
      );
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('page=2');
      expect(url).toContain('limit=5');
    });

    it('getById sends GET to /entity/:id', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.getById({ id: '123' });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/api/items/123',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('getById throws if no id', async () => {
      const api = createCrudApi('items');
      await expect(api.getById({ id: '' })).rejects.toThrow('ID is required');
    });

    it('create sends POST with body', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.create({ data: { name: 'New Item' } });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/api/items',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'New Item' }),
        })
      );
    });

    it('update sends PATCH with body', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.update({ id: '123', data: { name: 'Updated' } });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/api/items/123',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: 'Updated' }),
        })
      );
    });

    it('delete sends DELETE', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.delete({ id: '123' });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/api/items/123',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('search combines searchParams and params', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.search({
        searchParams: { 'name[contains]': 'test' },
        params: { page: 1 },
      });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('page=1');
      expect(url).toContain('name%5Bcontains%5D=test');
    });

    it('findBy with operator uses bracket syntax', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.findBy({ field: 'price', value: 100, operator: 'gte' });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('price%5Bgte%5D=100');
    });

    it('findBy without operator uses direct field', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.findBy({ field: 'status', value: 'active' });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('status=active');
    });

    it('findBy throws without field or value', async () => {
      const api = createCrudApi('items');
      await expect(api.findBy({ field: '', value: 'x' })).rejects.toThrow('Field and value are required');
      await expect(api.findBy({ field: 'x', value: undefined })).rejects.toThrow('Field and value are required');
    });

    it('request sends to custom endpoint', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.request('POST', '/api/items/123/publish', { data: { now: true } });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/api/items/123/publish',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ now: true }),
        })
      );
    });

    it('passes organizationId header', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.getAll({ organizationId: 'org-abc' });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['x-organization-id']).toBe('org-abc');
    });
  });

  describe('config.headers', () => {
    it('sends instance headers on getAll', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        headers: { 'x-arc-scope': 'platform', 'x-custom': 'test' },
      });
      await api.getAll();

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['x-arc-scope']).toBe('platform');
      expect(headers['x-custom']).toBe('test');
    });

    it('sends instance headers on getById', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        headers: { 'x-arc-scope': 'platform' },
      });
      await api.getById({ id: '1' });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['x-arc-scope']).toBe('platform');
    });

    it('sends instance headers on create', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        headers: { 'x-arc-scope': 'platform' },
      });
      await api.create({ data: { name: 'test' } });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['x-arc-scope']).toBe('platform');
    });

    it('sends instance headers on update', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        headers: { 'x-arc-scope': 'platform' },
      });
      await api.update({ id: '1', data: { name: 'updated' } });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['x-arc-scope']).toBe('platform');
    });

    it('sends instance headers on delete', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        headers: { 'x-arc-scope': 'platform' },
      });
      await api.delete({ id: '1' });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['x-arc-scope']).toBe('platform');
    });

    it('sends instance headers on request()', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        headers: { 'x-arc-scope': 'platform' },
      });
      await api.request('POST', '/api/items/1/publish', { data: {} });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['x-arc-scope']).toBe('platform');
    });

    it('per-call headerOptions override instance headers', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        headers: { 'x-arc-scope': 'platform', 'x-keep': 'yes' },
      });
      await api.getAll({ options: { headerOptions: { 'x-arc-scope': 'member' } } });

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['x-arc-scope']).toBe('member');
      expect(headers['x-keep']).toBe('yes');
    });

    it('does not send headers when config.headers is empty', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.getAll();

      const [, options] = fetchMock.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['x-arc-scope']).toBeUndefined();
    });
  });
});

// ============================================================================
// Upload Method
// ============================================================================

describe('BaseApi upload', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('sends FormData via POST without Content-Type header', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    const formData = new FormData();
    formData.append('file', 'test-content');

    await api.upload({ data: formData });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/items',
      expect.objectContaining({ method: 'POST' })
    );
    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect((options as RequestInit).body).toBe(formData);
  });

  it('upload supports custom path suffix', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    const formData = new FormData();
    formData.append('file', 'test-content');

    await api.upload({ data: formData, path: 'import' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/items/import',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('upload sends organizationId header', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    const formData = new FormData();
    formData.append('file', 'test-content');

    await api.upload({ data: formData, organizationId: 'org-123' });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-organization-id']).toBe('org-123');
  });

  it('upload with id posts to baseUrl/{id}/upload', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    const formData = new FormData();
    formData.append('file', 'test-content');

    await api.upload({ data: formData, id: 'doc-123' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/items/doc-123/upload',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('upload path takes precedence over id', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    const formData = new FormData();
    formData.append('file', 'test-content');

    await api.upload({ data: formData, id: 'doc-123', path: 'bulk-import' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/items/bulk-import',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('upload without id or path posts to base collection URL', async () => {
    const api = createCrudApi('items', { basePath: '/api' });
    const formData = new FormData();
    formData.append('file', 'test-content');

    await api.upload({ data: formData });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/items',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

// ============================================================================
// Type Guards
// ============================================================================

describe('type guards', () => {
  it('isOffsetPagination', () => {
    expect(isOffsetPagination({ success: true, method: 'offset', docs: [], page: 1, limit: 10, total: 0, pages: 0, hasNext: false, hasPrev: false })).toBe(true);
    expect(isOffsetPagination({ success: true, method: 'keyset', docs: [], limit: 10, hasMore: false, next: null })).toBe(false);
  });

  it('isKeysetPagination', () => {
    expect(isKeysetPagination({ success: true, method: 'keyset', docs: [], limit: 10, hasMore: false, next: null })).toBe(true);
    expect(isKeysetPagination({ success: true, method: 'offset', docs: [], page: 1, limit: 10, total: 0, pages: 0, hasNext: false, hasPrev: false })).toBe(false);
  });

  it('isAggregatePagination', () => {
    expect(isAggregatePagination({ success: true, method: 'aggregate', docs: [], page: 1, limit: 10, total: 0, pages: 0, hasNext: false, hasPrev: false })).toBe(true);
    expect(isAggregatePagination({ success: true, method: 'offset', docs: [], page: 1, limit: 10, total: 0, pages: 0, hasNext: false, hasPrev: false })).toBe(false);
  });
});

// ============================================================================
// createCrudApi factory
// ============================================================================

describe('createCrudApi', () => {
  it('returns a BaseApi instance', () => {
    const api = createCrudApi('products');
    expect(api).toBeInstanceOf(BaseApi);
    expect(api.entity).toBe('products');
  });

  it('passes config through', () => {
    const api = createCrudApi('products', { basePath: '/v2' });
    expect(api.baseUrl).toBe('/v2/products');
  });
});

// ============================================================================
// BaseApi with ArcClient (Multi-Client)
// ============================================================================

describe('BaseApi with client', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://global.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, docs: [], total: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('uses client baseUrl instead of global', async () => {
    const client = createClient({ baseUrl: 'http://analytics.test' });
    const api = createCrudApi('events', { basePath: '/api', client });

    await api.getAll();

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('http://analytics.test/api/events');
  });

  it('global and client APIs coexist', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    const client = createClient({ baseUrl: 'http://other.test' });

    const globalApi = createCrudApi('items', { basePath: '/api' });
    const clientApi = createCrudApi('items', { basePath: '/api', client });

    await globalApi.getById({ id: '1' });
    await clientApi.getById({ id: '2' });

    expect(fetchMock.mock.calls[0]![0]).toBe('http://global.test/api/items/1');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://other.test/api/items/2');
  });

  it('client API sends POST with body', async () => {
    const client = createClient({ baseUrl: 'http://other.test' });
    const api = createCrudApi('items', { basePath: '/api', client });

    await api.create({ data: { name: 'New' } });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://other.test/api/items',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'New' }),
      })
    );
  });

  it('client API sends internalApiKey', async () => {
    const client = createClient({ baseUrl: 'http://other.test', internalApiKey: 'key-123' });
    const api = createCrudApi('items', { basePath: '/api', client });

    await api.getAll();

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-internal-api-key']).toBe('key-123');
  });

  // ========== v0.3.1: defaultParams merge into request methods ==========

  describe('defaultParams merge', () => {
    it('getAll includes defaultParams in query string', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        defaultParams: { limit: 25 },
      });

      await api.getAll({ params: { status: 'active' } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('limit=25');
      expect(url).toContain('status=active');
    });

    it('explicit params override defaultParams', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        defaultParams: { limit: 25 },
      });

      await api.getAll({ params: { limit: 50 } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('limit=50');
      expect(url).not.toContain('limit=25');
    });

    it('search includes defaultParams in query string', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        defaultParams: { limit: 15 },
      });

      await api.search({ searchParams: { q: 'test' } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('limit=15');
      expect(url).toContain('q=test');
    });

    it('findBy includes defaultParams in query string', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        defaultParams: { limit: 30 },
      });

      await api.findBy({ field: 'status', value: 'active' });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('limit=30');
      expect(url).toContain('status=active');
    });
  });

  // ==========================================================================
  // Soft Delete Preset
  // ==========================================================================

  describe('getDeleted', () => {
    it('sends GET to /deleted endpoint', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.getDeleted();

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('/api/items/deleted?');
      const [, options] = fetchMock.mock.calls[0]!;
      expect((options as RequestInit).method).toBe('GET');
    });

    it('passes pagination params', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.getDeleted({ params: { page: 2, limit: 5 } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('page=2');
      expect(url).toContain('limit=5');
    });
  });

  describe('restore', () => {
    it('sends POST to /:id/restore', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.restore({ id: 'abc' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/items/abc/restore'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('throws when id is empty', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await expect(api.restore({ id: '' })).rejects.toThrow('ID is required');
    });
  });

  // ==========================================================================
  // Bulk Preset
  // ==========================================================================

  describe('bulkCreate', () => {
    it('sends POST to /bulk with array body', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.bulkCreate({ data: [{ name: 'A' }, { name: 'B' }] });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/items/bulk'),
        expect.objectContaining({ method: 'POST' })
      );
      const [, options] = fetchMock.mock.calls[0]!;
      expect((options as RequestInit).body).toBe(JSON.stringify([{ name: 'A' }, { name: 'B' }]));
    });
  });

  describe('bulkUpdate', () => {
    it('sends PATCH to /bulk with filter and data', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.bulkUpdate({
        filter: { status: 'draft' },
        data: { status: 'published' },
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/items/bulk'),
        expect.objectContaining({ method: 'PATCH' })
      );
      const [, options] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((options as RequestInit).body as string);
      expect(body.filter).toEqual({ status: 'draft' });
      expect(body.data).toEqual({ status: 'published' });
    });
  });

  describe('bulkDelete', () => {
    it('sends DELETE to /bulk with filter', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.bulkDelete({ filter: { status: 'archived' } });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/items/bulk'),
        expect.objectContaining({ method: 'DELETE' })
      );
      const [, options] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((options as RequestInit).body as string);
      expect(body.filter).toEqual({ status: 'archived' });
    });
  });

  // ==========================================================================
  // Slug Lookup Preset
  // ==========================================================================

  describe('getBySlug', () => {
    it('sends GET to /slug/:slug', async () => {
      const api = createCrudApi('articles', { basePath: '/api' });
      await api.getBySlug({ slug: 'my-article' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/articles/slug/my-article'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('appends select/populate params', async () => {
      const api = createCrudApi('articles', { basePath: '/api' });
      await api.getBySlug({ slug: 'my-article', params: { select: 'title,body' } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('select=title%2Cbody');
    });

    it('throws when slug is empty', async () => {
      const api = createCrudApi('articles', { basePath: '/api' });
      await expect(api.getBySlug({ slug: '' })).rejects.toThrow('Slug is required');
    });
  });

  // ==========================================================================
  // Tree Preset
  // ==========================================================================

  describe('getTree', () => {
    it('sends GET to /tree', async () => {
      const api = createCrudApi('categories', { basePath: '/api' });
      await api.getTree();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/categories/tree?'),
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('getChildren', () => {
    it('sends GET to /:parentId/children', async () => {
      const api = createCrudApi('categories', { basePath: '/api' });
      await api.getChildren({ parentId: 'parent-1' });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/categories/parent-1/children?'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('throws when parentId is empty', async () => {
      const api = createCrudApi('categories', { basePath: '/api' });
      await expect(api.getChildren({ parentId: '' })).rejects.toThrow('Parent ID is required');
    });
  });

  // ==========================================================================
  // Lookup params
  // ==========================================================================

  describe('prepareParams — lookup', () => {
    const api = new BaseApi('test');

    it('serializes simple string lookup', () => {
      const result = api.prepareParams({ lookup: { dept: 'departments' } });
      expect(result['lookup[dept]']).toBe('departments');
    });

    it('serializes full lookup config', () => {
      const result = api.prepareParams({
        lookup: {
          dept: {
            from: 'departments',
            localField: 'deptId',
            foreignField: '_id',
            select: 'name',
          },
        },
      });
      expect(result['lookup[dept][from]']).toBe('departments');
      expect(result['lookup[dept][localField]']).toBe('deptId');
      expect(result['lookup[dept][foreignField]']).toBe('_id');
      expect(result['lookup[dept][select]']).toBe('name');
    });
  });
});
