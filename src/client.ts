// ============================================================================
// Shared Types (used by client, mutation, and hooks)
// ============================================================================

export interface ToastHandler {
  success: (message: string) => void;
  error: (message: string) => void;
}

export type UseRouterHook = () => {
  push: (href: string, options?: { scroll?: boolean }) => void;
  replace: (href: string, options?: { scroll?: boolean }) => void;
};

// ============================================================================
// ArcApiError
// ============================================================================

export interface ArcApiErrorOptions {
  status: number;
  statusText: string;
  json: unknown;
  endpoint: string;
  method: HttpMethod;
}

/**
 * Rich API error with status code, response payload, and request metadata.
 * Extends Error so existing `catch (e) { if (e instanceof Error) }` still works.
 *
 * @example
 * try {
 *   await handleApiRequest('POST', '/users', { body: data });
 * } catch (error) {
 *   if (isArcApiError(error)) {
 *     console.log(error.status);       // 422
 *     console.log(error.fieldErrors);   // { email: 'already taken' }
 *   }
 * }
 */
export class ArcApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly json: unknown;
  readonly endpoint: string;
  readonly method: HttpMethod;

  constructor(message: string, options: ArcApiErrorOptions) {
    super(message);
    this.name = 'ArcApiError';
    this.status = options.status;
    this.statusText = options.statusText;
    this.json = options.json;
    this.endpoint = options.endpoint;
    this.method = options.method;
  }

  /** Extract field-level validation errors if present (e.g. `{ field: "message" }`) */
  get fieldErrors(): Record<string, string> | null {
    const j = this.json as { errors?: Record<string, string> } | null;
    return j?.errors ?? null;
  }
}

/**
 * Type guard for ArcApiError.
 */
export function isArcApiError(error: unknown): error is ArcApiError {
  return error instanceof ArcApiError;
}

// ============================================================================
// Client Configuration
// ============================================================================

export interface ClientConfig {
  baseUrl: string;
  internalApiKey?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Auth mode for the API client.
   * - 'bearer' (default): Requires a token for authenticated requests. Queries are disabled until a token is provided.
   * - 'cookie': Auth is handled via HTTP-only cookies (e.g. Better Auth). Queries are always enabled — no token needed.
   */
  authMode?: 'bearer' | 'cookie';
  /**
   * Fetch credentials policy.
   * - 'include': Always send cookies cross-origin (required for cookie-based auth).
   * - 'same-origin': Only send cookies to same-origin requests (browser default).
   * - 'omit': Never send cookies.
   *
   * When not set, derived from `authMode`:
   * - `authMode: 'cookie'` → `'include'`
   * - `authMode: 'bearer'` (default) → `'same-origin'`
   */
  credentials?: RequestCredentials;
}

let clientConfig: ClientConfig | null = null;

/**
 * Configure the API client. Call once at app init before any API requests.
 *
 * **SSR safety:** This sets module-level state. In Next.js, call this only in
 * client-side code (e.g. a `"use client"` provider or `useEffect`).
 * Calling on the server risks leaking state between requests.
 *
 * @example
 * // Bearer token auth (default)
 * configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL! });
 *
 * // Cookie-based auth (e.g. Better Auth)
 * configureClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL!, authMode: 'cookie' });
 */
export function configureClient(config: ClientConfig): void {
  clientConfig = config;
}

/**
 * Get the configured auth mode. Returns 'bearer' if not configured.
 */
export function getAuthMode(): 'bearer' | 'cookie' {
  return clientConfig?.authMode ?? 'bearer';
}

// ============================================================================
// Auth Configuration
// ============================================================================

export interface AuthConfig {
  getToken?: () => string | null;
  getOrgId?: () => string | null;
}

let authConfig: AuthConfig | null = null;

/**
 * Configure auth context for automatic token/orgId injection.
 * When configured, hooks auto-inject these values so you don't need to pass them manually.
 *
 * **SSR safety:** This sets module-level state. Call only in client-side code.
 *
 * @example
 * // Cookie auth (no token needed)
 * configureAuth({ getOrgId: () => currentOrg.id });
 *
 * // Bearer auth
 * configureAuth({
 *   getToken: () => session?.accessToken ?? null,
 *   getOrgId: () => currentOrg?.id ?? null,
 * });
 */
export function configureAuth(config: AuthConfig): void {
  authConfig = config;
}

/**
 * Get the current auth context. Returns nulls when not configured.
 */
export function getAuthContext(): { token: string | null; organizationId: string | null } {
  return {
    token: authConfig?.getToken?.() ?? null,
    organizationId: authConfig?.getOrgId?.() ?? null,
  };
}

// ============================================================================
// Types
// ============================================================================

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiRequestOptions {
  body?: unknown;
  token?: string | null;
  organizationId?: string | null;
  revalidate?: number;
  headerOptions?: Record<string, string>;
  tags?: string[];
  cache?: RequestCache;
  signal?: AbortSignal;
}

export interface BlobResponse {
  data: Blob;
  response: Response;
}

export interface TextResponse {
  data: string;
  response: Response;
}

// ============================================================================
// Multi-Client Support
// ============================================================================

export interface ArcClientConfig extends ClientConfig {
  toast?: ToastHandler;
  navigation?: UseRouterHook;
}

export interface ArcClient {
  request: <T = unknown>(method: HttpMethod, endpoint: string, options?: ApiRequestOptions) => Promise<T>;
  config: ClientConfig;
  toast?: ToastHandler;
  navigation?: UseRouterHook;
}

/**
 * Create an isolated API client for a specific backend.
 * Use this when your app needs to talk to multiple APIs.
 *
 * @example
 * const analyticsClient = createClient({
 *   baseUrl: 'https://analytics.example.com',
 *   toast: { success: toast.success, error: toast.error },
 *   navigation: useRouter,
 * });
 *
 * const eventsApi = createCrudApi('events', { client: analyticsClient });
 */
export function createClient(config: ArcClientConfig): ArcClient {
  const { toast, navigation, ...clientCfg } = config;
  return {
    request: <T = unknown>(method: HttpMethod, endpoint: string, options?: ApiRequestOptions) =>
      executeRequest<T>(clientCfg, method, endpoint, options),
    config: clientCfg,
    toast,
    navigation,
  };
}

// ============================================================================
// Core Request Logic
// ============================================================================

async function executeRequest<T = unknown>(
  config: ClientConfig,
  method: HttpMethod,
  endpoint: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const {
    body,
    token,
    organizationId,
    revalidate,
    headerOptions,
    tags,
    cache,
    signal,
  } = options;

  try {
    let headers: Record<string, string> = {
      ...(organizationId ? { 'x-organization-id': organizationId } : {}),
      ...(config.defaultHeaders ?? {}),
    };

    if (config.internalApiKey) {
      headers['x-internal-api-key'] = config.internalApiKey;
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    if (headerOptions) {
      headers = { ...headers, ...headerOptions };
    }

    // Derive credentials: explicit config > authMode-based default
    const credentials = config.credentials
      ?? (config.authMode === 'cookie' ? 'include' : 'same-origin');

    const fetchOptions: RequestInit & { next?: { revalidate?: number; tags?: string[] } } = {
      method,
      headers,
      credentials,
      ...(signal ? { signal } : {}),
    };

    if (body !== undefined && body !== null) {
      fetchOptions.body = body instanceof FormData ? body : JSON.stringify(body);
    }

    if (cache) {
      fetchOptions.cache = cache;
    }
    if (revalidate !== undefined) {
      fetchOptions.next = { ...fetchOptions.next, revalidate };
    }
    if (tags) {
      fetchOptions.next = { ...fetchOptions.next, tags };
    }

    const response = await fetch(`${config.baseUrl}${endpoint}`, fetchOptions);

    if (!response.ok) {
      const json = await response.json().catch(() => null);
      throw new ArcApiError(
        (json as { message?: string } | null)?.message || response.statusText,
        {
          status: response.status,
          statusText: response.statusText,
          json,
          endpoint,
          method,
        }
      );
    }

    const contentType = response.headers.get('Content-Type');

    let data: unknown;

    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else if (contentType?.includes('application/pdf') || contentType?.includes('image/')) {
      const blobData = await response.blob();
      data = { data: blobData, response };
    } else if (contentType?.includes('text/csv')) {
      const csvData = await response.blob();
      data = { data: csvData, response };
    } else if (contentType?.includes('text/')) {
      const text = await response.text();
      data = { data: text, response };
    } else {
      try {
        const blob = await response.clone().blob();
        data = { data: blob, response };
      } catch {
        const text = await response.text();
        data = { data: text, response };
      }
    }

    return data as T;
  } catch (error) {
    // Preserve original error type (ArcApiError, AbortError, TypeError, etc.)
    if (error instanceof Error) throw error;
    throw new Error('An error occurred while fetching data.');
  }
}

// ============================================================================
// API Request Handler (Global — uses configureClient singleton)
// ============================================================================

/**
 * Universal API request handler.
 * Handles JSON, binary (PDF, images), CSV, and text responses.
 *
 * @example
 * const { success, data } = await handleApiRequest<ApiResponse<User>>('GET', '/users/me');
 * const response = await handleApiRequest<PaginatedResponse<Product>>('GET', '/products?page=1');
 */
export async function handleApiRequest<T = unknown>(
  method: HttpMethod,
  endpoint: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  if (!clientConfig) {
    throw new Error(
      'arc-next: Client not configured. Call configureClient({ baseUrl }) before making API requests.'
    );
  }
  return executeRequest<T>(clientConfig, method, endpoint, options);
}

// ============================================================================
// Query String Utilities
// ============================================================================

/**
 * Creates query string from parameters.
 * Supports: arrays as field[in]=value1,value2, populateOptions with field selection.
 *
 * @example
 * createQueryString({ page: 1, limit: 10, status: 'active' })
 * // => 'page=1&limit=10&status=active'
 *
 * createQueryString({ roles: ['admin', 'user'] })
 * // => 'roles[in]=admin,user'
 *
 * createQueryString({
 *   populateOptions: [{ path: 'employeeId', select: 'name email' }]
 * })
 * // => 'populate[employeeId][select]=name,email'
 */
export function createQueryString<T extends Record<string, unknown>>(params: T = {} as T): string {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === '') return;

    if (key === 'populateOptions' && Array.isArray(value)) {
      (value as Array<{ path: string; select?: string; match?: Record<string, unknown> }>).forEach(
        (opt) => {
          if (opt.select) {
            const selectFields = opt.select.replace(/\s+/g, ',');
            searchParams.append(`populate[${opt.path}][select]`, selectFields);
          }
          if (opt.match) {
            searchParams.append(`populate[${opt.path}][match]`, JSON.stringify(opt.match));
          }
          if (!opt.select && !opt.match) {
            const existing = searchParams.get('populate');
            if (existing) {
              searchParams.set('populate', `${existing},${opt.path}`);
            } else {
              searchParams.append('populate', opt.path);
            }
          }
        }
      );
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > 1) {
        searchParams.append(`${key}[in]`, value.join(','));
      } else if (value.length === 1) {
        searchParams.append(key, String(value[0]));
      }
    } else if (value === null) {
      searchParams.append(key, 'null');
    } else {
      searchParams.append(key, String(value));
    }
  });

  return searchParams.toString();
}
