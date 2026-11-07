"use client";

/**
 * `@classytic/arc-next/devtools`: TanStack Query devtools, loaded only when shown.
 *
 * `@tanstack/react-query-devtools` is an OPTIONAL peer. The component imports it lazily, so it is
 * a separate chunk that production users never download unless `enabled` is true (TanStack's
 * production lazy-load recipe). Web only: React Native uses its own devtools.
 *
 * @example
 * <QueryClientProvider client={getQueryClient()}>
 *   {children}
 *   <QueryDevtools enabled={process.env.NODE_ENV === "development"} />
 * </QueryClientProvider>
 */

import { createElement, lazy, Suspense } from "react";

export interface QueryDevtoolsProps {
  /** Render (and download) the devtools. Default: `false`, so nothing ships unless asked. */
  enabled?: boolean;
  initialIsOpen?: boolean;
  buttonPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "relative";
  position?: "top" | "bottom" | "left" | "right";
}

const LazyDevtools = lazy(() =>
  import("@tanstack/react-query-devtools").then((module) => ({
    default: module.ReactQueryDevtools,
  })),
);

export function QueryDevtools({ enabled = false, ...props }: QueryDevtoolsProps) {
  if (!enabled) return null;
  return createElement(Suspense, { fallback: null }, createElement(LazyDevtools, props));
}
