/**
 * Encoder ↔ parser roundtrip — arc-next URL emission must reverse cleanly
 * through `@classytic/repo-core/query-parser`'s `parseUrl()`.
 *
 * Locks the cross-package grammar contract: every shape arc-next encodes
 * (CRUD `getAll` filters, aggregation filters, custom-route params) MUST
 * produce a URL that arc's server-side parser converts back into a Filter
 * IR matching the host's intent. Drift here = silent data corruption.
 *
 * Note on values: `parseUrl()` keeps everything as strings — type coercion
 * (number / boolean / Date) happens at the **kit layer** using schema
 * introspection (mongokit reads the Mongoose schema, sqlitekit the Drizzle
 * one). These tests assert on string values; numeric coercion is a
 * separate concern tested in each kit's QueryParser suite.
 */

import { and, contains, eq, gte, in_, lt, TRUE } from "@classytic/repo-core/filter";
import { parseUrl } from "@classytic/repo-core/query-parser";
import { describe, expect, it } from "vitest";
import { createQueryString } from "../src/client.js";

/**
 * Run a value through arc-next's encoder, parse the result with repo-core's
 * URL parser, and return the parsed filter IR for comparison.
 */
function roundtrip(input: Record<string, unknown>) {
  const encoded = createQueryString(input);
  const params = new URLSearchParams(encoded);
  return parseUrl(params);
}

describe("encoder ↔ parseUrl — bracket grammar alignment", () => {
  it('plain equality: { status: "active" } → eq', () => {
    const parsed = roundtrip({ status: "active" });
    expect(parsed.filter).toEqual(eq("status", "active"));
  });

  it("nested operator: { age: { gte: 18 } } → gte", () => {
    const parsed = roundtrip({ age: { gte: 18 } });
    expect(parsed.filter).toEqual(gte("age", "18"));
  });

  it("multi-op nested: { age: { gte: 18, lt: 65 } } → and(gte, lt)", () => {
    const parsed = roundtrip({ age: { gte: 18, lt: 65 } });
    // Parser ANDs multiple operators on the same field.
    expect(parsed.filter).toEqual(and(gte("age", "18"), lt("age", "65")));
  });

  it('array shorthand: { tags: ["a","b"] } → in_', () => {
    const parsed = roundtrip({ tags: ["a", "b"] });
    expect(parsed.filter).toEqual(in_("tags", ["a", "b"]));
  });

  it('explicit in op: { role: { in: ["admin","editor"] } } → in_', () => {
    const parsed = roundtrip({ role: { in: ["admin", "editor"] } });
    expect(parsed.filter).toEqual(in_("role", ["admin", "editor"]));
  });

  it('contains: { name: { contains: "john" } } → contains', () => {
    const parsed = roundtrip({ name: { contains: "john" } });
    expect(parsed.filter).toEqual(contains("name", "john"));
  });

  it("mixed: status + nested age range → AND of all three", () => {
    const parsed = roundtrip({ status: "active", age: { gte: 18, lt: 65 } });
    // Parser composes the field-level filters into an AND.
    expect(parsed.filter).toEqual(and(eq("status", "active"), gte("age", "18"), lt("age", "65")));
  });

  it('pre-bracketed key: { "age[gte]": 18 } → gte (back-compat path)', () => {
    // Existing callers who built the bracket key themselves still work.
    const parsed = roundtrip({ "age[gte]": 18 });
    expect(parsed.filter).toEqual(gte("age", "18"));
  });

  it("empty params → TRUE filter (no narrowing)", () => {
    const parsed = roundtrip({});
    expect(parsed.filter).toEqual(TRUE);
  });

  it("reserved control params (page, limit, sort) bypass the filter IR", () => {
    const parsed = roundtrip({ page: 2, limit: 50, sort: "-createdAt", status: "x" });
    expect(parsed.page).toBe(2);
    expect(parsed.limit).toBe(50);
    expect(parsed.sort).toEqual({ createdAt: -1 });
    // Only `status` should land in the filter — control params are stripped.
    expect(parsed.filter).toEqual(eq("status", "x"));
  });

  it('null encodes as the string "null" (matches mongokit/sqlitekit grammar)', () => {
    const encoded = createQueryString({ deletedAt: null });
    expect(encoded).toContain("deletedAt=null");
  });
});
