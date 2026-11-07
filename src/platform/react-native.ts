/**
 * `@classytic/arc-next/react-native`: wire TanStack Query to React Native's app lifecycle and
 * network state, in one call. arc-next does not import `react-native` or
 * `@react-native-community/netinfo`: pass the modules in (structural types below), so the package
 * has no hard dependency on either and the web build never sees them.
 *
 * @example
 * // App.tsx (once, at startup)
 * import { AppState } from "react-native";
 * import NetInfo from "@react-native-community/netinfo";
 * import { setupReactNative } from "@classytic/arc-next/react-native";
 * setupReactNative({ appState: AppState, netInfo: NetInfo });
 *
 * Why: the browser has `visibilitychange` and `online` events, which TanStack listens to by
 * default; React Native has neither. Without this, queries never refetch when the app returns to
 * the foreground, and TanStack thinks the phone is always online.
 */

import { focusManager, onlineManager } from "@tanstack/react-query";

/** The slice of React Native's `AppState` used here. */
export interface AppStateLike {
  addEventListener(
    type: "change",
    listener: (state: string) => void,
  ): { remove(): void } | undefined;
}

/** The slice of `@react-native-community/netinfo` used here. */
export interface NetInfoLike {
  addEventListener(
    listener: (state: {
      isConnected: boolean | null;
      isInternetReachable?: boolean | null;
    }) => void,
  ): () => void;
}

export interface SetupReactNativeOptions {
  /** `AppState` from `react-native`: refetch stale queries when the app comes to the foreground. */
  appState?: AppStateLike;
  /** NetInfo: pause queries and mutations offline, resume (and refetch) on reconnect. */
  netInfo?: NetInfoLike;
}

/**
 * Point `focusManager` at `AppState` ("active" = focused) and `onlineManager` at NetInfo
 * (connected and not known-unreachable = online). Returns a function that undoes both.
 * Call it once; calling again replaces the previous wiring.
 */
export function setupReactNative(options: SetupReactNativeOptions): () => void {
  const cleanups: Array<() => void> = [];

  const { appState, netInfo } = options;
  if (appState) {
    focusManager.setEventListener((handleFocus) => {
      const subscription = appState.addEventListener("change", (state) => {
        handleFocus(state === "active");
      });
      return () => subscription?.remove();
    });
    cleanups.push(() => focusManager.setEventListener(defaultFocusListener));
  }

  if (netInfo) {
    onlineManager.setEventListener((setOnline) =>
      netInfo.addEventListener((state) => {
        setOnline(state.isConnected === true && state.isInternetReachable !== false);
      }),
    );
    cleanups.push(() => onlineManager.setEventListener(defaultOnlineListener));
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

// TanStack's own defaults (no-ops off the browser), restored by the cleanup.
const defaultFocusListener = (handleFocus: (focused?: boolean) => void) => {
  const target = globalThis as {
    addEventListener?: (type: string, fn: () => void) => void;
    removeEventListener?: (type: string, fn: () => void) => void;
  };
  if (typeof target.addEventListener !== "function") return undefined;
  const listener = () => handleFocus();
  target.addEventListener("visibilitychange", listener);
  return () => target.removeEventListener?.("visibilitychange", listener);
};

const defaultOnlineListener = (setOnline: (online: boolean) => void) => {
  const target = globalThis as {
    addEventListener?: (type: string, fn: () => void) => void;
    removeEventListener?: (type: string, fn: () => void) => void;
  };
  if (typeof target.addEventListener !== "function") return undefined;
  const on = () => setOnline(true);
  const off = () => setOnline(false);
  target.addEventListener("online", on);
  target.addEventListener("offline", off);
  return () => {
    target.removeEventListener?.("online", on);
    target.removeEventListener?.("offline", off);
  };
};
