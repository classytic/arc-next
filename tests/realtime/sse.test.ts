import { type ResyncReason, STREAM_FRAMES } from "@classytic/repo-core/sync";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAuthRecovery,
  _resetAuthWarnings,
  configureAuth,
  configureClient,
  createAuthRefreshHandler,
  type EventSourceEventLike,
  type EventSourceInitLike,
} from "../../src/client/client.js";
import {
  buildSseUrl,
  type StreamStatus,
  subscribeToEvents,
  useEventStream,
} from "../../src/realtime/sse.js";
import { createTestQueryClient, createWrapper } from "../harness/query-client.js";

describe("sse", () => {
  // ============================================================================
  // Test setup
  // ============================================================================

  // Mock EventSource
  class MockEventSource {
    static instances: MockEventSource[] = [];
    url: string;
    withCredentials: boolean;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readyState = 0;
    closed = false;
    namedListeners: Map<string, ((event: MessageEvent) => void)[]> = new Map();

    constructor(url: string, options?: { withCredentials?: boolean }) {
      this.url = url;
      this.withCredentials = options?.withCredentials ?? false;
      MockEventSource.instances.push(this);

      // Auto-connect after microtask
      queueMicrotask(() => {
        if (!this.closed) {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
        }
      });
    }

    close() {
      this.closed = true;
      this.readyState = 2;
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      // The SDK consumes built-in events via addEventListener; route them to the
      // on* slots the simulate helpers fire.
      if (type === "open") this.onopen = listener as (e: Event) => void;
      else if (type === "message") this.onmessage = listener;
      else if (type === "error") this.onerror = listener as (e: Event) => void;
      if (type === "open" || type === "message" || type === "error") return;
      const list = this.namedListeners.get(type) ?? [];
      list.push(listener);
      this.namedListeners.set(type, list);
    }

    removeEventListener(type: string, listener: (event: MessageEvent) => void) {
      const list = this.namedListeners.get(type);
      if (!list) return;
      this.namedListeners.set(
        type,
        list.filter((l) => l !== listener),
      );
    }

    simulateMessage(data: unknown) {
      this.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify(data),
        }),
      );
    }

    /** Simulate a named SSE frame (`event: <type>\ndata: <payload>`). */
    simulateNamedEvent(type: string, payload: unknown, options?: { lastEventId?: string }) {
      const data = typeof payload === "string" ? payload : JSON.stringify(payload);
      const evt = new MessageEvent(type, { data, lastEventId: options?.lastEventId ?? "" });
      const listeners = this.namedListeners.get(type) ?? [];
      for (const l of listeners) l(evt);
    }

    simulateError() {
      this.onerror?.(new Event("error"));
    }

    static reset() {
      MockEventSource.instances = [];
    }

    static latest(): MockEventSource | undefined {
      return MockEventSource.instances[MockEventSource.instances.length - 1];
    }
  }

  // ============================================================================
  // Tests
  // ============================================================================

  describe("useEventStream", () => {
    let queryClient: QueryClient;

    const originalEventSource = globalThis.EventSource;

    beforeEach(() => {
      MockEventSource.reset();
      localStorage.clear(); // no tab-leader record from another test decides who connects      // Assign directly — vi.stubGlobal can be flaky in jsdom for EventSource
      (globalThis as Record<string, unknown>).EventSource = MockEventSource;
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => "test-token", getOrgId: () => "org-1" });
      queryClient = createTestQueryClient();
    });

    afterEach(() => {
      queryClient.clear();
      if (originalEventSource) {
        (globalThis as Record<string, unknown>).EventSource = originalEventSource;
      } else {
        delete (globalThis as Record<string, unknown>).EventSource;
      }
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("connects to SSE endpoint on mount", async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(() => useEventStream({ resource: "agents" }), { wrapper });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0);
      });

      const es = MockEventSource.latest()!;
      expect(es.url).toContain("http://api.test/events/stream");
      expect(es.url).toContain("token=test-token");
      expect(es.url).toContain("organizationId=org-1");
    });

    it("reports connected state after open", async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(() => useEventStream({ resource: "agents" }), { wrapper });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });
    });

    it("uses custom url when provided", async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(() => useEventStream({ url: "/custom/stream" }), { wrapper });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0);
      });

      expect(MockEventSource.latest()!.url).toBe("/custom/stream");
    });

    it("includes patterns in URL", async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(
        () =>
          useEventStream({ resource: "agents", patterns: ["agents.created", "agents.updated"] }),
        { wrapper },
      );

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0);
      });

      expect(MockEventSource.latest()!.url).toContain("patterns=agents.created%2Cagents.updated");
    });

    it("calls onEvent callback when message is received", async () => {
      const onEvent = vi.fn();
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(() => useEventStream({ resource: "agents", onEvent }), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const es = MockEventSource.latest()!;
      act(() => {
        es.simulateMessage({
          type: "agents.created",
          resource: "agents",
          data: { _id: "1", name: "New Agent" },
          timestamp: "2024-01-01T00:00:00Z",
        });
      });

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agents.created",
          resource: "agents",
        }),
      );
    });

    it("increments eventCount on each message", async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(() => useEventStream({ resource: "agents" }), { wrapper });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const es = MockEventSource.latest()!;
      act(() => {
        es.simulateMessage({ type: "agents.created", resource: "agents", data: {}, timestamp: "" });
      });

      expect(result.current.eventCount).toBe(1);

      act(() => {
        es.simulateMessage({ type: "agents.updated", resource: "agents", data: {}, timestamp: "" });
      });

      expect(result.current.eventCount).toBe(2);
    });

    it("invalidates queries on event", async () => {
      const listKey = ["agents", "list"];
      queryClient.setQueryData(listKey, { data: [] });
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () =>
          useEventStream({
            resource: "agents",
            invalidateQueries: [listKey],
          }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      act(() => {
        MockEventSource.latest()!.simulateMessage({
          type: "agents.created",
          resource: "agents",
          data: {},
          timestamp: "",
        });
      });

      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: listKey }));
    });

    it("filters by patterns when specified", async () => {
      const onEvent = vi.fn();
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => useEventStream({ resource: "agents", patterns: ["agents.created"], onEvent }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const es = MockEventSource.latest()!;

      act(() => {
        es.simulateMessage({ type: "agents.created", resource: "agents", data: {}, timestamp: "" });
      });

      expect(onEvent).toHaveBeenCalledTimes(1);

      // Non-matching pattern — should be filtered
      act(() => {
        es.simulateMessage({ type: "agents.deleted", resource: "agents", data: {}, timestamp: "" });
      });

      expect(onEvent).toHaveBeenCalledTimes(1); // Still 1
    });

    it("does not connect when enabled is false", async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(() => useEventStream({ resource: "agents", enabled: false }), { wrapper });

      // Wait a tick
      await new Promise((r) => setTimeout(r, 50));

      expect(MockEventSource.instances).toHaveLength(0);
    });

    it("closes connection on unmount", async () => {
      const wrapper = createWrapper(queryClient);

      const { result, unmount } = renderHook(() => useEventStream({ resource: "agents" }), {
        wrapper,
      });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const es = MockEventSource.latest()!;
      unmount();

      expect(es.closed).toBe(true);
    });

    it("close() manually disconnects and reports state", async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(() => useEventStream({ resource: "agents" }), { wrapper });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      act(() => {
        result.current.close();
      });

      expect(result.current.isConnected).toBe(false);
    });

    it("calls onConnectionChange on connect/disconnect", async () => {
      const onConnectionChange = vi.fn();
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(
        () => useEventStream({ resource: "agents", onConnectionChange }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      expect(onConnectionChange).toHaveBeenCalledWith(true);

      act(() => {
        result.current.close();
      });

      expect(onConnectionChange).toHaveBeenCalledWith(false);
    });

    it("passes withCredentials for cookie auth", async () => {
      configureClient({ baseUrl: "http://api.test", authMode: "cookie" });

      const wrapper = createWrapper(queryClient);

      renderHook(() => useEventStream({ resource: "agents" }), { wrapper });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0);
      });

      expect(MockEventSource.latest()!.withCredentials).toBe(true);
    });

    it("uses custom basePath", async () => {
      const wrapper = createWrapper(queryClient);

      renderHook(() => useEventStream({ resource: "agents", path: "/api/v2/events/stream" }), {
        wrapper,
      });

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(0);
      });

      expect(MockEventSource.latest()!.url).toContain("http://api.test/api/v2/events/stream");
    });

    it("stores lastEvent from most recent message", async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(() => useEventStream({ resource: "agents" }), { wrapper });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      expect(result.current.lastEvent).toBeNull();

      const event = {
        type: "agents.created",
        resource: "agents",
        data: { _id: "1" },
        timestamp: "2024-01-01",
      };
      act(() => {
        MockEventSource.latest()!.simulateMessage(event);
      });

      expect(result.current.lastEvent).toEqual(event);
    });

    it("reconnect() after close() creates new connection", async () => {
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(() => useEventStream({ resource: "agents" }), { wrapper });

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      const firstEs = MockEventSource.latest()!;

      // Close
      act(() => result.current.close());
      expect(result.current.isConnected).toBe(false);

      // Reconnect
      act(() => result.current.reconnect());

      await waitFor(() => {
        expect(result.current.isConnected).toBe(true);
      });

      // Should be a NEW EventSource instance
      const secondEs = MockEventSource.latest()!;
      expect(secondEs).not.toBe(firstEs);
      expect(secondEs.url).toContain("http://api.test/events/stream");
    });

    it("events after reconnect still trigger callbacks", async () => {
      const onEvent = vi.fn();
      const wrapper = createWrapper(queryClient);

      const { result } = renderHook(() => useEventStream({ resource: "agents", onEvent }), {
        wrapper,
      });

      await waitFor(() => expect(result.current.isConnected).toBe(true));

      // Close and reconnect
      act(() => result.current.close());
      act(() => result.current.reconnect());

      await waitFor(() => expect(result.current.isConnected).toBe(true));

      // Send event on new connection
      act(() => {
        MockEventSource.latest()!.simulateMessage({
          type: "agents.created",
          resource: "agents",
          data: { _id: "99" },
          timestamp: "",
        });
      });

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "agents.created" }));
    });

    // ==========================================================================
    // Named SSE events (Arc ssePlugin compat)
    // ==========================================================================

    describe("named events", () => {
      it("subscribes to addEventListener for derived [resource.created/updated/deleted]", async () => {
        const wrapper = createWrapper(queryClient);

        renderHook(() => useEventStream({ resource: "agents" }), { wrapper });

        await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));

        const es = MockEventSource.latest()!;
        expect(es.namedListeners.has("agents.created")).toBe(true);
        expect(es.namedListeners.has("agents.updated")).toBe(true);
        expect(es.namedListeners.has("agents.deleted")).toBe(true);
      });

      it("receives a named SSE frame and dispatches to onEvent", async () => {
        const onEvent = vi.fn();
        const wrapper = createWrapper(queryClient);

        const { result } = renderHook(() => useEventStream({ resource: "agents", onEvent }), {
          wrapper,
        });

        await waitFor(() => expect(result.current.isConnected).toBe(true));

        const es = MockEventSource.latest()!;
        act(() => {
          es.simulateNamedEvent("agents.created", { _id: "42", name: "Bot" });
        });

        expect(onEvent).toHaveBeenCalledTimes(1);
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "agents.created",
            resource: "agents",
            data: { _id: "42", name: "Bot" },
          }),
        );
      });

      it("treats fully shaped ArcServerEvent payloads as-is", async () => {
        const onEvent = vi.fn();
        const wrapper = createWrapper(queryClient);

        const { result } = renderHook(() => useEventStream({ resource: "agents", onEvent }), {
          wrapper,
        });

        await waitFor(() => expect(result.current.isConnected).toBe(true));

        const shaped = {
          type: "agents.created",
          resource: "agents",
          data: { _id: "99" },
          timestamp: "2024-01-01",
          id: "frame-1",
        };
        act(() => {
          MockEventSource.latest()!.simulateNamedEvent("agents.created", shaped);
        });

        expect(onEvent).toHaveBeenCalledWith(shaped);
      });

      it("explicit eventTypes override resource derivation", async () => {
        const onEvent = vi.fn();
        const wrapper = createWrapper(queryClient);

        const { result } = renderHook(
          () =>
            useEventStream({
              resource: "agents",
              eventTypes: ["sync-job.phase", "sync-job.completed"],
              onEvent,
            }),
          { wrapper },
        );

        await waitFor(() => expect(result.current.isConnected).toBe(true));

        const es = MockEventSource.latest()!;
        // Should NOT subscribe to derived agents.* events
        expect(es.namedListeners.has("agents.created")).toBe(false);
        // Should subscribe to explicit list
        expect(es.namedListeners.has("sync-job.phase")).toBe(true);
        expect(es.namedListeners.has("sync-job.completed")).toBe(true);

        act(() => {
          es.simulateNamedEvent("sync-job.phase", { phase: "extracting" });
        });
        expect(onEvent).toHaveBeenCalledWith(
          expect.objectContaining({ type: "sync-job.phase", data: { phase: "extracting" } }),
        );
      });

      it("falls back to patterns (filtered for wildcards) when no eventTypes", async () => {
        const wrapper = createWrapper(queryClient);

        renderHook(
          () => useEventStream({ patterns: ["order.placed", "order.*", "invoice.paid"] }),
          { wrapper },
        );

        await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));

        const es = MockEventSource.latest()!;
        expect(es.namedListeners.has("order.placed")).toBe(true);
        expect(es.namedListeners.has("invoice.paid")).toBe(true);
        expect(es.namedListeners.has("order.*")).toBe(false); // wildcard skipped
      });

      it("opts out of named subscription when eventTypes: []", async () => {
        const wrapper = createWrapper(queryClient);

        renderHook(
          () =>
            useEventStream({
              resource: "agents",
              eventTypes: [],
            }),
          { wrapper },
        );

        await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));

        const es = MockEventSource.latest()!;
        expect(es.namedListeners.size).toBe(0);
      });

      it("named events still trigger invalidateQueries", async () => {
        const listKey = ["agents", "list"];
        queryClient.setQueryData(listKey, { data: [] });
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

        const wrapper = createWrapper(queryClient);

        const { result } = renderHook(
          () => useEventStream({ resource: "agents", invalidateQueries: [listKey] }),
          { wrapper },
        );

        await waitFor(() => expect(result.current.isConnected).toBe(true));

        act(() => {
          MockEventSource.latest()!.simulateNamedEvent("agents.created", { _id: "1" });
        });

        expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: listKey }));
      });

      it("does not reconnect when caller passes inline arrays of equal contents", async () => {
        const wrapper = createWrapper(queryClient);

        const { rerender } = renderHook(
          ({ types }: { types: string[] }) =>
            useEventStream({
              resource: "agents",
              eventTypes: types,
            }),
          { wrapper, initialProps: { types: ["a", "b"] } },
        );

        await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

        // New array, same content — should NOT reconnect
        rerender({ types: ["a", "b"] });
        await new Promise((r) => setTimeout(r, 30));
        expect(MockEventSource.instances.length).toBe(1);

        // Different content — should reconnect
        rerender({ types: ["a", "b", "c"] });
        await waitFor(() => expect(MockEventSource.instances.length).toBe(2));
      });
    });
  });

  // ============================================================================
  // buildSseUrl
  // ============================================================================

  describe("buildSseUrl", () => {
    beforeEach(() => {
      configureClient({ baseUrl: "http://api.test" });
      configureAuth({ getToken: () => "tok-123", getOrgId: () => "org-9" });
    });

    afterEach(() => {
      configureAuth({ getToken: () => null, getOrgId: () => null });
    });

    it("prefixes baseUrl from configureClient", () => {
      const url = buildSseUrl("/jobs/stream");
      expect(url.startsWith("http://api.test/jobs/stream")).toBe(true);
    });

    it("attaches token + organizationId for bearer mode", () => {
      const url = buildSseUrl("/jobs/stream");
      expect(url).toContain("token=tok-123");
      expect(url).toContain("organizationId=org-9");
    });

    it("omits token in cookie mode", () => {
      configureClient({ baseUrl: "http://api.test", authMode: "cookie" });
      const url = buildSseUrl("/jobs/stream");
      expect(url).not.toContain("token=");
      expect(url).toContain("organizationId=org-9");
    });

    it("merges custom params with auth params", () => {
      const url = buildSseUrl("/jobs/stream", { jobId: "abc-123" });
      expect(url).toContain("jobId=abc-123");
      expect(url).toContain("token=tok-123");
    });

    it("caller params win over derived auth params", () => {
      const url = buildSseUrl("/jobs/stream", { token: "override" });
      expect(url).toContain("token=override");
      expect(url).not.toContain("token=tok-123");
    });

    it("skips empty / null / undefined param values", () => {
      const url = buildSseUrl("/jobs/stream", {
        jobId: "abc",
        empty: "",
        missing: null,
        gone: undefined,
      });
      expect(url).toContain("jobId=abc");
      expect(url).not.toContain("empty=");
      expect(url).not.toContain("missing=");
      expect(url).not.toContain("gone=");
    });

    it("coerces numeric and boolean params to strings", () => {
      const url = buildSseUrl("/stream", { limit: 50, live: true });
      expect(url).toContain("limit=50");
      expect(url).toContain("live=true");
    });

    it("emits clean URL with no query string when nothing to attach", () => {
      configureClient({ baseUrl: "http://api.test", authMode: "cookie" });
      configureAuth({ getToken: () => null, getOrgId: () => null });

      const url = buildSseUrl("/stream");
      expect(url).toBe("http://api.test/stream");
    });
  });
});

describe("rate limits", () => {
  /**
   * A 429 must not be reconnected on the transient-error curve.
   *
   * `EventSource` reports no status, so a rate-limited stream is indistinguishable
   * from a dropped one — and retrying it is worse than useless: each attempt
   * spends another token, so the window never drains and the client locks itself
   * out. The pre-flight probe is a plain `fetch`, so it CAN read the status and
   * `Retry-After`; this pins that it does, and that the server's number wins.
   */

  class FakeES {
    static instances: FakeES[] = [];
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    addEventListener(type: string, fn: (e: MessageEvent) => void) {
      if (type === "open") this.onopen = fn as (e: Event) => void;
      else if (type === "message") this.onmessage = fn;
      else if (type === "error") this.onerror = fn as (e: Event) => void;
    }
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

    it("a successful open restores the probe budget, so a later drop is diagnosed too", async () => {
      // Regression: `sseProbes` never reset, so after the first probe every later
      // failure on a long-lived stream went straight to backoff — a 429 included.
      const fetchMock = vi.fn().mockResolvedValue({ status: 503, headers: { get: () => null } });
      (globalThis as Record<string, unknown>).fetch = fetchMock;

      const handle = subscribeToEvents({ resource: "n", reconnectDelay: 1000 });
      FakeES.instances[0].onerror?.(new Event("error"));
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1); // one HEAD probe

      await vi.advanceTimersByTimeAsync(1_500);
      const reopened = FakeES.instances.at(-1)!;
      expect(reopened).not.toBe(FakeES.instances[0]);
      reopened.onopen?.(new Event("open"));

      const before = fetchMock.mock.calls.length;
      reopened.onerror?.(new Event("error"));
      await flush();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);

      handle.close();
    });
  });
});

describe("auth refresh", () => {
  /**
   * SSE auth-recovery — 0.7 wires EventSource errors through a pre-flight
   * fetch probe, then through the shared `onAuthError` cycle when the probe
   * comes back 401 (or 403 with `retryOn403`). Verifies:
   *
   *  - error + probe returns 401 → handler runs → reconnect with new auth
   *  - error + probe returns 200 → handler NOT called, normal backoff
   *  - error + probe returns 500 → handler NOT called, normal backoff
   *  - 403 + retryOn403:true → handler runs (matches fetch + WS + upload contract)
   *  - 'skip' decision → no immediate reconnect via auth path (falls back to backoff)
   */

  // ── MockEventSource — doesn't auto-open; tests control timing.
  class MockES {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    static instances: MockES[] = [];

    url: string;
    withCredentials: boolean;
    readyState = 0;
    closed = false;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;

    constructor(url: string, options?: { withCredentials?: boolean }) {
      this.url = url;
      this.withCredentials = options?.withCredentials ?? false;
      MockES.instances.push(this);
    }

    close(): void {
      this.closed = true;
      this.readyState = 2;
    }
    addEventListener(type: string, fn: (e: MessageEvent) => void): void {
      // Built-in events arrive via addEventListener; named ones are not exercised here.
      if (type === "open") this.onopen = fn as (e: Event) => void;
      else if (type === "message") this.onmessage = fn;
      else if (type === "error") this.onerror = fn as (e: Event) => void;
    }
    removeEventListener(): void {
      /* not exercised here */
    }

    triggerOpen(): void {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    }
    triggerError(): void {
      this.onerror?.(new Event("error"));
    }

    static reset(): void {
      MockES.instances = [];
    }
    static all(): MockES[] {
      return MockES.instances;
    }
    static latest(): MockES {
      const x = MockES.instances[MockES.instances.length - 1];
      if (!x) throw new Error("no MockES opened");
      return x;
    }
  }

  const originalES = (globalThis as Record<string, unknown>).EventSource;

  function mockProbeFetch(status: number): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, "fetch").mockImplementation(((
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof globalThis.fetch);
  }

  beforeEach(() => {
    MockES.reset();
    (globalThis as Record<string, unknown>).EventSource = MockES;
    configureClient({ baseUrl: "http://api.test" });
    configureAuth({ getToken: () => null, getOrgId: () => null });
    _resetAuthRecovery();
    _resetAuthWarnings();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalES) (globalThis as Record<string, unknown>).EventSource = originalES;
    else delete (globalThis as Record<string, unknown>).EventSource;
    vi.restoreAllMocks();
  });

  describe("subscribeToEvents — auth-recovery via pre-flight probe", () => {
    it("error + probe returns 401 → handler refreshes → reconnect with new token", async () => {
      let cached = "stale-tok";
      const refresh = vi.fn(async () => {
        cached = "fresh-tok";
        return "fresh-tok";
      });
      configureAuth({ getToken: () => cached, onAuthError: createAuthRefreshHandler({ refresh }) });
      mockProbeFetch(401);

      const handle = subscribeToEvents({ resource: "todo" });

      expect(MockES.all()).toHaveLength(1);
      MockES.latest().triggerOpen();
      MockES.latest().triggerError(); // simulates server kick

      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
      expect(MockES.all()[1]!.url).toContain("token=fresh-tok");

      handle.close();
    });

    it("error + probe returns 200 → handler NOT called, normal backoff reconnect", async () => {
      const refresh = vi.fn();
      configureAuth({ getToken: () => "tok", onAuthError: createAuthRefreshHandler({ refresh }) });
      mockProbeFetch(200);

      const handle = subscribeToEvents({ resource: "todo", reconnectDelay: 10 });
      MockES.latest().triggerOpen();
      MockES.latest().triggerError();

      // Backoff reconnect schedules a new EventSource after delay.
      await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
      expect(refresh).not.toHaveBeenCalled();

      handle.close();
    });

    it("error + probe returns 500 → handler NOT called, normal backoff reconnect", async () => {
      const refresh = vi.fn();
      configureAuth({ getToken: () => "tok", onAuthError: createAuthRefreshHandler({ refresh }) });
      mockProbeFetch(500);

      const handle = subscribeToEvents({ resource: "todo", reconnectDelay: 10 });
      MockES.latest().triggerOpen();
      MockES.latest().triggerError();

      await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
      expect(refresh).not.toHaveBeenCalled();

      handle.close();
    });

    it("error + probe returns 403 + retryOn403:true → handler runs", async () => {
      const refresh = vi.fn(async () => "fresh");
      configureAuth({
        getToken: () => "tok",
        retryOn403: true,
        onAuthError: createAuthRefreshHandler({ refresh }),
      });
      mockProbeFetch(403);

      const handle = subscribeToEvents({ resource: "todo" });
      MockES.latest().triggerOpen();
      MockES.latest().triggerError();

      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      handle.close();
    });

    it("error + probe returns 403 + retryOn403:false (default) → handler NOT called", async () => {
      const refresh = vi.fn();
      configureAuth({ getToken: () => "tok", onAuthError: createAuthRefreshHandler({ refresh }) });
      mockProbeFetch(403);

      const handle = subscribeToEvents({ resource: "todo", reconnectDelay: 10 });
      MockES.latest().triggerOpen();
      MockES.latest().triggerError();

      await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
      expect(refresh).not.toHaveBeenCalled();

      handle.close();
    });

    it("'skip' decision → no immediate reconnect via auth path (backoff still kicks in eventually)", async () => {
      configureAuth({
        getToken: () => "tok",
        onAuthError: async () => "skip",
      });
      mockProbeFetch(401);

      const handle = subscribeToEvents({ resource: "todo", reconnectDelay: 50 });
      MockES.latest().triggerOpen();
      MockES.latest().triggerError();

      // Wait long enough for ONLY the auth path to settle (probe ~instant).
      // Auth path returned 'skip' → falls through to backoff (50ms delay).
      await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));

      handle.close();
    });

    it("probe network failure (fetch throws) → falls back to backoff reconnect (transient classification)", async () => {
      const refresh = vi.fn();
      configureAuth({ getToken: () => "tok", onAuthError: createAuthRefreshHandler({ refresh }) });
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));

      const handle = subscribeToEvents({ resource: "todo", reconnectDelay: 10 });
      MockES.latest().triggerOpen();
      MockES.latest().triggerError();

      await vi.waitFor(() => expect(MockES.all()).toHaveLength(2));
      expect(refresh).not.toHaveBeenCalled();

      handle.close();
    });
  });
});

describe("cross-tab sharing", () => {
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
      renderHook(() => useEventStream({ resource: "n" }), { wrapper: createWrapper(qc) });
      renderHook(() => useEventStream({ resource: "n" }), { wrapper: createWrapper(qc) });

      expect(OpenEventSource.instances).toHaveLength(1);
    });

    it("a follower reports CONNECTED once the leader says it is", () => {
      const leader = renderHook(() => useEventStream({ resource: "n" }), {
        wrapper: createWrapper(qc),
      });
      const follower = renderHook(() => useEventStream({ resource: "n" }), {
        wrapper: createWrapper(qc),
      });

      expect(follower.result.current.isConnected).toBe(false);

      act(() => {
        OpenEventSource.latest().onopen?.(new Event("open"));
      });

      expect(leader.result.current.isConnected).toBe(true);
      expect(follower.result.current.isConnected).toBe(true);
    });

    it("a follower goes DISCONNECTED when the shared socket drops", () => {
      renderHook(() => useEventStream({ resource: "n" }), { wrapper: createWrapper(qc) });
      const follower = renderHook(() => useEventStream({ resource: "n" }), {
        wrapper: createWrapper(qc),
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
      renderHook(() => useEventStream({ resource: "n" }), { wrapper: createWrapper(qc) });
      const follower = renderHook(() => useEventStream({ resource: "n" }), {
        wrapper: createWrapper(qc),
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
          useEventStream({ resource: "n", onResync: leaderResync, terminalEvents: ["revoked"] }),
        { wrapper: createWrapper(qc) },
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
        { wrapper: createWrapper(qc) },
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
      expect(followerResync).toHaveBeenCalledWith({
        cursor: "0000000000000010",
        reason: "initial",
      });
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
      renderHook(() => useEventStream({ resource: "n" }), { wrapper: createWrapper(qc) });
      act(() => {
        OpenEventSource.latest().onopen?.(new Event("open"));
      });
      const late = renderHook(() => useEventStream({ resource: "n" }), {
        wrapper: createWrapper(qc),
      });
      expect(late.result.current.status.health).toBe("live");
      expect(late.result.current.isConnected).toBe(true);
    });

    const resumeOpts = { resource: "n", resumeFrom: "1", resumeQueryParam: "lastEventId" } as const;

    it("an effect re-run resumes from the cursor reached, not the resumeFrom prop", () => {
      const hook = renderHook(
        ({ enabled }: { enabled: boolean }) =>
          useEventStream({ ...resumeOpts, enabled, shareAcrossTabs: false }),
        { wrapper: createWrapper(qc), initialProps: { enabled: true } },
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
      const leader = renderHook(() => useEventStream(resumeOpts), { wrapper: createWrapper(qc) });
      renderHook(() => useEventStream(resumeOpts), { wrapper: createWrapper(qc) });
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
      const leader = renderHook(() => useEventStream(resumeOpts), { wrapper: createWrapper(qc) });
      renderHook(() => useEventStream(resumeOpts), { wrapper: createWrapper(qc) });
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
      const leader = renderHook(() => useEventStream(resumeOpts), { wrapper: createWrapper(qc) });
      const follower = renderHook(() => useEventStream(resumeOpts), { wrapper: createWrapper(qc) });
      act(() => {
        OpenEventSource.latest().onopen?.(new Event("open"));
        OpenEventSource.latest().emit("revoked", { reason: "access_ended" });
      });
      expect(follower.result.current.status.health).toBe("revoked");
      leader.unmount();
      expect(follower.result.current.status.health).toBe("revoked");
    });

    it("a disabled follower reports closed, not the leader's last health", () => {
      renderHook(() => useEventStream({ resource: "n" }), { wrapper: createWrapper(qc) });
      const follower = renderHook(
        ({ enabled }: { enabled: boolean }) => useEventStream({ resource: "n", enabled }),
        { wrapper: createWrapper(qc), initialProps: { enabled: true } },
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
        { wrapper: createWrapper(qc), initialProps: { enabled: true } },
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
      const leader = renderHook(() => useEventStream(resumeOpts), { wrapper: createWrapper(qc) });
      const follower = renderHook(() => useEventStream(resumeOpts), { wrapper: createWrapper(qc) });
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
});

describe("resumable streams", () => {
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
      // `mockReset`, not `mockClear`: a test's `mockImplementation` (a probe that never answers)
      // must not carry into the next test (restoreMocks leaves `vi.fn` mocks alone).
      fetchSpy.mockReset().mockImplementation(async () => new Response("", { status: 200 }));
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
      // Measured on the fake clock: spying on `setTimeout` would outlive the fake clock (the spy
      // restores the FAKE function after `useRealTimers`) and freeze every later test's timers.
      const h = subscribeToEvents({ resource: "alert" });
      for (const delay of [3000, 4500, 6750, 10125, 15187.5, 22781.25, 30000, 30000]) {
        const before = FakeES.instances.length;
        FakeES.latest().fail(503);
        await flush();
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(FakeES.instances).toHaveLength(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeES.instances).toHaveLength(before + 1);
      }
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
      const h = subscribeToEvents({
        resource: "alert",
        onConnectionChange: (c) => changes.push(c),
      });
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
      expect(onTerminal).toHaveBeenCalledWith({
        event: "revoked",
        data: { reason: "access_ended" },
      });
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
      const h = subscribeToEvents({
        resource: "alert",
        staleAfterMs: 5000,
        maxReconnectAttempts: 0,
      });
      FakeES.latest().open();
      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeES.latest().closed).toBe(true);
      expect(h.status().health).toBe("offline");
      expect(vi.getTimerCount()).toBe(0);
      h.close();
    });

    it("invalid backoff values fall back or clamp instead of a tight loop", async () => {
      // Measured on the fake clock, as above: each reconnect lands at exactly 3000 ms.
      const h = subscribeToEvents({
        resource: "alert",
        backoff: { initialMs: Number.NaN, factor: 0.1, maxMs: 0, jitter: Number.NaN },
      });
      for (let i = 1; i <= 3; i++) {
        FakeES.latest().fail(503);
        await flush();
        await vi.advanceTimersByTimeAsync(2999);
        expect(FakeES.instances).toHaveLength(i);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeES.instances).toHaveLength(i + 1);
      }
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
      const p = subscribeToEvents({
        eventTypes: ["note"],
        compareCursors: lexical,
        onEvent: plain,
      });
      FakeES.latest().open();
      FakeES.latest().frame("note", { a: 1 });
      FakeES.latest().frame("note", { a: 2 });
      expect(plain).toHaveBeenCalledTimes(2);
      p.close();
    });
  });
});
