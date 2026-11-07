/**
 * Contract tests against @classytic/repo-core, the package arc and arc-next share:
 *
 * - what arc-next ENCODES, repo-core's `parseUrl` (the parser arc runs) reads back as the same
 *   query as repo-core's own `formatQuery` encoding of it;
 * - what arc EMITS (`toCanonicalList`) arc-next's list helpers and page params read correctly;
 * Type-level contracts are in repo-core.test-d.ts.
 */

import { type KeysetPaginationResult, toCanonicalList } from "@classytic/repo-core/pagination";
import { formatQuery, parseUrl } from "@classytic/repo-core/query-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import { configureClient } from "../../src/client/client.js";
import { extractItems, normalizePagination } from "../../src/query/cache.js";
import { createEntityQueries, nextPageParam } from "../../src/query/query-options.js";

interface Course {
  _id: string;
  title: string;
}

let urls: string[] = [];
beforeEach(() => {
  urls = [];
  configureClient({
    baseUrl: "http://api.test",
    fetch: vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ method: "offset", data: [], count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  });
});
afterEach(() => configureClient({ baseUrl: "" }));

const parsedFromUrl = (url: string) => parseUrl(new URL(url).searchParams);

describe("encoding: arc-next params parse as repo-core's own encoding", () => {
  const api = () => createCrudApi<Course>("courses", { basePath: "/api" });

  it("bracket operators, arrays, sort, page, limit", async () => {
    await api().getAll({
      params: {
        status: ["draft", "live"],
        "price[gte]": 5,
        sort: "-createdAt",
        page: 2,
        limit: 10,
      },
    });
    const ours = parsedFromUrl(urls[0]!);
    const theirs = parseUrl(
      formatQuery({
        filters: [
          { field: "status", op: "in", value: ["draft", "live"] },
          { field: "price", op: "gte", value: 5 },
        ],
        sort: "-createdAt",
        page: 2,
        limit: 10,
      }),
    );
    expect(ours).toEqual(theirs);
  });

  it("typed `filters` go through repo-core's formatQuery", async () => {
    await api().getAll({
      params: { filters: [{ field: "title", op: "contains", value: "algebra" }], limit: 5 },
    });
    expect(parsedFromUrl(urls[0]!)).toEqual(
      parseUrl(
        formatQuery({
          filters: [{ field: "title", op: "contains", value: "algebra" }],
          page: 1,
          limit: 5,
        }),
      ),
    );
  });

  it("a keyset page is requested with `after`, the param arc parses", async () => {
    const queries = createEntityQueries<Course>(api(), "courses");
    const infinite = queries.infiniteList({ limit: 20 });
    await (infinite.queryFn as (ctx: unknown) => Promise<unknown>)({
      pageParam: "cursor-abc",
      signal: new AbortController().signal,
    });
    const parsed = parsedFromUrl(urls[0]!);
    expect(parsed.after).toBe("cursor-abc");
    // A keyset request carries no offset page (the api default page must not leak in).
    expect(parsed.page).toBeUndefined();
  });

  it("dispatch verbs are reserved (never parsed as a field filter)", async () => {
    await api().count({ params: { status: "live" } });
    const parsed = parsedFromUrl(urls[0]!);
    expect(parsed).toEqual(
      parseUrl(formatQuery({ filters: [{ field: "status", value: "live" }], page: 1, limit: 10 })),
    );
  });
});

describe("decoding: arc's canonical envelopes", () => {
  const rows: Course[] = [{ _id: "c1", title: "Algebra" }];

  it("offset", () => {
    const wire = toCanonicalList<Course>({
      method: "offset",
      data: rows,
      page: 1,
      limit: 20,
      total: 41,
      pages: 3,
      hasNext: true,
      hasPrev: false,
    });
    expect(extractItems<Course>(wire)).toEqual(rows);
    expect(normalizePagination(wire)).toMatchObject({ method: "offset", total: 41, hasNext: true });
    expect(nextPageParam(wire)).toBe(2);
  });

  it("keyset (next cursor, end, no total)", () => {
    const wire = toCanonicalList<Course>({
      method: "keyset",
      data: rows,
      limit: 20,
      hasMore: true,
      next: "n1",
      end: "e1",
    } as KeysetPaginationResult<Course>);
    expect(normalizePagination(wire)).toMatchObject({
      method: "keyset",
      hasNext: true,
      next: "n1",
      end: "e1",
    });
    expect(nextPageParam(wire)).toBe("n1");
    expect(nextPageParam({ ...wire, hasMore: false, next: null })).toBeUndefined();
  });

  it("bare list (a non-paginated route): rows, no pagination", () => {
    const wire = toCanonicalList(rows);
    expect(extractItems<Course>(wire)).toEqual(rows);
    expect(normalizePagination(wire)).toBeNull();
  });
});
