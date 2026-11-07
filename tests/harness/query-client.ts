/**
 * The one QueryClient + render harness every React test uses.
 *
 * `createTestQueryClient`: no retries (a failure surfaces at once) and `gcTime: Infinity` (an
 * unobserved query is not collected mid-test). `createWrapper` / `renderWithClient`: render under
 * a `QueryClientProvider`, optionally inside a Suspense boundary for suspense hooks.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderHookOptions, renderHook } from "@testing-library/react";
import React from "react";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

export function createWrapper(
  client: QueryClient,
  options: { suspense?: boolean } = {},
): (props: { children: React.ReactNode }) => React.ReactElement {
  return function Wrapper({ children }) {
    const inner = options.suspense
      ? React.createElement(React.Suspense, { fallback: null }, children)
      : children;
    return React.createElement(QueryClientProvider, { client }, inner);
  };
}

/** `renderHook` under a provider; returns the client too so a test can read the cache. */
export function renderWithClient<Result, Props>(
  hook: (props: Props) => Result,
  options: { client?: QueryClient; suspense?: boolean } & Omit<
    RenderHookOptions<Props>,
    "wrapper"
  > = {},
) {
  const { client = createTestQueryClient(), suspense, ...rest } = options;
  const rendered = renderHook(hook, {
    ...rest,
    wrapper: createWrapper(client, suspense ? { suspense } : {}),
  });
  return { ...rendered, client };
}
