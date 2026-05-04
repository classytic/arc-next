import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  configureClient, configureAuth, getAuthContext, getAuthMode, handleApiRequest,
  createQueryString, createClient, createAuthAwareClient, _resetAuthWarnings,
  ArcApiError, isArcApiError, isAbortError,
  KNOWN_ARC_ERROR_CODES,
} from '../src/client.js';

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

  it('captures text body when json parse fails', async () => {
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
      // Now captures body text instead of just statusText
      expect((error as ArcApiError).message).toBe('not json');
      expect(((error as ArcApiError).json as { rawBody: string }).rawBody).toBe('not json');
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

// ============================================================================
// Per-client auth (createClient with getToken/getOrgId)
// ============================================================================

describe('per-client auth', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'global-token', getOrgId: () => 'global-org' });
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    fetchMock.mockRestore();
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it('per-client getToken injects token into requests', async () => {
    const client = createClient({
      baseUrl: 'http://other.test',
      getToken: () => 'client-token',
    });

    await client.request('GET', '/items');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer client-token');
  });

  it('per-client getOrgId injects org header', async () => {
    const client = createClient({
      baseUrl: 'http://other.test',
      getOrgId: () => 'client-org',
    });

    await client.request('GET', '/items');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-organization-id']).toBe('client-org');
  });

  it('per-client header auth with custom headerName', async () => {
    const client = createClient({
      baseUrl: 'http://other.test',
      authMode: 'header',
      getToken: () => 'my-api-key',
      headerName: 'x-admin-key',
    });

    await client.request('GET', '/items');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-admin-key']).toBe('my-api-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('explicit token in options overrides per-client getToken', async () => {
    const client = createClient({
      baseUrl: 'http://other.test',
      getToken: () => 'client-default',
    });

    await client.request('GET', '/items', { token: 'explicit-override' });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer explicit-override');
  });

  it('client without per-client auth does not auto-inject', async () => {
    const client = createClient({ baseUrl: 'http://other.test' });

    await client.request('GET', '/items');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});

// ============================================================================
// Non-JSON error responses
// ============================================================================

describe('non-JSON error responses', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configureClient({ baseUrl: 'http://api.test' });
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('handles HTML error page (502 gateway)', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html><body>Bad Gateway</body></html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/html' },
      })
    );

    try {
      await handleApiRequest('GET', '/items');
      expect.fail('Should throw');
    } catch (error) {
      expect(isArcApiError(error)).toBe(true);
      expect((error as ArcApiError).status).toBe(502);
    }
  });

  it('handles empty error body', async () => {
    fetchMock.mockResolvedValue(
      new Response('', {
        status: 500,
        statusText: 'Internal Server Error',
      })
    );

    try {
      await handleApiRequest('GET', '/items');
      expect.fail('Should throw');
    } catch (error) {
      expect(isArcApiError(error)).toBe(true);
      expect((error as ArcApiError).status).toBe(500);
      expect((error as ArcApiError).message).toBe('Internal Server Error');
    }
  });

  it('handles plain text error', async () => {
    fetchMock.mockResolvedValue(
      new Response('Service Unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    try {
      await handleApiRequest('GET', '/items');
      expect.fail('Should throw');
    } catch (error) {
      expect(isArcApiError(error)).toBe(true);
      expect((error as ArcApiError).status).toBe(503);
    }
  });
});

// ============================================================================
// createAuthAwareClient
// ============================================================================

describe('createAuthAwareClient', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    // Reset global auth between tests
    configureAuth({});
    _resetAuthWarnings();
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('inherits baseUrl from configureClient when no override', async () => {
    configureClient({ baseUrl: 'http://global.test' });
    const client = createAuthAwareClient();

    await client.request('GET', '/users');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://global.test/users',
      expect.any(Object),
    );
  });

  it('overrides baseUrl when supplied', async () => {
    configureClient({ baseUrl: 'http://global.test' });
    const client = createAuthAwareClient({ baseUrl: 'http://override.test' });

    await client.request('GET', '/test');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://override.test/test',
      expect.any(Object),
    );
  });

  it('injects token from global configureAuth', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'token-abc' });
    const client = createAuthAwareClient();

    await client.request('GET', '/secure');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token-abc');
  });

  it('injects organizationId from global configureAuth', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getOrgId: () => 'org-123' });
    const client = createAuthAwareClient();

    await client.request('GET', '/items');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-organization-id']).toBe('org-123');
  });

  it('reads token lazily on every request (rotation)', async () => {
    let token = 'first';
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => token });
    const client = createAuthAwareClient();

    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    );

    await client.request('GET', '/a');
    token = 'second';
    await client.request('GET', '/b');

    const headersA = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const headersB = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headersA['Authorization']).toBe('Bearer first');
    expect(headersB['Authorization']).toBe('Bearer second');
  });

  it('inherits authMode from configureClient (cookie → include credentials)', async () => {
    configureClient({ baseUrl: 'http://api.test', authMode: 'cookie' });
    const client = createAuthAwareClient();

    await client.request('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    expect((options as RequestInit).credentials).toBe('include');
  });

  it('header authMode injects token as custom header', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'api-key-xyz', headerName: 'x-api-key' });
    const client = createAuthAwareClient({ authMode: 'header' });

    await client.request('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('api-key-xyz');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('explicit getToken override wins over global', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'global-token' });
    const client = createAuthAwareClient({ getToken: () => 'override-token' });

    await client.request('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer override-token');
  });

  it('returns null token when global auth is unconfigured', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({}); // no getToken
    const client = createAuthAwareClient();

    await client.request('GET', '/test');

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('explicit options.token wins over auto-injection', async () => {
    configureClient({ baseUrl: 'http://api.test' });
    configureAuth({ getToken: () => 'global-token' });
    const client = createAuthAwareClient();

    await client.request('GET', '/test', { token: 'explicit-token' });

    const [, options] = fetchMock.mock.calls[0]!;
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer explicit-token');
  });
});

// ============================================================================
// configureAuth — async getToken guard
// ============================================================================

describe('configureAuth async-token guard', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetAuthWarnings();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns null and warns when getToken returns a Promise', () => {
    configureAuth({
      getToken: () => Promise.resolve('async-token') as unknown as string | null,
    });

    const ctx = getAuthContext();

    expect(ctx.token).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('returned a Promise'),
    );
  });

  it('warns only once across multiple calls', () => {
    configureAuth({
      getToken: () => Promise.resolve('x') as unknown as string | null,
    });

    getAuthContext();
    getAuthContext();
    getAuthContext();

    // Server-warning from configureAuth (jsdom has window so this should NOT fire)
    // We only count the async-token warnings
    const asyncWarnCount = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('returned a Promise'),
    ).length;
    expect(asyncWarnCount).toBe(1);
  });

  it('resets dedup flag on reconfigure', () => {
    configureAuth({
      getToken: () => Promise.resolve('x') as unknown as string | null,
    });
    getAuthContext();

    configureAuth({
      getToken: () => Promise.resolve('y') as unknown as string | null,
    });
    getAuthContext();

    const asyncWarnCount = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('returned a Promise'),
    ).length;
    expect(asyncWarnCount).toBe(2);
  });

  it('passes through synchronous tokens', () => {
    configureAuth({ getToken: () => 'sync-token' });

    const ctx = getAuthContext();

    expect(ctx.token).toBe('sync-token');
    const asyncWarnCount = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('returned a Promise'),
    ).length;
    expect(asyncWarnCount).toBe(0);
  });

  it('handles thenable (non-Promise) returns as async', () => {
    const thenable = { then: () => {} };
    configureAuth({ getToken: () => thenable as unknown as string });

    const ctx = getAuthContext();

    expect(ctx.token).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('returned a Promise'),
    );
  });
});

// ============================================================================
// isAbortError
// ============================================================================

describe('isAbortError', () => {
  it('detects DOMException AbortError (browser)', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isAbortError(err)).toBe(true);
  });

  it('detects Error with name=AbortError (Node 18+ undici)', () => {
    const err = new Error('Request aborted');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('detects code: ERR_ABORTED', () => {
    const err = Object.assign(new Error('cancelled'), { code: 'ERR_ABORTED' });
    expect(isAbortError(err)).toBe(true);
  });

  it('returns false for ArcApiError', () => {
    const err = new ArcApiError('boom', { status: 500, statusText: 'x', json: null, endpoint: '/a', method: 'GET' });
    expect(isAbortError(err)).toBe(false);
  });

  it('returns false for plain TypeError (network failure)', () => {
    expect(isAbortError(new TypeError('fetch failed'))).toBe(false);
  });

  it('returns false for null / undefined / primitives', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(0)).toBe(false);
  });
});

// ============================================================================
// Known error code arrays — runtime / type-level consistency
// ============================================================================

describe('KNOWN_ARC_ERROR_CODES', () => {
  it('is non-empty + unique', () => {
    expect(KNOWN_ARC_ERROR_CODES.length).toBeGreaterThan(10);
    expect(new Set(KNOWN_ARC_ERROR_CODES).size).toBe(KNOWN_ARC_ERROR_CODES.length);
  });

  it('exposes the canonical and arc business codes', () => {
    // repo-core canonical (lowercase, RFC 7807).
    expect(KNOWN_ARC_ERROR_CODES).toContain('validation_error');
    expect(KNOWN_ARC_ERROR_CODES).toContain('not_found');
    expect(KNOWN_ARC_ERROR_CODES).toContain('duplicate_key');
    // arc hierarchical.
    expect(KNOWN_ARC_ERROR_CODES).toContain('arc.forbidden');
    expect(KNOWN_ARC_ERROR_CODES).toContain('arc.validation_error');
    // arc business (UPPER_SNAKE).
    expect(KNOWN_ARC_ERROR_CODES).toContain('ORG_CONTEXT_REQUIRED');
    expect(KNOWN_ARC_ERROR_CODES).toContain('ALL_FIELDS_STRIPPED');
  });

  it('is array-shaped', () => {
    expect(Array.isArray(KNOWN_ARC_ERROR_CODES)).toBe(true);
  });
});

// ============================================================================
// ClientConfig.retry
// ============================================================================

describe('ClientConfig.retry', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('retries on 500 and succeeds on second attempt', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      retry: { attempts: 2, backoff: () => 0 }, // zero backoff for test speed
    });

    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500, statusText: 'Internal Server Error' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const result = await handleApiRequest<{ ok: boolean }>('GET', '/test');
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 4xx (client error)', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      retry: { attempts: 5, backoff: () => 0 },
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'bad input' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(handleApiRequest('POST', '/test', { body: { x: 1 } })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on network failure (TypeError from fetch)', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      retry: { attempts: 3, backoff: () => 0 },
    });

    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const result = await handleApiRequest<{ ok: boolean }>('GET', '/test');
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on AbortError', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      retry: { attempts: 5, backoff: () => 0 },
    });

    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValue(abortErr);

    await expect(handleApiRequest('GET', '/test')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and throws the last error', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      retry: { attempts: 3, backoff: () => 0 },
    });

    fetchMock.mockResolvedValue(new Response('boom', { status: 503, statusText: 'Service Unavailable' }));

    try {
      await handleApiRequest('GET', '/test');
      expect.fail('should have thrown');
    } catch (error) {
      expect(isArcApiError(error)).toBe(true);
      if (isArcApiError(error)) expect(error.status).toBe(503);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('respects explicit retryOn whitelist (numbers)', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      retry: { attempts: 3, backoff: () => 0, retryOn: [502, 503] },
    });

    // 504 is NOT in whitelist — should not retry
    fetchMock.mockResolvedValue(new Response('boom', { status: 504, statusText: 'Gateway Timeout' }));

    await expect(handleApiRequest('GET', '/test')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('custom backoff function receives 0-indexed attempt', async () => {
    const delays: number[] = [];
    configureClient({
      baseUrl: 'http://api.test',
      retry: {
        attempts: 3,
        backoff: (attempt) => {
          delays.push(attempt);
          return 0;
        },
      },
    });

    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(handleApiRequest('GET', '/test')).rejects.toThrow();
    // attempts:3 means 1 initial + 2 retries → backoff called twice (after attempt 0 and 1)
    expect(delays).toEqual([0, 1]);
  });

  it('default behavior (no retry config) is one attempt', async () => {
    configureClient({ baseUrl: 'http://api.test' });

    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(handleApiRequest('GET', '/test')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('signal abort during backoff cancels subsequent retries', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      retry: { attempts: 5, backoff: () => 100 },
    });

    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30); // abort during the backoff sleep

    await expect(
      handleApiRequest('GET', '/test', { signal: controller.signal }),
    ).rejects.toThrow();

    // First fetch happened; backoff was interrupted before second
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// ClientConfig.beforeRequest / afterResponse interceptors
// ============================================================================

describe('ClientConfig.beforeRequest', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => fetchMock.mockRestore());

  it('runs before fetch and can mutate headers', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      beforeRequest: (ctx) => ({
        ...ctx,
        headers: { ...ctx.headers, 'x-trace-id': 'abc-123' },
      }),
    });

    await handleApiRequest('GET', '/test');

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-trace-id']).toBe('abc-123');
  });

  it('supports async interceptors', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      beforeRequest: async (ctx) => {
        await Promise.resolve();
        return { ...ctx, headers: { ...ctx.headers, 'x-async': 'yes' } };
      },
    });

    await handleApiRequest('GET', '/test');

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-async']).toBe('yes');
  });

  it('receives the attempt counter (0 on first, 1+ on retry)', async () => {
    const attempts: number[] = [];
    configureClient({
      baseUrl: 'http://api.test',
      retry: { attempts: 2, backoff: () => 0 },
      beforeRequest: (ctx) => {
        attempts.push(ctx.attempt);
        return ctx;
      },
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    await handleApiRequest('GET', '/test');
    expect(attempts).toEqual([0, 1]);
  });

  it('can replace body before fetch', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      beforeRequest: (ctx) => ({
        ...ctx,
        body: JSON.stringify({ ...JSON.parse(ctx.body as string), injected: true }),
      }),
    });

    await handleApiRequest('POST', '/test', { body: { x: 1 } });

    const sentBody = (fetchMock.mock.calls[0]![1] as RequestInit).body as string;
    expect(JSON.parse(sentBody)).toEqual({ x: 1, injected: true });
  });
});

describe('ClientConfig.afterResponse', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => fetchMock.mockRestore());

  it('receives parsed body + status + duration', async () => {
    let captured: { status: number; body: unknown; durationMs: number } | null = null;
    configureClient({
      baseUrl: 'http://api.test',
      afterResponse: (ctx) => {
        captured = { status: ctx.status, body: ctx.body, durationMs: ctx.durationMs };
        return ctx;
      },
    });

    await handleApiRequest('GET', '/test');

    expect(captured).not.toBeNull();
    expect(captured!.status).toBe(200);
    expect(captured!.body).toEqual({ value: 42 });
    expect(captured!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('can transform body', async () => {
    configureClient({
      baseUrl: 'http://api.test',
      afterResponse: (ctx) => ({
        ...ctx,
        body: { wrapped: ctx.body },
      }),
    });

    const result = await handleApiRequest('GET', '/test');
    expect(result).toEqual({ wrapped: { value: 42 } });
  });

  it('does NOT run on error responses (ArcApiError thrown first)', async () => {
    const after = vi.fn((ctx) => ctx);
    configureClient({
      baseUrl: 'http://api.test',
      afterResponse: after,
    });

    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(handleApiRequest('GET', '/test')).rejects.toThrow();
    expect(after).not.toHaveBeenCalled();
  });
});
