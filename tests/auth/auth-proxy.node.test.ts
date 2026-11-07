import { describe, expect, it } from "vitest";
import { createAuthProxy, resolveUpstream } from "../../src/auth/auth-proxy.js";

interface Call {
  url: string;
  init: RequestInit & { headers: Headers };
}

function proxyWith(respond: (call: Call) => Response | Promise<Response>, options = {}) {
  const calls: Call[] = [];
  const fetchStub = (async (url: string, init: Call["init"]) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  const handlers = createAuthProxy({
    upstream: "https://api.example.test/",
    fetch: fetchStub,
    ...options,
  });
  return { handlers, calls };
}

describe("createAuthProxy: request", () => {
  it("forwards method, path, query and body to the upstream origin", async () => {
    const { handlers, calls } = proxyWith(() => new Response("ok"));
    await handlers.POST(
      new Request("https://portal.example.test/api/auth/sign-in/email?next=%2Fhome", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.test" }),
      }),
    );
    expect(calls[0]?.url).toBe("https://api.example.test/api/auth/sign-in/email?next=%2Fhome");
    expect(calls[0]?.init.method).toBe("POST");
    expect(new TextDecoder().decode(calls[0]?.init.body as ArrayBuffer)).toBe(
      '{"email":"a@b.test"}',
    );
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.cache).toBe("no-store");
  });

  it("GET and HEAD carry no body", async () => {
    const { handlers, calls } = proxyWith(() => new Response("ok"));
    await handlers.GET(new Request("https://portal.example.test/api/auth/get-session"));
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("passes origin and x-forwarded-for through, drops hop-by-hop headers", async () => {
    const { handlers, calls } = proxyWith(() => new Response("ok"));
    await handlers.POST(
      new Request("https://portal.example.test/api/auth/x", {
        method: "POST",
        body: "{}",
        headers: {
          origin: "https://portal.example.test",
          "x-forwarded-for": "203.0.113.9",
          cookie: "a=b",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          te: "trailers",
          "x-internal": "secret",
        },
      }),
    );
    const sent = calls[0]?.init.headers;
    expect(sent?.get("origin")).toBe("https://portal.example.test");
    expect(sent?.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(sent?.get("cookie")).toBe("a=b");
    expect(sent?.has("connection")).toBe(false);
    expect(sent?.has("keep-alive")).toBe(false);
    expect(sent?.has("te")).toBe(false);
    expect(sent?.has("host")).toBe(false);
    expect(sent?.has("content-length")).toBe(false);
    expect(sent?.get("x-internal")).toBe("secret");
  });

  it("stripRequestHeaders removes host-chosen headers too", async () => {
    const { handlers, calls } = proxyWith(() => new Response("ok"), {
      stripRequestHeaders: ["x-internal"],
    });
    await handlers.GET(
      new Request("https://portal.example.test/api/auth/x", { headers: { "x-internal": "1" } }),
    );
    expect(calls[0]?.init.headers.has("x-internal")).toBe(false);
  });
});

describe("createAuthProxy: response", () => {
  it("preserves every set-cookie as its own header", async () => {
    const { handlers } = proxyWith(() => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append(
        "set-cookie",
        "two_factor=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      );
      headers.append("set-cookie", "csrf=def; Path=/; SameSite=Lax");
      return new Response("{}", { status: 200, headers });
    });
    const response = await handlers.POST(
      new Request("https://portal.example.test/api/auth/x", { method: "POST", body: "{}" }),
    );
    expect(response.headers.getSetCookie()).toEqual([
      "two_factor=abc; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
      "csrf=def; Path=/; SameSite=Lax",
    ]);
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("drops headers describing an encoding fetch already undid", async () => {
    const { handlers } = proxyWith(
      () =>
        new Response("body", {
          headers: {
            "content-encoding": "gzip",
            "content-length": "999",
            "transfer-encoding": "chunked",
            "x-keep": "1",
          },
        }),
    );
    const response = await handlers.GET(new Request("https://portal.example.test/api/auth/x"));
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("transfer-encoding")).toBe(false);
    expect(response.headers.get("content-length")).not.toBe("999");
    expect(response.headers.get("x-keep")).toBe("1");
    expect(await response.text()).toBe("body");
  });

  it("returns redirects as-is (manual): status and location reach the browser", async () => {
    const { handlers } = proxyWith(
      () =>
        new Response(null, { status: 302, headers: { location: "https://idp.example.test/auth" } }),
    );
    const response = await handlers.GET(new Request("https://portal.example.test/api/auth/oauth"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://idp.example.test/auth");
  });

  it("passes upstream error statuses through", async () => {
    const { handlers } = proxyWith(() => Response.json({ code: "bad" }, { status: 401 }));
    const response = await handlers.GET(new Request("https://portal.example.test/api/auth/x"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "bad" });
  });

  it("an unreachable upstream is a 502 with the default body", async () => {
    const { handlers } = proxyWith(() => {
      throw new TypeError("fetch failed");
    });
    const response = await handlers.GET(new Request("https://portal.example.test/api/auth/x"));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      code: "auth.upstream_unavailable",
      message: "The sign-in service is unreachable.",
    });
  });

  it("the 502 body is host-configurable", async () => {
    const { handlers } = proxyWith(
      () => {
        throw new TypeError("fetch failed");
      },
      { unavailable: { code: "x.down", message: "Try later." } },
    );
    const response = await handlers.GET(new Request("https://portal.example.test/api/auth/x"));
    expect(await response.json()).toEqual({ code: "x.down", message: "Try later." });
  });
});

describe("upstream resolution", () => {
  it("prefers the internal upstream, falls back to the public one, trims slashes", () => {
    expect(resolveUpstream({ upstream: "https://api.example.test///" })).toBe(
      "https://api.example.test",
    );
    expect(
      resolveUpstream({
        upstream: "https://api.example.test",
        internalUpstream: "http://api:4000/",
      }),
    ).toBe("http://api:4000");
    expect(
      resolveUpstream({ upstream: "https://api.example.test", internalUpstream: () => undefined }),
    ).toBe("https://api.example.test");
    expect(
      resolveUpstream({ upstream: () => "https://lazy.example.test", internalUpstream: "" }),
    ).toBe("https://lazy.example.test");
  });

  it("throws when nothing is configured", () => {
    expect(() => resolveUpstream({ upstream: () => undefined })).toThrow(/no upstream/);
  });

  it("is evaluated per request, so a runtime setting is honoured", async () => {
    let current = "https://one.example.test";
    const { handlers, calls } = proxyWith(() => new Response("ok"), { upstream: () => current });
    await handlers.GET(new Request("https://portal.example.test/api/auth/a"));
    current = "https://two.example.test";
    await handlers.GET(new Request("https://portal.example.test/api/auth/a"));
    expect(calls.map((c) => c.url)).toEqual([
      "https://one.example.test/api/auth/a",
      "https://two.example.test/api/auth/a",
    ]);
  });
});
