/**
 * The ONE streamed-download helper. Exports (CSV, XLSX) and generated documents stream a file body
 * that arc-next's JSON client would buffer, so they go through here: bearer token in a header
 * (never the URL), the server's `code` on a refusal, the filename from `content-disposition`, and
 * the truncation flag the server sets when it cut the file at its row cap.
 *
 * Either read `stream` chunk by chunk (progress, piping) or call `blob()`: the body can be consumed once.
 *
 * Server-safe (no "use client"); `saveDownload` needs a browser document and says so.
 */

import { SdkRequestError } from "./errors.js";
import { type RawTransport, requireGlobalTransport } from "./transport.js";

/** Response header a server sets to `1` when it cut an export at its row cap. */
export const DEFAULT_TRUNCATED_HEADER = "x-export-truncated";

export type DownloadParams = Record<string, string | number | boolean | null | undefined>;

export interface DownloadRequest {
  /** Path under the API base path, e.g. `reports/summary/export`. */
  path: string;
  params?: DownloadParams;
  signal?: AbortSignal;
}

export interface DownloadResult {
  status: number;
  /** From `content-disposition`, when the server sent one. */
  filename: string | null;
  contentType: string | null;
  /** The server cut the file at its row cap (the truncation header is `1`). */
  truncated: boolean;
  /** The response body as bytes; `null` for an empty body. */
  stream: ReadableStream<Uint8Array> | null;
  /** The whole body as one Blob (consumes the stream). */
  blob(): Promise<Blob>;
}

export type Downloader = (request: DownloadRequest) => Promise<DownloadResult>;

export interface DownloaderOptions {
  /** Header that reports a truncated export. Default {@link DEFAULT_TRUNCATED_HEADER}. */
  truncatedHeader?: string;
}

export function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      /* fall through to the plain form */
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? null;
}

export function downloadUrl(transport: RawTransport, request: DownloadRequest): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(request.params ?? {})) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const qs = query.toString();
  // A path the server itself handed out (`/api/files/...`) already carries the mount point.
  const mount = `${transport.basePath}/`;
  const path = request.path.startsWith(mount)
    ? request.path.slice(mount.length)
    : request.path.replace(/^\/+/, "");
  return `${transport.baseUrl}${transport.basePath}/${path}${qs ? `?${qs}` : ""}`;
}

export function createDownloader(
  transport: RawTransport,
  options: DownloaderOptions = {},
): Downloader {
  const truncatedHeader = options.truncatedHeader ?? DEFAULT_TRUNCATED_HEADER;
  return async (request) => {
    const token = transport.getToken();
    if (!token) throw new SdkRequestError("Sign in again", "arc.unauthorized", 401);
    let response: Response;
    try {
      response = await transport.fetch(downloadUrl(transport, request), {
        method: "GET",
        credentials: "omit",
        headers: { authorization: `Bearer ${token}` },
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new SdkRequestError("Network error", "network", 0);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      throw new SdkRequestError(
        body?.message ?? `Download failed (${response.status})`,
        body?.code ?? `http.${response.status}`,
        response.status,
      );
    }
    return {
      status: response.status,
      filename: filenameFromDisposition(response.headers.get("content-disposition")),
      contentType: response.headers.get("content-type"),
      truncated: response.headers.get(truncatedHeader) === "1",
      stream: response.body,
      blob: () => response.blob(),
    };
  };
}

/** A downloader bound to the transport `initSDK` configured (resolved per call). */
export const streamDownload: Downloader = (request) =>
  createDownloader(requireGlobalTransport())(request);

/**
 * Browser convenience: hand a finished download to the user as a file. Reads the whole body, so use
 * it for exports and documents, not for anything large enough to need streaming to disk.
 */
export async function saveDownload(
  result: DownloadResult,
  fallbackName: string,
): Promise<{ truncated: boolean }> {
  const blob = await result.blob();
  const host = globalThis as unknown as {
    document?: { createElement(tag: "a"): { href: string; download: string; click(): void } };
  };
  if (!host.document) throw new Error("saveDownload needs a browser document");
  const url = URL.createObjectURL(blob);
  const link = host.document.createElement("a");
  link.href = url;
  link.download = result.filename ?? fallbackName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { truncated: result.truncated };
}
