import { defaultShouldDehydrateQuery, isServer, QueryClient } from "@tanstack/react-query";
import { isQuotaExceeded } from "./client.js";

// ============================================================================
// Types
// ============================================================================

export interface QueryClientOverrides {
  staleTime?: number;
  gcTime?: number;
  retry?: number | boolean;
  refetchOnWindowFocus?: boolean;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS: Required<QueryClientOverrides> = {
  staleTime: 5 * 60 * 1000,
  gcTime: 30 * 60 * 1000,
  retry: 0,
  refetchOnWindowFocus: false,
};

// ============================================================================
// Factory
// ============================================================================

function makeQueryClient(overrides?: QueryClientOverrides): QueryClient {
  const opts = { ...DEFAULTS, ...overrides };

  return new QueryClient({
    defaultOptions: {
      queries: {
        // Hosts may opt into retries, but quota 429s (arc 2.22
        // `quota.exceeded`) NEVER retry — a monthly quota doesn't reset
        // between attempts; retrying is noise against the counter.
        retry: (failureCount, error) =>
          !isQuotaExceeded(error) && failureCount < ((opts.retry as number) || 0),
        staleTime: opts.staleTime,
        gcTime: opts.gcTime,
        refetchOnWindowFocus: opts.refetchOnWindowFocus,
      },
      dehydrate: {
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * SSR-safe QueryClient singleton factory.
 * Server: always creates a new instance (one per request).
 * Browser: reuses a singleton (survives Suspense re-renders).
 *
 * @example
 * // In layout.tsx or providers
 * const queryClient = getQueryClient();
 *
 * // With overrides
 * const queryClient = getQueryClient({ staleTime: 60_000 });
 */
export function getQueryClient(overrides?: QueryClientOverrides): QueryClient {
  if (isServer) {
    return makeQueryClient(overrides);
  }

  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient(overrides);
  } else if (overrides) {
    console.warn(
      "[arc-next] getQueryClient(): Browser singleton already exists — overrides are ignored. " +
        "Pass overrides only on the first call.",
    );
  }
  return browserQueryClient;
}
