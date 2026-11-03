import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  createNonce,
  createProxy,
  hostOrigins,
  NONCE_HEADER,
  originOf,
  originsOf,
  TRUSTED_TYPES_DEFAULT_POLICY,
} from "../src/csp.js";

const API = "https://api.example.test";
const STORAGE = "https://files.example.test";
const directive = (csp: string, name: string) =>
  csp.split("; ").find((d) => d === name || d.startsWith(`${name} `)) ?? "";

describe("contentSecurityPolicy", () => {
  it("production: nonce'd strict-dynamic scripts, Trusted Types, no eval", () => {
    const csp = contentSecurityPolicy({ nonce: "abc", apiOrigin: API, dev: false });
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("require-trusted-types-for 'script'");
    expect(csp).toContain("trusted-types nextjs nextjs#bundler default");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(directive(csp, "connect-src")).toBe(`connect-src 'self' ${API}`);
  });

  it("development: eval and HMR sockets allowed, Trusted Types and upgrade off", () => {
    const csp = contentSecurityPolicy({
      nonce: "abc",
      apiOrigin: "http://localhost:4000",
      dev: true,
    });
    expect(directive(csp, "script-src")).toContain("'unsafe-eval'");
    expect(directive(csp, "connect-src")).toContain("ws:");
    expect(csp).not.toContain("trusted-types");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("no upgrade-insecure-requests for a plain-http API origin, even in production", () => {
    const csp = contentSecurityPolicy({ nonce: "n", apiOrigin: "http://api.internal", dev: false });
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(
      contentSecurityPolicy({
        nonce: "n",
        apiOrigin: "http://x",
        dev: false,
        upgradeInsecureRequests: true,
      }),
    ).toContain("upgrade-insecure-requests");
  });

  it("trustedTypes and its policy names are host-controlled", () => {
    expect(
      contentSecurityPolicy({ nonce: "n", apiOrigin: API, dev: true, trustedTypes: true }),
    ).toContain("require-trusted-types-for 'script'");
    const off = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      dev: false,
      trustedTypes: false,
    });
    expect(off).not.toContain("trusted-types");
    const custom = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      dev: false,
      trustedTypesPolicies: ["nextjs", "default", "dompurify"],
    });
    expect(custom).toContain("trusted-types nextjs default dompurify");
  });

  it("the storage origin reaches img, connect, frame and media; maps reach img and connect only", () => {
    const csp = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      storageOrigin: STORAGE,
      mapOrigins: ["https://tiles.example.test"],
      dev: false,
    });
    for (const name of ["img-src", "connect-src", "frame-src", "media-src"]) {
      expect(directive(csp, name)).toContain(STORAGE);
    }
    for (const name of ["img-src", "connect-src"]) {
      expect(directive(csp, name)).toContain("https://tiles.example.test");
    }
    for (const name of ["frame-src", "media-src", "script-src"]) {
      expect(directive(csp, name)).not.toContain("tiles.example.test");
    }
  });

  it("embed origins reach frame-src only", () => {
    const csp = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      embedOrigins: ["https://player.example.test"],
      dev: false,
    });
    expect(directive(csp, "frame-src")).toBe(`frame-src 'self' ${API} https://player.example.test`);
    expect(csp.match(/player\.example\.test/g)).toHaveLength(1);
  });

  it("extra origins merge per directive and unknown directives are appended", () => {
    const csp = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      dev: false,
      extra: {
        "connect-src": ["https://metrics.example.test", API],
        "child-src": ["https://child.example.test"],
        "font-src": [],
      },
    });
    expect(directive(csp, "connect-src")).toBe(
      `connect-src 'self' ${API} https://metrics.example.test`,
    );
    expect(csp).toContain("child-src https://child.example.test");
    expect(directive(csp, "font-src")).toBe("font-src 'self' data:");
  });

  it("de-duplicates repeated origins", () => {
    const csp = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      storageOrigin: API,
      dev: false,
    });
    expect(directive(csp, "img-src")).toBe(`img-src 'self' data: blob: ${API}`);
  });
});

describe("contentSecurityPolicy — frameSrc (Unreleased)", () => {
  it("absent: frame-src output is identical to 0.19", () => {
    const csp = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      storageOrigin: STORAGE,
      embedOrigins: ["https://player.example.test"],
      dev: false,
    });
    expect(directive(csp, "frame-src")).toBe(
      `frame-src 'self' ${STORAGE} ${API} https://player.example.test`,
    );
  });

  it("'none' emits frame-src 'none' and nothing else", () => {
    const csp = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      storageOrigin: STORAGE,
      dev: false,
      frameSrc: "none",
    });
    expect(directive(csp, "frame-src")).toBe("frame-src 'none'");
    // Other directives keep the storage and api origins.
    expect(directive(csp, "media-src")).toBe(`media-src 'self' blob: ${STORAGE} ${API}`);
  });

  it("'none' with embedOrigins or extra frame-src is a config error", () => {
    const base = { nonce: "n", apiOrigin: API, dev: false, frameSrc: "none" as const };
    expect(() =>
      contentSecurityPolicy({ ...base, embedOrigins: ["https://player.example.test"] }),
    ).toThrow(/frameSrc: 'none'/);
    expect(() =>
      contentSecurityPolicy({ ...base, extra: { "frame-src": ["https://x.example.test"] } }),
    ).toThrow(/frameSrc: 'none'/);
    // Empty lists are not a conflict.
    expect(() =>
      contentSecurityPolicy({ ...base, embedOrigins: [], extra: { "frame-src": [] } }),
    ).not.toThrow();
  });

  it("an array replaces the built-in self / storage / api list; embed and extra still merge", () => {
    const csp = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      storageOrigin: STORAGE,
      embedOrigins: ["https://player.example.test"],
      extra: { "frame-src": ["https://pay.example.test"] },
      dev: false,
      frameSrc: ["'self'"],
    });
    expect(directive(csp, "frame-src")).toBe(
      "frame-src 'self' https://player.example.test https://pay.example.test",
    );
  });

  it("an empty array with nothing else to frame falls back to 'none'", () => {
    const csp = contentSecurityPolicy({ nonce: "n", apiOrigin: API, dev: false, frameSrc: [] });
    expect(directive(csp, "frame-src")).toBe("frame-src 'none'");
  });

  it("array entries must be single source expressions; 'none' inside an array throws", () => {
    const base = { nonce: "n", apiOrigin: API, dev: false };
    for (const bad of [
      "https://a.test; script-src *",
      "https://a.test,https://b.test",
      "a b",
      "",
      "'none'",
    ]) {
      expect(() => contentSecurityPolicy({ ...base, frameSrc: [bad] })).toThrow(/frameSrc entry/);
    }
    expect(() => contentSecurityPolicy({ ...base, frameSrc: ["'self'", "'none'"] })).toThrow(
      /frameSrc entry/,
    );
  });

  it("connect-src blob: is added through extra and is not in the default", () => {
    const plain = contentSecurityPolicy({ nonce: "n", apiOrigin: API, dev: false });
    expect(directive(plain, "connect-src")).not.toContain("blob:");
    const csp = contentSecurityPolicy({
      nonce: "n",
      apiOrigin: API,
      dev: false,
      extra: { "connect-src": ["blob:"] },
    });
    expect(directive(csp, "connect-src")).toBe(`connect-src 'self' ${API} blob:`);
  });
});

describe("origin helpers", () => {
  it("originOf drops relative, empty and unparsable urls and tolerates {templates}", () => {
    expect(originOf("https://cdn.example.test/tiles/{z}/{x}/{y}.pbf")).toBe(
      "https://cdn.example.test",
    );
    expect(originOf("/local/style.json")).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originsOf(["https://a.test/x", "https://a.test/y", "/z", undefined])).toEqual([
      "https://a.test",
    ]);
  });

  it("hostOrigins keeps only bare hosts matching the pattern", () => {
    expect(
      hostOrigins([
        "tenant.example.test",
        "*.example.test",
        "https://x.example.test",
        "evil",
        "tenant.example.test",
      ]),
    ).toEqual(["https://tenant.example.test"]);
    expect(
      hostOrigins(["a.share.test", "a.share.test.evil.test"], /^[a-z0-9-]+\.share\.test$/),
    ).toEqual(["https://a.share.test"]);
  });
});

describe("TRUSTED_TYPES_DEFAULT_POLICY", () => {
  it("is a self-invoking default policy that refuses HTML and script strings", () => {
    expect(TRUSTED_TYPES_DEFAULT_POLICY).toContain('createPolicy("default"');
    expect(TRUSTED_TYPES_DEFAULT_POLICY).toContain("createHTML:function(){throw");
    expect(TRUSTED_TYPES_DEFAULT_POLICY).toContain("createScript:function(){throw");
    expect(() => new Function(TRUSTED_TYPES_DEFAULT_POLICY)).not.toThrow();
  });

  it("allows blob: and same-origin script URLs only", () => {
    type Policy = { createScriptURL: (u: string) => string };
    const created: Policy[] = [];
    const win = {
      trustedTypes: { createPolicy: (_name: string, policy: Policy) => created.push(policy) },
    };
    const loc = { href: "https://app.example.test/", origin: "https://app.example.test" };
    new Function("window", "location", TRUSTED_TYPES_DEFAULT_POLICY)(win, loc);
    const policy = created[0];
    expect(policy?.createScriptURL("/_next/a.js")).toBe("/_next/a.js");
    expect(policy?.createScriptURL("blob:https://app.example.test/1")).toBe(
      "blob:https://app.example.test/1",
    );
    expect(() => policy?.createScriptURL("https://evil.example.test/a.js")).toThrow(/refused/);
  });
});

describe("createProxy", () => {
  function setup() {
    const forwarded: Headers[] = [];
    const NextResponse = {
      next(init: { request: { headers: Headers } }) {
        forwarded.push(init.request.headers);
        return { headers: new Headers() };
      },
    };
    return { NextResponse, forwarded };
  }

  it("mints a nonce, forwards it with the CSP on the request and sets the CSP on the response", () => {
    const { NextResponse, forwarded } = setup();
    const seen: Array<{ nonce: string; dev: boolean }> = [];
    const proxy = createProxy({
      NextResponse,
      nonce: () => "fixed-nonce",
      dev: false,
      policy: ({ nonce, dev }) => {
        seen.push({ nonce, dev });
        return contentSecurityPolicy({ nonce, dev, apiOrigin: API });
      },
    });
    const response = proxy({ headers: new Headers({ "x-keep": "1" }) });
    const csp = response.headers.get("content-security-policy");
    expect(csp).toContain("'nonce-fixed-nonce'");
    expect(forwarded[0]?.get(NONCE_HEADER)).toBe("fixed-nonce");
    expect(forwarded[0]?.get("content-security-policy")).toBe(csp);
    expect(forwarded[0]?.get("x-keep")).toBe("1");
    expect(seen).toEqual([{ nonce: "fixed-nonce", dev: false }]);
  });

  it("requestHeaders are forwarded on the request; the response CSP is unchanged", () => {
    const { NextResponse, forwarded } = setup();
    const ctxs: Array<{ nonce: string; dev: boolean; path: string | null }> = [];
    const proxy = createProxy({
      NextResponse,
      nonce: () => "fixed-nonce",
      dev: false,
      policy: ({ nonce }) => `script-src 'nonce-${nonce}'`,
      requestHeaders: ({ request, nonce, dev }) => {
        ctxs.push({ nonce, dev, path: request.headers.get("x-path") });
        return { "x-app-surface": "console", "x-keep": "override" };
      },
    });
    const response = proxy({ headers: new Headers({ "x-keep": "1", "x-path": "/a" }) });
    expect(ctxs).toEqual([{ nonce: "fixed-nonce", dev: false, path: "/a" }]);
    expect(forwarded[0]?.get("x-app-surface")).toBe("console");
    expect(forwarded[0]?.get("x-keep")).toBe("override");
    expect(response.headers.get("content-security-policy")).toBe("script-src 'nonce-fixed-nonce'");
    expect(response.headers.get("x-app-surface")).toBeNull();
  });

  it("requestHeaders cannot override the minted nonce or the CSP (any case)", () => {
    const { NextResponse, forwarded } = setup();
    const proxy = createProxy({
      NextResponse,
      nonce: () => "minted",
      dev: false,
      policy: ({ nonce }) => `script-src 'nonce-${nonce}'`,
      requestHeaders: () => ({
        "X-Nonce": "attacker",
        "Content-Security-Policy": "script-src *",
        "x-ok": "1",
      }),
    });
    const response = proxy({ headers: new Headers() });
    expect(forwarded[0]?.get(NONCE_HEADER)).toBe("minted");
    expect(forwarded[0]?.get("content-security-policy")).toBe("script-src 'nonce-minted'");
    expect(forwarded[0]?.get("x-ok")).toBe("1");
    expect(response.headers.get("content-security-policy")).toBe("script-src 'nonce-minted'");
  });

  it("requestHeaders returning undefined forwards the request headers unchanged", () => {
    const { NextResponse, forwarded } = setup();
    const proxy = createProxy({
      NextResponse,
      nonce: () => "n",
      dev: false,
      policy: () => "x",
      requestHeaders: () => undefined,
    });
    proxy({ headers: new Headers({ "x-keep": "1" }) });
    expect([...forwarded[0]!.keys()].sort()).toEqual(
      ["content-security-policy", "x-keep", NONCE_HEADER].sort(),
    );
  });

  it("requestHeaders: null deletes a client-sent header; other incoming headers pass through", () => {
    const { NextResponse, forwarded } = setup();
    const proxy = createProxy({
      NextResponse,
      nonce: () => "n",
      dev: false,
      policy: () => "x",
      requestHeaders: () => ({ "X-App-Surface": null, "x-tenant": "t1" }),
    });
    proxy({
      headers: new Headers({ "x-app-surface": "admin", "x-tenant": "spoof", "x-keep": "1" }),
    });
    expect(forwarded[0]!.has("x-app-surface")).toBe(false);
    expect(forwarded[0]!.get("x-tenant")).toBe("t1");
    expect(forwarded[0]!.get("x-keep")).toBe("1");
  });

  it("a fresh base64 nonce per request", () => {
    const { NextResponse } = setup();
    const proxy = createProxy({
      NextResponse,
      policy: ({ nonce }) => `script-src 'nonce-${nonce}'`,
    });
    const a = proxy({ headers: new Headers() }).headers.get("content-security-policy");
    const b = proxy({ headers: new Headers() }).headers.get("content-security-policy");
    expect(a).not.toBe(b);
    expect(createNonce()).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("dev follows NODE_ENV when not set explicitly", () => {
    const { NextResponse } = setup();
    const devs: boolean[] = [];
    const proxy = createProxy({
      NextResponse,
      policy: ({ dev }) => {
        devs.push(dev);
        return "x";
      },
    });
    proxy({ headers: new Headers() });
    expect(devs).toEqual([false]);
  });
});
