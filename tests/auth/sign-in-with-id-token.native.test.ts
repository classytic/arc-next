/**
 * Social sign-in off the browser: injectable (async) storage for the handoff verifier and the
 * last sign-in method, and the React Native ID-token path. No DOM in this environment.
 */

import { describe, expect, it, vi } from "vitest";
import {
  completeSocialSignIn,
  getLastAuthMethod,
  LAST_AUTH_METHOD_KEY,
  loadLastAuthMethod,
  SOCIAL_HANDOFF_KEY,
  setLastAuthMethod,
  signInWithIdToken,
  startSocialSignIn,
} from "../../src/auth/auth-social.js";
import { createTokenStore } from "../../src/auth/auth-token.js";

/** An async key-value store, shaped like expo-secure-store / AsyncStorage. */
function asyncStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: async (k: string) => {
      map.delete(k);
    },
  };
}

describe("injectable storage", () => {
  it("last method: async storage round-trip; the web getter is null without localStorage", async () => {
    const store = asyncStorage();
    await setLastAuthMethod("google", store);
    expect(store.map.get(LAST_AUTH_METHOD_KEY)).toBe("google");
    expect(await loadLastAuthMethod(store)).toBe("google");
    expect(getLastAuthMethod()).toBeNull();
    await expect(setLastAuthMethod("google")).resolves.toBeUndefined();
  });

  it("start + complete a redirect handoff through injected async storage", async () => {
    const storage = asyncStorage();
    const methodStorage = asyncStorage();
    const social = vi.fn(async () => ({ data: { url: "https://provider" } }));
    await startSocialSignIn(
      { signIn: { social } },
      { provider: "github", appOrigin: "https://app.example.com", next: "/orders", storage },
    );
    expect(storage.map.has(SOCIAL_HANDOFF_KEY)).toBe(true);

    const tokens = createTokenStore(asyncStorage(), "token");
    const target = {
      baseURL: "https://api.example.com/api/auth",
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ token: "tok", user: { id: "u1" } }), { status: 200 }),
      ) as never,
    };
    const result = await completeSocialSignIn(target, tokens, {
      location: { hash: "#handoff=code1", search: "?next=%2Forders", pathname: "/auth/callback" },
      storage,
      methodStorage,
    });
    expect(result).toMatchObject({ ok: true, next: "/orders", provider: "github" });
    expect(tokens.get()).toBe("tok");
    expect(storage.map.has(SOCIAL_HANDOFF_KEY)).toBe(false);
    expect(methodStorage.map.get(LAST_AUTH_METHOD_KEY)).toBe("github");
  });
});

describe("signInWithIdToken (React Native)", () => {
  it("sends the ID token + nonce, stores the bearer token and the method", async () => {
    const social = vi.fn(async () => ({
      data: { token: "bearer-1", user: { id: "u1" } },
      error: null,
    }));
    const tokens = createTokenStore(asyncStorage(), "token");
    const methodStorage = asyncStorage();
    const result = await signInWithIdToken({ signIn: { social } }, tokens, {
      provider: "google",
      idToken: "id-token",
      nonce: "n1",
      methodStorage,
    });
    expect(social).toHaveBeenCalledWith({
      provider: "google",
      idToken: { token: "id-token", nonce: "n1" },
    });
    expect(result).toEqual({ ok: true, user: { id: "u1" }, provider: "google" });
    expect(tokens.get()).toBe("bearer-1");
    expect(methodStorage.map.get(LAST_AUTH_METHOD_KEY)).toBe("google");
  });

  it("maps a refusal to a UI intent and never throws", async () => {
    const tokens = createTokenStore(asyncStorage(), "token");
    const refused = await signInWithIdToken(
      {
        signIn: {
          social: async () => ({ data: null, error: { code: "BANNED_USER", status: 403 } }),
        },
      },
      tokens,
      { provider: "google", idToken: "x" },
    );
    expect(refused).toMatchObject({ ok: false, error: { intent: "blocked" } });
    const offline = await signInWithIdToken(
      {
        signIn: {
          social: async () => {
            throw new TypeError("Network request failed");
          },
        },
      },
      tokens,
      { provider: "google", idToken: "x" },
    );
    expect(offline).toMatchObject({ ok: false, error: { code: "network_error" } });
    expect(tokens.get()).toBeNull();
  });
});
