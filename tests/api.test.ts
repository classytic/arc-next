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

    // Former `search()` and `findBy()` methods were removed in 0.5.0 — both
    // were sugar over `getAll({ params })`. The next three cases prove the
    // bracket-key syntax that replaces them works correctly via getAll.

    it('getAll passes bracket-key contains operator (replaces search())', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.getAll({ params: { 'name[contains]': 'test', page: 1 } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('page=1');
      expect(url).toContain('name%5Bcontains%5D=test');
    });

    it('getAll passes bracket-key gte operator (replaces findBy with operator)', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.getAll({ params: { 'price[gte]': 100 } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('price%5Bgte%5D=100');
    });

    it('getAll passes direct field equality (replaces findBy without operator)', async () => {
      const api = createCrudApi('items', { basePath: '/api' });
      await api.getAll({ params: { status: 'active' } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('status=active');
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

    it('getAll free-text search includes defaultParams in query string', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        defaultParams: { limit: 15 },
      });

      await api.getAll({ params: { q: 'test' } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('limit=15');
      expect(url).toContain('q=test');
    });

    it('getAll single-field equality includes defaultParams in query string', async () => {
      const api = createCrudApi('items', {
        basePath: '/api',
        defaultParams: { limit: 30 },
      });

      await api.getAll({ params: { status: 'active' } });

      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('limit=30');
      expect(url).toContain('status=active');
    });
  });

  // ==========================================================================
  // Soft Delete Preset
  // ==========================================================================

  // Soft-delete, bulk, slug, tree presets all moved to tests/presets/*.test.ts
  // alongside their respective `withXxx()` factories. Only the always-on
  // BaseApi surface is tested here.

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

  // ==========================================================================
  // invokeRoute — generic helper for resource-relative custom routes
  // ==========================================================================

  describe('invokeRoute', () => {
    let invokeFetch: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: 'http://api.test' });
      invokeFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { ok: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    afterEach(() => invokeFetch.mockRestore());

    it('GET /:resource/<path> defaults to GET method', async () => {
      const api = createCrudApi('todos', { basePath: '/api/v1' });
      await api.invokeRoute({ path: '/stats' });

      expect(invokeFetch).toHaveBeenCalledWith(
        'http://api.test/api/v1/todos/stats',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('prepends slash automatically when omitted', async () => {
      const api = createCrudApi('todos', { basePath: '/api/v1' });
      await api.invokeRoute({ path: 'recent' });

      const url = invokeFetch.mock.calls[0]![0] as string;
      expect(url).toBe('http://api.test/api/v1/todos/recent');
    });

    it('passes params through prepareParams', async () => {
      const api = createCrudApi('todos', { basePath: '/api/v1' });
      await api.invokeRoute({ path: '/recent', params: { limit: 5, status: 'active' } });

      const url = invokeFetch.mock.calls[0]![0] as string;
      expect(url).toContain('limit=5');
      expect(url).toContain('status=active');
    });

    it('POST with body', async () => {
      const api = createCrudApi('products', { basePath: '/api/v1' });
      await api.invokeRoute({
        method: 'POST',
        path: '/import',
        data: { source: 'csv', count: 42 },
      });

      const [url, init] = invokeFetch.mock.calls[0]!;
      expect(url).toBe('http://api.test/api/v1/products/import');
      expect((init as RequestInit).method).toBe('POST');
      expect((init as RequestInit).body).toBe(JSON.stringify({ source: 'csv', count: 42 }));
    });

    it('forwards token + organizationId', async () => {
      const api = createCrudApi('todos', { basePath: '/api/v1' });
      await api.invokeRoute({
        path: '/stats',
        token: 'tok-1',
        organizationId: 'org-9',
      });

      const headers = (invokeFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer tok-1');
      expect(headers['x-organization-id']).toBe('org-9');
    });

    it('throws when path is empty', async () => {
      const api = createCrudApi('todos', { basePath: '/api/v1' });
      await expect(api.invokeRoute({ path: '' })).rejects.toThrow('path is required');
    });

    it('respects custom idField resource (uses entity name unchanged)', async () => {
      const api = createCrudApi('products', { basePath: '/api/v1' });
      await api.invokeRoute({ path: '/by-sku/SKU-1' });
      expect(invokeFetch.mock.calls[0]![0]).toBe('http://api.test/api/v1/products/by-sku/SKU-1');
    });
  });

  // ==========================================================================
  // action — POST /:id/action with { action, ...data }
  // ==========================================================================

  describe('action', () => {
    let actionFetch: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: 'http://api.test' });
      actionFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { _id: '1', status: 'completed' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    afterEach(() => actionFetch.mockRestore());

    it('POSTs to /:id/action with body { action }', async () => {
      const api = createCrudApi('todos', { basePath: '/api/v1' });
      await api.dispatchAction({ id: '123', action: 'complete' });

      const [url, init] = actionFetch.mock.calls[0]!;
      expect(url).toBe('http://api.test/api/v1/todos/123/action');
      expect((init as RequestInit).method).toBe('POST');
      expect((init as RequestInit).body).toBe(JSON.stringify({ action: 'complete' }));
    });

    it('flattens data into the body alongside action name', async () => {
      const api = createCrudApi('todos', { basePath: '/api/v1' });
      await api.dispatchAction({ id: '1', action: 'prioritize', data: { priority: 7 } });

      const body = (actionFetch.mock.calls[0]![1] as RequestInit).body as string;
      expect(JSON.parse(body)).toEqual({ action: 'prioritize', priority: 7 });
    });

    it('throws on missing id', async () => {
      const api = createCrudApi('todos', { basePath: '/api/v1' });
      await expect(api.dispatchAction({ id: '', action: 'complete' })).rejects.toThrow('ID is required');
    });

    it('throws on missing action name', async () => {
      const api = createCrudApi('todos', { basePath: '/api/v1' });
      await expect(api.dispatchAction({ id: '1', action: '' })).rejects.toThrow('Action name is required');
    });
  });

  // ==========================================================================
  // findBy with geo operators (mongokit URL grammar)
  // ==========================================================================

  describe('getAll — geo & range operators (mongokit URL grammar)', () => {
    let geoFetch: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      configureClient({ baseUrl: 'http://api.test' });
      geoFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ success: true, docs: [], total: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    afterEach(() => geoFetch.mockRestore());

    it('withinRadius preserves [lng, lat, radius] as comma-joined value', async () => {
      const api = createCrudApi('places', { basePath: '/api/v1' });
      await api.getAll({
        params: { 'location[withinRadius]': [-73.98, 40.75, 5000] },
      });

      const url = geoFetch.mock.calls[0]![0] as string;
      // Should NOT be `location[in]=...` — should be `location[withinRadius]=lng,lat,r`
      expect(url).toContain('location%5BwithinRadius%5D=-73.98%2C40.75%2C5000');
      expect(url).not.toContain('location%5Bin%5D');
    });

    it('near with maxDistance preserves [lng, lat, max]', async () => {
      const api = createCrudApi('places', { basePath: '/api/v1' });
      await api.getAll({
        params: { 'location[near]': [-73.98, 40.75, 4000] },
      });

      const url = geoFetch.mock.calls[0]![0] as string;
      expect(url).toContain('location%5Bnear%5D=-73.98%2C40.75%2C4000');
    });

    it('geoWithin bounding box [minLng, minLat, maxLng, maxLat]', async () => {
      const api = createCrudApi('places', { basePath: '/api/v1' });
      await api.getAll({
        params: { 'location[geoWithin]': [-74.02, 40.7, -73.93, 40.79] },
      });

      const url = geoFetch.mock.calls[0]![0] as string;
      expect(url).toContain('location%5BgeoWithin%5D=-74.02%2C40.7%2C-73.93%2C40.79');
    });

    it('non-geo operator still uses [in] for arrays', async () => {
      const api = createCrudApi('items', { basePath: '/api/v1' });
      await api.getAll({
        params: { 'status[in]': ['active', 'pending'] },
      });

      const url = geoFetch.mock.calls[0]![0] as string;
      // [in] operator → `field[in]=a,b`
      expect(url).toContain('status%5Bin%5D=active%2Cpending');
    });
  });

  // search preset moved to tests/presets/search.test.ts
});
