/** Timing helpers shared by tests: microtask flushing and a scoped fake-timer run. */

import { vi } from "vitest";

/** Let pending promise callbacks run (lazy imports, resolved fetches) without advancing time. */
export const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Run `fn` with fake timers, always restoring real ones (even when `fn` throws). */
export async function withFakeTimers<T>(fn: () => Promise<T> | T): Promise<T> {
  vi.useFakeTimers();
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
