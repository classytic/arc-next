import { describe, expect, expectTypeOf, it } from "vitest";
import { BaseApi } from "../../src/client/api.js";
import { createClient } from "../../src/client/client.js";
import {
  type ActionDescriptor,
  createCommitActionDefiner,
  defineAction,
  defineCommitAction,
  defineRouteAction,
  type RouteApi,
  runAction,
  runRouteAction,
} from "../../src/sdk/actions.js";
import { type ActionHooksLike, useResourceAction } from "../../src/sdk/hooks.js";
import { getRoute } from "../../src/sdk/route.js";

describe("actions", () => {
  function recorder() {
    const calls: unknown[] = [];
    const api: RouteApi = {
      invokeRoute: async (args) => {
        calls.push({ route: args });
        return { data: { id: "x" } } as never;
      },
      dispatchAction: async (args) => {
        calls.push({ action: args });
        return { ok: true } as never;
      },
    };
    return { api, calls };
  }

  describe("defineCommitAction / defineAction", () => {
    it("carries message KEYS, never English, in the descriptor", () => {
      const action = defineCommitAction<void>("publish", {
        key: "a.publish",
        fallback: { success: "Published" },
      });
      expect(action).toMatchObject({ verb: "publish", kind: "commit", key: "a.publish" });
      expect(action.messages.success).toContain("action.a.publish.success");
      expect(action.messages.error).toContain("action.a.publish.error");
      expect(action.messages.success).not.toContain("Published");
    });

    it("silent: no keys at all", () => {
      expect(defineCommitAction<void>("ping", { key: "a.ping", silent: true }).messages).toEqual(
        {},
      );
    });

    it("the host can add its own kinds and reserve verbs for another constructor", () => {
      const chain = defineAction("decide", "approval", { key: "a.decide" });
      expect(chain.kind).toBe("approval");
      const strict = createCommitActionDefiner({
        reservedVerbs: ["decide", "submit"],
        reservedBy: "defineApprovalActions()",
      });
      expect(() => strict("decide", { key: "a.x" })).toThrow(/defineApprovalActions/);
      expect(strict("archive", { key: "a.archive" }).kind).toBe("commit");
    });
  });

  describe("runAction", () => {
    it("dispatches the verb and the payload", async () => {
      const { api, calls } = recorder();
      const publish = defineCommitAction<{ expectedVersion: number }>("publish", {
        key: "a.publish2",
      });
      await runAction(api, publish, "a1", { expectedVersion: 3 });
      expect(calls).toEqual([
        { action: { id: "a1", action: "publish", data: { expectedVersion: 3 } } },
      ]);
    });

    it("sends no data for a no-payload verb", async () => {
      const { api, calls } = recorder();
      await runAction(api, defineCommitAction<void>("archive", { key: "a.archive2" }), "a1");
      expect(calls).toEqual([{ action: { id: "a1", action: "archive" } }]);
    });

    it("forwards per-call request options (idempotencyKey) after the payload, never in the body", async () => {
      const { api, calls } = recorder();
      const publish = defineCommitAction<{ expectedVersion: number }>("publish", {
        key: "a.publish3",
      });
      await runAction(api, publish, "a1", { expectedVersion: 3 }, { idempotencyKey: "k-1" });
      const archive = defineCommitAction<void>("archive", { key: "a.archive3" });
      await runAction(api, archive, "a2", undefined, { idempotencyKey: "k-2" });
      expect(calls).toEqual([
        {
          action: {
            id: "a1",
            action: "publish",
            data: { expectedVersion: 3 },
            options: { idempotencyKey: "k-1" },
          },
        },
        { action: { id: "a2", action: "archive", options: { idempotencyKey: "k-2" } } },
      ]);
    });

    it("sends Idempotency-Key through a real BaseApi", async () => {
      const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
      const client = createClient({
        baseUrl: "http://api.test",
        fetch: (async (url: string, init: RequestInit) => {
          seen.push({
            url: String(url),
            headers: new Headers(init.headers),
            body: JSON.parse(String(init.body)),
          });
          return new Response(JSON.stringify({ _id: "a1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      });
      const api = new BaseApi("docs", { client });
      const close = defineCommitAction<{ note: string }, { _id: string }>("close", {
        key: "a.close3",
      });
      await expect(
        runAction(api, close, "a1", { note: "n" }, { idempotencyKey: "press-1" }),
      ).resolves.toEqual({ _id: "a1" });
      expect(seen[0]?.headers.get("idempotency-key")).toBe("press-1");
      expect(seen[0]?.body).toEqual({ action: "close", note: "n" });
    });
  });

  describe("runRouteAction: method, path, body, params", () => {
    it("builds method, path and body from the input and unwraps the envelope", async () => {
      const { api, calls } = recorder();
      const action = defineRouteAction<
        { id: string; reason: string },
        { id: string },
        { data: { id: string } }
      >({
        key: "a.route",
        method: "POST",
        path: ({ id }) => `/${id}/revoke`,
        body: ({ reason }) => ({ reason }),
        select: (raw) => raw.data,
      });
      expect(action.kind).toBe("route");
      expect(await runRouteAction(api, action, { id: "c1", reason: "lost" })).toEqual({ id: "x" });
      expect(calls).toEqual([
        { route: { method: "POST", path: "/c1/revoke", data: { reason: "lost" } } },
      ]);
    });

    it("omits the body when the descriptor has none, and carries query params when it has", async () => {
      const { api, calls } = recorder();
      const mint = defineRouteAction<void, unknown>({
        key: "a.get",
        method: "GET",
        path: () => "/mint",
      });
      await runRouteAction(api, mint, undefined);
      const list = defineRouteAction<{ q: string }, unknown>({
        key: "a.search",
        method: "GET",
        path: () => "/search",
        params: ({ q }) => ({ q }),
      });
      await runRouteAction(api, list, { q: "ada" });
      expect(calls).toEqual([
        { route: { method: "GET", path: "/mint" } },
        { route: { method: "GET", path: "/search", params: { q: "ada" } } },
      ]);
    });

    it("every verb reaches the wire as that HTTP method on that URL (real BaseApi, fake fetch)", async () => {
      const seen: Array<{ url: string; method: string; body: unknown }> = [];
      const client = createClient({
        baseUrl: "http://api.test",
        basePath: "/api",
        getToken: () => "tok",
        fetch: (async (url: string, init: RequestInit) => {
          seen.push({
            url,
            method: String(init.method),
            body: init.body ? JSON.parse(String(init.body)) : undefined,
          });
          return Response.json({ ok: true });
        }) as unknown as typeof fetch,
      });
      const api = new BaseApi("things", { client, basePath: "/api" });
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
        const action = defineRouteAction<{ id: string }, unknown>({
          key: `a.wire.${method}`,
          method,
          path: ({ id }) => `/${id}/go`,
          ...(method === "GET" || method === "DELETE" ? {} : { body: () => ({ n: 1 }) }),
          params: () => ({ page: 2 }),
        });
        await runRouteAction(api, action, { id: "z9" });
      }
      await runAction(api, defineCommitAction<{ n: number }>("close", { key: "a.close" }), "z9", {
        n: 1,
      });
      await getRoute(api, "/stats", { from: "2026-01-01" });

      expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
        "GET http://api.test/api/things/z9/go?page=2",
        "POST http://api.test/api/things/z9/go?page=2",
        "PUT http://api.test/api/things/z9/go?page=2",
        "PATCH http://api.test/api/things/z9/go?page=2",
        "DELETE http://api.test/api/things/z9/go?page=2",
        "POST http://api.test/api/things/z9/action",
        "GET http://api.test/api/things/stats?from=2026-01-01",
      ]);
      expect(seen[1]?.body).toEqual({ n: 1 });
      expect(seen[5]?.body).toEqual({ action: "close", n: 1 });
    });
  });
});

describe("descriptor type inference", () => {
  /**
   * Type contracts of the action runners: the payload and the result come from the DESCRIPTOR, not
   * from the call arguments. Compiled in the `typecheck:tests` lane (tsconfig.test.json); the runtime
   * assertions here are a smoke check only.
   */
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
});
