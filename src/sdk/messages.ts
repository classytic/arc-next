/**
 * Toast text as KEYS. A bilingual app never hard-codes English into a toast: every CRUD and action
 * message is a stable key (`<prefix>.crud.<resource>.<op>.<outcome>`, `<prefix>.action.<key>.<outcome>`).
 * arc-next copies message strings when hooks are created (module load, before the host configures
 * anything), so the key travels through arc-next unchanged and the toast handler installed by
 * `initSDK` turns it into text at DISPLAY time through the host's `messages` resolver (current
 * locale). A key the host does not know falls back to the English default registered next to the
 * definition, so a missing translation never shows a raw key.
 *
 * The `<prefix>` (default `sdk`) is read when a key is resolved or listed, not when it is
 * registered, so a host sets it once at boot (`configureMessages(resolver, { keyPrefix: "app" })`
 * or `initSDK({ messageKeyPrefix })`) without caring about module evaluation order.
 *
 * Hosts that call arc-next's `configureToast` themselves wrap their handler with
 * `localizeToastHandler` so keys never reach the screen.
 *
 * Server-safe (no "use client"): definitions run in server modules too.
 */

import type { ToastHandler } from "../client/client.js";
import { matchServerError, type ServerErrorDetail } from "./error-capture.js";

export type MessageOutcome = "success" | "error";
export type CrudOperation = "create" | "update" | "delete";

/** Errors only: the refused request's stable server fields, so a host can localize domain errors. */
export interface MessageErrorFields {
  /** The server error `code` (`stock.item.exists`, `arc.forbidden`...), when the response carried one. */
  code?: string;
  /** The server's field-level `details`, when any. */
  details?: readonly ServerErrorDetail[];
  /** Support reference (request id) of the refused response, when any: show `Error ref: ${correlationId.slice(0, 8)}`. */
  correlationId?: string;
}

export type MessageContext =
  | ({
      kind: "crud";
      /** Full key, e.g. `app.crud.stations.create.success`. */
      key: string;
      /** Query-key root of the resource (its route path). */
      resource: string;
      operation: CrudOperation;
      outcome: MessageOutcome;
      /** English display name (fallback copy only). */
      singular: string;
      /** Whatever the resource registered next to its name (e.g. its permission-matrix resource). */
      permission?: string;
      /** Errors only: the server message arc-next extracted, when any. */
      detail?: string;
      fallback: string;
    } & MessageErrorFields)
  | ({
      kind: "action";
      key: string;
      /** The action key, e.g. `catalog.item.publish`. */
      action: string;
      outcome: MessageOutcome;
      detail?: string;
      fallback: string;
    } & MessageErrorFields);

/** Return the translated text, or `undefined` to keep the English default. */
export type MessageResolver = (context: MessageContext) => string | undefined;

export interface ConfigureMessagesOptions {
  /** First segment of every key the host sees. Default `sdk`. */
  keyPrefix?: string;
}

export const DEFAULT_KEY_PREFIX = "sdk";

// Registry entries are keyed by the prefix-less STEM (`crud.stations.create.success`).
type StemContext =
  | Omit<Extract<MessageContext, { kind: "crud" }>, "key">
  | Omit<Extract<MessageContext, { kind: "action" }>, "key">;

const registry = new Map<string, StemContext>();
let resolver: MessageResolver | undefined;
let keyPrefix = DEFAULT_KEY_PREFIX;

// U+2063 (invisible separator) brackets a key so it can never collide with real copy.
const MARK = String.fromCharCode(0x2063);
const MARKED = new RegExp(
  `^${MARK}((?:crud|action)\\.[A-Za-z0-9_.:/-]+)${MARK}(?:: ([\\s\\S]*))?$`,
);

const PAST = { create: "created", update: "updated", delete: "deleted" } as const;

const wrap = (stem: string) => `${MARK}${stem}${MARK}`;
const full = (stem: string) => `${keyPrefix}.${stem}`;

const crudStem = (resource: string, op: CrudOperation, outcome: MessageOutcome) =>
  `crud.${resource}.${op}.${outcome}`;
const actionStem = (action: string, outcome: MessageOutcome) => `action.${action}.${outcome}`;

/** The full key (with the configured prefix) of a CRUD message. */
export const crudMessageKey = (resource: string, op: CrudOperation, outcome: MessageOutcome) =>
  full(crudStem(resource, op, outcome));

/** The full key (with the configured prefix) of an action message. */
export const actionMessageKey = (action: string, outcome: MessageOutcome) =>
  full(actionStem(action, outcome));

export interface CrudMessageKeys {
  createSuccess: string;
  createError: string;
  updateSuccess: string;
  updateError: string;
  deleteSuccess: string;
  deleteError: string;
}

/** The six CRUD message keys of a resource, registered with their English fallbacks. */
export function registerCrudMessages(
  resource: string,
  singular: string,
  extra: { permission?: string } = {},
): CrudMessageKeys {
  const out: Record<string, string> = {};
  for (const op of ["create", "update", "delete"] as const) {
    for (const outcome of ["success", "error"] as const) {
      const stem = crudStem(resource, op, outcome);
      const fallback =
        outcome === "success"
          ? `${singular} ${PAST[op]} successfully`
          : `Failed to ${op} ${singular.toLowerCase()}`;
      registry.set(stem, {
        kind: "crud",
        resource,
        operation: op,
        outcome,
        singular,
        ...(extra.permission ? { permission: extra.permission } : {}),
        fallback,
      });
      out[`${op}${outcome === "success" ? "Success" : "Error"}`] = wrap(stem);
    }
  }
  return out as unknown as CrudMessageKeys;
}

export interface ActionFallback {
  success?: string;
  error?: string;
}

/**
 * The message keys of an action, registered with their English fallbacks. A success key exists only
 * when the action gave a success fallback (most verbs toast nothing on success); an error key always
 * exists, so a failure never shows the server's raw English line on its own.
 */
export function registerActionMessages(
  action: string,
  fallback: ActionFallback = {},
): { success?: string; error: string } {
  const out: { success?: string; error: string } = { error: "" };
  for (const outcome of ["success", "error"] as const) {
    const text =
      fallback[outcome] ??
      (outcome === "error" ? "Something went wrong. Please try again." : undefined);
    if (text === undefined) continue;
    const stem = actionStem(action, outcome);
    registry.set(stem, { kind: "action", action, outcome, fallback: text });
    out[outcome] = wrap(stem);
  }
  return out;
}

/** Install (or clear) the host's resolver. The key prefix is kept unless `options.keyPrefix` is given. */
export function configureMessages(
  next: MessageResolver | undefined,
  options: ConfigureMessagesOptions = {},
): void {
  resolver = next;
  if (options.keyPrefix) keyPrefix = options.keyPrefix;
}

/** Every key the sdk can emit with its English default: for the host's translation catalog and for tests. */
export function listMessageKeys(): ReadonlyArray<{ key: string; fallback: string }> {
  return [...registry.entries()].map(([stem, context]) => ({
    key: full(stem),
    fallback: context.fallback,
  }));
}

/** The localized success line of a CRUD operation, or `undefined` when the resource registered none. */
export function crudSuccessText(root: string, op: CrudOperation): string | undefined {
  const stem = crudStem(root, op, "success");
  return registry.has(stem) ? resolveToastText(wrap(stem)) : undefined;
}

/** Text for a toast message: keys resolved through the host's resolver, anything else unchanged. */
export function resolveToastText(message: string): string {
  const match = MARKED.exec(message);
  if (!match) return message;
  const stem = match[1] ?? "";
  const detail = match[2];
  const known = registry.get(stem);
  if (!known) return detail ?? full(stem);
  const server = known.outcome === "error" ? matchServerError(detail) : undefined;
  const context = {
    ...known,
    key: full(stem),
    ...(detail ? { detail } : {}),
    ...(server?.code ? { code: server.code } : {}),
    ...(server?.details ? { details: server.details } : {}),
    ...(server?.correlationId ? { correlationId: server.correlationId } : {}),
  } as MessageContext;
  // A host translation owns the whole line (it receives `detail`); the English default appends it.
  const translated = resolver?.(context);
  if (translated !== undefined) return translated;
  return detail && context.outcome === "error"
    ? `${context.fallback}: ${detail}`
    : context.fallback;
}

export function localizeToastHandler(handler: ToastHandler): ToastHandler {
  return {
    success: (message) => handler.success(resolveToastText(message)),
    error: (message) => handler.error(resolveToastText(message)),
  };
}
