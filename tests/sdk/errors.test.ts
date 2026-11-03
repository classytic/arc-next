// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ArcApiError } from "../../src/client.js";
import { errorDetails, SdkRequestError } from "../../src/sdk/errors.js";

const refused = (json: unknown, status = 422) =>
  new ArcApiError("refused", { status, statusText: "", json, endpoint: "/alerts", method: "POST" });

describe("errorDetails", () => {
  it("reads arc's `meta` (a thrown error's details object on the wire)", () => {
    const error = refused({
      code: "alerts.form_incomplete",
      message: "x",
      status: 422,
      meta: { missing: ["cause", "eta"] },
    });
    expect(errorDetails(error)).toEqual({ missing: ["cause", "eta"] });
  });

  it("prefers `meta` over an object `details`", () => {
    expect(
      errorDetails(refused({ meta: { field: "destination.platform" }, details: { field: "x" } })),
    ).toEqual({
      field: "destination.platform",
    });
  });

  it("falls back to an object `details` (older or non-arc backends)", () => {
    expect(
      errorDetails(refused({ code: "rate", details: { retryAfterSeconds: 30 } }, 429)),
    ).toEqual({
      retryAfterSeconds: 30,
    });
  });

  it("ignores the validation `details` array (that is `fieldErrors`)", () => {
    const error = refused({
      code: "arc.validation_error",
      details: [{ path: "name", code: "required", message: "m" }],
    });
    expect(errorDetails(error)).toBeUndefined();
  });

  it("skips a non-object `meta` and uses an object `details`", () => {
    expect(errorDetails(refused({ meta: ["a"], details: { rev: 3 } }))).toEqual({ rev: 3 });
    expect(errorDetails(refused({ meta: "x" }))).toBeUndefined();
  });

  it("reads any error-like object carrying a `json` body", () => {
    expect(errorDetails({ json: { meta: { since: "2026-10-31T08:00:00.000Z" } } })).toEqual({
      since: "2026-10-31T08:00:00.000Z",
    });
  });

  it("returns undefined, never throws, for anything else", () => {
    for (const value of [
      undefined,
      null,
      0,
      "x",
      new Error("boom"),
      new SdkRequestError("m", "c", 0),
      refused(null),
      refused("text"),
    ]) {
      expect(errorDetails(value)).toBeUndefined();
    }
    const hostile = Object.defineProperty({}, "json", {
      get() {
        throw new Error("getter");
      },
    });
    expect(() => errorDetails(hostile)).not.toThrow();
    expect(errorDetails(hostile)).toBeUndefined();
  });
});
