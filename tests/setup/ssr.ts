/**
 * SSR project setup: a server render has no DOM, so TanStack's `environmentManager.isServer()` is
 * true and `getQueryClient()` returns a fresh client per call (per request). Fail fast if a
 * browser global leaked into this environment.
 */

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
  throw new Error("ssr tests must run without a DOM (window is defined)");
}
