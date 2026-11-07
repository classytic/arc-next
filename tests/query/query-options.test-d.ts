/**
 * Type contracts of the option factories: data types are inferred from the resource and carried
 * by the key (TanStack DataTag), so `getQueryData` / `setQueryData` / `useQuery` are typed without
 * annotations, and write variables are the resource's create / update payloads.
 */

import type { PaginatedResult } from "@classytic/repo-core/pagination";
import type { AggResult } from "@classytic/repo-core/repository";
import { QueryClient, useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { describe, expectTypeOf, it } from "vitest";
import { createCrudApi } from "../../src/client/api.js";
import { createCrudHooks, type PendingWrite } from "../../src/query/hooks.js";
import type { CursorPager } from "../../src/query/query.js";
import { createEntityQueries } from "../../src/query/query-options.js";

interface Course {
  _id: string;
  title: string;
}
type CourseCreate = { title: string };
type CourseUpdate = { title?: string };

const api = createCrudApi<Course, CourseCreate, CourseUpdate>("courses");
const queries = createEntityQueries<Course, CourseCreate, CourseUpdate>(api, "courses");

describe("createEntityQueries", () => {
  it("keys carry the data type", () => {
    const qc = new QueryClient();
    expectTypeOf(qc.getQueryData(queries.detail("c1").queryKey)).toEqualTypeOf<
      Course | undefined
    >();
    expectTypeOf(qc.getQueryData(queries.list().queryKey)).toEqualTypeOf<
      PaginatedResult<Course> | undefined
    >();
    expectTypeOf(qc.getQueryData(queries.count().queryKey)).toEqualTypeOf<number | undefined>();
    expectTypeOf(
      qc.getQueryData(queries.aggregation<{ day: string }>("byDay").queryKey),
    ).toEqualTypeOf<AggResult<{ day: string }> | undefined>();
  });

  it("the same options type useQuery and useSuspenseQuery", () => {
    expectTypeOf(useQuery(queries.detail("c1")).data).toEqualTypeOf<Course | undefined>();
    expectTypeOf(useSuspenseQuery(queries.detail("c1")).data).toEqualTypeOf<Course>();
  });

  it("mutation options take the resource's payloads", () => {
    const create = useMutation(queries.create());
    expectTypeOf(create.mutateAsync).parameter(0).toEqualTypeOf<{
      data: CourseCreate;
      token?: string | null;
      organizationId?: string | null;
    }>();
    expectTypeOf(create.data).toEqualTypeOf<Course | undefined>();
    const update = useMutation(queries.update());
    expectTypeOf(update.mutateAsync)
      .parameter(0)
      .toHaveProperty("data")
      .toEqualTypeOf<CourseUpdate>();
  });

  it("ctx accepts auth: 'omit' and nothing else", () => {
    queries.list({}, { auth: "omit" });
    // @ts-expect-error only "inherit" | "omit"
    queries.list({}, { auth: "anonymous" });
  });

  it("ctx org / token: string, null (deliberately none) or omitted; never a boolean mode", () => {
    queries.route("/me", { organizationId: null, token: "t" });
    // @ts-expect-error intent is a value or null, not a flag
    queries.route("/me", { organizationId: false });
  });
});

describe("custom routes", () => {
  interface Me {
    id: string;
    roles: string[];
  }

  it("route<TData>() types the key, useQuery and useSuspenseQuery", () => {
    const qc = new QueryClient();
    const me = queries.route<Me>("/me", { organizationId: null, staleTime: 60_000 });
    expectTypeOf(qc.getQueryData(me.queryKey)).toEqualTypeOf<Me | undefined>();
    expectTypeOf(useQuery(me).data).toEqualTypeOf<Me | undefined>();
    expectTypeOf(useSuspenseQuery(me).data).toEqualTypeOf<Me>();
    // @ts-expect-error staleTime is a TanStack StaleTime, not a string
    queries.route("/me", { staleTime: "1m" });
  });

  it("routeMutation<TData, TBody>() types data and variables", () => {
    const approve = useMutation(
      queries.routeMutation<Course, { note: string }>("/:id/approve", {
        method: "PATCH",
        invalidates: (course) => ({ op: "update", id: course._id }),
      }),
    );
    expectTypeOf(approve.data).toEqualTypeOf<Course | undefined>();
    approve.mutate({ pathParams: { id: "c1" }, data: { note: "ok" }, organizationId: null });
    // @ts-expect-error the body is typed
    approve.mutate({ data: { note: 1 } });
    // @ts-expect-error a route mutation is never a GET
    queries.routeMutation("/x", { method: "GET" });
  });
});

describe("createCrudHooks", () => {
  const hooks = createCrudHooks<Course, CourseCreate, CourseUpdate>({
    api,
    entityKey: "courses",
    singular: "Course",
  });

  it("exposes the same factories it reads with", () => {
    expectTypeOf(hooks.queries.detail).returns.toHaveProperty("queryKey");
    expectTypeOf(hooks.usePendingWrites).returns.toEqualTypeOf<
      PendingWrite<CourseCreate, CourseUpdate>[]
    >();
  });

  it("useCursorPager returns typed rows; maxPages is not an option (Previous needs every page)", () => {
    expectTypeOf(hooks.useCursorPager).returns.toEqualTypeOf<CursorPager<Course>>();
    // @ts-expect-error evicting pages would break Previous
    hooks.useCursorPager({}, { maxPages: 3 });
  });

  it("the token-first signatures are gone", () => {
    // @ts-expect-error useList(params, options): no token argument
    hooks.useList("token", {});
  });
});
