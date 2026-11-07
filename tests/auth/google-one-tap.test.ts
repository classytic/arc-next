/**
 * Google One Tap: the script loads only in the browser and only while enabled; the nonce given to
 * Google is the one posted with the credential; the token lands in the store; unmount cancels.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLastAuthMethod } from "../../src/auth/auth-social.js";
import { createTokenStore } from "../../src/auth/auth-token.js";

const GSI = "https://accounts.google.com/gsi/client";
const gsiScripts = () => [...document.head.querySelectorAll("script")].filter((s) => s.src === GSI);

const tokenStore = () => {
  const data = new Map<string, string>();
  return createTokenStore(
    {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    },
    "token",
  );
};

const fakeGoogle = () => {
  const id = { initialize: vi.fn(), prompt: vi.fn(), cancel: vi.fn() };
  (window as any).google = { accounts: { id } };
  return id;
};

const load = async () => {
  vi.resetModules();
  return import("../../src/auth/google-one-tap.js");
};

beforeEach(() => {
  localStorage.clear();
  for (const s of gsiScripts()) s.remove();
  delete (window as any).google;
});
afterEach(() => vi.restoreAllMocks());

describe("useGoogleOneTap", () => {
  it("injects nothing while disabled", async () => {
    const { useGoogleOneTap } = await load();
    renderHook(() =>
      useGoogleOneTap({
        clientId: "cid",
        enabled: false,
        authClient: { baseURL: "https://api" },
        tokens: tokenStore(),
        idleTimeoutMs: 0,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(gsiScripts()).toHaveLength(0);
  });

  it("loads the script when idle, prompts with FedCM and a nonce, and signs in with the credential", async () => {
    const { useGoogleOneTap } = await load();
    const $fetch = vi.fn(async () => ({
      data: { token: "ot-token", user: { id: "u1" } },
      error: null,
    }));
    const tokens = tokenStore();
    const onSignedIn = vi.fn();
    const { unmount } = renderHook(() =>
      useGoogleOneTap({
        clientId: "cid",
        authClient: { $fetch },
        tokens,
        onSignedIn,
        context: "signup",
        idleTimeoutMs: 0,
      }),
    );

    await waitFor(() => expect(gsiScripts()).toHaveLength(1));
    const id = fakeGoogle();
    gsiScripts()[0]!.onload?.(new Event("load"));
    await waitFor(() => expect(id.prompt).toHaveBeenCalledTimes(1));

    const config = id.initialize.mock.calls[0]![0];
    expect(config).toMatchObject({
      client_id: "cid",
      use_fedcm_for_prompt: true,
      context: "signup",
    });
    expect(config.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);

    await config.callback({ credential: "id-token" });
    expect($fetch).toHaveBeenCalledWith("/one-tap/callback", {
      method: "POST",
      body: { idToken: "id-token", nonce: config.nonce },
    });
    expect(tokens.get()).toBe("ot-token");
    expect(getLastAuthMethod()).toBe("google");
    expect(onSignedIn).toHaveBeenCalledWith({ token: "ot-token", user: { id: "u1" } });

    unmount();
    expect(id.cancel).toHaveBeenCalled();
  });

  it("reports a refused credential through onError", async () => {
    const { useGoogleOneTap } = await load();
    const id = fakeGoogle(); // already loaded: no script tag needed
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "SIGNUP_DISABLED", message: "signup disabled" }), {
          status: 401,
        }),
    );
    const onError = vi.fn();
    const tokens = tokenStore();
    renderHook(() =>
      useGoogleOneTap({
        clientId: "cid",
        authClient: {
          baseURL: "https://api/api/auth",
          fetch: fetchMock as unknown as typeof fetch,
        },
        tokens,
        onError,
        idleTimeoutMs: 0,
      }),
    );
    await waitFor(() => expect(id.initialize).toHaveBeenCalled());
    expect(gsiScripts()).toHaveLength(0);
    await id.initialize.mock.calls[0]![0].callback({ credential: "id-token" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api/api/auth/one-tap/callback",
      expect.anything(),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SIGNUP_DISABLED", intent: "signup-disabled" }),
    );
    expect(tokens.get()).toBeNull();
  });
});
