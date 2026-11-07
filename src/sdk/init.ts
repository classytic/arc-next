"use client";

/**
 * `initSDK(config)`: the GLOBAL SINGLETON. Configures the arc-next transport, auth, toast,
 * navigation and the message resolver once at app boot (browser only: arc-next's globals are
 * process-scoped, never call it per request on a server). Every hook and every module-level api
 * reads it.
 *
 * For SSR, tests and background jobs use the isolated path instead: `createIsolatedClient` from
 * `./transport` touches no global state.
 */

import { configureAuth, configureClient } from "../client/client.js";
import { configureNavigation } from "../query/hooks.js";
import { configureToast } from "../query/mutation.js";
import { captureServerErrors } from "./error-capture.js";
import { configureMessages, localizeToastHandler } from "./messages.js";
import {
  clientConfigFor,
  type ResolvedTransport,
  resolveTransport,
  type SdkConfig,
  setGlobalTransport,
} from "./transport.js";

export function initSDK(config: SdkConfig): ResolvedTransport {
  const transport = resolveTransport(config);
  setGlobalTransport(transport);
  configureClient(
    clientConfigFor(
      config,
      transport,
      config.captureErrors === false ? transport.apiFetch : captureServerErrors(transport.apiFetch),
    ),
  );
  configureAuth({
    getToken: config.getToken,
    ...(config.onAuthError ? { onAuthError: config.onAuthError } : {}),
    ...(config.onSessionChange ? { onSessionChange: config.onSessionChange } : {}),
  });
  configureMessages(config.messages, {
    ...(config.messageKeyPrefix ? { keyPrefix: config.messageKeyPrefix } : {}),
  });
  if (config.toast) configureToast(localizeToastHandler(config.toast));
  if (config.navigation) configureNavigation(config.navigation);
  return transport;
}
