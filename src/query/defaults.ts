// Freshness defaults: the one source for arc-next's QueryClient (`./query-client`) and its hooks.
// Internal module (no subpath of its own); `./cache` is where hosts import these from. Kept apart
// so `./query-client` does not pull the whole cache module into its bundle.

export const DEFAULT_QUERY_CONFIG = {
  staleTime: 5 * 60 * 1000,
  gcTime: 30 * 60 * 1000,
  refetchOnWindowFocus: false,
  retry: 0,
} as const;

/** Pre-built query config presets for common data freshness patterns. */
export const QUERY_CONFIGS = {
  /** Live data: 20s stale, 30s polling */
  realtime: { staleTime: 20_000, refetchInterval: 30_000 },
  /** Frequently updated: 60s stale */
  frequent: { staleTime: 60_000 },
  /** Stable data: 5min stale (same as default) */
  stable: { staleTime: 300_000 },
  /** Rarely changes: 10min stale */
  static: { staleTime: 600_000 },
} as const;
