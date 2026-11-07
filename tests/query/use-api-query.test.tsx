import type { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUERY_CONFIGS } from "../../src/query/cache.js";
import { useApiQuery } from "../../src/query/query.js";
import { createTestQueryClient, createWrapper } from "../harness/query-client.js";

// ============================================================================
// Test setup
// ============================================================================

// ============================================================================
// useApiQuery
// ============================================================================

describe("useApiQuery", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = createTestQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("passes response through identity (no envelope unwrap)", async () => {
    const wrapper = createWrapper(queryClient);
    const response = { totalRevenue: 100, customers: 5 };
    const queryFn = vi.fn().mockResolvedValue(response);

    const { result } = renderHook(
      () =>
        useApiQuery<{ totalRevenue: number; customers: number }>({
          queryKey: ["dashboard", "stats"],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual(response);
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("passes through non-envelope responses unchanged", async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue([1, 2, 3]);

    const { result } = renderHook(
      () =>
        useApiQuery<number[]>({
          queryKey: ["raw", "array"],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual([1, 2, 3]);
  });

  it("does NOT unwrap when only `data` is present (no `success`)", async () => {
    // Stricter detector: chart-style { data, labels } stays intact.
    const wrapper = createWrapper(queryClient);
    const response = { data: [1, 2], labels: ["a", "b"] };
    const queryFn = vi.fn().mockResolvedValue(response);

    const { result } = renderHook(
      () =>
        useApiQuery<{ data: number[]; labels: string[] }>({
          queryKey: ["chart"],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual(response);
  });

  it("custom select wins over auto-unwrap and receives raw response", async () => {
    const wrapper = createWrapper(queryClient);
    const response = { entries: [{ amount: 100 }, { amount: 200 }] };
    const queryFn = vi.fn().mockResolvedValue(response);
    const select = vi.fn((res: { entries: { amount: number }[] }) =>
      res.entries.map((e) => e.amount),
    );

    const { result } = renderHook(
      () =>
        useApiQuery<{ entries: { amount: number }[] }, number[]>({
          queryKey: ["ledger"],
          queryFn,
          select,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual([100, 200]);
    expect(select).toHaveBeenCalledWith(response);
  });

  it("applies freshness preset (realtime → 20s stale)", async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue(1);

    renderHook(
      () =>
        useApiQuery<number>({
          queryKey: ["rt"],
          queryFn,
          freshness: "realtime",
        }),
      { wrapper },
    );

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    const cached = queryClient.getQueryCache().find({ queryKey: ["rt"] });
    expect((cached?.options as { staleTime?: unknown } | undefined)?.staleTime).toBe(
      QUERY_CONFIGS.realtime.staleTime,
    );
    expect((cached?.options as { refetchInterval?: unknown } | undefined)?.refetchInterval).toBe(
      QUERY_CONFIGS.realtime.refetchInterval,
    );
  });

  it("options override freshness preset", async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue(1);

    renderHook(
      () =>
        useApiQuery<number>({
          queryKey: ["override"],
          queryFn,
          freshness: "static",
          options: { staleTime: 1234 },
        }),
      { wrapper },
    );

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    const cached = queryClient.getQueryCache().find({ queryKey: ["override"] });
    expect((cached?.options as { staleTime?: unknown } | undefined)?.staleTime).toBe(1234);
  });

  it("respects enabled: false", async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn();

    const { result } = renderHook(
      () =>
        useApiQuery<unknown>({
          queryKey: ["disabled"],
          queryFn,
          enabled: false,
        }),
      { wrapper },
    );

    expect(queryFn).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it("exposes refetch function", async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");

    const { result } = renderHook(
      () =>
        useApiQuery<string>({
          queryKey: ["refetch"],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBe("first"));

    await result.current.refetch();

    await waitFor(() => expect(result.current.data).toBe("second"));
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("forwards AbortSignal to queryFn", async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return "ok";
    });

    renderHook(
      () =>
        useApiQuery<string>({
          queryKey: ["signal"],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    expect(queryFn.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces errors via { error, isError }", async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockRejectedValue(new Error("boom"));

    const { result } = renderHook(
      () =>
        useApiQuery<unknown>({
          queryKey: ["err"],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.data).toBeNull();
  });

  it("handles primitive (number) response", async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue(42);

    const { result } = renderHook(
      () =>
        useApiQuery<number>({
          queryKey: ["count"],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toBe(42);
  });

  it("handles null response (returns null)", async () => {
    const wrapper = createWrapper(queryClient);
    const queryFn = vi.fn().mockResolvedValue(null);

    const { result } = renderHook(
      () =>
        useApiQuery<null>({
          queryKey: ["null-data"],
          queryFn,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toBeNull();
  });
});
