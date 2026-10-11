/**
 * `@classytic/arc-next/auth-token` — bearer-token sessions for arc apps on Better Auth: where the
 * token lives, and the Better Auth client options that send it and keep the one the server issues.
 *
 * Every request reads the token synchronously (`configureAuth({ getToken })`), while durable storage
 * on a phone (Keystore, Keychain) is asynchronous — so the store loads once and serves from memory.
 */

/** Durable key-value storage: `localStorage`, or a device's secure storage. Sync or async. */
export interface TokenStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface TokenStore {
  /** The current token, synchronously (for `configureAuth({ getToken })`). With async storage, `null` until `load()`. */
  get(): string | null;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
  /** Read the stored token into memory. Call once before the first request. */
  load(): Promise<string | null>;
}

export function createTokenStore(storage: TokenStorage, key: string): TokenStore {
  // Synchronous storage (`localStorage`) is read live — the first request carries it, and another
  // tab's sign-in or sign-out applies here at once. Asynchronous storage is served from memory.
  const initial = storage.getItem(key);
  const live = !(initial instanceof Promise);
  let current: string | null = live ? (initial as string | null) : null;
  return {
    get: () => (live ? (storage.getItem(key) as string | null) : current),
    async set(token) {
      current = token;
      await storage.setItem(key, token);
    },
    async clear() {
      current = null;
      await storage.removeItem(key);
    },
    async load() {
      current = (await storage.getItem(key)) ?? null;
      return current;
    },
  };
}

/** The slice of a Better Auth fetch success context this reads. */
interface FetchSuccessContext {
  response?: { headers?: { get(name: string): string | null } };
  data?: unknown;
}

/**
 * Better Auth client `fetchOptions` for bearer mode. The server's `bearer()` plugin issues the token
 * in the `set-auth-token` response header (exposed cross-origin); sign-in also echoes it as the
 * body's `token`. Header first, then body.
 */
export function bearerFetchOptions(tokens: TokenStore) {
  return {
    auth: { type: "Bearer" as const, token: () => tokens.get() ?? undefined },
    async onSuccess(ctx: FetchSuccessContext) {
      const issued =
        ctx.response?.headers?.get("set-auth-token") ??
        (ctx.data as { token?: unknown } | undefined)?.token;
      if (typeof issued === "string" && issued) await tokens.set(issued);
    },
  };
}
