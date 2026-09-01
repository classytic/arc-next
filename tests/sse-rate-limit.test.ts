/**
 * A 429 must not be reconnected on the transient-error curve.
 *
 * `EventSource` reports no status, so a rate-limited stream is indistinguishable
 * from a dropped one — and retrying it is worse than useless: each attempt
 * spends another token, so the window never drains and the client locks itself
 * out. The pre-flight probe is a plain `fetch`, so it CAN read the status and
 * `Retry-After`; this pins that it does, and that the server's number wins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeToEvents } from "../src/sse.js";
import { configureAuth, configureClient } from "../src/client.js";

class FakeES {
  static instances: FakeES[] = [];
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  addEventListener() {}
  constructor(public url: string) {
    FakeES.instances.push(this);
  }
  close() {}
  static reset() {
    FakeES.instances = [];
  }
}

/**
 * Let the probe's promise chain settle under fake timers.
 * `advanceTimersByTimeAsync(0)` drains microtasks; a `setTimeout`-based flush
 * would never fire while timers are faked.
 */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("SSE rate-limit handling", () => {
  const origES = globalThis.EventSource;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    // Faked from the START — installing them after `subscribeToEvents` leaves the
    // reconnect timer on the real clock, so advancing fake time does nothing and
    // a "no reconnect happened" assertion passes for the wrong reason.
    vi.useFakeTimers();
    FakeES.reset();
    (globalThis as Record<string, unknown>).EventSource = FakeES;
    configureClient({ baseUrl: "http://api.test" });
    configureAuth({ getToken: () => "t", getOrgId: () => "o" });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (origES) (globalThis as Record<string, unknown>).EventSource = origES;
    if (origFetch) (globalThis as Record<string, unknown>).fetch = origFetch;
  });

  it("waits the server's Retry-After instead of the backoff curve", async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue({
      status: 429,
      headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "240" : null) },
    });

    const handle = subscribeToEvents({ resource: "n", reconnectDelay: 3000 });
    expect(FakeES.instances).toHaveLength(1);

    FakeES.instances[0].onerror?.(new Event("error"));
    await flush();

    // The transient curve would have reconnected at ~3s. 240s was stated.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeES.instances).toHaveLength(1);

    handle.close();
  });

  it("still reconnects on the normal curve for a transient failure", async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue({
      status: 503,
      headers: { get: () => null },
    });

    const handle = subscribeToEvents({ resource: "n", reconnectDelay: 3000 });
    FakeES.instances[0].onerror?.(new Event("error"));
    await flush();

    await vi.advanceTimersByTimeAsync(3_500);
    expect(FakeES.instances.length).toBeGreaterThan(1);

    handle.close();
  });

  it("probes even when no auth handler is registered", async () => {
    // Gated on `handler`, this never ran — and 429 fell to plain backoff.
    const fetchMock = vi.fn().mockResolvedValue({ status: 429, headers: { get: () => null } });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const handle = subscribeToEvents({ resource: "n" });
    FakeES.instances[0].onerror?.(new Event("error"));
    await flush();

    expect(fetchMock).toHaveBeenCalled();
    handle.close();
  });
});
