import { readFileSync } from "node:fs";
import path from "node:path";
import { focusManager, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { RN_SUBPATHS } from "../../scripts/check-rn-boundary.mjs";
import { setupReactNative } from "../../src/platform/react-native.js";

describe("setupReactNative", () => {
  /**
   * `setupReactNative`: TanStack's focus and online managers follow React Native's AppState and
   * NetInfo (fakes here; arc-next never imports either module).
   */

  function fakeAppState() {
    let listener: ((state: string) => void) | null = null;
    let removed = false;
    return {
      addEventListener(_type: "change", fn: (state: string) => void) {
        listener = fn;
        return {
          remove() {
            removed = true;
          },
        };
      },
      emit: (state: string) => listener?.(state),
      get removed() {
        return removed;
      },
    };
  }

  function fakeNetInfo() {
    let listener:
      | ((s: { isConnected: boolean | null; isInternetReachable?: boolean | null }) => void)
      | null = null;
    let unsubscribed = false;
    return {
      addEventListener(fn: typeof listener & object) {
        listener = fn;
        return () => {
          unsubscribed = true;
        };
      },
      emit: (s: { isConnected: boolean | null; isInternetReachable?: boolean | null }) =>
        listener?.(s),
      get unsubscribed() {
        return unsubscribed;
      },
    };
  }

  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  });

  describe("setupReactNative", () => {
    it("AppState 'active' focuses, 'background' blurs", () => {
      const appState = fakeAppState();
      cleanup = setupReactNative({ appState });
      appState.emit("background");
      expect(focusManager.isFocused()).toBe(false);
      appState.emit("active");
      expect(focusManager.isFocused()).toBe(true);
    });

    it("NetInfo drives onlineManager (unreachable counts as offline)", () => {
      const netInfo = fakeNetInfo();
      cleanup = setupReactNative({ netInfo });
      netInfo.emit({ isConnected: false });
      expect(onlineManager.isOnline()).toBe(false);
      netInfo.emit({ isConnected: true, isInternetReachable: false });
      expect(onlineManager.isOnline()).toBe(false);
      netInfo.emit({ isConnected: true, isInternetReachable: true });
      expect(onlineManager.isOnline()).toBe(true);
    });

    it("the returned cleanup unsubscribes both listeners", () => {
      const appState = fakeAppState();
      const netInfo = fakeNetInfo();
      setupReactNative({ appState, netInfo })();
      expect(appState.removed).toBe(true);
      expect(netInfo.unsubscribed).toBe(true);
    });
  });
});

describe("module load without DOM globals", () => {
  /**
   * React Native boundary, runtime half: every RN-facing subpath's source module imports with NO
   * DOM globals (`window`, `document`, `localStorage`, `sessionStorage` all undefined), so nothing
   * touches the DOM at module load. The static half (no web/Next/Node module reachable from the
   * built entry) is `scripts/check-rn-boundary.mjs`, which owns the subpath list used here.
   */

  const ROOT = path.resolve(__dirname, "../..");
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    exports: Record<string, { default: string }>;
  };

  /** dist/x/y.js -> src/x/y.ts */
  const sourceOf = (sub: string) =>
    path.join(
      ROOT,
      pkg.exports[sub]!.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"),
    );

  describe("React Native boundary: module load without DOM globals", () => {
    it("the environment really has no DOM", () => {
      const g = globalThis as Record<string, unknown>;
      for (const name of ["window", "document", "localStorage", "sessionStorage"]) {
        expect(typeof g[name], name).toBe("undefined");
      }
    });

    for (const sub of RN_SUBPATHS as string[]) {
      it(`${sub} imports cleanly`, async () => {
        const mod = (await import(/* @vite-ignore */ sourceOf(sub))) as Record<string, unknown>;
        expect(Object.keys(mod).length).toBeGreaterThan(0);
      });
    }
  });
});
