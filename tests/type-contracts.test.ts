/**
 * Type-contract lock-ins — the SDK's wire types must BE (or derive from)
 * repo-core's canonical contracts, not parallel declarations. These
 * assertions compile in the `typecheck:tests` lane; a repo-core rename or
 * an accidental local re-declaration fails here first.
 */

import type { ErrorDetail } from "@classytic/repo-core/errors";
import { ERROR_CODES } from "@classytic/repo-core/errors";
import type {
  SortDirection as CoreSortDirection,
  PaginatedResult,
} from "@classytic/repo-core/pagination";
import type { ParsedPopulate } from "@classytic/repo-core/query-parser";
import type { DeleteResult } from "@classytic/repo-core/repository";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { PopulateOption, SortDirection } from "../src/api.js";
import { BaseApi } from "../src/api.js";
import type { ArcErrorCode } from "../src/client.js";
import { type ArcApiError, KNOWN_ARC_ERROR_CODES } from "../src/client.js";

type Doc = { _id: string; name: string };

describe("canonical wire-type derivation", () => {
  it("BaseApi.getAll resolves to repo-core PaginatedResult", () => {
    const api = new BaseApi<Doc>("things");
    expectTypeOf(api.getAll).returns.resolves.toEqualTypeOf<PaginatedResult<Doc>>();
  });

  it("BaseApi.delete resolves to repo-core DeleteResult", () => {
    const api = new BaseApi<Doc>("things");
    expectTypeOf(api.delete).returns.resolves.toEqualTypeOf<DeleteResult>();
  });

  it("SortDirection is the canonical numeric core plus URL string forms", () => {
    expectTypeOf<CoreSortDirection>().toMatchTypeOf<SortDirection>();
    expectTypeOf<"asc" | "desc">().toMatchTypeOf<SortDirection>();
    // @ts-expect-error — arbitrary strings are NOT sort directions
    const bad: SortDirection = "ascending";
    void bad;
  });

  it("PopulateOption is a strict subset of repo-core ParsedPopulate", () => {
    expectTypeOf<PopulateOption>().toEqualTypeOf<
      Pick<ParsedPopulate, "path" | "select" | "match">
    >();
  });

  it("ArcApiError.details carries repo-core ErrorDetail entries", () => {
    expectTypeOf<ArcApiError["details"]>().toEqualTypeOf<readonly ErrorDetail[] | null>();
  });

  it("every repo-core canonical error code satisfies ArcErrorCode", () => {
    for (const code of Object.values(ERROR_CODES)) {
      expectTypeOf(code).toMatchTypeOf<ArcErrorCode>();
    }
    // Runtime lock: the canonical block of KNOWN_ARC_ERROR_CODES IS the
    // imported ERROR_CODES values (spread, not copied).
    for (const code of Object.values(ERROR_CODES)) {
      expect(KNOWN_ARC_ERROR_CODES).toContain(code);
    }
  });
});
