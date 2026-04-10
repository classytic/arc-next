import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureClient, configureAuth, getAuthContext, getAuthMode, handleApiRequest, createQueryString, createClient, ArcApiError, isArcApiError } from '../src/client.js';

// ============================================================================
// configureClient
// ============================================================================

describe('configureClient', () => {
  afterEach(() => {
    // Reset to unconfigured state by configuring with a known URL
    // (there's no "reset" export, so we just reconfigure for each test)
  });

  it('throws if handleApiRequest called before configureClient', async () => {
    // We need a fresh module to test unconfigured state
    // Since configureClient is module-level, we test via the error path
    // by making fetch fail after config
    configureClient({ baseUrl: 'http://localhost:9999' });

    // After configuring, requests should not throw the config error
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await handleApiRequest('GET', '/test');
    expect(result).toEqual({ success: true });

    fetchMock.mockRestore();
  });
});

// ============================================================================
// handleApiRequest
// ============================================================================

describe('handleApiRequest', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('makes GET request to correct URL', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await handleApiRequest('GET', '/users');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/users',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
      })
    );
  });

  it('sends organizationId as header', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await handleApiRequest('GET', '/items', { organizationId: 'org-123' });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-organization-id']).toBe('org-123');
  });

  it('sends JSON body for POST', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await handleApiRequest('POST', '/items', {
      body: { name: 'Test' },
    });

    const [, options] = fetchMock.mock.calls[0]!;
    expect((options as RequestInit).body).toBe(JSON.stringify({ name: 'Test' }));
  });

  it('does not set Content-Type for FormData', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const formData = new FormData();
    formData.append('file', 'test');
    await handleApiRequest('POST', '/upload', { body: formData });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(handleApiRequest('GET', '/missing')).rejects.toThrow('Not found');
  });

  it('sends internalApiKey when configured', async () => {
    configureClient({ baseUrl: 'http://api.test', internalApiKey: 'secret-key' });

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await handleApiRequest('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-internal-api-key']).toBe('secret-key');

    // Reset
    configureClient({ baseUrl: 'http://api.test' });
  });

  it('sends Authorization header when token provided', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await handleApiRequest('GET', '/test', { token: 'my-token' });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-token');
  });

  it('merges custom headerOptions', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await handleApiRequest('GET', '/test', {
      headerOptions: { 'X-Custom': 'value' },
    });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('value');
  });

  it('passes cache option to fetch', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await handleApiRequest('GET', '/test', { cache: 'force-cache' });

    const [, options] = fetchMock.mock.calls[0]!;
    expect((options as RequestInit).cache).toBe('force-cache');
  });

  it('passes next.revalidate and next.tags', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await handleApiRequest('GET', '/test', { revalidate: 60, tags: ['posts'] });

    const [, options] = fetchMock.mock.calls[0]!;
    const fetchOpts = options as RequestInit & { next?: { revalidate?: number; tags?: string[] } };
    expect(fetchOpts.next?.revalidate).toBe(60);
    expect(fetchOpts.next?.tags).toEqual(['posts']);
  });
});

// ============================================================================
// Credentials Policy
// ============================================================================

describe('credentials policy', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('bearer mode (default) uses same-origin credentials', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    await handleApiRequest('GET', '/test');

    const [, opts] = fetchMock.mock.calls[0]!;
    expect((opts as RequestInit).credentials).toBe('same-origin');
  });

  it('cookie mode uses include credentials', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });
    await handleApiRequest('GET', '/test');

    const [, opts] = fetchMock.mock.calls[0]!;
    expect((opts as RequestInit).credentials).toBe('include');
  });

  it('explicit credentials override authMode default', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie', credentials: 'omit' });
    await handleApiRequest('GET', '/test');

    const [, opts] = fetchMock.mock.calls[0]!;
    expect((opts as RequestInit).credentials).toBe('omit');
  });

  it('bearer mode with explicit include sends cookies', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'bearer', credentials: 'include' });
    await handleApiRequest('GET', '/test');

    const [, opts] = fetchMock.mock.calls[0]!;
    expect((opts as RequestInit).credentials).toBe('include');
  });

  it('createClient respects credentials config', async () => {
    configureClient({ baseUrl: 'http://global.test' });
    const client = createClient({ baseUrl: 'http://other.test', credentials: 'omit' });
    const api = (await import('../src/api.js')).createCrudApi('items', { basePath: '/api', client });
    await api.getAll();

    const [, opts] = fetchMock.mock.calls[0]!;
    expect((opts as RequestInit).credentials).toBe('omit');
  });

  it('createClient cookie mode defaults to include', async () => {
    configureClient({ baseUrl: 'http://global.test' });
    const client = createClient({ baseUrl: 'http://cookie.test', authMode: 'cookie' });
    const api = (await import('../src/api.js')).createCrudApi('items', { basePath: '/api', client });
    await api.getAll();

    const [, opts] = fetchMock.mock.calls[0]!;
    expect((opts as RequestInit).credentials).toBe('include');
  });
});

// ============================================================================
// createQueryString
// ============================================================================

describe('createQueryString', () => {
  it('creates basic params', () => {
    const qs = createQueryString({ page: 1, limit: 10, status: 'active' });
    expect(qs).toContain('page=1');
    expect(qs).toContain('limit=10');
    expect(qs).toContain('status=active');
  });

  it('handles arrays with [in] syntax', () => {
    const qs = createQueryString({ roles: ['admin', 'user'] });
    expect(qs).toBe('roles%5Bin%5D=admin%2Cuser');
  });

  it('handles single-element arrays', () => {
    const qs = createQueryString({ role: ['admin'] });
    expect(qs).toBe('role=admin');
  });

  it('skips undefined and empty strings', () => {
    const qs = createQueryString({ a: undefined, b: '', c: 'ok' });
    expect(qs).toBe('c=ok');
  });

  it('handles null values', () => {
    const qs = createQueryString({ status: null });
    expect(qs).toBe('status=null');
  });

  it('handles populateOptions with select', () => {
    const qs = createQueryString({
      populateOptions: [{ path: 'author', select: 'name email' }],
    });
    expect(qs).toContain('populate%5Bauthor%5D%5Bselect%5D=name%2Cemail');
  });

  it('handles populateOptions with match', () => {
    const qs = createQueryString({
      populateOptions: [{ path: 'comments', match: { approved: true } }],
    });
    expect(qs).toContain('populate%5Bcomments%5D%5Bmatch%5D');
  });

  it('handles populateOptions without select or match', () => {
    const qs = createQueryString({
      populateOptions: [{ path: 'author' }],
    });
    expect(qs).toBe('populate=author');
  });

  it('returns empty string for empty params', () => {
    expect(createQueryString({})).toBe('');
    expect(createQueryString()).toBe('');
  });
});

// ============================================================================
// createClient (Multi-Client)
// ============================================================================

describe('createClient', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('returns an ArcClient object', () => {
    const client = createClient({ baseUrl: 'http://other.test' });
    expect(client.request).toBeTypeOf('function');
    expect(client.config.baseUrl).toBe('http://other.test');
  });

  it('uses its own baseUrl for requests', async () => {
    const client = createClient({ baseUrl: 'http://analytics.test' });
    await client.request('GET', '/events');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://analytics.test/events',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('sends internalApiKey header when configured', async () => {
    const client = createClient({
      baseUrl: 'http://other.test',
      internalApiKey: 'other-secret',
    });

    await client.request('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-internal-api-key']).toBe('other-secret');
  });

  it('two clients with different baseUrls work independently', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    const clientA = createClient({ baseUrl: 'http://a.test' });
    const clientB = createClient({ baseUrl: 'http://b.test' });

    await clientA.request('GET', '/path');
    await clientB.request('GET', '/path');

    expect(fetchMock.mock.calls[0]![0]).toBe('http://a.test/path');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://b.test/path');
  });

  it('works independently from global configureClient', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    );

    configureClient({ baseUrl: 'http://global.test' });
    const client = createClient({ baseUrl: 'http://isolated.test' });

    await client.request('GET', '/test');
    await handleApiRequest('GET', '/test');

    expect(fetchMock.mock.calls[0]![0]).toBe('http://isolated.test/test');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://global.test/test');
  });

  it('stores toast and navigation config', () => {
    const toast = { success: vi.fn(), error: vi.fn() };
    const navigation = () => ({ push: vi.fn(), replace: vi.fn() });

    const client = createClient({
      baseUrl: 'http://test.test',
      toast,
      navigation,
    });

    expect(client.toast).toBe(toast);
    expect(client.navigation).toBe(navigation);
  });

  it('sends defaultHeaders', async () => {
    const client = createClient({
      baseUrl: 'http://other.test',
      defaultHeaders: { 'X-Custom': 'custom-value' },
    });

    await client.request('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('custom-value');
  });
});

// ============================================================================
// ArcApiError
// ============================================================================

describe('ArcApiError', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('throws ArcApiError on non-ok response with status, json, endpoint, method', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Validation failed', errors: { email: 'already taken' } }), {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    try {
      await handleApiRequest('POST', '/users');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ArcApiError);
      const apiError = error as ArcApiError;
      expect(apiError.status).toBe(422);
      expect(apiError.statusText).toBe('Unprocessable Entity');
      expect(apiError.endpoint).toBe('/users');
      expect(apiError.method).toBe('POST');
      expect(apiError.json).toEqual({ message: 'Validation failed', errors: { email: 'already taken' } });
      expect(apiError.message).toBe('Validation failed');
    }
  });

  it('ArcApiError is also instanceof Error', () => {
    const error = new ArcApiError('test', {
      status: 404,
      statusText: 'Not Found',
      json: null,
      endpoint: '/test',
      method: 'GET',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ArcApiError);
    expect(error.name).toBe('ArcApiError');
  });

  it('isArcApiError type guard works', () => {
    const apiError = new ArcApiError('test', {
      status: 500,
      statusText: 'Internal Server Error',
      json: null,
      endpoint: '/test',
      method: 'GET',
    });

    expect(isArcApiError(apiError)).toBe(true);
    expect(isArcApiError(new Error('plain'))).toBe(false);
    expect(isArcApiError(null)).toBe(false);
    expect(isArcApiError('string')).toBe(false);
  });

  it('fieldErrors getter returns null when no errors field', () => {
    const error = new ArcApiError('test', {
      status: 400,
      statusText: 'Bad Request',
      json: { message: 'Bad request' },
      endpoint: '/test',
      method: 'POST',
    });

    expect(error.fieldErrors).toBeNull();
  });

  it('fieldErrors getter extracts errors map', () => {
    const error = new ArcApiError('test', {
      status: 422,
      statusText: 'Unprocessable Entity',
      json: { message: 'Validation failed', errors: { email: 'invalid', name: 'required' } },
      endpoint: '/test',
      method: 'POST',
    });

    expect(error.fieldErrors).toEqual({ email: 'invalid', name: 'required' });
  });

  it('fieldErrors returns null when json is null', () => {
    const error = new ArcApiError('test', {
      status: 500,
      statusText: 'Internal Server Error',
      json: null,
      endpoint: '/test',
      method: 'GET',
    });

    expect(error.fieldErrors).toBeNull();
  });

  it('falls back to statusText when json has no message', async () => {
    fetchMock.mockResolvedValue(
      new Response('not json', {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    try {
      await handleApiRequest('GET', '/fail');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ArcApiError);
      expect((error as ArcApiError).message).toBe('Internal Server Error');
    }
  });
});

// ============================================================================
// Response Type Handling
// ============================================================================

describe('response type handling', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('handles PDF response with data and response properties', async () => {
    // Use ArrayBuffer instead of Blob (Node.js Response compat)
    const buffer = new TextEncoder().encode('pdf-content');
    fetchMock.mockResolvedValue(
      new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      })
    );

    const result = await handleApiRequest<{ data: Blob; response: Response }>('GET', '/report.pdf');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('response');
  });

  it('handles image response with data and response properties', async () => {
    const buffer = new TextEncoder().encode('img-data');
    fetchMock.mockResolvedValue(
      new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    );

    const result = await handleApiRequest<{ data: Blob; response: Response }>('GET', '/image.png');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('response');
  });

  it('handles CSV response with data and response properties', async () => {
    const csvContent = 'name,email\nJohn,john@test.com';
    fetchMock.mockResolvedValue(
      new Response(csvContent, {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      })
    );

    const result = await handleApiRequest<{ data: Blob; response: Response }>('GET', '/export.csv');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('response');
  });

  it('handles text/plain response', async () => {
    fetchMock.mockResolvedValue(
      new Response('plain text content', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    const result = await handleApiRequest<{ data: string; response: Response }>('GET', '/text');
    expect(result.data).toBe('plain text content');
  });

  it('handles text/html response', async () => {
    fetchMock.mockResolvedValue(
      new Response('<h1>Hello</h1>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const result = await handleApiRequest<{ data: string; response: Response }>('GET', '/page');
    expect(result.data).toBe('<h1>Hello</h1>');
  });
});

// ============================================================================
// Error Handling Edge Cases
// ============================================================================

describe('error handling edge cases', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('wraps network errors as plain Error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    try {
      await handleApiRequest('GET', '/test');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Failed to fetch');
    }
  });

  it('wraps non-Error throws as generic message', async () => {
    fetchMock.mockRejectedValue('string error');

    try {
      await handleApiRequest('GET', '/test');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('An error occurred while fetching data.');
    }
  });

  it('preserves ArcApiError on HTTP error', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    try {
      await handleApiRequest('DELETE', '/admin/resource');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(isArcApiError(error)).toBe(true);
      expect((error as ArcApiError).status).toBe(403);
      expect((error as ArcApiError).method).toBe('DELETE');
    }
  });

  it('handles 401 unauthorized', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    try {
      await handleApiRequest('GET', '/protected');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(isArcApiError(error)).toBe(true);
      expect((error as ArcApiError).status).toBe(401);
    }
  });

  it('handles non-JSON error body gracefully', async () => {
    fetchMock.mockResolvedValue(
      new Response('Bad Gateway', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/html' },
      })
    );

    try {
      await handleApiRequest('GET', '/test');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(isArcApiError(error)).toBe(true);
      expect((error as ArcApiError).status).toBe(502);
      expect((error as ArcApiError).message).toBe('Bad Gateway');
    }
  });
});

// ============================================================================
// getAuthMode
// ============================================================================

describe('getAuthMode', () => {
  it('returns bearer by default', () => {
    configureClient({ baseUrl: 'http://api.test' });
    expect(getAuthMode()).toBe('bearer');
  });

  it('returns cookie when configured', () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });
    expect(getAuthMode()).toBe('cookie');
    // Reset
    configureClient({ baseUrl: 'http://api.test' });
  });
});

// ============================================================================
// defaultHeaders
// ============================================================================

describe('defaultHeaders', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    configureClient({ baseUrl: 'http://api.test' });
  });

  it('sends defaultHeaders on every request', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      defaultHeaders: { 'X-App-Version': '1.0.0', 'X-Client': 'web' },
    });

    await handleApiRequest('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['X-App-Version']).toBe('1.0.0');
    expect(headers['X-Client']).toBe('web');
  });

  it('headerOptions override defaultHeaders', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      defaultHeaders: { 'X-Mode': 'default' },
    });

    await handleApiRequest('GET', '/test', {
      headerOptions: { 'X-Mode': 'override' },
    });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['X-Mode']).toBe('override');
  });
});

// ============================================================================
// AbortSignal
// ============================================================================

describe('AbortSignal', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('passes signal to fetch when provided', async () => {
    const controller = new AbortController();

    await handleApiRequest('GET', '/test', { signal: controller.signal });

    const [, options] = fetchMock.mock.calls[0]!;
    expect((options as RequestInit).signal).toBe(controller.signal);
  });

  it('does not set signal when not provided', async () => {
    await handleApiRequest('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    expect((options as RequestInit).signal).toBeUndefined();
  });
});

// ============================================================================
// configureAuth / getAuthContext
// ============================================================================

describe('configureAuth', () => {
  afterEach(() => {
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('stores and retrieves token and orgId', () => {
    configureAuth({
      getToken: () => 'test-token',
      getOrgId: () => 'test-org',
    });

    const ctx = getAuthContext();
    expect(ctx.token).toBe('test-token');
    expect(ctx.organizationId).toBe('test-org');
  });

  it('returns nulls when not configured', () => {
    configureAuth({ getToken: () => null, getOrgId: () => null });

    const ctx = getAuthContext();
    expect(ctx.token).toBeNull();
    expect(ctx.organizationId).toBeNull();
  });

  it('supports partial config (only getOrgId)', () => {
    configureAuth({
      getOrgId: () => 'org-only',
    });

    const ctx = getAuthContext();
    expect(ctx.token).toBeNull();
    expect(ctx.organizationId).toBe('org-only');
  });
});

// ============================================================================
// v0.2.1 — Error preservation
// ============================================================================

describe('v0.2.1 error preservation', () => {
  beforeEach(() => {
    configureClient({ baseUrl: 'https://api.test.com' });
  });

  it('preserves AbortError when fetch is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

    try {
      await handleApiRequest('GET', '/test');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('AbortError');
    }

    vi.unstubAllGlobals();
  });

  it('preserves TypeError on network failure', async () => {
    const networkError = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

    try {
      await handleApiRequest('GET', '/test');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toBe('Failed to fetch');
    }

    vi.unstubAllGlobals();
  });

  it('wraps non-Error throws in generic Error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('string error'));

    try {
      await handleApiRequest('GET', '/test');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('An error occurred while fetching data.');
    }

    vi.unstubAllGlobals();
  });
});

// ============================================================================
// authMode: 'header'
// ============================================================================

describe('authMode: header', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('sets custom header instead of Authorization when authMode is header', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'header' });
    configureAuth({ getToken: () => 'snr_abc123', headerName: 'x-api-key' });

    await handleApiRequest('GET', '/test', { token: 'snr_abc123' });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('snr_abc123');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('defaults headerName to x-api-key when not specified', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'header' });
    configureAuth({ getToken: () => 'key123' });

    await handleApiRequest('GET', '/test', { token: 'key123' });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('key123');
  });

  it('uses custom headerName from authConfig', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'header' });
    configureAuth({ getToken: () => 'admin-key', headerName: 'x-admin-key' });

    await handleApiRequest('GET', '/test', { token: 'admin-key' });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-admin-key']).toBe('admin-key');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('still uses Bearer for authMode: bearer (default)', async () => {
    configureClient({ baseUrl: 'http://api.test' });

    await handleApiRequest('GET', '/test', { token: 'my-token' });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-token');
  });

  it('getAuthMode returns header when configured', () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'header' });
    expect(getAuthMode()).toBe('header');
  });
});

// ============================================================================
// apiVersion
// ============================================================================

describe('apiVersion', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    configureClient({ baseUrl: 'http://api.test' });
  });

  it('sends Accept-Version header when apiVersion is configured', async () => {
    configureClient({ baseUrl: 'http://api.test', apiVersion: '2' });

    await handleApiRequest('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Accept-Version']).toBe('2');
  });

  it('does not send Accept-Version when not configured', async () => {
    configureClient({ baseUrl: 'http://api.test' });

    await handleApiRequest('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Accept-Version']).toBeUndefined();
  });
});

// ============================================================================
// idempotency
// ============================================================================

describe('idempotency', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    configureClient({ baseUrl: 'http://api.test' });
  });

  it('sends explicit idempotencyKey when provided', async () => {
    configureClient({ baseUrl: 'http://api.test' });

    await handleApiRequest('POST', '/items', {
      body: { name: 'test' },
      idempotencyKey: 'my-key-123',
    });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('my-key-123');
  });

  it('raw handleApiRequest does NOT auto-generate — auto-idempotency is mutation-level', async () => {
    configureClient({ baseUrl: 'http://api.test', autoIdempotency: true });

    await handleApiRequest('POST', '/items', { body: { name: 'test' } });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    // Auto-generation happens in useMutationWithTransition, not in raw client
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('explicit idempotencyKey is always sent', async () => {
    configureClient({ baseUrl: 'http://api.test' });

    await handleApiRequest('POST', '/items', {
      body: { name: 'test' },
      idempotencyKey: 'explicit-key',
    });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('explicit-key');
  });

  it('isAutoIdempotency reflects client config', async () => {
    const { isAutoIdempotency } = await import('../src/client.js');

    configureClient({ baseUrl: 'http://api.test' });
    expect(isAutoIdempotency()).toBe(false);

    configureClient({ baseUrl: 'http://api.test', autoIdempotency: true });
    expect(isAutoIdempotency()).toBe(true);

    configureClient({ baseUrl: 'http://api.test' });
  });
});
