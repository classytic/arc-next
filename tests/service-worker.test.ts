/**
 * Service worker registration with a waiting update: a new worker never takes over by itself; the
 * page is told an update is ready and reloads only when asked.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyServiceWorkerUpdate,
  SKIP_WAITING_MESSAGE,
  useServiceWorker,
  watchServiceWorker,
} from "../src/service-worker.js";

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = "installing";
  postMessage = vi.fn();
  install(registration: FakeRegistration) {
    this.state = "installed";
    registration.installing = null;
    registration.waiting = this;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(async () => undefined);
  /** A newer worker was found and starts installing. */
  found(): FakeWorker {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
    return worker;
  }
}

class FakeContainer extends EventTarget {
  controller: object | null;
  registration = new FakeRegistration();
  register = vi.fn(async () => this.registration);
  constructor(controlled: boolean) {
    super();
    this.controller = controlled ? {} : null;
  }
}

const asContainer = (c: FakeContainer) => c as unknown as ServiceWorkerContainer;
const flush = () => act(async () => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe("watchServiceWorker", () => {
  it("registers the script with its scope and always fetches the script fresh", async () => {
    const container = new FakeContainer(false);
    const stop = watchServiceWorker(
      { url: "/sw.js", scope: "/station", container: asContainer(container) },
      vi.fn(),
    );
    await flush();
    expect(container.register).toHaveBeenCalledWith("/sw.js", {
      scope: "/station",
      updateViaCache: "none",
    });
    stop();
  });

  it("does not report the FIRST install as an update (no worker controlled the page)", async () => {
    const container = new FakeContainer(false);
    const ready = vi.fn();
    const stop = watchServiceWorker({ url: "/sw.js", container: asContainer(container) }, ready);
    await flush();
    container.registration.found().install(container.registration);
    expect(ready).not.toHaveBeenCalled();
    stop();
  });

  it("reports a newer worker once it is installed and waiting behind the controlling one", async () => {
    const container = new FakeContainer(true);
    const ready = vi.fn();
    const stop = watchServiceWorker({ url: "/sw.js", container: asContainer(container) }, ready);
    await flush();
    const worker = container.registration.found();
    expect(ready).not.toHaveBeenCalled();
    worker.install(container.registration);
    expect(ready).toHaveBeenCalledWith(container.registration);
    // Waiting, never told to take over by the watcher itself.
    expect(worker.postMessage).not.toHaveBeenCalled();
    stop();
  });

  it("reports a worker that was already waiting when the page opened", async () => {
    const container = new FakeContainer(true);
    container.registration.waiting = new FakeWorker();
    const ready = vi.fn();
    const stop = watchServiceWorker({ url: "/sw.js", container: asContainer(container) }, ready);
    await flush();
    expect(ready).toHaveBeenCalledTimes(1);
    stop();
  });

  it("checks for a newer worker when the page becomes visible and on the interval, until stopped", async () => {
    vi.useFakeTimers();
    const container = new FakeContainer(true);
    const stop = watchServiceWorker(
      { url: "/sw.js", checkEveryMs: 60_000, container: asContainer(container) },
      vi.fn(),
    );
    await flush();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(container.registration.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(container.registration.update).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(120_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(container.registration.update).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when registration is refused or there is no service worker support", async () => {
    const container = new FakeContainer(true);
    container.register.mockRejectedValueOnce(new Error("SecurityError"));
    const ready = vi.fn();
    watchServiceWorker({ url: "/sw.js", container: asContainer(container) }, ready)();
    await flush();
    expect(ready).not.toHaveBeenCalled();
    // jsdom has no navigator.serviceWorker: a no-op stop function.
    expect(() => watchServiceWorker({ url: "/sw.js" }, ready)()).not.toThrow();
  });
});

describe("applyServiceWorkerUpdate", () => {
  it("asks the waiting worker to activate and reloads only once it controls the page", () => {
    const container = new FakeContainer(true);
    const worker = new FakeWorker();
    container.registration.waiting = worker;
    const reload = vi.fn();
    applyServiceWorkerUpdate(container.registration as unknown as ServiceWorkerRegistration, {
      container: asContainer(container),
      reload,
    });
    expect(worker.postMessage).toHaveBeenCalledWith(SKIP_WAITING_MESSAGE);
    expect(reload).not.toHaveBeenCalled();
    container.dispatchEvent(new Event("controllerchange"));
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a waiting worker", () => {
    const container = new FakeContainer(true);
    const reload = vi.fn();
    applyServiceWorkerUpdate(container.registration as unknown as ServiceWorkerRegistration, {
      container: asContainer(container),
      reload,
    });
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("useServiceWorker", () => {
  it("reports the waiting update and applies it on request", async () => {
    const container = new FakeContainer(true);
    const { result } = renderHook(() =>
      useServiceWorker({ url: "/sw.js", container: asContainer(container) }),
    );
    await flush();
    expect(result.current.updateReady).toBe(false);
    let worker!: FakeWorker;
    act(() => {
      worker = container.registration.found();
      worker.install(container.registration);
    });
    await waitFor(() => expect(result.current.updateReady).toBe(true));
    act(() => result.current.applyUpdate());
    expect(worker.postMessage).toHaveBeenCalledWith(SKIP_WAITING_MESSAGE);
  });

  it("does not register while disabled", async () => {
    const container = new FakeContainer(true);
    renderHook(() =>
      useServiceWorker({ url: "/sw.js", container: asContainer(container), enabled: false }),
    );
    await flush();
    expect(container.register).not.toHaveBeenCalled();
  });
});
