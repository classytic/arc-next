"use client";

/**
 * Register a service worker and surface a waiting update, never taking over by itself.
 *
 * A screen that stays open for a whole shift must not have its code swapped underneath it: a new
 * worker installs and WAITS; the page learns that an update is ready and the person chooses when
 * to reload. {@link applyServiceWorkerUpdate} then asks the waiting worker to activate (the worker
 * answers {@link SKIP_WAITING_MESSAGE} with `self.skipWaiting()`) and reloads once it controls the
 * page. The browser only looks for a new worker on navigation, so a long-open page also checks when
 * it becomes visible again and, optionally, on an interval.
 *
 * Registration uses `updateViaCache: "none"`: the worker script is always fetched fresh. The
 * worker itself (what it caches) belongs to the host.
 */

import { useCallback, useEffect, useState } from "react";

/** The message a waiting worker must answer with `self.skipWaiting()` (the common worker convention). */
export const SKIP_WAITING_MESSAGE = { type: "SKIP_WAITING" } as const;

export interface ServiceWorkerOptions {
  /** Worker script URL (same origin), e.g. `/sw.js`. */
  url: string;
  /** Registration scope, e.g. `/station`. Default: the script's directory. */
  scope?: string;
  /** Also ask the browser for a newer worker this often (ms) while the page is open. Default: only on visibility. */
  checkEveryMs?: number;
  /** The container to register with. Default: `navigator.serviceWorker` (absent: nothing happens). */
  container?: ServiceWorkerContainer;
}

function defaultContainer(): ServiceWorkerContainer | undefined {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator
    ? navigator.serviceWorker
    : undefined;
}

/**
 * Register `url` and call `onUpdateReady(registration)` whenever a new worker is installed and
 * waiting while an older one controls the page (a first install is not an update). Returns a stop
 * function that removes every listener and timer; the registration itself stays.
 */
export function watchServiceWorker(
  options: ServiceWorkerOptions,
  onUpdateReady: (registration: ServiceWorkerRegistration) => void,
): () => void {
  const container = options.container ?? defaultContainer();
  if (!container) return () => undefined;
  let stopped = false;
  const cleanups: Array<() => void> = [];
  const isUpdate = () => container.controller !== null;

  const watchInstalling = (
    registration: ServiceWorkerRegistration,
    worker: ServiceWorker | null,
  ) => {
    if (!worker) return;
    const onState = () => {
      if (
        worker.state === "installed" &&
        registration.waiting === worker &&
        isUpdate() &&
        !stopped
      ) {
        onUpdateReady(registration);
      }
    };
    worker.addEventListener("statechange", onState);
    cleanups.push(() => worker.removeEventListener("statechange", onState));
  };

  container
    .register(options.url, {
      ...(options.scope ? { scope: options.scope } : {}),
      updateViaCache: "none",
    })
    .then((registration) => {
      if (stopped) return;
      if (registration.waiting && isUpdate()) onUpdateReady(registration);
      watchInstalling(registration, registration.installing);
      const onFound = () => watchInstalling(registration, registration.installing);
      registration.addEventListener("updatefound", onFound);
      cleanups.push(() => registration.removeEventListener("updatefound", onFound));

      const check = () => {
        registration.update().catch(() => undefined);
      };
      if (typeof document !== "undefined") {
        const onVisible = () => {
          if (document.visibilityState === "visible") check();
        };
        document.addEventListener("visibilitychange", onVisible);
        cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));
      }
      if (options.checkEveryMs && options.checkEveryMs > 0) {
        const timer = setInterval(check, options.checkEveryMs);
        cleanups.push(() => clearInterval(timer));
      }
    })
    // Refused (unsupported scheme, blocked by policy, private mode): the page works without a worker.
    .catch(() => undefined);

  return () => {
    stopped = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
}

/**
 * Activate the waiting worker and reload once it controls the page. Does nothing when no worker
 * is waiting. `reload` defaults to `location.reload()`.
 */
export function applyServiceWorkerUpdate(
  registration: ServiceWorkerRegistration,
  options: { container?: ServiceWorkerContainer; reload?: () => void } = {},
): void {
  const waiting = registration.waiting;
  const container = options.container ?? defaultContainer();
  if (!waiting || !container) return;
  const reload = options.reload ?? (() => window.location.reload());
  container.addEventListener("controllerchange", () => reload(), { once: true });
  waiting.postMessage(SKIP_WAITING_MESSAGE);
}

export interface ServiceWorkerUpdate {
  /** A new worker is installed and waiting: offer a reload. */
  updateReady: boolean;
  /** Activate the waiting worker and reload the page. */
  applyUpdate: () => void;
}

/**
 * {@link watchServiceWorker} as a hook: registers while `enabled` (default true) and reports a
 * waiting update. The page decides how to offer it; nothing reloads until `applyUpdate()`.
 */
export function useServiceWorker(
  options: ServiceWorkerOptions & { enabled?: boolean },
): ServiceWorkerUpdate {
  const { url, scope, checkEveryMs, container, enabled = true } = options;
  const [waiting, setWaiting] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!enabled) return;
    return watchServiceWorker(
      {
        url,
        ...(scope ? { scope } : {}),
        ...(checkEveryMs ? { checkEveryMs } : {}),
        ...(container ? { container } : {}),
      },
      setWaiting,
    );
  }, [url, scope, checkEveryMs, container, enabled]);

  const applyUpdate = useCallback(() => {
    if (waiting) applyServiceWorkerUpdate(waiting, container ? { container } : {});
  }, [waiting, container]);

  return { updateReady: waiting !== null, applyUpdate };
}
