/**
 * `isConnected` means "this tab is receiving events", not "this tab owns a
 * socket".
 *
 * Consumers switch polling off on it (`refetchInterval: isConnected ? false :
 * …`), so a follower reporting `false` polls despite being live — which would
 * restore exactly the request load that sharing the connection removes.
 * A follower must also NOT assume `true`: if no leader is listening, polling is
 * the only thing keeping the UI current.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAuth, configureClient } from "../src/client.js";
import { useEventStream } from "../src/sse.js";

/** Minimal same-realm BroadcastChannel: delivers to peers, never to the sender. */
class FakeChannel {
  static peers = new Map<string, Set<FakeChannel>>();
  /** Drop every post (a tab that died without its unload work). */
  static muted = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public name: string) {
    if (!FakeChannel.peers.has(name)) FakeChannel.peers.set(name, new Set());
    FakeChannel.peers.get(name)!.add(this);
  }
  postMessage(data: unknown) {
    if (FakeChannel.muted) return;
    for (const p of FakeChannel.peers.get(this.name) ?? []) {
      if (p !== this) p.onmessage?.({ data: structuredClone(data) });
    }
  }
  close() {
    FakeChannel.peers.get(this.name)?.delete(this);
  }
  static reset() {
    FakeChannel.muted = false;
    FakeChannel.peers.clear();
  }
}

class OpenEventSource {
  static instances: OpenEventSource[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  /** 0.15.1 subscribes to NAMED events via addEventListener, not just onmessage. */
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) {
    OpenEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    // Built-in events go to the on* slots the tests fire directly.
    if (type === "open") this.onopen = fn as (e: Event) => void;
    else if (type === "message") this.onmessage = fn;
    else if (type === "error") this.onerror = fn as (e: Event) => void;
    else this.listeners.set(type, fn);
  }
  emit(type: string, payload: unknown, id?: string) {
    const ev = new MessageEvent(type, { data: JSON.stringify(payload), lastEventId: id ?? "" });
    const named = this.listeners.get(type);
    if (named) named(ev);
    else this.onmessage?.(ev);
  }
  close() {}
  static reset() {
    OpenEventSource.instances = [];
  }
  static latest() {
    return OpenEventSource.instances[OpenEventSource.instances.length - 1];
  }
}

function wrapperFor(qc: QueryClient) {
  return function W({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe("useEventStream — cross-tab connection state", () => {
  let qc: QueryClient;
  const origES = globalThis.EventSource;
  const origBC = globalThis.BroadcastChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    FakeChannel.reset();
    OpenEventSource.reset();
    (globalThis as Record<string, unknown>).EventSource = OpenEventSource;
    (globalThis as Record<string, unknown>).BroadcastChannel = FakeChannel;
    configureClient({ baseUrl: "http://api.test" });
    configureAuth({ getToken: () => "t", getOrgId: () => "o" });
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
    qc.clear();
    localStorage.clear();
    if (origES) (globalThis as Record<string, unknown>).EventSource = origES;
    if (origBC) (globalThis as Record<string, unknown>).BroadcastChannel = origBC;
  });

  it("only the leader opens a socket", () => {
    renderHook(() => useEventStream({ resource: "n" }), { wrapper: wrapperFor(qc) });
    renderHook(() => useEventStream({ resource: "n" }), { wrapper: wrapperFor(qc) });

    expect(OpenEventSource.instances).toHaveLength(1);
  });

  it("a follower reports CONNECTED once the leader says it is", () => {
    const leader = renderHook(() => useEventStream({ resource: "n" }), { wrapper: wrapperFor(qc) });
    const follower = renderHook(() => useEventStream({ resource: "n" }), {
      wrapper: wrapperFor(qc),
    });

    expect(follower.result.current.isConnected).toBe(false);

    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
    });

    expect(leader.result.current.isConnected).toBe(true);
    expect(follower.result.current.isConnected).toBe(true);
  });

  it("a follower goes DISCONNECTED when the shared socket drops", () => {
    renderHook(() => useEventStream({ resource: "n" }), { wrapper: wrapperFor(qc) });
    const follower = renderHook(() => useEventStream({ resource: "n" }), {
      wrapper: wrapperFor(qc),
    });

    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
    });
    expect(follower.result.current.isConnected).toBe(true);

    act(() => {
      OpenEventSource.latest().onerror?.(new Event("error"));
    });
    expect(follower.result.current.isConnected).toBe(false);
  });

  it("a follower receives relayed events without its own socket", () => {
    renderHook(() => useEventStream({ resource: "n" }), { wrapper: wrapperFor(qc) });
    const follower = renderHook(() => useEventStream({ resource: "n" }), {
      wrapper: wrapperFor(qc),
    });

    act(() => {
      OpenEventSource.latest().emit("n.created", {
        type: "n.created",
        resource: "n",
        data: {},
        timestamp: "x",
      });
    });

    expect(OpenEventSource.instances).toHaveLength(1);
    expect(follower.result.current.eventCount).toBe(1);
    expect(follower.result.current.lastEvent?.type).toBe("n.created");
  });

  it("a follower mirrors the leader's status and runs its own onReady / onResync / onTerminal", () => {
    const leaderResync = vi.fn();
    const followerResync = vi.fn();
    const followerReady = vi.fn();
    const followerTerminal = vi.fn();
    const followerStatus = vi.fn();
    const leader = renderHook(
      () =>
        useEventStream({
          resource: "n",
          onResync: leaderResync,
          terminalEvents: ["revoked"],
        }),
      { wrapper: wrapperFor(qc) },
    );
    const follower = renderHook(
      () =>
        useEventStream({
          resource: "n",
          onResync: followerResync,
          onReady: followerReady,
          onTerminal: followerTerminal,
          onStatus: followerStatus,
          terminalEvents: ["revoked"],
        }),
      { wrapper: wrapperFor(qc) },
    );
    expect(follower.result.current.status.health).toBe("connecting");

    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
    });
    // A resumable stream is live on its `ready` frame, not on `open` (liveOn defaults to "ready").
    expect(leader.result.current.status.health).toBe("connecting");
    expect(follower.result.current.status.health).toBe("connecting");
    expect(follower.result.current.isConnected).toBe(true);

    act(() => {
      OpenEventSource.latest().emit("ready", { cursor: "0000000000000010", resumed: false });
    });
    expect(leader.result.current.status.health).toBe("live");
    expect(follower.result.current.status.health).toBe("live");
    expect(followerStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ health: "live", lastEventId: "0000000000000010" }),
    );
    expect(leaderResync).toHaveBeenCalledWith({ cursor: "0000000000000010", reason: "initial" });
    expect(followerResync).toHaveBeenCalledWith({ cursor: "0000000000000010", reason: "initial" });
    expect(followerReady).toHaveBeenCalledWith({ cursor: "0000000000000010", resumed: false });
    // Control frames are not events.
    expect(follower.result.current.eventCount).toBe(0);

    act(() => {
      OpenEventSource.latest().emit("resync", {
        cursor: "0000000000000020",
        reason: "gap_too_large",
      });
    });
    expect(followerResync).toHaveBeenLastCalledWith({
      cursor: "0000000000000020",
      reason: "gap_too_large",
    });

    act(() => {
      OpenEventSource.latest().emit("revoked", { reason: "access_ended" });
    });
    expect(followerTerminal).toHaveBeenCalledWith({
      event: "revoked",
      data: { reason: "access_ended" },
    });
    expect(follower.result.current.status.health).toBe("revoked");
    expect(follower.result.current.isConnected).toBe(false);
  });

  it("a follower arriving later learns the current status from the leader", () => {
    renderHook(() => useEventStream({ resource: "n" }), { wrapper: wrapperFor(qc) });
    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
    });
    const late = renderHook(() => useEventStream({ resource: "n" }), { wrapper: wrapperFor(qc) });
    expect(late.result.current.status.health).toBe("live");
    expect(late.result.current.isConnected).toBe(true);
  });

  const resumeOpts = { resource: "n", resumeFrom: "1", resumeQueryParam: "lastEventId" } as const;

  it("an effect re-run resumes from the cursor reached, not the resumeFrom prop", () => {
    const hook = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useEventStream({ ...resumeOpts, enabled, shareAcrossTabs: false }),
      { wrapper: wrapperFor(qc), initialProps: { enabled: true } },
    );
    expect(OpenEventSource.latest().url).toContain("lastEventId=1");
    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
      OpenEventSource.latest().emit("n.created", { type: "n.created", data: {} }, "5");
    });
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    expect(OpenEventSource.instances).toHaveLength(2);
    expect(OpenEventSource.latest().url).toContain("lastEventId=5");
  });

  it("a follower that takes over resumes from the leader's last cursor", async () => {
    const leader = renderHook(() => useEventStream(resumeOpts), { wrapper: wrapperFor(qc) });
    renderHook(() => useEventStream(resumeOpts), { wrapper: wrapperFor(qc) });
    expect(OpenEventSource.instances).toHaveLength(1);
    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
      OpenEventSource.latest().emit("n.created", { type: "n.created", data: {} }, "7");
    });
    leader.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(OpenEventSource.instances).toHaveLength(2);
    expect(OpenEventSource.latest().url).toContain("lastEventId=7");
  });

  it("a follower that takes over after the leader died silently resumes from the last relayed event", async () => {
    const leader = renderHook(() => useEventStream(resumeOpts), { wrapper: wrapperFor(qc) });
    renderHook(() => useEventStream(resumeOpts), { wrapper: wrapperFor(qc) });
    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
      OpenEventSource.latest().emit("n.created", { type: "n.created", data: {} }, "9");
    });
    // The leader's last words (its closing status) never arrive.
    FakeChannel.muted = true;
    leader.unmount();
    FakeChannel.muted = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(OpenEventSource.instances).toHaveLength(2);
    expect(OpenEventSource.latest().url).toContain("lastEventId=9");
  });

  it("a revoked stream stays revoked for followers when the leader lets go", () => {
    const leader = renderHook(() => useEventStream(resumeOpts), { wrapper: wrapperFor(qc) });
    const follower = renderHook(() => useEventStream(resumeOpts), { wrapper: wrapperFor(qc) });
    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
      OpenEventSource.latest().emit("revoked", { reason: "access_ended" });
    });
    expect(follower.result.current.status.health).toBe("revoked");
    leader.unmount();
    expect(follower.result.current.status.health).toBe("revoked");
  });

  it("a disabled follower reports closed, not the leader's last health", () => {
    renderHook(() => useEventStream({ resource: "n" }), { wrapper: wrapperFor(qc) });
    const follower = renderHook(
      ({ enabled }: { enabled: boolean }) => useEventStream({ resource: "n", enabled }),
      { wrapper: wrapperFor(qc), initialProps: { enabled: true } },
    );
    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
    });
    expect(follower.result.current.status.health).toBe("live");
    follower.rerender({ enabled: false });
    expect(follower.result.current.status.health).toBe("closed");
  });

  /** One connection that opens and drops before `ready` (the transport reports no response). */
  const dropBeforeReady = async () => {
    act(() => {
      const es = OpenEventSource.latest();
      es.onopen?.(new Event("open"));
      es.onerror?.({ status: 0 } as unknown as Event);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
  };

  it("an effect re-run after maxResumeFailures starts fresh, not from the dropped cursor", async () => {
    const hook = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useEventStream({ ...resumeOpts, enabled, shareAcrossTabs: false }),
      { wrapper: wrapperFor(qc), initialProps: { enabled: true } },
    );
    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
      OpenEventSource.latest().emit("n.created", { type: "n.created", data: {} }, "5");
    });
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    expect(OpenEventSource.latest().url).toContain("lastEventId=5");
    for (let i = 0; i < 3; i += 1) await dropBeforeReady();
    expect(OpenEventSource.latest().url).not.toContain("lastEventId");
    expect(hook.result.current.status.lastEventId).toBeNull();
    // Toggled before the fresh `ready`: neither the dropped cursor nor the resumeFrom prop.
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    expect(OpenEventSource.latest().url).not.toContain("lastEventId");
  });

  it("a follower that takes over after maxResumeFailures starts fresh, not from the dropped cursor", async () => {
    const leader = renderHook(() => useEventStream(resumeOpts), { wrapper: wrapperFor(qc) });
    const follower = renderHook(() => useEventStream(resumeOpts), { wrapper: wrapperFor(qc) });
    act(() => {
      OpenEventSource.latest().onopen?.(new Event("open"));
      OpenEventSource.latest().emit("n.created", { type: "n.created", data: {} }, "7");
    });
    // The first drop counts against "1" (the cursor that connection sent), the next three on "7".
    for (let i = 0; i < 4; i += 1) await dropBeforeReady();
    expect(OpenEventSource.latest().url).not.toContain("lastEventId");
    expect(follower.result.current.status.lastEventId).toBeNull();
    const before = OpenEventSource.instances.length;
    leader.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(OpenEventSource.instances.length).toBeGreaterThan(before);
    expect(OpenEventSource.latest().url).not.toContain("lastEventId");
  });
});
