import {
  defaultShouldDehydrateQuery,
  environmentManager,
  type NetworkMode,
  QueryClient,
} from "@tanstack/react-query";
import { isQuotaExceeded } from "../client/client.js";
import { DEFAULT_QUERY_CONFIG } from "./defaults.js";

// ============================================================================
// Types
// ============================================================================

export interface QueryClientOverrides {
  staleTime?: number;
  gcTime?: number;
  /**
   * TanStack's `retry`: `true` = no limit, `false` = never, a count, or a decision function.
   * A quota 429 (`quota.exceeded`) never retries, whatever this says. Default 0.
   */
  retry?: boolean | number | ((failureCount: number, error: unknown) => boolean);
  refetchOnWindowFocus?: boolean;
  /**
   * Query network mode. Default `"offlineFirst"`: the first fetch always runs (a service worker,
   * an HTTP cache or a cached query answers it offline) and only retries pause while offline.
   * TanStack's own default, `"online"`, would never even try without a connection, so a cached
   * read on a phone in a tunnel stays pending. Mutations keep `"online"`: they pause offline and
   * resume when the connection returns.
   */
  networkMode?: NetworkMode;
}

// ============================================================================
// Defaults
// ============================================================================

// The same freshness defaults every arc-next hook applies (one source: DEFAULT_QUERY_CONFIG).
const DEFAULTS: Required<QueryClientOverrides> = {
  ...DEFAULT_QUERY_CONFIG,
  networkMode: "offlineFirst",
};

/**
 * TanStack's retryer decision (`retryer.ts`: `retry === true || failureCount < retry ||
 * retry(failureCount, error)`), with one exclusion first: a quota 429 (arc 2.22 `quota.exceeded`)
 * never retries, because a monthly quota does not reset between attempts.
 */
function shouldRetry(
  retry: QueryClientOverrides["retry"],
  failureCount: number,
  error: unknown,
): boolean {
  if (isQuotaExceeded(error)) return false;
  if (typeof retry === "function") return retry(failureCount, error);
  if (typeof retry === "number") return failureCount < retry;
  return retry === true;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * A NEW QueryClient with arc-next's defaults. Use it for one server request (a Server Component
 * prefetch), a test, or anywhere a client must not be shared. `getQueryClient()` reuses one in the
 * browser; on the server it calls this.
 *
 * Dehydration includes PENDING queries, so a Server Component can start a fetch, render
 * `<HydrationBoundary>` without awaiting it, and stream the result (TanStack advanced SSR).
 */
export function makeQueryClient(overrides?: QueryClientOverrides): QueryClient {
  const opts = { ...DEFAULTS, ...overrides };

  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => shouldRetry(opts.retry, failureCount, error),
        staleTime: opts.staleTime,
        gcTime: opts.gcTime,
        refetchOnWindowFocus: opts.refetchOnWindowFocus,
        networkMode: opts.networkMode,
      },
      dehydrate: {
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
        // Let the framework (Next) redact a streamed error itself, as TanStack's SSR guide does.
        shouldRedactErrors: () => false,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * Server: a NEW client per call (one per request; never shared between users).
 * Browser / React Native: one singleton (survives Suspense re-renders).
 *
 * @example
 * // providers.tsx ("use client")
 * <QueryClientProvider client={getQueryClient()}>{children}</QueryClientProvider>
 */
export function getQueryClient(overrides?: QueryClientOverrides): QueryClient {
  if (environmentManager.isServer()) return makeQueryClient(overrides);

  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient(overrides);
  } else if (overrides) {
    console.warn(
      "[arc-next] getQueryClient(): Browser singleton already exists; overrides are ignored. " +
        "Pass overrides only on the first call.",
    );
  }
  return browserQueryClient;
}
