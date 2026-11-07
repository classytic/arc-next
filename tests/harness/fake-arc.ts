/**
 * A contract-true fake arc server: a `fetch` implementation that answers the way arc does, built
 * from @classytic/repo-core (the package arc itself uses), so a test never hand-writes wire JSON:
 *
 * - query strings are read with repo-core `parseUrl` (an unknown or malformed param is a 400, as
 *   in arc); lists answer `toCanonicalList` envelopes (offset by default, keyset when `after`
 *   or `keyset: true`);
 * - `GET /:id`, `POST`, `PATCH /:id`, `DELETE /:id`, `?_count=true` behave like a CRUD resource;
 * - errors are repo-core `ErrorContract` bodies with the right status.
 *
 * Every request is recorded (`requests`) with its parsed query and lower-cased headers.
 */

import { toCanonicalList } from "@classytic/repo-core/pagination";
import { parseUrl } from "@classytic/repo-core/query-parser";

export interface FakeRequest {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

export interface FakeArcOptions {
  /** Path prefix (`basePath`). Default `/api`. */
  basePath?: string;
  /** Seed rows per resource (`{ courses: [{ _id: "c1", ... }] }`). */
  resources?: Record<string, Array<Record<string, unknown>>>;
  /** Resources that paginate by cursor (keyset) instead of page (offset). */
  keyset?: string[];
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** A repo-core ErrorContract response. */
export const arcError = (status: number, code: string, message: string, extra = {}) =>
  json(status, { code, message, status, ...extra });

export function createFakeArc(options: FakeArcOptions = {}) {
  const basePath = options.basePath ?? "/api";
  const tables = new Map<string, Array<Record<string, unknown>>>(
    Object.entries(options.resources ?? {}).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]),
  );
  const keyset = new Set(options.keyset ?? []);
  const requests: FakeRequest[] = [];
  let nextId = 1;

  const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const path = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length)
      : url.pathname;
    requests.push({ method, url, path, headers, credentials: init.credentials, body });

    const [, resource = "", id] = path.split("/");
    const rows = tables.get(resource);
    if (!rows) return arcError(404, "arc.not_found", `Unknown resource ${resource}`);

    if (method === "GET" && !id) {
      const search = new URLSearchParams(url.search);
      if (search.get("_count") === "true") return json(200, { count: rows.length });
      let parsed: ReturnType<typeof parseUrl>;
      try {
        search.delete("_count");
        parsed = parseUrl(search);
      } catch (error) {
        return arcError(400, "arc.validation_error", (error as Error).message);
      }
      const limit = parsed.limit;
      if (keyset.has(resource) || parsed.after !== undefined) {
        const start = parsed.after ? Number(parsed.after) : 0;
        const page = rows.slice(start, start + limit);
        const more = start + limit < rows.length;
        return json(
          200,
          toCanonicalList({
            method: "keyset",
            data: page,
            limit,
            hasMore: more,
            next: more ? String(start + limit) : null,
          }),
        );
      }
      const pageNo = parsed.page ?? 1;
      const pages = Math.max(1, Math.ceil(rows.length / limit));
      return json(
        200,
        toCanonicalList({
          method: "offset",
          data: rows.slice((pageNo - 1) * limit, pageNo * limit),
          page: pageNo,
          limit,
          total: rows.length,
          pages,
          hasNext: pageNo < pages,
          hasPrev: pageNo > 1,
        }),
      );
    }

    const index = id ? rows.findIndex((r) => String(r._id) === id) : -1;
    if (method === "GET") {
      return index >= 0 ? json(200, rows[index]) : arcError(404, "arc.not_found", "Not found");
    }
    if (method === "POST" && !id) {
      const doc = { _id: `${resource}-${nextId++}`, ...(body as object) };
      rows.push(doc);
      return json(201, doc);
    }
    if (method === "PATCH" && index >= 0) {
      rows[index] = { ...rows[index], ...(body as object) };
      return json(200, rows[index]);
    }
    if (method === "DELETE" && index >= 0) {
      rows.splice(index, 1);
      return json(200, { message: "Deleted successfully", id });
    }
    return arcError(404, "arc.not_found", "Not found");
  };

  return { fetch, requests, tables, last: () => requests[requests.length - 1] };
}
