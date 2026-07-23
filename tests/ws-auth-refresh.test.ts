/**
 * WebSocket close-code 401 recovery — 0.7 wires WS close events with
 * auth-flavored codes (1008 / 3401 / 4001 / 4401) through the shared
 * `onAuthError` cycle. Verifies:
 *
 *  - Close with 1008 → handler fires → reconnects with new token in URL
 *  - Close with 4401 → recovery fires (community convention range)
 *  - Close with 1006 (abnormal) → NOT recovery, normal backoff reconnect
 *  - Handler returns 'skip' → no reconnect
 *  - Concurrent socket reconnects collapse to ONE refresh (shared dedup)
 *  - maxAuthRetries cap honored
 *  - Successful onopen resets the auth-retry budget
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAuthRecovery,
  _resetAuthWarnings,
  configureAuth,
  configureClient,
  createAuthRefreshHandler,
} from "../src/client.js";
import { connectWs } from "../src/ws.js";

// ── MockWebSocket — finer-grained than the one in ws.test.tsx because we
// need to control onopen timing (close BEFORE open to simulate auth-reject-
// at-handshake) and emit specific close codes.
class MockWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWS[] = [];

  url: string;
  protocols?: string | string[];
  readyState: number = MockWS.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  sent: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWS.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWS.OPEN) throw new Error("not open");
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWS.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }
  /** Manually open (so tests control timing of OPEN vs close). */
  triggerOpen(): void {
    this.readyState = MockWS.OPEN;
    this.onopen?.(new Event("open"));
  }
  /** Emit a close with a specific code (auth or non-auth). */
  triggerClose(code: number, reason = ""): void {
    this.readyState = MockWS.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason } as CloseEventInit));
  }

  static reset(): void {
    MockWS.instances = [];
  }
  static all(): MockWS[] {
    return MockWS.instances;
  }
  static latest(): MockWS {
    const x = MockWS.instances[MockWS.instances.length - 1];
    if (!x) throw new Error("no MockWS opened");
    return x;
  }
}

const originalWs = (globalThis as Record<string, unknown>).WebSocket;

beforeEach(() => {
  MockWS.reset();
  (globalThis as Record<string, unknown>).WebSocket = MockWS;
  // Provide WebSocket constants on the globalThis copy too (the SDK reads
  // `WebSocket.OPEN` etc. for ready-state checks).
  Object.assign(globalThis.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  configureClient({ baseUrl: "http://api.test" });
  configureAuth({ getToken: () => null, getOrgId: () => null });
  _resetAuthRecovery();
  _resetAuthWarnings();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (originalWs) (globalThis as Record<string, unknown>).WebSocket = originalWs;
  else delete (globalThis as Record<string, unknown>).WebSocket;
  vi.restoreAllMocks();
});

describe("connectWs — auth-recovery on close codes", () => {
  it("close code 1008 (Policy Violation) → handler refreshes → reconnects with new token", async () => {
    let cached = "stale-tok";
    const refresh = vi.fn(async () => {
      cached = "fresh-tok";
      return "fresh-tok";
    });
    configureAuth({
      getToken: () => cached,
      onAuthError: createAuthRefreshHandler({ refresh }),
    });

    const handle = connectWs({ path: "/ws" });

    // First socket opens, then server kicks us with 1008.
    expect(MockWS.all()).toHaveLength(1);
    MockWS.latest().triggerOpen();
    MockWS.latest().triggerClose(1008, "token expired");

    // Wait for the recovery cycle + reconnect to complete.
    await vi.waitFor(() => expect(MockWS.all()).toHaveLength(2));
    expect(refresh).toHaveBeenCalledTimes(1);
    // New URL carries the fresh token (buildStreamUrl reads getAuthContext).
    expect(MockWS.all()[1]!.url).toContain("token=fresh-tok");

    handle.close();
  });

  it.each([
    [3401, "3401 (community WebSocket-401)"],
    [4001, "4001 (legacy Socket.io 401)"],
    [4401, "4401 (4xxx range WebSocket-401)"],
  ])("close code %i → handler fires (%s)", async (code) => {
    const refresh = vi.fn(async () => "fresh");
    configureAuth({
      getToken: () => "stale",
      onAuthError: createAuthRefreshHandler({ refresh }),
    });

    const handle = connectWs({ path: "/ws" });
    MockWS.latest().triggerOpen();
    MockWS.latest().triggerClose(code);

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    handle.close();
  });

  it("close code 1006 (Abnormal) → recovery NOT invoked, normal backoff reconnect", async () => {
    const refresh = vi.fn();
    configureAuth({
      getToken: () => "tok",
      onAuthError: createAuthRefreshHandler({ refresh }),
    });

    const handle = connectWs({ path: "/ws", reconnectDelay: 10 });
    MockWS.latest().triggerOpen();
    MockWS.latest().triggerClose(1006);

    // Backoff reconnect schedules a new socket (after reconnectDelay).
    await vi.waitFor(() => expect(MockWS.all()).toHaveLength(2));
    expect(refresh).not.toHaveBeenCalled();

    handle.close();
  });

  it("handler returns 'skip' → no reconnect (consumer routes to sign-in)", async () => {
    configureAuth({
      getToken: () => "tok",
      onAuthError: async () => "skip",
    });

    const handle = connectWs({ path: "/ws" });
    MockWS.latest().triggerOpen();
    MockWS.latest().triggerClose(1008);

    // Give recovery a chance to run; assert no new socket was opened.
    await new Promise((r) => setTimeout(r, 60));
    expect(MockWS.all()).toHaveLength(1);

    handle.close();
  });

  it("CRITICAL — 3 concurrent sockets all 1008 → ONE refresh; all 3 reconnect with same token", async () => {
    let cached = "stale";
    const refresh = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      cached = "fresh";
      return "fresh";
    });
    configureAuth({
      getToken: () => cached,
      onAuthError: createAuthRefreshHandler({ refresh }),
    });

    const handles = [
      connectWs({ path: "/ws", url: "ws://api.test/ws?id=1" }),
      connectWs({ path: "/ws", url: "ws://api.test/ws?id=2" }),
      connectWs({ path: "/ws", url: "ws://api.test/ws?id=3" }),
    ];

    expect(MockWS.all()).toHaveLength(3);
    // All three sockets get kicked with 1008 simultaneously.
    for (const ws of MockWS.all()) {
      ws.triggerOpen();
      ws.triggerClose(1008);
    }

    await vi.waitFor(() => expect(MockWS.all()).toHaveLength(6));
    // ONE refresh shared across all three concurrent close events.
    expect(refresh).toHaveBeenCalledTimes(1);

    for (const h of handles) h.close();
  });

  it("maxAuthRetries:1 (default) — second auth-close surfaces without further handler calls", async () => {
    const refresh = vi.fn(async () => "fresh");
    configureAuth({
      getToken: () => "stale",
      onAuthError: createAuthRefreshHandler({ refresh }),
    });

    const handle = connectWs({ path: "/ws" });
    MockWS.latest().triggerOpen();
    MockWS.latest().triggerClose(1008); // first auth close → recovery

    await vi.waitFor(() => expect(MockWS.all()).toHaveLength(2));
    // Second socket also rejected with 1008 BEFORE successful open — cap hit.
    MockWS.latest().triggerClose(1008);

    // Give the runtime time to NOT spawn a third socket.
    await new Promise((r) => setTimeout(r, 60));

    // Handler was called once; second 1008 didn't trigger another recovery.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(MockWS.all()).toHaveLength(2);

    handle.close();
  });

  it("successful onopen between auth-closes resets the retry budget", async () => {
    let cached = "stale-1";
    let nextToken = "fresh-1";
    const refresh = vi.fn(async () => {
      cached = nextToken;
      return nextToken;
    });
    configureAuth({
      getToken: () => cached,
      onAuthError: createAuthRefreshHandler({ refresh }),
    });

    const handle = connectWs({ path: "/ws" });

    // Cycle 1: 1008 → recovery → reconnect → SUCCESSFUL open.
    MockWS.latest().triggerOpen();
    MockWS.latest().triggerClose(1008);
    await vi.waitFor(() => expect(MockWS.all()).toHaveLength(2));
    MockWS.latest().triggerOpen(); // success — budget resets

    // Cycle 2 (later): token expires again, 1008 again. Should recover again.
    nextToken = "fresh-2";
    MockWS.latest().triggerClose(1008);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(MockWS.all()).toHaveLength(3));
    expect(MockWS.all()[2]!.url).toContain("token=fresh-2");

    handle.close();
  });
});
