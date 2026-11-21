/**
 * Server error capture. arc-next builds an error toast from a fixed message plus the server's
 * English `message`; the stable `code` and `details` never reach the toast text. The global
 * transport therefore records every refused JSON response here, and the toast resolver
 * (`./messages`) looks the matching one up when it turns a message key into text. A small,
 * short-lived ring: a toast shows within a tick of the failure, so nothing older than `TTL_MS` can
 * belong to it.
 *
 * Server-safe (no "use client").
 */

export interface ServerErrorDetail {
  path?: string;
  code?: string;
  message?: string;
}

export interface CapturedServerError {
  status: number;
  code?: string;
  message?: string;
  details?: readonly ServerErrorDetail[];
  /** Support reference: the body's `correlationId`, else the `x-request-id` header when readable. */
  correlationId?: string;
  at: number;
}

const TTL_MS = 10_000;
/** A failure with no matching server message (5xx, field-level detail) pairs with the newest one this fresh. */
const FRESH_MS = 3_000;
const MAX = 20;

const recent: CapturedServerError[] = [];

export function recordServerError(entry: Omit<CapturedServerError, "at">, now = Date.now()): void {
  recent.unshift({ ...entry, at: now });
  recent.length = Math.min(recent.length, MAX);
}

/** The captured error behind a toast whose server `detail` text is known (or unknown), newest first. */
export function matchServerError(
  detail?: string,
  now = Date.now(),
): CapturedServerError | undefined {
  const live = recent.filter((entry) => now - entry.at <= TTL_MS);
  if (detail) {
    const exact = live.find((entry) => entry.message === detail);
    if (exact) return exact;
  }
  return live.find((entry) => now - entry.at <= FRESH_MS);
}

export function clearServerErrors(): void {
  recent.length = 0;
}

function asDetails(value: unknown): ServerErrorDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ServerErrorDetail[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { path, code, message } = item as Record<string, unknown>;
    out.push({
      ...(typeof path === "string" ? { path } : {}),
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof message === "string" ? { message } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Wrap a fetch so refused JSON responses are recorded. The response itself is returned untouched. */
export function captureServerErrors(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    if (!response.ok) {
      try {
        const body = (await response.clone().json()) as Record<string, unknown> | null;
        if (body && typeof body === "object") {
          const details = asDetails(body.details);
          const correlationId =
            (typeof body.correlationId === "string" && body.correlationId) ||
            response.headers.get("x-request-id");
          recordServerError({
            status: response.status,
            ...(typeof body.code === "string" ? { code: body.code } : {}),
            ...(typeof body.message === "string" ? { message: body.message } : {}),
            ...(details ? { details } : {}),
            ...(correlationId ? { correlationId } : {}),
          });
        }
      } catch {
        // Not JSON (a proxy page): there is no code to expose.
      }
    }
    return response;
  };
}
