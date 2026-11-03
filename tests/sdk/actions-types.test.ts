// @vitest-environment node
/**
 * Type contracts of the action runners: the payload and the result come from the DESCRIPTOR, not
 * from the call arguments. Compiled in the `typecheck:tests` lane (tsconfig.test.json); the runtime
 * assertions here are a smoke check only.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ActionDescriptor,
  defineCommitAction,
  type RouteApi,
  runAction,
} from "../../src/sdk/actions.js";
import { type ActionHooksLike, useResourceAction } from "../../src/sdk/hooks.js";

interface Doc {
  _id: string;
  status: string;
}

const api: RouteApi = {
  invokeRoute: async () => ({}) as never,
  dispatchAction: async (args) => ({ _id: args.id, status: args.action }) as never,
};

const acknowledge = defineCommitAction<{ deviceId?: string }, Doc, "acknowledge">("acknowledge", {
  key: "types.doc.acknowledge",
  silent: true,
});
const archive = defineCommitAction<void, Doc>("archive", {
  key: "types.doc.archive",
  silent: true,
});
const cancel = defineCommitAction<{ reason: string }, Doc>("cancel", {
  key: "types.doc.cancel",
  silent: true,
});

describe("runAction infers the payload and the result from the descriptor", () => {
  it("resolves to the descriptor's result", async () => {
    const result = runAction(api, acknowledge, "d1", {});
    expectTypeOf(result).resolves.toEqualTypeOf<Doc>();
    expect(await result).toEqual({ _id: "d1", status: "acknowledge" });
  });

  it("accepts a payload that only fits the descriptor's optional fields", async () => {
    const ack = (deviceId?: string) =>
      // `{ deviceId: string } | {}`: inferred from the argument it does not fit either rest tuple.
      runAction(api, acknowledge, "d1", deviceId ? { deviceId } : {});
    expectTypeOf(ack).returns.resolves.toEqualTypeOf<Doc>();
    expect(await ack("tab-1")).toEqual({ _id: "d1", status: "acknowledge" });
  });

  it("no-payload verbs take no payload, payload verbs require theirs", async () => {
    expectTypeOf(runAction(api, archive, "d1")).resolves.toEqualTypeOf<Doc>();
    // @ts-expect-error a no-payload verb takes no payload
    void runAction(api, archive, "d1", { extra: 1 });
    // @ts-expect-error the descriptor requires `reason`
    void runAction(api, cancel, "d1", {});
    // @ts-expect-error `reason` is a string
    void runAction(api, cancel, "d1", { reason: 1 });
    expectTypeOf(
      runAction(api, cancel, "d1", { reason: "duplicate" }),
    ).resolves.toEqualTypeOf<Doc>();
  });

  it("explicit type arguments and verb-only objects still compile (0.19 callers)", async () => {
    expectTypeOf(
      runAction<{ deviceId?: string }, Doc>(api, acknowledge, "d1", {}),
    ).resolves.toEqualTypeOf<Doc>();
    const loose: Pick<ActionDescriptor<{ n: number }, Doc>, "verb"> = { verb: "close" };
    expectTypeOf(runAction(api, loose, "d1", { n: 1 })).resolves.toEqualTypeOf<Doc>();
    await runAction(api, { verb: "close" }, "d1", { n: 1 });
  });

  it("explicit type arguments that differ from a typed descriptor still compile (0.19 callers)", async () => {
    // 0.19 descriptors were often defined untyped and the call site named the types.
    const untyped = defineCommitAction("close", { key: "types.doc.close", silent: true });
    const closed = runAction<{ a: string }, Doc>(api, untyped, "d1", { a: "x" });
    expectTypeOf(closed).resolves.toEqualTypeOf<Doc>();
    expect(await closed).toEqual({ _id: "d1", status: "close" });
    expectTypeOf(runAction<void, Doc>(api, cancel, "d1")).resolves.toEqualTypeOf<Doc>();
    // @ts-expect-error the explicit payload type still checks the argument
    void runAction<{ a: string }, Doc>(api, untyped, "d1", { a: 1 });
    // @ts-expect-error a payload verb requires its payload, explicit or not
    void runAction<{ a: string }, Doc>(api, untyped, "d1");
  });
});

describe("runAction per-call request options", () => {
  it("take RunRequestOptions after the payload; a no-payload verb passes undefined first", () => {
    expectTypeOf(
      runAction(api, cancel, "d1", { reason: "r" }, { idempotencyKey: "k" }),
    ).resolves.toEqualTypeOf<Doc>();
    expectTypeOf(
      runAction(api, archive, "d1", undefined, { idempotencyKey: "k" }),
    ).resolves.toEqualTypeOf<Doc>();
    expectTypeOf(
      runAction<{ a: string }, Doc>(api, archive, "d1", { a: "x" }, { idempotencyKey: "k" }),
    ).resolves.toEqualTypeOf<Doc>();
    // @ts-expect-error options are RunRequestOptions
    void runAction(api, cancel, "d1", { reason: "r" }, { idempotencyKey: 1 });
    // @ts-expect-error a no-payload verb still takes no payload before its options
    void runAction(api, archive, "d1", { extra: 1 }, { idempotencyKey: "k" });
  });
});

describe("useResourceAction infers the payload and the result from the descriptor", () => {
  it("types mutateAsync from the descriptor", () => {
    // Type-level only: the hook is never called here.
    const inferred = (hooks: ActionHooksLike) => useResourceAction(hooks, cancel);
    type Bound = ReturnType<typeof inferred>;
    expectTypeOf<Bound["mutateAsync"]>().returns.resolves.toEqualTypeOf<Doc>();
    expectTypeOf<Parameters<Bound["mutateAsync"]>[0]>().toEqualTypeOf<
      { id: string } & { reason: string }
    >();
  });

  it("explicit type arguments that differ from a typed descriptor still compile (0.19 callers)", () => {
    const untypedIn = defineCommitAction("close", { key: "types.doc.close", silent: true });
    const explicit = (hooks: ActionHooksLike) =>
      useResourceAction<{ a: string }, Doc>(hooks, untypedIn);
    type Bound = ReturnType<typeof explicit>;
    expectTypeOf<Bound["mutateAsync"]>().returns.resolves.toEqualTypeOf<Doc>();
    expectTypeOf<Parameters<Bound["mutateAsync"]>[0]>().toEqualTypeOf<
      { id: string } & { a: string }
    >();
  });
});
