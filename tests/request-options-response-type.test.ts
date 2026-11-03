/**
 * `responseType` is read (it was declared on `RequestOptions` and never used: a `text/*` body
 * came back as `{ data: text, response }`, so a caller unwrapped it by hand), and a per-request
 * `idempotencyKey` reaches the `Idempotency-Key` header through `BaseApi` options and
 * `runRouteAction`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseApi } from "../src/api.js";
import { configureClient, handleApiRequest } from "../src/client.js";
import { defineRouteAction, runRouteAction } from "../src/sdk/actions.js";

let fetchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configureClient({ baseUrl: "http://api.test" });
  fetchMock = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchMock.mockRestore();
});

const headersOf = (call = 0) =>
  (fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;

describe("responseType", () => {
  it("'text' answers the body string, whatever the content type", async () => {
    fetchMock.mockResolvedValue(
      new Response("line 1\nline 2", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const text = await handleApiRequest<string>("GET", "/me?format=text", { responseType: "text" });
    expect(text).toBe("line 1\nline 2");
  });

  it("'text' reads a JSON-typed body as text too", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"a":1}', { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    expect(await handleApiRequest("GET", "/x", { responseType: "text" })).toBe('{"a":1}');
  });

  it("'blob' answers the Blob itself (a CSV is not wrapped in { data, response })", async () => {
    fetchMock.mockResolvedValue(
      new Response("a,b\n1,2", { status: 200, headers: { "Content-Type": "text/csv" } }),
    );
    const blob = await handleApiRequest<Blob>("GET", "/export", { responseType: "blob" });
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("a,b\n1,2");
  });

  it("'json' parses a body served with a wrong content type; an empty body is undefined", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    expect(await handleApiRequest("GET", "/x", { responseType: "json" })).toEqual({ ok: true });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await handleApiRequest("POST", "/x", { responseType: "json" })).toBeUndefined();
  });

  it("omitted: the content-type rules of 0.19 hold (text/* stays { data, response })", async () => {
    fetchMock.mockResolvedValue(
      new Response("hi", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const raw = await handleApiRequest<{ data: string; response: Response }>("GET", "/x");
    expect(raw.data).toBe("hi");
    expect(raw.response).toBeInstanceOf(Response);
  });

  it("BaseApi.invokeRoute passes responseType through", async () => {
    fetchMock.mockResolvedValue(
      new Response("copy me", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const api = new BaseApi("event-log");
    const text = await api.invokeRoute<string>({
      path: "/me",
      params: { format: "text" },
      options: { responseType: "text" },
    });
    expect(text).toBe("copy me");
  });
});

describe("per-request idempotencyKey", () => {
  const json = () =>
    new Response('{"_id":"o1"}', { status: 200, headers: { "Content-Type": "application/json" } });

  it("BaseApi.dispatchAction / invokeRoute options carry it as Idempotency-Key", async () => {
    fetchMock.mockImplementation(async () => json());
    const api = new BaseApi("occurrences");
    await api.dispatchAction({ id: "o1", action: "close", options: { idempotencyKey: "k-1" } });
    await api.invokeRoute({
      method: "POST",
      path: "/",
      data: {},
      options: { idempotencyKey: "k-2" },
    });
    expect(headersOf(0)["Idempotency-Key"]).toBe("k-1");
    expect(headersOf(1)["Idempotency-Key"]).toBe("k-2");
  });

  it("runRouteAction forwards per-call options", async () => {
    fetchMock.mockImplementation(async () => json());
    const api = new BaseApi("occurrences");
    const declare = defineRouteAction<{ title: string }, { _id: string }>({
      key: "occ.declare",
      method: "POST",
      path: () => "/",
      body: (input) => input,
      silent: true,
    });
    const out = await runRouteAction(api, declare, { title: "t" }, { idempotencyKey: "k-3" });
    expect(out).toEqual({ _id: "o1" });
    expect(headersOf(0)["Idempotency-Key"]).toBe("k-3");
  });
});
