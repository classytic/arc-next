/**
 * Error mapping. A bilingual app maps a server `code` to localized copy (never the server's English
 * message), so the sdk exposes the code, the status and "did it even reach the server" in one place.
 * Server-safe (no "use client").
 */

import { isArcApiError } from "../client.js";

/** The failure of a request the sdk made outside arc-next (streamed download, presigned upload). */
export class SdkRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "SdkRequestError";
    this.code = code;
    this.status = status;
  }
}

/** The stable server `code` of a refused request (`stock.item.in_use`, `arc.unauthorized`...), if any. */
export function errorCode(error: unknown): string | undefined {
  if (error instanceof SdkRequestError) return error.code;
  if (isArcApiError(error)) return error.code ?? undefined;
  if (typeof error === "object" && error !== null) {
    const json = (error as { json?: unknown }).json;
    if (typeof json === "object" && json !== null) {
      const code = (json as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** HTTP status of a failed request; `0` when it never reached the server; `undefined` when unknown. */
export function errorStatus(error: unknown): number | undefined {
  if (error instanceof SdkRequestError) return error.status;
  if (isArcApiError(error)) return error.status;
  return undefined;
}

/** True when the request never reached the server (offline, DNS, dropped connection). */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof SdkRequestError || isArcApiError(error)) return error.status === 0;
  return error instanceof TypeError;
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/**
 * The structured context of a refusal (`{ missing: [...] }`, `{ field }`, `{ retryAfterSeconds }`...), or
 * `undefined` when there is none. arc serializes a thrown error's `details` object as the wire envelope's
 * `meta` (the canonical `ErrorContract` record), so `meta` is read first; an object `details` (older or
 * non-arc backends) is the fallback. The canonical `details` ARRAY is per-field validation, read through
 * `ArcApiError.details` / `fieldErrors`, never here. Values are `unknown`: narrow each one. Never throws.
 */
export function errorDetails(error: unknown): Readonly<Record<string, unknown>> | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const json = recordOf((error as { json?: unknown }).json);
    if (!json) return undefined;
    return recordOf(json.meta) ?? recordOf(json.details);
  } catch {
    return undefined;
  }
}

export interface MappedError {
  code: string | undefined;
  status: number | undefined;
  network: boolean;
  /** Field-level detail arc-next extracted from a validation failure. */
  fields: Record<string, string> | null;
}

export function mapError(error: unknown): MappedError {
  return {
    code: errorCode(error),
    status: errorStatus(error),
    network: isNetworkFailure(error),
    fields: isArcApiError(error) ? error.fieldErrors : null,
  };
}
