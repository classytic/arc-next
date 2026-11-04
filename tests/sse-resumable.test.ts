/**
 * Resumable, alarm-grade SSE on `subscribeToEvents` (Unreleased).
 *
 * The client half of the realtime contract shared with arc's replay hub:
 * `ready` / `resync` / `revoked` control frames ({@link STREAM_FRAMES}),
 * `resumeFrom` and `resumeQueryParam`, liveness via `onActivity` and
 * `staleAfterMs`, a jittered backoff, terminal events and statuses, and a
 * typed `onStatus` health.
 *
 * Driven by an injected EventSource so every frame, heartbeat and failure is
 * explicit, with fake timers from the start.
 */

import { type ResyncReason, STREAM_FRAMES } from "@classytic/repo-core/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAuthRecovery,
  _resetAuthWarnings,
  configureAuth,
  configureClient,
  type EventSourceEventLike,
  type EventSourceInitLike,
} from "../src/client.js";
import { type StreamStatus, subscribeToEvents } from "../src/sse.js";

type Listener = (event: EventSourceEventLike) => void;

/**
 * An injected transport: persistent `lastEventId` and `init.onActivity`, but NOT seeded from the
 * sent `Last-Event-ID` (like react-native-sse): it reports `""` until a frame carries an id, the
 * stricter case. The built-in FetchEventSource is covered in sse-fetch.test.ts.
 */
class FakeES {
  static instances: FakeES[] = [];
  listeners = new Map<string, Listener[]>();
  closed = false;
  lastEventId: string;
  constructor(
    public url: string,
    public init: EventSourceInitLike = {},
  ) {
    this.lastEventId = "";
    FakeES.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  close() {
    this.closed = true;
  }
  fire(type: string, event: EventSourceEventLike = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, ...event });
  }
  open() {
    this.fire("open");
  }
  frame(type: string, payload: unknown, id?: string) {
    if (id !== undefined) this.lastEventId = id;
    this.init.onActivity?.();
    this.fire(type, { data: JSON.stringify(payload), lastEventId: this.lastEventId });
  }
  heartbeat() {
    this.init.onActivity?.();
  }
  fail(status?: number) {
    this.fire("error", status === undefined ? {} : { status });
  }
  static latest(): FakeES {
    const es = FakeES.instances[FakeES.instances.length - 1];
    if (!es) throw new Error("no EventSource");
    return es;
  }
  static reset() {
    FakeES.instances = [];
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const sentId = (es: FakeES) => es.init.headers?.["Last-Event-ID"];

describe("subscribeToEvents — resumable stream contract", () => {
  const fetchSpy = vi.fn(async () => new Response("", { status: 200 }));

  beforeEach(() => {
    vi.useFakeTimers();
    FakeES.reset();
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
    configureClient({
      baseUrl: "http://api.test",
      streamAuth: "header",
      eventSource: FakeES as never,
    });
    configureAuth({ getToken: () => "tok", getOrgId: () => null });
    _resetAuthRecovery();
    _resetAuthWarnings();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    configureClient({ baseUrl: "" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  it("STREAM_FRAMES pins the wire names shared with arc", () => {
    expect(STREAM_FRAMES).toEqual({
      READY: "ready",
      RESYNC: "resync",
      REVOKED: "revoked",
      RETRY: "retry",
    });
  });

  describe("retry frame (server asks for a fresh, re-authorized connection)", () => {
    it("reconnects within the jitter (no backoff) from the current cursor; status shows connecting", async () => {
      const statuses: StreamStatus[] = [];
      const onConnectionChange = vi.fn();
      const h = subscribeToEvents({
        resource: "alert",
        resumeFrom: "10",
        backoff: { initialMs: 60_000, random: () => 0.5 },
        onStatus: (s) => statuses.push(s),
        onConnectionChange,
      });
      const first = FakeES.latest();
      first.open();
      first.frame(STREAM_FRAMES.READY, { cursor: "10", resumed: true });
      first.frame("alert.updated", { x: 1 }, "11");
      expect(h.status().health).toBe("live");

      first.frame(STREAM_FRAMES.RETRY, { reason: "revalidate_failed" });
      expect(first.closed).toBe(true);
      expect(h.status()).toMatchObject({ health: "connecting", attempts: 0, lastEventId: "11" });
      expect(statuses.at(-1)?.health).toBe("connecting");
      expect(onConnectionChange).toHaveBeenLastCalledWith(false);

      // The server closes right after the frame: that close is expected, not a failure.
      first.fail();
      await flush();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(h.status().health).toBe("connecting");

      await vi.advanceTimersByTimeAsync(249);
      expect(FakeES.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); // 500 ms jitter * random 0.5
      expect(FakeES.instances).toHaveLength(2);
      const second = FakeES.latest();
      expect(sentId(second)).toBe("11");
      second.open();
      second.frame(STREAM_FRAMES.READY, { cursor: "11", resumed: true });
      expect(h.status()).toMatchObject({ health: "live", attempts: 0 });
      h.close();
    });

    it("is not terminal and never reaches onEvent or onTerminal", async () => {
      const onEvent = vi.fn();
      const onTerminal = vi.fn();
      const h = subscribeToEvents({
        resource: "alert",
        resumeFrom: "1",
        backoff: { random: () => 0 },
        onEvent,
        onTerminal,
      });
      const es = FakeES.latest();
      es.open();
      es.frame(STREAM_FRAMES.READY, { cursor: "1", resumed: true });
      es.frame(STREAM_FRAMES.RETRY, { reason: "retry" });
      await flush();
      expect(FakeES.instances).toHaveLength(2);
      expect(onEvent).not.toHaveBeenCalled();
      expect(onTerminal).not.toHaveBeenCalled();
      h.close();
    });

    it("a retry before the stream went live backs off instead of looping", async () => {
      const h = subscribeToEvents({ resource: "alert", resumeFrom: "1", reconnectDelay: 3000 });
      const es = FakeES.latest();
      es.open();
      es.frame(STREAM_FRAMES.RETRY, { reason: "retry" });
      expect(h.status()).toMatchObject({ health: "offline", attempts: 1 });
      await vi.advanceTimersByTimeAsync(2999);
      expect(FakeES.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeES.instances).toHaveLength(2);
      h.close();
    });

    it("close() during the jitter cancels the reconnect", async () => {
      const h = subscribeToEvents({ resource: "alert", resumeFrom: "1" });
      const es = FakeES.latest();
      es.open();
      es.frame(STREAM_FRAMES.READY, { cursor: "1", resumed: true });
      es.frame(STREAM_FRAMES.RETRY, { reason: "retry" });
      h.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeES.instances).toHaveLength(1);
      expect(h.status().health).toBe("closed");
    });
  });

  it("resumeFrom is sent as Last-Event-ID on the first connect only; later connects use the last id", async () => {
    const h = subscribeToEvents({ resource: "alert", resumeFrom: "0000000000000041" });
    const first = FakeES.latest();
    expect(sentId(first)).toBe("0000000000000041");
    first.open();
    first.frame("alert.updated", { x: 1 }, "0000000000000042");
    first.fail(503);
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeES.instances).toHaveLength(2);
    expect(sentId(FakeES.latest())).toBe("0000000000000042");
    h.close();
  });

  it("no resumeFrom: no Last-Event-ID header (0.19 behaviour)", () => {
    const h = subscribeToEvents({ resource: "alert" });
    expect(sentId(FakeES.latest())).toBeUndefined();
    h.close();
  });

  it("query mode: resumeQueryParam carries the id in the URL; without it nothing is added", async () => {
    configureClient({ baseUrl: "http://api.test", eventSource: FakeES as never });
    const plain = subscribeToEvents({ resource: "alert", resumeFrom: "7" });
    expect(FakeES.latest().url).not.toContain("lastEventId");
    expect(FakeES.latest().init.headers).toBeUndefined();
    plain.close();

    const h = subscribeToEvents({
      url: "http://api.test/alerts/stream?x=1",
      resumeFrom: "7",
      resumeQueryParam: "lastEventId",
    });
    expect(FakeES.latest().url).toBe("http://api.test/alerts/stream?x=1&lastEventId=7");
    const es = FakeES.latest();
    es.open();
    es.frame("message", { type: "a", data: 1 }, "8");
    es.fail(503);
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeES.latest().url).toBe("http://api.test/alerts/stream?x=1&lastEventId=8");
    h.close();
  });

  it("ready{cursor, resumed:false} with no cursor sent → one onResync('initial'), and the cursor is resent", async () => {
    const onResync = vi.fn();
    const onReady = vi.fn();
    const onEvent = vi.fn();
    const h = subscribeToEvents({ resource: "alert", onResync, onReady, onEvent });
    const es = FakeES.latest();
    es.open();
    es.frame(STREAM_FRAMES.READY, { cursor: "0000000000000100", resumed: false });
    expect(onReady).toHaveBeenCalledWith({ cursor: "0000000000000100", resumed: false });
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenCalledWith({ cursor: "0000000000000100", reason: "initial" });
    expect(h.status().lastEventId).toBe("0000000000000100");
    expect(onEvent).not.toHaveBeenCalled();

    es.fail(503);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sentId(FakeES.latest())).toBe("0000000000000100");
    h.close();
  });

  it("ready{resumed:true} → no resync; ready without cursor (realtimePlugin) is ignored", () => {
    const onResync = vi.fn();
    const onReady = vi.fn();
    const h = subscribeToEvents({ resource: "alert", resumeFrom: "5", onResync, onReady });
    const es = FakeES.latest();
    es.open();
    es.frame(STREAM_FRAMES.READY, { cursor: "9", resumed: true });
    expect(onResync).not.toHaveBeenCalled();
    expect(h.status().lastEventId).toBe("5");
    h.close();

    const h2 = subscribeToEvents({ resource: "alert", onResync, onReady });
    FakeES.latest().open();
    FakeES.latest().frame(STREAM_FRAMES.READY, { resources: ["alert"], operations: [] });
    expect(onResync).not.toHaveBeenCalled();
    expect(h2.status().lastEventId).toBeNull();
    expect(onReady).toHaveBeenLastCalledWith({
      resources: ["alert"],
      operations: [],
      resumed: false,
    });
    h2.close();
  });

  it("ready{resumed:false} after a sent cursor waits for resync; resync moves the cursor", async () => {
    const onResync = vi.fn();
    const h = subscribeToEvents({ resource: "alert", resumeFrom: "3", onResync });
    const es = FakeES.latest();
    es.open();
    // An id on an event this subscription does not listen to, before the resync.
    es.frame("other.thing", {}, "4");
    es.frame(STREAM_FRAMES.READY, { cursor: "50", resumed: false });
    expect(onResync).not.toHaveBeenCalled();
    es.frame(STREAM_FRAMES.RESYNC, { cursor: "50", reason: "gap_too_large" });
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenCalledWith({ cursor: "50", reason: "gap_too_large" });
    // A frame without an id carries the transport's stale id: it must not undo the resync.
    es.frame("alert.updated", { x: 1 });
    expect(h.status().lastEventId).toBe("50");

    es.fail(503);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sentId(FakeES.latest())).toBe("50");
    h.close();
  });

  it("resync reasons are passed through as the server sent them", () => {
    const reasons: Array<ResyncReason | "initial"> = [];
    const h = subscribeToEvents({
      resource: "alert",
      resumeFrom: "1",
      onResync: ({ reason }) => reasons.push(reason),
    });
    const es = FakeES.latest();
    es.open();
    es.frame(STREAM_FRAMES.RESYNC, { cursor: "2", reason: "cursor_expired" });
    es.frame(STREAM_FRAMES.RESYNC, { cursor: "3", reason: "cursor_invalid" });
    es.frame(STREAM_FRAMES.RESYNC, { reason: "cursor_invalid" }); // malformed: ignored
    expect(reasons).toEqual(["cursor_expired", "cursor_invalid"]);
    h.close();
  });

  it("control frames never reach onEvent; data frames still do", () => {
    const onEvent = vi.fn();
    const onResync = vi.fn();
    const h = subscribeToEvents({
      resource: "alert",
      eventTypes: ["alert"],
      terminalEvents: [STREAM_FRAMES.REVOKED],
      resumeFrom: null,
      onEvent,
      onResync,
    });
    const es = FakeES.latest();
    es.open();
    es.frame(STREAM_FRAMES.READY, { cursor: "1", resumed: false });
    es.frame(STREAM_FRAMES.RESYNC, { cursor: "2", reason: "cursor_expired" });
    es.frame("alert", { id: "a1" }, "3");
    es.frame(STREAM_FRAMES.REVOKED, { reason: "access_ended" });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]![0]).toMatchObject({ type: "alert", data: { id: "a1" } });
    expect(onResync).toHaveBeenCalledTimes(2);
    h.close();
  });

  it("without any resume option, ready / resync are not listened to (0.19 listener set)", () => {
    const h = subscribeToEvents({ resource: "alert", eventTypes: [] });
    const es = FakeES.latest();
    expect([...es.listeners.keys()].sort()).toEqual(["error", "message", "open"]);
    es.open();
    es.frame(STREAM_FRAMES.READY, { cursor: "9", resumed: false });
    expect(h.status().lastEventId).toBeNull();
    h.close();
  });

  it("terminalEvents: revoked → onTerminal, health 'revoked', no timers pending; restart() reconnects", () => {
    const onTerminal = vi.fn();
    const onConnectionChange = vi.fn();
    const h = subscribeToEvents({
      resource: "alert",
      staleAfterMs: 30_000,
      terminalEvents: [STREAM_FRAMES.REVOKED],
      onTerminal,
      onConnectionChange,
    });
    const es = FakeES.latest();
    es.open();
    es.frame(STREAM_FRAMES.REVOKED, { reason: "access_ended" });
    expect(onTerminal).toHaveBeenCalledWith({
      event: "revoked",
      data: { reason: "access_ended" },
    });
    expect(es.closed).toBe(true);
    expect(h.status().health).toBe("revoked");
    expect(h.isConnected()).toBe(false);
    expect(onConnectionChange).toHaveBeenLastCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);

    h.restart();
    expect(FakeES.instances).toHaveLength(2);
    expect(h.status().health).toBe("connecting");
    FakeES.latest().open();
    expect(h.status().health).toBe("live");
    h.close();
  });

  it("terminalStatuses [403] → revoked; neither auth recovery nor a probe runs", async () => {
    const onAuthError = vi.fn(async () => "retry" as const);
    configureAuth({ getToken: () => "tok", getOrgId: () => null, onAuthError, retryOn403: true });
    const onTerminal = vi.fn();
    const h = subscribeToEvents({ resource: "alert", terminalStatuses: [403], onTerminal });
    FakeES.latest().fail(403);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onTerminal).toHaveBeenCalledWith({ status: 403 });
    expect(h.status()).toMatchObject({ health: "revoked", lastStatus: 403 });
    expect(onAuthError).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(FakeES.instances).toHaveLength(1);
    h.close();
  });

  it("terminalStatuses on a native EventSource are read from the probe", async () => {
    configureClient({ baseUrl: "http://api.test", eventSource: FakeES as never });
    fetchSpy.mockImplementation(async () => new Response("", { status: 403 }));
    const onTerminal = vi.fn();
    const h = subscribeToEvents({ resource: "alert", terminalStatuses: [403], onTerminal });
    FakeES.latest().fail();
    await flush();
    expect(onTerminal).toHaveBeenCalledWith({ status: 403 });
    expect(h.status().health).toBe("revoked");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeES.instances).toHaveLength(1);
    h.close();
  });

  it("staleAfterMs: silence → 'stale' → reconnect with Last-Event-ID; heartbeats keep it live", async () => {
    const health: string[] = [];
    const onActivity = vi.fn();
    const h = subscribeToEvents({
      resource: "alert",
      staleAfterMs: 10_000,
      onActivity,
      onStatus: (s) => health.push(s.health),
    });
    const es = FakeES.latest();
    es.open();
    es.frame("alert.updated", { x: 1 }, "0000000000000007");
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(8_000);
      es.heartbeat();
    }
    expect(h.status().health).toBe("live");
    expect(es.closed).toBe(false);
    expect(onActivity.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(typeof onActivity.mock.calls[0]![0]).toBe("number");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(es.closed).toBe(true);
    expect(h.status().health).toBe("stale");
    expect(h.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeES.instances).toHaveLength(2);
    expect(sentId(FakeES.latest())).toBe("0000000000000007");
    FakeES.latest().open();
    // The retry being scheduled re-reports `stale` with attempts 1; health transitions only:
    expect(health.filter((x, i) => x !== health[i - 1])).toEqual([
      "connecting",
      "live",
      "stale",
      "live",
    ]);
    h.close();
  });

  it("activity from a superseded connection is ignored", async () => {
    const onActivity = vi.fn();
    const h = subscribeToEvents({ resource: "alert", onActivity });
    const first = FakeES.latest();
    first.open();
    first.heartbeat();
    expect(onActivity).toHaveBeenCalledTimes(2); // open + heartbeat
    h.reconnect();
    const second = FakeES.latest();
    onActivity.mockClear();
    first.heartbeat();
    expect(onActivity).not.toHaveBeenCalled();
    second.open();
    second.heartbeat();
    expect(onActivity).toHaveBeenCalledTimes(2);
    h.close();
  });

  it("default backoff schedule is unchanged: 3000, 4500, 6750, … capped at 30000", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === "number" && ms > 0) delays.push(ms);
      return real(fn, ms);
    }) as typeof setTimeout);
    const h = subscribeToEvents({ resource: "alert" });
    for (let i = 0; i < 8; i++) {
      FakeES.latest().fail(503);
      await flush();
      await vi.advanceTimersByTimeAsync(delays[delays.length - 1] ?? 0);
    }
    expect(delays).toEqual([3000, 4500, 6750, 10125, 15187.5, 22781.25, 30000, 30000]);
    h.close();
  });

  it("backoff jitter uses the injected random: min(max, initial*factor^(n-1)) * (1 - jitter*random)", async () => {
    const h = subscribeToEvents({
      resource: "alert",
      backoff: { initialMs: 1000, factor: 2, maxMs: 3000, jitter: 0.5, random: () => 0.5 },
    });
    const expectNextAfter = async (ms: number) => {
      const before = FakeES.instances.length;
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(FakeES.instances).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeES.instances).toHaveLength(before + 1);
    };
    FakeES.latest().fail(503);
    await flush();
    await expectNextAfter(750); // 1000 * 0.75
    FakeES.latest().fail(503);
    await flush();
    await expectNextAfter(1500); // 2000 * 0.75
    FakeES.latest().fail(503);
    await flush();
    await expectNextAfter(2250); // min(3000, 4000) * 0.75
    h.close();
  });

  it("onStatus: connecting → live → offline (attempts 1) → live (attempts 0) → closed", async () => {
    const seen: StreamStatus[] = [];
    const h = subscribeToEvents({ resource: "alert", onStatus: (s) => seen.push(s) });
    FakeES.latest().open();
    FakeES.latest().fail(503);
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    FakeES.latest().open();
    h.close();

    const compact = seen.map((s) => [s.health, s.attempts]);
    // Offline is reported at the failure, then again once the retry is scheduled.
    expect(compact).toEqual([
      ["connecting", 0],
      ["live", 0],
      ["offline", 0],
      ["offline", 1],
      ["live", 0],
      ["closed", 0],
    ]);
    expect(seen[2]!.lastStatus).toBe(503);
    expect(seen[4]!.lastStatus).toBeUndefined();
    expect(seen.every((s) => typeof s.since === "number")).toBe(true);
    expect(h.status().health).toBe("closed");
  });

  it("onConnectionChange is derived as before", async () => {
    const changes: boolean[] = [];
    const h = subscribeToEvents({ resource: "alert", onConnectionChange: (c) => changes.push(c) });
    FakeES.latest().open();
    FakeES.latest().fail(503);
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    FakeES.latest().open();
    h.close();
    expect(changes).toEqual([true, false, true, false]);
  });

  it('an id-less frame on a transport that reports "" keeps the sent cursor', async () => {
    const h = subscribeToEvents({ resource: "alert", resumeFrom: "c1", onResync: vi.fn() });
    const es = FakeES.latest();
    es.open();
    es.frame(STREAM_FRAMES.READY, { cursor: "c1", resumed: true });
    expect(h.status().lastEventId).toBe("c1");
    es.fail(); // the transport's lastEventId is still ""
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeES.instances).toHaveLength(2);
    expect(sentId(FakeES.latest())).toBe("c1");
    h.close();
  });

  it("revoked is terminal by default once the stream opts into resume; [] and no opt-in keep 0.19", () => {
    const onTerminal = vi.fn();
    const h = subscribeToEvents({ resource: "alert", resumeFrom: "1", onTerminal });
    FakeES.latest().open();
    FakeES.latest().frame(STREAM_FRAMES.REVOKED, { reason: "access_ended" });
    expect(onTerminal).toHaveBeenCalledWith({ event: "revoked", data: { reason: "access_ended" } });
    expect(h.status().health).toBe("revoked");
    h.close();

    const optOut = subscribeToEvents({ resource: "alert", resumeFrom: "1", terminalEvents: [] });
    expect(FakeES.latest().listeners.has(STREAM_FRAMES.REVOKED)).toBe(false);
    optOut.close();
    const plain = subscribeToEvents({ resource: "alert" });
    expect(FakeES.latest().listeners.has(STREAM_FRAMES.REVOKED)).toBe(false);
    plain.close();
  });

  it("a manual reconnect() cancels a pending scheduled reconnect", async () => {
    const h = subscribeToEvents({ resource: "alert" });
    FakeES.latest().fail(503);
    await flush();
    h.reconnect();
    expect(FakeES.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeES.instances).toHaveLength(2);
    h.close();
  });

  it("an error from a superseded transport does not close or reschedule the live one", async () => {
    const h = subscribeToEvents({ resource: "alert" });
    const first = FakeES.latest();
    first.open();
    h.reconnect();
    const live = FakeES.latest();
    live.open();
    first.fail(503);
    await flush();
    expect(live.closed).toBe(false);
    expect(h.status()).toMatchObject({ health: "live", attempts: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeES.instances).toHaveLength(2);
    h.close();
  });

  it("a probe still running when reconnect() opens a newer connection does not touch it", async () => {
    configureClient({ baseUrl: "http://api.test", eventSource: FakeES as never });
    let resolveProbe!: (r: Response) => void;
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolveProbe = r;
        }),
    );
    const onTerminal = vi.fn();
    const h = subscribeToEvents({ resource: "alert", terminalStatuses: [403], onTerminal });
    FakeES.latest().fail();
    h.reconnect();
    const live = FakeES.latest();
    live.open();
    resolveProbe(new Response("", { status: 403 }));
    await flush();
    expect(onTerminal).not.toHaveBeenCalled();
    expect(live.closed).toBe(false);
    expect(h.status()).toMatchObject({ health: "live", attempts: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeES.instances).toHaveLength(2);
    h.close();
  });

  it("an auth recovery still running when reconnect() opens a newer connection does not reopen", async () => {
    let decide!: (d: "retry") => void;
    const onAuthError = vi.fn(
      () =>
        new Promise<"retry">((r) => {
          decide = r;
        }),
    );
    configureAuth({ getToken: () => "tok", getOrgId: () => null, onAuthError });
    const h = subscribeToEvents({ resource: "alert" });
    FakeES.latest().fail(401);
    await flush();
    expect(onAuthError).toHaveBeenCalledTimes(1);
    h.reconnect();
    const live = FakeES.latest();
    live.open();
    decide("retry");
    await flush();
    expect(FakeES.instances).toHaveLength(2);
    expect(live.closed).toBe(false);
    h.close();
  });

  it("close() during onAuthError recovery does not reconnect later", async () => {
    let decide!: (d: "retry") => void;
    const onAuthError = vi.fn(
      () =>
        new Promise<"retry">((r) => {
          decide = r;
        }),
    );
    configureAuth({ getToken: () => "tok", getOrgId: () => null, onAuthError });
    const h = subscribeToEvents({ resource: "alert" });
    FakeES.latest().fail(401);
    await flush();
    h.close();
    decide("retry");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeES.instances).toHaveLength(1);
    expect(h.status().health).toBe("closed");
  });

  it("native EventSource: terminalStatuses are probed on every failure, not just the first", async () => {
    configureClient({ baseUrl: "http://api.test", eventSource: FakeES as never });
    fetchSpy.mockImplementationOnce(async () => new Response("", { status: 502 }));
    fetchSpy.mockImplementation(async () => new Response("", { status: 403 }));
    const onTerminal = vi.fn();
    const h = subscribeToEvents({ resource: "alert", terminalStatuses: [403], onTerminal });
    FakeES.latest().fail(); // server restarting
    await flush();
    expect(h.status()).toMatchObject({ health: "offline", lastStatus: 502 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeES.instances).toHaveLength(2);
    FakeES.latest().fail(); // back, and now refusing
    await flush();
    expect(onTerminal).toHaveBeenCalledWith({ status: 403 });
    expect(h.status().health).toBe("revoked");
    h.close();
  });

  it("a probe that answers 2xx is not recorded as a failure status", async () => {
    configureClient({ baseUrl: "http://api.test", eventSource: FakeES as never });
    fetchSpy.mockImplementation(async () => new Response("", { status: 200 }));
    const h = subscribeToEvents({ resource: "alert" });
    FakeES.latest().fail();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(h.status().health).toBe("offline");
    expect(h.status().lastStatus).toBeUndefined();
    h.close();
  });

  it("out of attempts: health becomes offline, also after a stale timeout", async () => {
    const h = subscribeToEvents({ resource: "alert", staleAfterMs: 5000, maxReconnectAttempts: 0 });
    FakeES.latest().open();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeES.latest().closed).toBe(true);
    expect(h.status().health).toBe("offline");
    expect(vi.getTimerCount()).toBe(0);
    h.close();
  });

  it("invalid backoff values fall back or clamp instead of a tight loop", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === "number") delays.push(ms);
      return real(fn, ms);
    }) as typeof setTimeout);
    const h = subscribeToEvents({
      resource: "alert",
      backoff: { initialMs: Number.NaN, factor: 0.1, maxMs: 0, jitter: Number.NaN },
    });
    for (let i = 0; i < 3; i++) {
      FakeES.latest().fail(503);
      await flush();
      await vi.advanceTimersByTimeAsync(delays[delays.length - 1] ?? 0);
    }
    expect(delays.filter((d) => d > 0)).toEqual([3000, 3000, 3000]);
    h.close();
  });

  it("staleAfterMs on the runtime's native EventSource warns once (heartbeats are invisible there)", () => {
    vi.stubGlobal("EventSource", FakeES);
    configureClient({ baseUrl: "http://api.test" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = subscribeToEvents({ resource: "alert", staleAfterMs: 30_000 });
    h.reconnect();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("staleAfterMs");
    h.close();
    warn.mockClear();
    configureClient({ baseUrl: "http://api.test", eventSource: FakeES as never });
    const injected = subscribeToEvents({ resource: "alert", staleAfterMs: 30_000 });
    expect(warn).not.toHaveBeenCalled();
    injected.close();
    warn.mockRestore();
  });

  it("close() during the failure probe does not reconnect later", async () => {
    configureClient({ baseUrl: "http://api.test", eventSource: FakeES as never });
    let resolveProbe!: (r: Response) => void;
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolveProbe = r;
        }),
    );
    const h = subscribeToEvents({ resource: "alert" });
    FakeES.latest().fail();
    h.close();
    resolveProbe(new Response("", { status: 503 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeES.instances).toHaveLength(1);
  });
});

describe("subscribeToEvents — liveOn: live on the ready frame (G-E2E-PORTAL-1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeES.reset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
    configureClient({
      baseUrl: "http://api.test",
      streamAuth: "header",
      eventSource: FakeES as never,
    });
    configureAuth({ getToken: () => "tok", getOrgId: () => null });
    _resetAuthRecovery();
    _resetAuthWarnings();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    configureClient({ baseUrl: "" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  const healths = (seen: StreamStatus[]) => seen.map((s) => [s.health, s.attempts]);

  it("a resumable stream that opens and heartbeats is not live until its ready frame", () => {
    const seen: StreamStatus[] = [];
    const connected: boolean[] = [];
    const h = subscribeToEvents({
      resource: "alert",
      onResync: vi.fn(),
      onStatus: (s) => seen.push(s),
      onConnectionChange: (c) => connected.push(c),
    });
    const es = FakeES.latest();
    es.open();
    es.heartbeat();
    expect(h.status().health).toBe("connecting");
    // The transport is open: onConnectionChange / isConnected still follow it.
    expect(connected).toEqual([true]);
    expect(h.isConnected()).toBe(true);

    es.frame(STREAM_FRAMES.READY, { cursor: "0000000000000010", resumed: false });
    expect(h.status().health).toBe("live");
    expect(healths(seen)).toEqual([
      ["connecting", 0],
      ["live", 0],
    ]);
    // The live status already carries the cursor the ready frame set.
    expect(seen[1]!.lastEventId).toBe("0000000000000010");
    h.close();
  });

  it("a drop before ready resumes with the cursor it had and shows offline, never live", async () => {
    const seen: StreamStatus[] = [];
    const h = subscribeToEvents({
      resource: "alert",
      resumeFrom: "0000000000000041",
      onStatus: (s) => seen.push(s),
    });
    FakeES.latest().open();
    FakeES.latest().fail(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sentId(FakeES.latest())).toBe("0000000000000041");
    FakeES.latest().open();
    expect(h.status().health).toBe("offline");
    // attempts are not reset by an open without ready: the backoff keeps growing.
    FakeES.latest().fail(0);
    await vi.advanceTimersByTimeAsync(4499);
    expect(FakeES.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeES.instances).toHaveLength(3);
    expect(sentId(FakeES.latest())).toBe("0000000000000041");
    FakeES.latest().open();
    FakeES.latest().frame(STREAM_FRAMES.READY, { cursor: "0000000000000041", resumed: true });
    expect(h.status()).toMatchObject({ health: "live", attempts: 0 });
    expect(seen.filter((s) => s.health === "live")).toHaveLength(1);
    h.close();
  });

  it("a first connect that drops before ready reconnects with no cursor", async () => {
    const h = subscribeToEvents({ resource: "alert", onResync: vi.fn() });
    expect(sentId(FakeES.latest())).toBeUndefined();
    FakeES.latest().open();
    FakeES.latest().fail(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeES.instances).toHaveLength(2);
    expect(sentId(FakeES.latest())).toBeUndefined();
    expect(h.status().health).toBe("offline");
    h.close();
  });

  it("a stale reconnect stays stale until the new connection's ready", async () => {
    const h = subscribeToEvents({ resource: "alert", resumeFrom: "c1", staleAfterMs: 10_000 });
    FakeES.latest().open();
    FakeES.latest().frame(STREAM_FRAMES.READY, { cursor: "c1", resumed: true });
    expect(h.status().health).toBe("live");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.status().health).toBe("stale");
    await vi.advanceTimersByTimeAsync(3000);
    FakeES.latest().open();
    FakeES.latest().heartbeat();
    expect(h.status().health).toBe("stale");
    FakeES.latest().frame(STREAM_FRAMES.READY, { cursor: "c1", resumed: true });
    expect(h.status().health).toBe("live");
    h.close();
  });

  it("after maxResumeFailures drops before ready on one cursor, the next connect starts fresh and resyncs", async () => {
    const onResync = vi.fn();
    const h = subscribeToEvents({ resource: "alert", resumeFrom: "0000000000000099", onResync });
    // Three connections accept the cursor, then die before ready (default limit 3).
    for (let i = 0; i < 3; i += 1) {
      expect(sentId(FakeES.latest())).toBe("0000000000000099");
      FakeES.latest().open();
      FakeES.latest().fail(0);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const fresh = FakeES.latest();
    expect(sentId(fresh)).toBeUndefined();
    fresh.open();
    fresh.frame(STREAM_FRAMES.READY, { cursor: "0000000000000120", resumed: false });
    expect(onResync).toHaveBeenCalledWith({ cursor: "0000000000000120", reason: "initial" });
    expect(h.status()).toMatchObject({ health: "live", lastEventId: "0000000000000120" });
    h.close();
  });

  it("failures that never opened, or a ready in between, do not count; 0 turns the reset off", async () => {
    const h = subscribeToEvents({ resource: "alert", resumeFrom: "c9" });
    // Never opened (network down): five times, the cursor stays.
    for (let i = 0; i < 5; i += 1) {
      FakeES.latest().fail(0);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(sentId(FakeES.latest())).toBe("c9");
    // Two early drops, a ready, two more: never three in a row.
    for (const ready of [false, false, true, false, false]) {
      FakeES.latest().open();
      if (ready) FakeES.latest().frame(STREAM_FRAMES.READY, { cursor: "c9", resumed: true });
      FakeES.latest().fail(0);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(sentId(FakeES.latest())).toBe("c9");
    h.close();

    FakeES.reset();
    const off = subscribeToEvents({ resource: "alert", resumeFrom: "c9", maxResumeFailures: 0 });
    for (let i = 0; i < 6; i += 1) {
      FakeES.latest().open();
      FakeES.latest().fail(0);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(sentId(FakeES.latest())).toBe("c9");
    off.close();
  });

  it("liveOn: 'open' keeps 0.19's live-on-open for a resumable server without a ready frame", () => {
    const h = subscribeToEvents({ resource: "alert", resumeFrom: "c1", liveOn: "open" });
    FakeES.latest().open();
    expect(h.status().health).toBe("live");
    h.close();
  });

  it("liveOn: 'ready' opts a plain stream into the contract (ready frames handled, not events)", () => {
    const onEvent = vi.fn();
    const h = subscribeToEvents({ resource: "alert", liveOn: "ready", onEvent });
    FakeES.latest().open();
    expect(h.status().health).toBe("connecting");
    FakeES.latest().frame(STREAM_FRAMES.READY, { resumed: false });
    expect(h.status().health).toBe("live");
    expect(onEvent).not.toHaveBeenCalled();
    h.close();
  });
});

describe("subscribeToEvents — compareCursors: each data frame once, in cursor order (G-INT-1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeES.reset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
    configureClient({
      baseUrl: "http://api.test",
      streamAuth: "header",
      eventSource: FakeES as never,
    });
    configureAuth({ getToken: () => "tok", getOrgId: () => null });
    _resetAuthRecovery();
    _resetAuthWarnings();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    configureClient({ baseUrl: "" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
  });

  const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const ids = (onEvent: ReturnType<typeof vi.fn>) =>
    onEvent.mock.calls.map((c) => (c[0] as { id?: string }).id);

  it("drops frames at or below resumeFrom and repeats on the same connection", () => {
    const onEvent = vi.fn();
    const h = subscribeToEvents({
      eventTypes: ["alert"],
      resumeFrom: "0005",
      compareCursors: lexical,
      onEvent,
    });
    const es = FakeES.latest();
    es.open();
    es.frame(STREAM_FRAMES.READY, { cursor: "0005", resumed: true });
    for (const id of ["0004", "0005", "0006", "0006", "0007"]) es.frame("alert", { n: id }, id);
    expect(ids(onEvent)).toEqual(["0006", "0007"]);
    h.close();
  });

  it("a replay after a reconnect applies only what was not applied yet", async () => {
    const onEvent = vi.fn();
    const h = subscribeToEvents({
      eventTypes: ["alert"],
      resumeFrom: null,
      compareCursors: lexical,
      onEvent,
    });
    FakeES.latest().open();
    FakeES.latest().frame(STREAM_FRAMES.READY, { cursor: "0001", resumed: false });
    FakeES.latest().frame("alert", {}, "0002");
    FakeES.latest().frame("alert", {}, "0003");
    FakeES.latest().fail(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sentId(FakeES.latest())).toBe("0003");
    FakeES.latest().open();
    FakeES.latest().frame(STREAM_FRAMES.READY, { cursor: "0003", resumed: true });
    // At-least-once: the server repeats from an older point.
    for (const id of ["0002", "0003", "0004"]) FakeES.latest().frame("alert", {}, id);
    expect(ids(onEvent)).toEqual(["0002", "0003", "0004"]);
    h.close();
  });

  it("a resync or an initial ready moves the floor to the server's cursor, also down", () => {
    const onEvent = vi.fn();
    const h = subscribeToEvents({
      eventTypes: ["alert"],
      resumeFrom: "0009",
      compareCursors: lexical,
      onEvent,
      onResync: vi.fn(),
    });
    const es = FakeES.latest();
    es.open();
    es.frame(STREAM_FRAMES.RESYNC, { cursor: "0003", reason: "cursor_invalid" });
    es.frame("alert", {}, "0004");
    expect(ids(onEvent)).toEqual(["0004"]);
    h.close();
  });

  it("frames without any id, and every frame without compareCursors, pass (0.19)", () => {
    const onEvent = vi.fn();
    const h = subscribeToEvents({ eventTypes: ["alert"], resumeFrom: "0005", onEvent });
    const es = FakeES.latest();
    es.open();
    for (const id of ["0004", "0006", "0006"]) es.frame("alert", {}, id);
    expect(ids(onEvent)).toEqual(["0004", "0006", "0006"]);
    h.close();

    FakeES.reset();
    const plain = vi.fn();
    const p = subscribeToEvents({ eventTypes: ["note"], compareCursors: lexical, onEvent: plain });
    FakeES.latest().open();
    FakeES.latest().frame("note", { a: 1 });
    FakeES.latest().frame("note", { a: 2 });
    expect(plain).toHaveBeenCalledTimes(2);
    p.close();
  });
});
