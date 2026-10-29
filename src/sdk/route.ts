/** Small helpers every api file uses to build custom-route paths and query objects. Server-safe. */

import type { RouteApi } from "./actions.js";

export const enc = encodeURIComponent;

/** Query params without the unset ones: the server refuses empty values. */
export function compact(params: object): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/** A page of an arc list as the sdk reads it. */
export interface PageLike<T> {
  data: T[];
  hasNext?: boolean;
  total?: number;
}

export interface AllPagesOptions {
  /** Stop after this many pages and throw (a silently truncated catalog is worse than an error). Default 10. */
  maxPages?: number;
}

export class PageLimitError extends Error {
  constructor(readonly kind: "changed" | "too-many") {
    super(
      kind === "changed"
        ? "The list changed while loading. Refresh and try again."
        : "The list is longer than the page cap; nothing was partially applied.",
    );
    this.name = "PageLimitError";
  }
}

/**
 * Every row of a bounded list, page by page. Never author a whole-collection replacement from a
 * silently truncated read: an empty page mid-list or hitting the cap throws instead.
 */
export async function fetchAllPages<T>(
  read: (page: number) => Promise<PageLike<T>>,
  options: AllPagesOptions = {},
): Promise<T[]> {
  const max = options.maxPages ?? 10;
  const items: T[] = [];
  for (let page = 1; page <= max; page++) {
    const result = await read(page);
    items.push(...result.data);
    if (result.hasNext === false) return items;
    if (
      result.hasNext === undefined &&
      result.total !== undefined &&
      items.length >= result.total
    ) {
      return items;
    }
    if (result.data.length === 0) throw new PageLimitError("changed");
  }
  throw new PageLimitError("too-many");
}

/** `GET <path>` through a resource's route invoker. */
export function getRoute<T>(
  api: RouteApi,
  path: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return api.invokeRoute<T>({ method: "GET", path, ...(params ? { params } : {}) });
}
