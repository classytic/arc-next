"use client";

/**
 * `@classytic/arc-next/google-one-tap`: Google One Tap for a bearer-token app on Better Auth's
 * `oneTap()` server plugin. Headless: Google draws the prompt; this hook loads the script when the
 * page is idle, prompts through FedCM, posts the credential to `<authBase>/one-tap/callback` and
 * stores the returned token.
 *
 * Content Security Policy: allow `https://accounts.google.com` in `connect-src` and `frame-src`
 * (and `https://accounts.google.com/gsi/style` in `style-src`). With Trusted Types enforced, add
 * {@link GOOGLE_ONE_TAP_POLICY} to the allowed policy names: the script URL is created through it.
 */

import { useEffect, useRef } from "react";
import {
  type AuthTarget,
  postAuthEndpoint,
  type SocialSignInError,
  setLastAuthMethod,
  toSocialError,
} from "./auth-social.js";
import type { TokenStore } from "./auth-token.js";

/** Google Identity Services client script. */
export const GOOGLE_GSI_SCRIPT_URL = "https://accounts.google.com/gsi/client";
/** Trusted Types policy name used to load {@link GOOGLE_GSI_SCRIPT_URL}. */
export const GOOGLE_ONE_TAP_POLICY = "arc-google-one-tap";

export interface GoogleOneTapOptions {
  /** OAuth web client id (the same one the server's Google provider or `oneTap()` uses). */
  clientId: string;
  /** Prompt only when true: pass `false` while signed in or while the session is loading. Default true. */
  enabled?: boolean;
  /** Where the credential is posted: a Better Auth client, or `{ baseURL }` of the auth API. */
  authClient: AuthTarget;
  tokens: TokenStore;
  onSignedIn?: (result: { token: string; user: unknown }) => void;
  onError?: (error: SocialSignInError) => void;
  /** Google's prompt wording. Default `"signin"`. */
  context?: "signin" | "signup" | "use";
  /** Sign in a returning person without a tap. Default false. */
  autoSelect?: boolean;
  /** Longest wait for an idle moment before loading the script (ms). Default 2000. */
  idleTimeoutMs?: number;
}

interface GoogleIdApi {
  initialize(config: Record<string, unknown>): void;
  prompt(): void;
  cancel(): void;
}

type GoogleWindow = Window & { google?: { accounts?: { id?: GoogleIdApi } } };

type TrustedTypesFactory = {
  createPolicy(
    name: string,
    rules: { createScriptURL(url: string): string },
  ): { createScriptURL(url: string): unknown };
};

/** Delay before loading where `requestIdleCallback` is missing (Safari). */
const NO_IDLE_DELAY_MS = 300;

let scriptPromise: Promise<GoogleIdApi> | null = null;
let scriptPolicy: { createScriptURL(url: string): unknown } | null = null;

function gsi(): GoogleIdApi | undefined {
  return (window as GoogleWindow).google?.accounts?.id;
}

function scriptUrl(): unknown {
  const factory = (window as Window & { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  if (!factory) return GOOGLE_GSI_SCRIPT_URL;
  scriptPolicy ??= factory.createPolicy(GOOGLE_ONE_TAP_POLICY, {
    createScriptURL: (url) => {
      if (url !== GOOGLE_GSI_SCRIPT_URL) throw new TypeError("Google One Tap: script URL refused");
      return url;
    },
  });
  return scriptPolicy.createScriptURL(GOOGLE_GSI_SCRIPT_URL);
}

function loadGoogleIdentity(): Promise<GoogleIdApi> {
  const ready = gsi();
  if (ready) return Promise.resolve(ready);
  scriptPromise ??= new Promise<GoogleIdApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const api = gsi();
      if (api) resolve(api);
      else reject(new Error("Google Identity Services did not initialize"));
    };
    script.onerror = () => reject(new Error("Google Identity Services failed to load"));
    (script as { src: unknown }).src = scriptUrl();
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

/** A random nonce for the ID token (base64url, 16 bytes). */
function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Show Google One Tap while `enabled`. Loads the script after `requestIdleCallback` (or a timeout),
 * prompts with FedCM, and on a credential posts `{ idToken, nonce }` to `/one-tap/callback`, stores
 * the token, records `"google"` as the last method and calls `onSignedIn`. Does nothing on the
 * server; cancels the prompt on unmount or when `enabled` turns false.
 */
export function useGoogleOneTap(options: GoogleOneTapOptions): void {
  const { clientId, enabled = true, context = "signin", autoSelect = false } = options;
  const idleTimeoutMs = options.idleTimeoutMs ?? 2000;
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!enabled || !clientId || typeof window === "undefined") return;
    let active = true;
    let started = false;
    const report = (code: string, description?: string) => {
      if (active) latest.current.onError?.(toSocialError(code, description));
    };

    const start = () => {
      if (!active) return;
      started = true;
      const nonce = createNonce();
      loadGoogleIdentity()
        .then((api) => {
          if (!active) return;
          api.initialize({
            client_id: clientId,
            nonce,
            context,
            auto_select: autoSelect,
            use_fedcm_for_prompt: true,
            itp_support: true,
            callback: async (response: { credential?: string }) => {
              if (!active || !response.credential) return;
              const { authClient, tokens } = latest.current;
              const result = await postAuthEndpoint(authClient, "/one-tap/callback", {
                idToken: response.credential,
                nonce,
              });
              if (!result.ok) return report(result.code, result.message);
              if (!result.token) return report("token_missing");
              await tokens.set(result.token);
              void setLastAuthMethod("google");
              const user = (result.data as { user?: unknown } | null)?.user ?? null;
              if (active) latest.current.onSignedIn?.({ token: result.token, user });
            },
          });
          api.prompt();
        })
        .catch((error: unknown) =>
          report("script_failed", error instanceof Error ? error.message : undefined),
        );
    };

    const idle = window.requestIdleCallback;
    const handle =
      typeof idle === "function"
        ? idle.call(window, start, { timeout: idleTimeoutMs })
        : window.setTimeout(start, Math.min(idleTimeoutMs, NO_IDLE_DELAY_MS));

    return () => {
      active = false;
      if (typeof idle === "function") window.cancelIdleCallback?.(handle);
      else window.clearTimeout(handle);
      if (started) gsi()?.cancel();
    };
  }, [enabled, clientId, context, autoSelect, idleTimeoutMs]);
}
