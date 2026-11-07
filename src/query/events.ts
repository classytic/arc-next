/**
 * Change events: every successful write made through `createCrudHooks`, reported once for the
 * whole app. Server-safe (no "use client"), and its own subpath so only code that writes pays for it.
 */

/** A write that succeeded, as `createCrudHooks` reports it. */
export interface ArcChangeEvent<T = unknown> {
  /** The resource's `entityKey` ("lessons"). */
  entity: string;
  op: "create" | "update" | "delete" | "restore";
  id: string;
  /** The document the server returned; `null` for a delete. */
  item: T | null;
  /**
   * The document as this client last saw it, before the write (detail cache, else a list row);
   * `null` when it was never loaded. For a delete it is the only record of the document, so a
   * listener can still read its parent ("which course was this lesson in").
   */
  previous: T | null;
}

export type ArcChangeListener = (event: ArcChangeEvent) => void | Promise<void>;

const changeListeners = new Set<ArcChangeListener>();

/**
 * Hear every successful write made through `createCrudHooks`, once, for the whole app.
 *
 * The integration point for server caches: a Next.js app passes a server action that turns the
 * event into cache tags (`arcTag`) and invalidates them, so a public page rendered from a cache
 * changes the moment it is edited, including after a delete. A listener's failure is logged and
 * never fails the write. Returns an unsubscribe function.
 *
 * Client-side only (like `configureClient`): register it in a `"use client"` provider.
 */
export function onArcChange(listener: ArcChangeListener): () => void {
  if (typeof window === "undefined") {
    console.warn(
      "[arc-next] onArcChange() called on the server. Listeners are module state shared by every " +
        "request; register them from client-side code (e.g. a 'use client' provider).",
    );
  }
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** @internal — called by `createCrudHooks` after a write succeeds. */
export function emitArcChange(event: ArcChangeEvent): void {
  for (const listener of changeListeners) {
    try {
      const result = listener(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((error: unknown) =>
          console.error(`[arc-next] change listener failed for ${event.entity} ${event.op}`, error),
        );
      }
    } catch (error) {
      console.error(`[arc-next] change listener failed for ${event.entity} ${event.op}`, error);
    }
  }
}
