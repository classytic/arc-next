/**
 * Type-level contract with @classytic/repo-core: arc-next's wire types are repo-core's, so a
 * contract change upstream is a compile error here, not a runtime surprise.
 */

import type { ErrorDetail } from "@classytic/repo-core/errors";
import type { KeysetPaginationResult, PaginatedResult } from "@classytic/repo-core/pagination";
import type { AggResult, DeleteResult } from "@classytic/repo-core/repository";
import { QueryClient } from "@tanstack/react-query";
import { describe, expectTypeOf, it } from "vitest";
import { BaseApi, createCrudApi } from "../../src/client/api.js";
import type { ArcApiError } from "../../src/client/client.js";
import type { PaginationData, PaginationMethod } from "../../src/query/cache.js";
import { createEntityQueries } from "../../src/query/query-options.js";

interface Course {
  _id: string;
  title: string;
}

describe("BaseApi wire types", () => {
  it("reads and deletes resolve to repo-core's shapes", () => {
    const api = new BaseApi<Course>("courses");
    expectTypeOf(api.getAll).returns.resolves.toEqualTypeOf<PaginatedResult<Course>>();
    expectTypeOf(api.delete).returns.resolves.toEqualTypeOf<DeleteResult>();
  });

  it("errors expose repo-core ErrorDetail", () => {
    expectTypeOf<ArcApiError["details"]>().toEqualTypeOf<readonly ErrorDetail[] | null>();
  });
});

describe("option factories and pagination", () => {
  const queries = createEntityQueries<Course>(createCrudApi<Course>("courses"), "courses");

  it("factory data types are repo-core's wire types, carried by the key (DataTag)", () => {
    const qc = new QueryClient();
    expectTypeOf(qc.getQueryData(queries.detail("c1").queryKey)).toEqualTypeOf<
      Course | undefined
    >();
    expectTypeOf(qc.getQueryData(queries.list().queryKey)).toEqualTypeOf<
      PaginatedResult<Course> | undefined
    >();
    expectTypeOf(qc.getQueryData(queries.count().queryKey)).toEqualTypeOf<number | undefined>();
    expectTypeOf(qc.getQueryData(queries.aggregation("byDay").queryKey)).toEqualTypeOf<
      AggResult | undefined
    >();
  });

  it("the pagination method is repo-core's discriminant", () => {
    expectTypeOf<PaginationMethod>().toEqualTypeOf<"offset" | "keyset" | "aggregate">();
    expectTypeOf<PaginationData["next"]>().toEqualTypeOf<
      KeysetPaginationResult<unknown>["next"] | undefined
    >();
  });
});
