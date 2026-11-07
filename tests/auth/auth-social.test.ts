/**
 * Social sign-in handoff: absolute redirect targets with a validated `next`, a PKCE-style verifier,
 * a single-use exchange on the callback page, and error codes mapped to UI intents.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeSocialSignIn,
  createHandoffVerifier,
  fetchSocialProviders,
  getLastAuthMethod,
  handoffChallenge,
  LAST_AUTH_METHOD_KEY,
  readSocialError,
  SOCIAL_HANDOFF_KEY,
  SOCIAL_HANDOFF_TTL_MS,
  type SocialSignInRequest,
  safeNextPath,
  setLastAuthMethod,
  socialErrorIntent,
  socialErrorMessage,
  startSocialSignIn,
} from "../../src/auth/auth-social.js";
import { createTokenStore, type TokenStorage } from "../../src/auth/auth-token.js";

const memoryTokens = () => {
  const data = new Map<string, string>();
  const storage: TokenStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
  return createTokenStore(storage, "token");
};

const fakeClient = () => {
  const calls: SocialSignInRequest[] = [];
  return {
    calls,
    signIn: {
      social: vi.fn(async (input: SocialSignInRequest) => {
        calls.push(input);
        return { data: { url: "https://accounts.google.com/o/oauth2" }, error: null };
      }),
    },
  };
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.restoreAllMocks());

describe("safeNextPath", () => {
  it("keeps same-origin paths and refuses open-redirect shapes", () => {
    expect(safeNextPath("/orders?tab=open#top")).toBe("/orders?tab=open#top");
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "evil.com",
      "/a\nb",
      "/\tevil.com",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(safeNextPath(bad)).toBe("/");
    }
    expect(safeNextPath("//evil.com", "/home")).toBe("/home");
  });
});

describe("verifier and challenge", () => {
  it("challenge is base64url(SHA-256(verifier)): RFC 7636 appendix B vector", async () => {
    expect(await handoffChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("verifier is 32 random bytes in base64url (43 chars, no padding)", () => {
    const a = createHandoffVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHandoffVerifier()).not.toBe(a);
  });
});

describe("startSocialSignIn", () => {
  it("sends absolute callback, error and new-user URLs plus the challenge, and stores the verifier", async () => {
    const client = fakeClient();
    const result = await startSocialSignIn(client, {
      provider: "google",
      next: "/orders?tab=open",
      appOrigin: "https://app.example.com/",
      newUserNext: "/welcome",
    });
    expect(result).toEqual({ data: { url: "https://accounts.google.com/o/oauth2" }, error: null });
    const [input] = client.calls;
    expect(input).toMatchObject({
      provider: "google",
      callbackURL: "https://app.example.com/auth/callback?next=%2Forders%3Ftab%3Dopen",
      errorCallbackURL: "https://app.example.com/sign-in?next=%2Forders%3Ftab%3Dopen",
      newUserCallbackURL: "https://app.example.com/auth/callback?next=%2Fwelcome&new=1",
    });
    const stored = JSON.parse(sessionStorage.getItem(SOCIAL_HANDOFF_KEY)!);
    expect(stored.provider).toBe("google");
    expect(typeof stored.createdAt).toBe("number");
    expect(input!.additionalData).toEqual({ handoff: await handoffChallenge(stored.verifier) });
  });

  it("replaces an off-site next with / and rejects unsafe paths or origins", async () => {
    const client = fakeClient();
    await startSocialSignIn(client, {
      provider: "github",
      next: "//evil.com/steal",
      appOrigin: "http://localhost:3000",
      callbackPath: "/cb",
      errorPath: "/login",
    });
    expect(client.calls[0]).toMatchObject({
      callbackURL: "http://localhost:3000/cb?next=%2F",
      errorCallbackURL: "http://localhost:3000/login?next=%2F",
      newUserCallbackURL: "http://localhost:3000/cb?next=%2F&new=1",
    });
    await expect(
      startSocialSignIn(client, { provider: "x", appOrigin: "javascript:alert(1)" }),
    ).rejects.toThrow(/appOrigin/);
    await expect(
      startSocialSignIn(client, {
        provider: "x",
        appOrigin: "https://app.example.com",
        callbackPath: "//evil.com",
      }),
    ).rejects.toThrow(/callbackPath/);
  });

  it("drops the stored verifier when the client throws", async () => {
    const client = {
      signIn: {
        social: async () => {
          throw new Error("offline");
        },
      },
    };
    await expect(
      startSocialSignIn(client, { provider: "google", appOrigin: "https://app.example.com" }),
    ).rejects.toThrow("offline");
    expect(sessionStorage.getItem(SOCIAL_HANDOFF_KEY)).toBeNull();
  });
});

describe("completeSocialSignIn", () => {
  const begin = async () => {
    await startSocialSignIn(fakeClient(), {
      provider: "google",
      appOrigin: "https://app.example.com",
    });
    return JSON.parse(sessionStorage.getItem(SOCIAL_HANDOFF_KEY)!).verifier as string;
  };

  it("strips the fragment, exchanges once, stores the token and records the method", async () => {
    const verifier = await begin();
    window.history.replaceState(null, "", "/auth/callback?next=%2Forders&new=1#handoff=code-1");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // The fragment is gone before the network call.
      expect(window.location.hash).toBe("");
      expect(JSON.parse(String(init?.body))).toEqual({ code: "code-1", verifier });
      return json(200, { token: "body-token", user: { id: "u1" } }, { "set-auth-token": "hdr" });
    });
    const tokens = memoryTokens();
    const result = await completeSocialSignIn(
      { baseURL: "https://api.example.com/api/auth/", fetch: fetchMock as typeof fetch },
      tokens,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/auth/social/handoff",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({
      ok: true,
      next: "/orders",
      isNewUser: true,
      user: { id: "u1" },
      provider: "google",
    });
    expect(tokens.get()).toBe("hdr");
    expect(window.location.pathname + window.location.search).toBe(
      "/auth/callback?next=%2Forders&new=1",
    );
    expect(getLastAuthMethod()).toBe("google");
    expect(sessionStorage.getItem(SOCIAL_HANDOFF_KEY)).toBeNull();

    // A second run (reload, double effect) finds no verifier.
    window.history.replaceState(null, "", "/auth/callback#handoff=code-1");
    const again = await completeSocialSignIn({ baseURL: "https://api.example.com" }, tokens);
    expect(again).toMatchObject({
      ok: false,
      error: { code: "verifier_missing", intent: "expired-retry" },
    });
  });

  it("goes through a Better Auth client's $fetch and reads the token from the body", async () => {
    await begin();
    window.history.replaceState(null, "", "/auth/callback?next=%2F%2Fevil.com#handoff=c2");
    const $fetch = vi.fn(async () => ({ data: { token: "t2", user: { id: "u2" } }, error: null }));
    const tokens = memoryTokens();
    const result = await completeSocialSignIn({ $fetch }, tokens);
    expect($fetch).toHaveBeenCalledWith("/social/handoff", {
      method: "POST",
      body: expect.objectContaining({ code: "c2" }),
    });
    expect(result).toMatchObject({ ok: true, next: "/", isNewUser: false });
    expect(tokens.get()).toBe("t2");
  });

  it("reports a missing fragment, an expired or absent verifier, and a refused exchange", async () => {
    const tokens = memoryTokens();
    window.history.replaceState(null, "", "/auth/callback");
    expect(await completeSocialSignIn({ baseURL: "https://api" }, tokens)).toMatchObject({
      ok: false,
      error: { code: "handoff_missing", intent: "expired-retry" },
    });

    // Opened in another tab: this tab's sessionStorage holds no verifier.
    window.history.replaceState(null, "", "/auth/callback#handoff=x");
    expect(await completeSocialSignIn({ baseURL: "https://api" }, tokens)).toMatchObject({
      ok: false,
      error: { code: "verifier_missing" },
    });

    sessionStorage.setItem(
      SOCIAL_HANDOFF_KEY,
      JSON.stringify({
        verifier: "v",
        provider: "google",
        createdAt: Date.now() - SOCIAL_HANDOFF_TTL_MS - 1,
      }),
    );
    window.history.replaceState(null, "", "/auth/callback#handoff=x");
    expect(await completeSocialSignIn({ baseURL: "https://api" }, tokens)).toMatchObject({
      ok: false,
      error: { code: "verifier_missing" },
    });

    await begin();
    window.history.replaceState(null, "", "/auth/callback#handoff=x");
    const refused = vi.fn(async () => json(400, { code: "HANDOFF_INVALID", message: "Invalid" }));
    const result = await completeSocialSignIn(
      { baseURL: "https://api", fetch: refused as unknown as typeof fetch },
      tokens,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "HANDOFF_INVALID", intent: "expired-retry" },
    });
    expect(tokens.get()).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("surfaces an ?error= that reached the callback page", async () => {
    window.history.replaceState(null, "", "/auth/callback?error=access_denied");
    const result = await completeSocialSignIn({ baseURL: "https://api" }, memoryTokens());
    expect(result).toMatchObject({ ok: false, error: { intent: "cancelled" } });
  });
});

describe("error codes", () => {
  it("maps server and provider codes to UI intents", () => {
    const cases: Array<[string, string]> = [
      ["access_denied", "cancelled"],
      ["account_not_linked", "link-required"],
      ["unable_to_link_account", "link-failed"],
      ["state_mismatch", "expired-retry"],
      ["state_not_found", "expired-retry"],
      ["HANDOFF_INVALID", "expired-retry"],
      ["verifier_missing", "expired-retry"],
      ["email_not_found", "email-missing"],
      ["signup_disabled", "signup-disabled"],
      ["signup disabled", "signup-disabled"],
      ["banned", "blocked"],
      ["BANNED_USER", "blocked"],
      ["something_else", "unknown"],
    ];
    for (const [code, intent] of cases) expect(socialErrorIntent(code)).toBe(intent);
  });

  it("reads ?error from URLSearchParams, a query string or a searchParams object, with overrides", () => {
    expect(readSocialError(new URLSearchParams("next=%2F"))).toBeNull();
    expect(readSocialError("?error=account_not_linked&error_description=x")).toEqual({
      code: "account_not_linked",
      intent: "link-required",
      message: socialErrorMessage("account_not_linked"),
      description: "x",
    });
    expect(readSocialError({ error: ["banned"] }, { blocked: "Contact support." })).toMatchObject({
      intent: "blocked",
      message: "Contact support.",
    });
  });
});

describe("last auth method", () => {
  it("round-trips through localStorage and never throws when storage is blocked", () => {
    expect(getLastAuthMethod()).toBeNull();
    setLastAuthMethod("password");
    expect(localStorage.getItem(LAST_AUTH_METHOD_KEY)).toBe("password");
    expect(getLastAuthMethod()).toBe("password");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(getLastAuthMethod()).toBeNull();
    expect(() => setLastAuthMethod("google")).not.toThrow();
  });

  it("is SSR-safe: no localStorage global means null and a no-op", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
    try {
      expect(getLastAuthMethod()).toBeNull();
      expect(() => setLastAuthMethod("google")).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});

describe("fetchSocialProviders", () => {
  it("returns the enabled providers, and [] on any failure", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json(200, {
        providers: [{ id: "google", name: "Google" }, { id: "github" }, { name: "x" }],
      }),
    );
    expect(await fetchSocialProviders("https://api.example.com/api/auth/")).toEqual([
      { id: "google", name: "Google" },
      { id: "github", name: "github" },
    ]);
    expect(spy.mock.calls[0]![0]).toBe("https://api.example.com/api/auth/social/providers");
    spy.mockResolvedValueOnce(json(500, {}));
    expect(await fetchSocialProviders("https://api")).toEqual([]);
    spy.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await fetchSocialProviders("https://api")).toEqual([]);
  });
});
