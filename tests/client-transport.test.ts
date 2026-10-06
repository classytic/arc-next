import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseApi } from "../src/api.js";
import { ArcApiError, configureClient, createAuthAwareClient, createClient, handleApiRequest } from "../src/client.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ClientConfig.fetch — the transport slot", () => {
  afterEach(() => vi.restoreAllMocks());

  it("routes the global client through the supplied transport, never the runtime fetch", async () => {
    const global = vi.spyOn(globalThis, "fetch");
    const transport = vi.fn(async () => json(200, { success: true, data: { id: "p1" } }));
    configureClient({ baseUrl: "local:", fetch: transport });

    const res = await handleApiRequest<{ data: { id: string } }>("GET", "/api/v1/products/p1");

    expect(res.data.id).toBe("p1");
    expect(transport).toHaveBeenCalledWith("local:/api/v1/products/p1", expect.objectContaining({ method: "GET" }));
    expect(global).not.toHaveBeenCalled();
  });

  it("an error answered by the transport reaches the caller as the same ArcApiError a server's would", async () => {
    const transport = vi.fn(async () =>
      json(501, { success: false, error: { code: "offline.unsupported", message: "Not available offline" } }),
    );
    const client = createClient({ baseUrl: "local:", fetch: transport });

    const err = await client.request("GET", "/api/v1/reports/x").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ArcApiError);
    expect((err as ArcApiError).status).toBe(501);
  });
});

describe("createAuthAwareClient — the client SDKs use", () => {
  it("carries every request-time field of the global config: the transport, the cache mode", async () => {
    const global = vi.spyOn(globalThis, "fetch");
    const transport = vi.fn(async () => json(200, { id: "p1" }));
    configureClient({ baseUrl: "local:", fetch: transport, cache: "no-store" });

    const res = await createAuthAwareClient().request<{ id: string }>("GET", "/api/v1/products/p1");

    expect(res.id).toBe("p1");
    expect(transport).toHaveBeenCalledWith("local:/api/v1/products/p1", expect.objectContaining({ cache: "no-store" }));
    expect(global).not.toHaveBeenCalled();
  });

  it("an explicit override still wins over the global config", async () => {
    const globalTransport = vi.fn(async () => json(200, {}));
    const own = vi.fn(async () => json(200, { id: "own" }));
    configureClient({ baseUrl: "local:", fetch: globalTransport });

    await createAuthAwareClient({ fetch: own }).request("GET", "/api/v1/x");

    expect(own).toHaveBeenCalledOnce();
    expect(globalTransport).not.toHaveBeenCalled();
  });
});

describe("BaseApi.request — per-request options reach the transport", () => {
  it("a per-request timeoutMs ends a request the transport never answers", async () => {
    const hang = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const api = new BaseApi("orders", { basePath: "/api/v1", client: createClient({ baseUrl: "local:", fetch: hang }) });

    const err = await api.request("POST", "/api/v1/orders", { data: {}, options: { timeoutMs: 20 } }).catch((e: unknown) => e);

    expect((err as Error).name).toBe("TimeoutError");
  });
});
