/** A refused action verb toasts its error — the caller's headline, plus the server's reason on a 4xx. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ArcApiError, configureClient } from "../src/client.js";
import { createCrudHooks, type CrudApi } from "../src/hooks.js";
import { configureToast } from "../src/mutation.js";

type Item = { _id: string; name: string };

async function toastFor(rejection: Error): Promise<string> {
  configureClient({ baseUrl: "http://api.test" });
  const toast = { success: vi.fn(), error: vi.fn() };
  configureToast(toast);
  const api: CrudApi<Item, { name: string }, { name: string }> = {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    dispatchAction: vi.fn().mockRejectedValue(rejection),
  };
  const hooks = createCrudHooks<Item, { name: string }, { name: string }>({ api, entityKey: "items", singular: "Item" });
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  const { result } = renderHook(
    () => hooks.useAction({ action: "end", messages: { success: "Ended", error: "Failed to end" } }),
    { wrapper },
  );
  await act(async () => {
    await result.current.mutateAsync({ id: "1", data: {} }).catch(() => undefined);
  });
  expect(toast.error).toHaveBeenCalledTimes(1);
  return String(toast.error.mock.calls[0]?.[0]);
}

const apiError = (status: number, message: string) =>
  new ArcApiError(message, { status, statusText: "", json: { message }, endpoint: "/items/1/action", method: "POST" });

describe("useAction error toast", () => {
  it("a 4xx refusal shows the headline AND the server's reason", async () => {
    expect(await toastFor(apiError(422, "A relationship ends after it starts."))).toBe(
      "Failed to end: A relationship ends after it starts.",
    );
  });

  it("a 5xx keeps the headline alone — its message is not the operator's to act on", async () => {
    expect(await toastFor(apiError(500, "TypeError: cannot read x of undefined"))).toBe("Failed to end");
  });

  it("a non-API error still reaches the configured error toast", async () => {
    expect(await toastFor(new Error("network down"))).toBe("Failed to end");
  });
});
