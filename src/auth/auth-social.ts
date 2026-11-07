/**
 * `@classytic/arc-next/auth-social`: the client half of social sign-in against arc's `socialAuth()`
 * plugin on Better Auth, for apps that hold a bearer token (see `./auth-token`). Headless: no UI.
 *
 * The flow, end to end:
 * 1. {@link startSocialSignIn} mints a one-time verifier (kept in `sessionStorage`), sends its
 *    SHA-256 challenge as `additionalData.handoff`, and lets Better Auth redirect to the provider.
 * 2. The provider returns to the API; the API redirects the browser to the app's callback page with
 *    `#handoff=<code>` (a fragment: never sent to a server, never in a referrer).
 * 3. {@link completeSocialSignIn} on that page strips the fragment, posts `{ code, verifier }` to
 *    `<authBase>/social/handoff`, and stores the returned token.
 *
 * A failed callback lands on the error page with `?error=<code>`: {@link readSocialError} turns it
 * into a {@link SocialSignInError} with a UI intent. Server-safe: nothing touches `window` at import.
 *
 * React Native signs in with the provider's ID token instead of a redirect
 * ({@link signInWithIdToken}). Storage is injectable everywhere (`sessionStorage` /
 * `localStorage` by default on the web; an async store such as SecureStore on a device).
 */

import type { NextFetchOptions } from "../client/client.js";
import type { TokenStorage, TokenStore } from "./auth-token.js";

// ── Errors ──────────────────────────────────────────────────────────────────────────────────────

/** What the UI should do about a failed social sign-in. */
export type SocialErrorIntent =
  /** The person closed the provider's consent screen: show nothing. */
  | "cancelled"
  /** An account with this email exists but is not linked to the provider: sign in another way, then link. */
  | "link-required"
  /** Linking the provider to the signed-in account failed. */
  | "link-failed"
  /** The attempt expired or was opened in another tab: start again. */
  | "expired-retry"
  /** The provider shared no email address. */
  | "email-missing"
  /** New accounts are closed. */
  | "signup-disabled"
  /** The account is banned. */
  | "blocked"
  | "unknown";

export interface SocialSignInError {
  /** The raw code from the server or the provider (`access_denied`, `HANDOFF_INVALID`, ...). */
  code: string;
  intent: SocialErrorIntent;
  /** Short English default; override per intent with `messages`. */
  message: string;
  /** `error_description` from the provider or server, when present. Do not render it as-is. */
  description?: string;
}

/** Per-intent message overrides. */
export type SocialErrorMessages = Partial<Record<SocialErrorIntent, string>>;

export const SOCIAL_ERROR_MESSAGES: Readonly<Record<SocialErrorIntent, string>> = {
  cancelled: "Sign-in was cancelled.",
  "link-required":
    "An account with this email already exists. Sign in with your password, then link this provider.",
  "link-failed": "We could not link this account.",
  "expired-retry": "That sign-in attempt expired. Please try again.",
  "email-missing": "The provider did not share an email address.",
  "signup-disabled": "New accounts are not open right now.",
  blocked: "This account has been blocked.",
  unknown: "Sign-in failed. Please try again.",
};

/** Codes compared lower-case with spaces and dashes folded to `_` (`"signup disabled"` = `SIGNUP_DISABLED`). */
const INTENT_BY_CODE: Readonly<Record<string, SocialErrorIntent>> = {
  access_denied: "cancelled",
  account_not_linked: "link-required",
  unable_to_link_account: "link-failed",
  email_does_not_match: "link-failed",
  account_already_linked_to_different_user: "link-failed",
  state_mismatch: "expired-retry",
  state_not_found: "expired-retry",
  please_restart_the_process: "expired-retry",
  handoff_invalid: "expired-retry",
  handoff_missing: "expired-retry",
  verifier_missing: "expired-retry",
  email_not_found: "email-missing",
  signup_disabled: "signup-disabled",
  banned: "blocked",
  banned_user: "blocked",
};

const normalizeCode = (code: string) =>
  code
    .trim()
    .toLowerCase()
    .replace(/[\s'-]+/g, "_");

/** The UI intent for an error code. Unknown codes map to `"unknown"`. */
export function socialErrorIntent(code: string): SocialErrorIntent {
  return INTENT_BY_CODE[normalizeCode(code)] ?? "unknown";
}

/** The message for an error code: the override for its intent, else the English default. */
export function socialErrorMessage(code: string, messages?: SocialErrorMessages): string {
  const intent = socialErrorIntent(code);
  return messages?.[intent] ?? SOCIAL_ERROR_MESSAGES[intent];
}

/** Build a {@link SocialSignInError} from a code. */
export function toSocialError(
  code: string,
  description?: string | null,
  messages?: SocialErrorMessages,
): SocialSignInError {
  const error: SocialSignInError = {
    code,
    intent: socialErrorIntent(code),
    message: socialErrorMessage(code, messages),
  };
  if (description) error.description = description;
  return error;
}

/** Search params as `URLSearchParams`, Next's `useSearchParams()`, a page's `searchParams` object, or a query string. */
export type SearchParamsInput =
  | string
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

function param(input: SearchParamsInput, name: string): string | null {
  if (typeof input === "string") return new URLSearchParams(input).get(name);
  if (typeof (input as { get?: unknown }).get === "function") {
    return (input as { get(name: string): string | null }).get(name);
  }
  const value = (input as Record<string, string | readonly string[] | undefined>)[name];
  return (Array.isArray(value) ? value[0] : (value as string | undefined)) ?? null;
}

/** The error a failed callback put on the error page (`?error=<code>&error_description=...`), or `null`. */
export function readSocialError(
  searchParams: SearchParamsInput,
  messages?: SocialErrorMessages,
): SocialSignInError | null {
  const code = param(searchParams, "error");
  if (!code) return null;
  return toSocialError(code, param(searchParams, "error_description"), messages);
}

// ── Redirect targets ────────────────────────────────────────────────────────────────────────────

/**
 * `next` when it is a same-origin path (`/orders?tab=open`), else `fallback`. Refuses
 * protocol-relative (`//evil.com`), backslash (`/\evil.com`), scheme (`javascript:`, `https:`) and
 * control-character targets: the open-redirect shapes browsers would resolve off-site.
 */
export function safeNextPath(next: unknown, fallback = "/"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const base = "http://next.invalid";
    const url = new URL(next, base);
    if (url.origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return next;
}

function originOf(appOrigin: string): string {
  let url: URL;
  try {
    url = new URL(appOrigin);
  } catch {
    throw new Error(`startSocialSignIn: appOrigin ${JSON.stringify(appOrigin)} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`startSocialSignIn: appOrigin must be http(s), got ${url.protocol}`);
  }
  return url.origin;
}

function pathOption(name: string, value: string): string {
  if (safeNextPath(value, "") !== value || value.includes("?") || value.includes("#")) {
    throw new Error(`startSocialSignIn: ${name} must be a plain same-origin path, got ${value}`);
  }
  return value;
}

// ── Handoff verifier ────────────────────────────────────────────────────────────────────────────

/** `sessionStorage` key of the pending handoff. */
export const SOCIAL_HANDOFF_KEY = "arc:social-handoff";
/** A pending handoff older than this is discarded. */
export const SOCIAL_HANDOFF_TTL_MS = 10 * 60 * 1000;

interface PendingHandoff {
  verifier: string;
  provider: string;
  createdAt: number;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh verifier: 32 random bytes, base64url (43 characters). */
export function createHandoffVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The challenge sent with the sign-in: base64url(SHA-256(verifier)), as PKCE S256. */
export async function handoffChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Key-value storage for the handoff verifier and the last sign-in method (sync or async). */
export type SocialStorage = TokenStorage;

function webStore(kind: "sessionStorage" | "localStorage"): SocialStorage | null {
  try {
    const store = (globalThis as Record<string, unknown>)[kind] as Storage | undefined;
    return store ?? null;
  } catch {
    return null;
  }
}

/** Read and delete the pending handoff: a verifier is used at most once. */
async function takePendingHandoff(
  now: number,
  store: SocialStorage | null,
): Promise<PendingHandoff | null> {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = await store.getItem(SOCIAL_HANDOFF_KEY);
    await store.removeItem(SOCIAL_HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingHandoff>;
    if (typeof parsed.verifier !== "string" || typeof parsed.createdAt !== "number") return null;
    if (now - parsed.createdAt > SOCIAL_HANDOFF_TTL_MS || parsed.createdAt > now + 60_000) {
      return null;
    }
    return {
      verifier: parsed.verifier,
      provider: typeof parsed.provider === "string" ? parsed.provider : "",
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

// ── Last sign-in method ─────────────────────────────────────────────────────────────────────────

/** `localStorage` key of the last sign-in method. */
export const LAST_AUTH_METHOD_KEY = "arc:last-auth-method";

/** The method this browser last signed in with (`"google"`, `"password"`, ...), or `null`. SSR-safe. */
export function getLastAuthMethod(): string | null {
  try {
    const store = webStore("localStorage");
    const value = store?.getItem(LAST_AUTH_METHOD_KEY);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** {@link getLastAuthMethod} from any storage, async included (React Native). Never throws. */
export async function loadLastAuthMethod(
  storage: SocialStorage | null = webStore("localStorage"),
): Promise<string | null> {
  try {
    return (await storage?.getItem(LAST_AUTH_METHOD_KEY)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Remember the sign-in method (call after a password sign-in too). Default storage is
 * `localStorage` (written synchronously); pass an async store on React Native. Never throws.
 */
export async function setLastAuthMethod(
  method: string,
  storage: SocialStorage | null = webStore("localStorage"),
): Promise<void> {
  if (!storage || !method) return;
  try {
    await storage.setItem(LAST_AUTH_METHOD_KEY, method);
  } catch {
    // storage blocked (private mode, quota): the hint is optional
  }
}

// ── Transport ───────────────────────────────────────────────────────────────────────────────────

/** The input `signIn.social` receives (a structural slice of Better Auth's client). */
export interface SocialSignInRequest {
  provider: string;
  callbackURL?: string;
  errorCallbackURL?: string;
  newUserCallbackURL?: string;
  additionalData?: Record<string, unknown>;
}

/** A Better Auth client: `createAuthClient()` from `better-auth/react` or `better-auth/client`. */
export interface SocialSignInClient<R = unknown> {
  signIn: { social(input: SocialSignInRequest): Promise<R> };
}

/** A Better Auth client's `$fetch` (better-fetch: resolves `{ data, error }`, never throws on HTTP errors). */
export interface AuthFetchClient {
  $fetch(
    path: string,
    options: { method: "POST"; body: Record<string, unknown> },
  ): Promise<{ data: unknown; error: unknown }>;
}

/** The auth base URL (`https://api.example.com/api/auth`) and, optionally, a fetch. */
export interface AuthEndpoint {
  baseURL: string;
  fetch?: typeof fetch;
}

/** Where the social helpers post: a Better Auth client, or a plain endpoint. */
export type AuthTarget = AuthFetchClient | AuthEndpoint;

export type AuthPostResult =
  | { ok: true; data: unknown; token: string | null }
  | { ok: false; status: number; code: string; message?: string };

const trimSlash = (url: string) => url.replace(/\/+$/, "");

function errorCode(body: unknown, status: number): { code: string; message?: string } {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message : undefined;
  const code =
    (typeof record.code === "string" && record.code) ||
    message ||
    (status > 0 ? `http_${status}` : "network_error");
  return message ? { code, message } : { code };
}

const tokenIn = (data: unknown): string | null => {
  const token = (data as { token?: unknown } | null)?.token;
  return typeof token === "string" && token ? token : null;
};

/**
 * POST JSON to an auth endpoint path (`/social/handoff`, `/one-tap/callback`) through a Better Auth
 * client or plain fetch. The token is read from the `set-auth-token` header, then the body.
 */
export async function postAuthEndpoint(
  target: AuthTarget,
  path: string,
  body: Record<string, unknown>,
): Promise<AuthPostResult> {
  const endpoint = target as Partial<AuthEndpoint>;
  // A Better Auth client is a Proxy: every property reads as a function, so test for a string URL.
  if (typeof endpoint.baseURL !== "string") {
    try {
      const { data, error } = await (target as AuthFetchClient).$fetch(path, {
        method: "POST",
        body,
      });
      if (error) {
        const status = Number((error as { status?: unknown }).status) || 0;
        return { ok: false, status, ...errorCode(error, status) };
      }
      return { ok: true, data, token: tokenIn(data) };
    } catch {
      return { ok: false, status: 0, code: "network_error" };
    }
  }
  let response: Response;
  try {
    response = await (endpoint.fetch ?? fetch)(`${trimSlash(endpoint.baseURL)}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: "network_error" };
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok)
    return { ok: false, status: response.status, ...errorCode(data, response.status) };
  return { ok: true, data, token: response.headers.get("set-auth-token") || tokenIn(data) };
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────────

export interface StartSocialSignInOptions {
  /** Provider id as configured on the server (`"google"`, `"github"`, ...). */
  provider: string;
  /** Where to go after sign-in: a same-origin path. Anything else becomes `"/"`. */
  next?: string | null;
  /** The app's own origin (`https://app.example.com`). Better Auth needs absolute redirect URLs. */
  appOrigin: string;
  /** The page that calls {@link completeSocialSignIn}. Default `/auth/callback`. */
  callbackPath?: string;
  /** The page that calls {@link readSocialError}. Default `/sign-in`. */
  errorPath?: string;
  /** Where a newly created account goes (onboarding). Default: `next`. */
  newUserNext?: string | null;
  /** Where the one-time verifier waits for the callback. Default `sessionStorage`. */
  storage?: SocialStorage;
}

/**
 * Begin a redirect sign-in with a provider. Stores a fresh verifier in `sessionStorage`, sends its
 * challenge as `additionalData.handoff`, and returns `authClient.signIn.social()`'s result (the
 * client then navigates to the provider).
 */
export async function startSocialSignIn<R>(
  authClient: SocialSignInClient<R>,
  options: StartSocialSignInOptions,
): Promise<R> {
  const origin = originOf(options.appOrigin);
  const callbackPath = pathOption("callbackPath", options.callbackPath ?? "/auth/callback");
  const errorPath = pathOption("errorPath", options.errorPath ?? "/sign-in");
  const next = safeNextPath(options.next);
  const newUserNext = safeNextPath(options.newUserNext, next);

  const verifier = createHandoffVerifier();
  const challenge = await handoffChallenge(verifier);
  const store = options.storage ?? webStore("sessionStorage");
  if (!store) throw new Error("startSocialSignIn: sessionStorage is unavailable");
  const pending: PendingHandoff = { verifier, provider: options.provider, createdAt: Date.now() };
  await store.setItem(SOCIAL_HANDOFF_KEY, JSON.stringify(pending));

  const query = (target: string) => `next=${encodeURIComponent(target)}`;
  try {
    return await authClient.signIn.social({
      provider: options.provider,
      callbackURL: `${origin}${callbackPath}?${query(next)}`,
      errorCallbackURL: `${origin}${errorPath}?${query(next)}`,
      newUserCallbackURL: `${origin}${callbackPath}?${query(newUserNext)}&new=1`,
      additionalData: { handoff: challenge },
    });
  } catch (error) {
    try {
      await store.removeItem(SOCIAL_HANDOFF_KEY);
    } catch {
      // nothing to clean
    }
    throw error;
  }
}

// ── Complete ────────────────────────────────────────────────────────────────────────────────────

export type CompleteSocialSignInResult =
  | {
      ok: true;
      /** Validated same-origin path to navigate to. */
      next: string;
      /** The account was created by this sign-in (`newUserCallbackURL`). */
      isNewUser: boolean;
      user: unknown;
      /** Provider id stored at the start, `""` when unknown. */
      provider: string;
    }
  | { ok: false; error: SocialSignInError };

/** The slice of `window.location` read on the callback page. */
export type CallbackLocation = Pick<Location, "hash" | "search" | "pathname">;

export interface CompleteSocialSignInOptions {
  /** Default: `window.location`. */
  location?: CallbackLocation;
  messages?: SocialErrorMessages;
  /** Where {@link startSocialSignIn} kept the verifier. Default `sessionStorage`. */
  storage?: SocialStorage;
  /** Where the last sign-in method is remembered. Default `localStorage`. */
  methodStorage?: SocialStorage;
}

/**
 * Finish a redirect sign-in on the callback page: read `#handoff=<code>`, strip it from the address
 * bar at once, consume the stored verifier, exchange both at `/social/handoff`, and store the token.
 * Call once per page load (in an effect); a second call finds no verifier and reports `expired-retry`.
 */
export async function completeSocialSignIn(
  target: AuthTarget,
  tokens: TokenStore,
  options: CompleteSocialSignInOptions = {},
): Promise<CompleteSocialSignInResult> {
  const location =
    options.location ?? (typeof window === "undefined" ? undefined : window.location);
  const fail = (code: string, description?: string | null): CompleteSocialSignInResult => ({
    ok: false,
    error: toSocialError(code, description, options.messages),
  });
  if (!location) return fail("handoff_missing");

  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const code = hash.get("handoff");
  if (location.hash && typeof history !== "undefined") {
    try {
      history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    } catch {
      // a sandboxed frame may refuse; the code is single-use anyway
    }
  }

  const callbackError = search.get("error");
  if (callbackError) return fail(callbackError, search.get("error_description"));
  if (!code) return fail("handoff_missing");

  const pending = await takePendingHandoff(
    Date.now(),
    options.storage ?? webStore("sessionStorage"),
  );
  if (!pending) return fail("verifier_missing");

  const result = await postAuthEndpoint(target, "/social/handoff", {
    code,
    verifier: pending.verifier,
  });
  if (!result.ok) return fail(result.code);
  if (!result.token) return fail("token_missing");

  await tokens.set(result.token);
  if (pending.provider) await setLastAuthMethod(pending.provider, options.methodStorage);
  return {
    ok: true,
    next: safeNextPath(search.get("next")),
    isNewUser: search.get("new") === "1",
    user: (result.data as { user?: unknown } | null)?.user ?? null,
    provider: pending.provider,
  };
}

// ── ID token (React Native, native SDKs) ──────────────────────────────────────────────────────────

/** A Better Auth client whose `signIn.social` accepts a provider ID token (no redirect). */
export interface IdTokenSignInClient {
  signIn: {
    social(input: {
      provider: string;
      idToken: { token: string; nonce?: string; accessToken?: string };
    }): Promise<{ data?: unknown; error?: unknown } | unknown>;
  };
}

export interface SignInWithIdTokenOptions {
  /** Provider id as configured on the server (`"google"`, `"apple"`). */
  provider: string;
  /** The ID token the native SDK returned (e.g. `@react-native-google-signin`). */
  idToken: string;
  /** The nonce the token was minted with, when the SDK used one (recommended). */
  nonce?: string;
  accessToken?: string;
  /** Where the last sign-in method is remembered (an async store on a device). */
  methodStorage?: SocialStorage;
  messages?: SocialErrorMessages;
}

export type SignInWithIdTokenResult =
  | { ok: true; user: unknown; provider: string }
  | { ok: false; error: SocialSignInError };

/**
 * Sign in with a provider ID token, the React Native path (no browser redirect, no DOM): sends
 * `signIn.social({ provider, idToken: { token, nonce } })`, stores the bearer token the server
 * issues in `tokens`, and remembers the method. Never throws; a refusal comes back as a
 * {@link SocialSignInError} with a UI intent.
 */
export async function signInWithIdToken(
  authClient: IdTokenSignInClient,
  tokens: TokenStore,
  options: SignInWithIdTokenOptions,
): Promise<SignInWithIdTokenResult> {
  const fail = (code: string, description?: string | null): SignInWithIdTokenResult => ({
    ok: false,
    error: toSocialError(code, description, options.messages),
  });
  if (!options.idToken) return fail("handoff_missing");
  let result: unknown;
  try {
    result = await authClient.signIn.social({
      provider: options.provider,
      idToken: {
        token: options.idToken,
        ...(options.nonce ? { nonce: options.nonce } : {}),
        ...(options.accessToken ? { accessToken: options.accessToken } : {}),
      },
    });
  } catch {
    return fail("network_error");
  }
  const { data, error } = (result ?? {}) as { data?: unknown; error?: unknown };
  if (error) {
    const e = error as { code?: unknown; message?: unknown; status?: unknown };
    const code =
      (typeof e.code === "string" && e.code) ||
      (typeof e.message === "string" && e.message) ||
      "unknown";
    return fail(code);
  }
  const token = tokenIn(data);
  if (!token) return fail("token_missing");
  await tokens.set(token);
  await setLastAuthMethod(options.provider, options.methodStorage);
  return {
    ok: true,
    user: (data as { user?: unknown } | null)?.user ?? null,
    provider: options.provider,
  };
}

// ── Providers ───────────────────────────────────────────────────────────────────────────────────

export interface SocialProvider {
  id: string;
  name: string;
}

/**
 * The providers the server has enabled (`GET <authBase>/social/providers`), for rendering buttons
 * in a Server Component. Returns `[]` on any failure so the page still renders a password form.
 */
export async function fetchSocialProviders(
  baseURL: string,
  init?: RequestInit & { next?: NextFetchOptions },
): Promise<SocialProvider[]> {
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    const response = await fetch(`${trimSlash(baseURL)}/social/providers`, { ...init, headers });
    if (!response.ok) return [];
    const body = (await response.json()) as { providers?: unknown };
    if (!Array.isArray(body?.providers)) return [];
    return body.providers.flatMap((entry: unknown) => {
      const { id, name } = (entry ?? {}) as { id?: unknown; name?: unknown };
      return typeof id === "string" && id
        ? [{ id, name: typeof name === "string" && name ? name : id }]
        : [];
    });
  } catch {
    return [];
  }
}
