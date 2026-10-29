// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineCommitAction } from "../../src/sdk/actions.js";
import {
  captureServerErrors,
  clearServerErrors,
  recordServerError,
} from "../../src/sdk/error-capture.js";
import {
  actionMessageKey,
  configureMessages,
  crudMessageKey,
  crudSuccessText,
  listMessageKeys,
  localizeToastHandler,
  type MessageContext,
  registerCrudMessages,
  resolveToastText,
} from "../../src/sdk/messages.js";

afterEach(() => {
  configureMessages(undefined, { keyPrefix: "sdk" });
  clearServerErrors();
});

describe("message keys", () => {
  it("plain text passes through untouched", () => {
    expect(resolveToastText("Saved")).toBe("Saved");
  });

  it("a CRUD key resolves to the English default when the host has no translation", () => {
    const m = registerCrudMessages("t-widgets", "Widget");
    expect(resolveToastText(m.createSuccess)).toBe("Widget created successfully");
    expect(resolveToastText(m.updateSuccess)).toBe("Widget updated successfully");
    expect(resolveToastText(m.deleteError)).toBe("Failed to delete widget");
  });

  it("an error key appends the server detail to the English default", () => {
    const m = registerCrudMessages("t-gadgets", "Gadget");
    expect(resolveToastText(`${m.updateError}: name is taken`)).toBe(
      "Failed to update gadget: name is taken",
    );
  });

  it("the markers never contain readable key text, so real copy cannot collide with a key", () => {
    const m = registerCrudMessages("t-collide", "Thing");
    expect(m.createSuccess.startsWith("⁣")).toBe(true);
    expect(resolveToastText("crud.t-collide.create.success")).toBe("crud.t-collide.create.success");
  });

  it("the host resolver sees the context at display time and owns the whole line", () => {
    const seen: MessageContext[] = [];
    const action = defineCommitAction<void>("publish", {
      key: "t.localised",
      fallback: { success: "Published" },
    });
    configureMessages((context) => {
      seen.push(context);
      return context.outcome === "success" ? "done-ar" : `failed-ar: ${context.detail ?? ""}`;
    });
    expect(resolveToastText(action.messages.success ?? "")).toBe("done-ar");
    expect(resolveToastText(`${action.messages.error}: stale`)).toBe("failed-ar: stale");
    expect(seen[0]).toMatchObject({
      kind: "action",
      key: "sdk.action.t.localised.success",
      action: "t.localised",
      outcome: "success",
      fallback: "Published",
    });
  });

  it("a CRUD context carries resource, operation, singular and the registered permission", () => {
    const m = registerCrudMessages("t-ctx", "Station", { permission: "stations" });
    const seen: MessageContext[] = [];
    configureMessages((context) => {
      seen.push(context);
      return undefined;
    });
    resolveToastText(m.deleteError);
    expect(seen[0]).toMatchObject({
      kind: "crud",
      key: "sdk.crud.t-ctx.delete.error",
      resource: "t-ctx",
      operation: "delete",
      outcome: "error",
      singular: "Station",
      permission: "stations",
    });
  });

  it("a resolver that returns undefined keeps the English default", () => {
    const action = defineCommitAction<void>("publish", {
      key: "t.fallback",
      fallback: { success: "Published" },
    });
    configureMessages(() => undefined);
    expect(resolveToastText(action.messages.success ?? "")).toBe("Published");
  });

  it("an action always has an error key; success only when a fallback was given", () => {
    const quiet = defineCommitAction<void>("ping", { key: "t.quiet" });
    expect(quiet.messages.success).toBeUndefined();
    expect(resolveToastText(quiet.messages.error ?? "")).toBe(
      "Something went wrong. Please try again.",
    );
    expect(defineCommitAction<void>("ping", { key: "t.silent", silent: true }).messages).toEqual(
      {},
    );
  });
});

describe("key prefix", () => {
  it("is applied when a key is resolved or listed, not when it is registered", () => {
    const m = registerCrudMessages("t-prefix", "Pad");
    configureMessages(undefined, { keyPrefix: "app" });
    const seen: string[] = [];
    configureMessages(
      (context) => {
        seen.push(context.key);
        return undefined;
      },
      { keyPrefix: "app" },
    );
    resolveToastText(m.createError);
    expect(seen).toEqual(["app.crud.t-prefix.create.error"]);
    expect(crudMessageKey("t-prefix", "create", "error")).toBe("app.crud.t-prefix.create.error");
    expect(actionMessageKey("a.b", "success")).toBe("app.action.a.b.success");
    expect(listMessageKeys().some((k) => k.key === "app.crud.t-prefix.create.error")).toBe(true);
  });

  it("configureMessages without options keeps the current prefix", () => {
    configureMessages(undefined, { keyPrefix: "keep" });
    configureMessages(undefined);
    expect(crudMessageKey("x", "update", "success")).toBe("keep.crud.x.update.success");
  });
});

describe("listMessageKeys", () => {
  it("lists every registered key with non-empty English fallback copy", () => {
    registerCrudMessages("t-list", "Entry");
    defineCommitAction<void>("go", { key: "t.list.go", fallback: { success: "Went" } });
    const keys = listMessageKeys();
    const byKey = new Map(keys.map((k) => [k.key, k.fallback]));
    expect(byKey.get("sdk.crud.t-list.create.success")).toBe("Entry created successfully");
    expect(byKey.get("sdk.action.t.list.go.success")).toBe("Went");
    for (const { key, fallback } of keys) {
      expect(key.startsWith("sdk.")).toBe(true);
      expect(fallback.length).toBeGreaterThan(2);
    }
  });
});

describe("error code and details in the message context", () => {
  it("an error toast carries the code and details of the refused response", async () => {
    const m = registerCrudMessages("t-err", "Role");
    const fake = captureServerErrors((async () =>
      Response.json(
        {
          code: "role.in_use",
          message: "Role is in use",
          details: [{ path: "roles.0", code: "x", message: "in use" }, "junk", { path: 5 }],
        },
        { status: 409 },
      )) as unknown as typeof fetch);
    const response = await fake("http://api.test/roles/1", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "role.in_use" });

    const seen: MessageContext[] = [];
    configureMessages((context) => {
      seen.push(context);
      return `localized:${context.code}`;
    });
    expect(resolveToastText(`${m.deleteError}: Role is in use`)).toBe("localized:role.in_use");
    expect(seen[0]).toMatchObject({
      outcome: "error",
      detail: "Role is in use",
      code: "role.in_use",
      details: [{ path: "roles.0", code: "x", message: "in use" }, {}],
    });
  });

  it("success messages never receive a stale server error", () => {
    const m = registerCrudMessages("t-ok", "Thing");
    recordServerError({ status: 409, code: "x.y" });
    const seen: MessageContext[] = [];
    configureMessages((context) => {
      seen.push(context);
      return undefined;
    });
    resolveToastText(m.createSuccess);
    expect(seen[0]?.code).toBeUndefined();
  });

  it("an exact server message wins over the newest capture; stale captures are ignored", () => {
    const m = registerCrudMessages("t-match", "Thing");
    const now = Date.now();
    recordServerError({ status: 409, code: "old.one", message: "taken" }, now - 2_000);
    recordServerError({ status: 500, code: "newest" }, now - 100);
    const codes: Array<string | undefined> = [];
    configureMessages((context) => {
      codes.push(context.code);
      return undefined;
    });
    resolveToastText(`${m.createError}: taken`);
    resolveToastText(m.createError);
    expect(codes).toEqual(["old.one", "newest"]);

    clearServerErrors();
    recordServerError({ status: 500, code: "ancient" }, now - 60_000);
    resolveToastText(m.createError);
    expect(codes[2]).toBeUndefined();
  });

  it("non-JSON error bodies record nothing and the response is untouched", async () => {
    const wrapped = captureServerErrors(
      (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch,
    );
    const response = await wrapped("http://api.test/x");
    expect(await response.text()).toBe("<html>");
    const m = registerCrudMessages("t-html", "Thing");
    const seen: MessageContext[] = [];
    configureMessages((context) => {
      seen.push(context);
      return undefined;
    });
    resolveToastText(m.createError);
    expect(seen[0]?.code).toBeUndefined();
  });
});

describe("toast handler and success text", () => {
  it("localizeToastHandler resolves keys before the host's toast sees them", () => {
    const action = defineCommitAction<void>("publish", {
      key: "t.handler",
      fallback: { success: "Published" },
    });
    const handler = { success: vi.fn(), error: vi.fn() };
    const wrapped = localizeToastHandler(handler);
    wrapped.success(action.messages.success ?? "");
    wrapped.error("plain server text");
    expect(handler.success).toHaveBeenCalledWith("Published");
    expect(handler.error).toHaveBeenCalledWith("plain server text");
  });

  it("crudSuccessText localizes a registered resource and is undefined for an unknown one", () => {
    registerCrudMessages("t-success", "Plan");
    expect(crudSuccessText("t-success", "create")).toBe("Plan created successfully");
    configureMessages(() => "translated");
    expect(crudSuccessText("t-success", "delete")).toBe("translated");
    expect(crudSuccessText("t-never-registered", "create")).toBeUndefined();
  });
});
