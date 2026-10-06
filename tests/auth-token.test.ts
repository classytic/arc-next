import { describe, expect, it } from "vitest";
import { bearerFetchOptions, createTokenStore, type TokenStorage } from "../src/auth-token.js";

const memory = (): TokenStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => void data.set(k, v), removeItem: async (k) => void data.delete(k) };
};

describe("createTokenStore", () => {
  it("serves the token synchronously after loading it from async storage, and persists changes", async () => {
    const storage = memory();
    storage.data.set("app:token", "t1");
    const tokens = createTokenStore(storage, "app:token");
    expect(tokens.get()).toBeNull();
    expect(await tokens.load()).toBe("t1");
    expect(tokens.get()).toBe("t1");
    await tokens.set("t2");
    expect(storage.data.get("app:token")).toBe("t2");
    await tokens.clear();
    expect(tokens.get()).toBeNull();
    expect(storage.data.has("app:token")).toBe(false);
  });
});

describe("createTokenStore over synchronous storage", () => {
  it("reads the token at once — the first request carries it without a load()", () => {
    const data = new Map([["k", "sync-token"]]);
    const tokens = createTokenStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }, "k");
    expect(tokens.get()).toBe("sync-token");
    // Another tab signs out: this one sees it at once.
    data.delete("k");
    expect(tokens.get()).toBeNull();
  });
});

describe("bearerFetchOptions", () => {
  it("sends the stored token and keeps the one the server issues — header first, then body", async () => {
    const tokens = createTokenStore(memory(), "k");
    const options = bearerFetchOptions(tokens);
    expect(options.auth.token()).toBeUndefined();
    await options.onSuccess({ response: { headers: { get: (n) => (n === "set-auth-token" ? "from-header" : null) } }, data: { token: "from-body" } });
    expect(options.auth.token()).toBe("from-header");
    await options.onSuccess({ response: { headers: { get: () => null } }, data: { token: "from-body" } });
    expect(tokens.get()).toBe("from-body");
    await options.onSuccess({ response: { headers: { get: () => null } }, data: {} });
    expect(tokens.get()).toBe("from-body"); // a response without a token leaves the session alone
  });
});
