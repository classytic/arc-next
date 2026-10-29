import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBasePath, getBaseUrl } from "../../src/client.js";
import { type CrudApi, createCrudHooks } from "../../src/hooks.js";
import { configureToast } from "../../src/mutation.js";
import { defineCommitAction, defineRouteAction, type RouteApi } from "../../src/sdk/actions.js";
import { clearServerErrors } from "../../src/sdk/error-capture.js";
import {
  useQuietRouteAction,
  useResourceAction,
  useRouteAction,
  useRouteList,
  useRouteQuery,
} from "../../src/sdk/hooks.js";
import { initSDK } from "../../src/sdk/init.js";
import {
  configureMessages,
  localizeToastHandler,
  type MessageContext,
} from "../../src/sdk/messages.js";
import { defineSdkResource } from "../../src/sdk/resource.js";
import { requireGlobalTransport } from "../../src/sdk/transport.js";

type Item = { _id: string; name: string };

let token: string | null = "tok";

function boot(fetchImpl?: typeof fetch) {
  const toast = { success: vi.fn(), error: vi.fn() };
  initSDK({
    baseUrl: "http://api.test",
    basePath: "/api",
    getToken: () => token,
    toast,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return toast;
}

function setup(apiOverrides: Partial<CrudApi<Item, { name: string }, { name: string }>> = {}) {
  const api = {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    dispatchAction: vi.fn().mockResolvedValue({ _id: "1", name: "done" }),
    ...apiOverrides,
  } as CrudApi<Item, { name: string }, { name: string }>;
  const hooks = createCrudHooks<Item, { name: string }, { name: string }>({
    api,
    entityKey: "items",
    singular: "Item",
  });
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { api, hooks, queryClient, wrapper };
}

beforeEach(() => {
  token = "tok";
});

afterEach(() => {
  configureMessages(undefined, { keyPrefix: "sdk" });
  clearServerErrors();
});

describe("initSDK", () => {
  it("configures the transport, the toast with message-key resolution and the global transport", async () => {
    const toast = boot();
    expect(getBaseUrl()).toBe("http://api.test");
    expect(getBasePath()).toBe("/api");
    expect(requireGlobalTransport().baseUrl).toBe("http://api.test");

    configureMessages((context) => `loc:${context.key}`, { keyPrefix: "app" });
    const resource = defineSdkResource({
      path: "init-things",
      singular: "Thing",
      plural: "Things",
      permission: null,
    });
    const messages = resource.hooksConfig.defaults?.messages as Record<string, string>;
    // The handler installed by initSDK resolves keys at display time.
    const { getToastHandler } = await import("../../src/mutation.js");
    getToastHandler().success(messages.createSuccess ?? "");
    expect(toast.success).toHaveBeenCalledWith("loc:app.crud.init-things.create.success");
  });

  it("a refused response's code and details reach the message context", async () => {
    const refusal = (async () =>
      Response.json(
        {
          code: "thing.exists",
          message: "Already there",
          details: [{ path: "name", message: "taken" }],
        },
        { status: 409 },
      )) as unknown as typeof fetch;
    const toast = boot(refusal);
    const seen: MessageContext[] = [];
    configureMessages((context) => {
      seen.push(context);
      return `code=${context.code}`;
    });
    const resource = defineSdkResource({
      path: "init-things2",
      singular: "Thing",
      plural: "Things",
      permission: null,
    });
    const { result, queryClient } = (() => {
      const hooks = createCrudHooks({ ...resource.hooksConfig });
      const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: qc }, children);
      return { result: renderHook(() => hooks.useActions(), { wrapper }).result, queryClient: qc };
    })();
    await act(async () => {
      await result.current.create({ data: { name: "x" } } as never).catch(() => undefined);
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0]?.[0]).toBe("code=thing.exists");
    expect(seen[0]).toMatchObject({
      kind: "crud",
      operation: "create",
      code: "thing.exists",
      details: [{ path: "name", message: "taken" }],
    });
    queryClient.clear();
  });

  it("captureErrors: false leaves the context without a server code", async () => {
    const refusal = (async () =>
      Response.json(
        { code: "thing.exists", message: "Already there" },
        { status: 409 },
      )) as unknown as typeof fetch;
    const toast = { success: vi.fn(), error: vi.fn() };
    initSDK({
      baseUrl: "http://api.test",
      getToken: () => token,
      toast,
      fetch: refusal,
      captureErrors: false,
    });
    const codes: Array<string | undefined> = [];
    configureMessages((context) => {
      codes.push(context.code);
      return undefined;
    });
    const resource = defineSdkResource({
      path: "init-things3",
      singular: "Thing",
      plural: "Things",
      permission: null,
    });
    const hooks = createCrudHooks({ ...resource.hooksConfig });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => hooks.useActions(), { wrapper });
    await act(async () => {
      await result.current.create({ data: { name: "x" } } as never).catch(() => undefined);
    });
    expect(codes).toEqual([undefined]);
    expect(toast.error.mock.calls[0]?.[0]).toContain("Failed to create thing");
  });
});

describe("useResourceAction", () => {
  it("dispatches the verb with flat vars split into id and data, and shows the key-resolved toast", async () => {
    const toast = boot();
    const { api, hooks, wrapper } = setup();
    const publish = defineCommitAction<{ version: number }, Item>("publish", {
      key: "hooks.publish",
      fallback: { success: "Published!" },
    });
    const { result } = renderHook(() => useResourceAction(hooks, publish), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "1", version: 4 });
    });
    expect(api.dispatchAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "1", action: "publish", data: { version: 4 } }),
    );
    expect(toast.success).toHaveBeenCalledWith("Published!");
  });

  it("no-payload verbs send no data", async () => {
    boot();
    const { api, hooks, wrapper } = setup();
    const archive = defineCommitAction<void, Item>("archive", {
      key: "hooks.archive",
      silent: true,
    });
    const { result } = renderHook(() => useResourceAction(hooks, archive), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "9" });
    });
    const call = (api.dispatchAction as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call).toMatchObject({ id: "9", action: "archive" });
    expect(call.data).toBeUndefined();
  });
});

describe("useRouteAction / useQuietRouteAction", () => {
  const routeApi = (impl: RouteApi["invokeRoute"]): RouteApi => ({
    invokeRoute: impl,
    dispatchAction: vi.fn() as never,
  });

  it("runs the route verb, invalidates the resource root by default, toasts the success key", async () => {
    const toast = boot();
    const { hooks, queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const invoke = vi.fn(async () => ({ ok: true }));
    const sweep = defineRouteAction<{ id: string }, { ok: boolean }>({
      key: "hooks.sweep",
      method: "POST",
      path: ({ id }) => `/${id}/sweep`,
      body: () => ({ force: true }),
      fallback: { success: "Swept" },
    });
    const { result } = renderHook(() => useRouteAction(hooks, routeApi(invoke as never), sweep), {
      wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ id: "s1" });
    });
    expect(invoke).toHaveBeenCalledWith({
      method: "POST",
      path: "/s1/sweep",
      data: { force: true },
    });
    expect(toast.success).toHaveBeenCalledWith("Swept");
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: hooks.KEYS.all }));
  });

  it("the quiet variant never toasts, success or error, and invalidates only what it is told", async () => {
    const toast = boot();
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const ping = defineRouteAction<void, unknown>({
      key: "hooks.ping",
      method: "POST",
      path: () => "/ping",
    });
    const ok = renderHook(
      () =>
        useQuietRouteAction(
          routeApi(async () => ({})),
          ping,
        ),
      { wrapper },
    );
    await act(async () => {
      await ok.result.current.mutateAsync();
    });
    expect(invalidate).not.toHaveBeenCalled();
    const bad = renderHook(
      () =>
        useQuietRouteAction(
          routeApi(async () => {
            throw new Error("boom");
          }),
          ping,
          { invalidate: [["x"]] },
        ),
      { wrapper },
    );
    await act(async () => {
      await bad.result.current.mutateAsync().catch(() => undefined);
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("useRouteQuery / useRouteList", () => {
  it("keys under the resource root and runs when signed in", async () => {
    boot();
    const { hooks, queryClient, wrapper } = setup();
    const { result } = renderHook(() => useRouteQuery(hooks, ["summary", "a1"], async () => 42), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toBe(42));
    expect(queryClient.getQueryData(hooks.KEYS.custom("summary", "a1"))).toBe(42);
    expect(hooks.KEYS.custom("summary", "a1")[0]).toBe(hooks.KEYS.all[0]);
  });

  it("enabled: false holds the request; user: true waits for a token; public ignores the token", async () => {
    boot();
    token = null;
    const { hooks, wrapper } = setup();
    const fn = vi.fn(async () => 1);
    const held = renderHook(
      () => useRouteQuery(hooks, ["a"], fn, { enabled: false, public: true }),
      {
        wrapper,
      },
    );
    const signedOut = renderHook(() => useRouteQuery(hooks, ["b"], fn, { user: true }), {
      wrapper,
    });
    expect(held.result.current.fetchStatus).toBe("idle");
    expect(signedOut.result.current.fetchStatus).toBe("idle");
    expect(fn).not.toHaveBeenCalled();
    const open = renderHook(() => useRouteQuery(hooks, ["c"], fn, { public: true }), { wrapper });
    await waitFor(() => expect(open.result.current.data).toBe(1));
  });

  it("useRouteList: one list key, enabled and placeholderData from the caller, previous rows kept while paging", async () => {
    boot();
    const { hooks, queryClient, wrapper } = setup();
    const load = vi.fn(async (query: { page: number }) => ({ rows: [query.page] }));
    const { result, rerender } = renderHook(
      ({ page, enabled }) =>
        useRouteList(
          hooks,
          { page },
          load,
          { retry: false },
          {
            enabled,
            placeholderData: (previous) => previous,
          },
        ),
      { wrapper, initialProps: { page: 1, enabled: true } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ rows: [1] }));
    expect(queryClient.getQueryData(hooks.KEYS.custom("list", { page: 1 }))).toEqual({ rows: [1] });

    rerender({ page: 2, enabled: true });
    expect(result.current.data).toEqual({ rows: [1] });
    expect(result.current.isPlaceholderData).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ rows: [2] }));

    rerender({ page: 3, enabled: false });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refetchInterval as a function receives the query state", async () => {
    boot();
    const { hooks, wrapper } = setup();
    const seen: unknown[] = [];
    const { result } = renderHook(
      () =>
        useRouteQuery(hooks, ["poll"], async () => 7, {
          refetchInterval: (query) => {
            seen.push(query.state.data);
            return false;
          },
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toBe(7));
    expect(seen).toContain(7);
  });
});

describe("toastCrudSuccess", () => {
  it("toasts the resource's localized success line and is a no-op for a routes-only resource", async () => {
    const toast = { success: vi.fn(), error: vi.fn() };
    configureToast(localizeToastHandler(toast));
    const { toastCrudSuccess } = await import("../../src/sdk/hooks.js");
    const crud = defineSdkResource({
      path: "ts-things",
      singular: "Gizmo",
      plural: "Gizmos",
      permission: null,
    });
    toastCrudSuccess(crud, "update");
    expect(toast.success).toHaveBeenCalledWith("Gizmo updated successfully");
    const routes = defineSdkResource({
      path: "ts-routes",
      singular: "R",
      plural: "Rs",
      permission: null,
      routesOnly: true,
    });
    toastCrudSuccess(routes, "update");
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
