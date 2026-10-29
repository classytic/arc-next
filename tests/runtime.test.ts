import { afterEach, describe, expect, it, vi } from "vitest";
import { csv, definePublicEnv, serializeForScript, trimSlash } from "../src/runtime.js";

interface Env {
  apiUrl: string;
  hosts: string[];
}

const read = (source: Record<string, string | undefined>): Env => ({
  apiUrl: trimSlash(source.API_URL ?? "http://localhost:4000"),
  hosts: csv(source.HOSTS),
});

afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(window, "__APP_ENV__");
});

describe("definePublicEnv", () => {
  it("server: reads the process environment through the host's schema", () => {
    vi.stubEnv("API_URL", "https://api.example.test//");
    const { publicEnv } = definePublicEnv({ globalName: "__APP_ENV__", read });
    expect(publicEnv.apiUrl).toBe("https://api.example.test");
    expect(Object.isFrozen(publicEnv)).toBe(true);
  });

  it("defaults and csv parsing live in the host's read function", () => {
    const { readProcessEnv } = definePublicEnv({ globalName: "__APP_ENV__", read });
    expect(readProcessEnv({})).toEqual({ apiUrl: "http://localhost:4000", hosts: [] });
    expect(readProcessEnv({ HOSTS: " A.example.test, ,b.example.test" }).hosts).toEqual([
      "a.example.test",
      "b.example.test",
    ]);
  });

  it("browser: prefers the values the server wrote into the page", () => {
    vi.stubEnv("API_URL", "https://ignored.example.test");
    Reflect.set(window, "__APP_ENV__", { apiUrl: "https://from-page.example.test", hosts: [] });
    const { publicEnv } = definePublicEnv({ globalName: "__APP_ENV__", read });
    expect(publicEnv.apiUrl).toBe("https://from-page.example.test");
  });

  it("publicEnvScript cannot close its own element and round-trips", () => {
    const { publicEnvScript } = definePublicEnv({ globalName: "__APP_ENV__", read });
    const hostile = "https://x.test/</script><script>alert(1)</script>";
    const script = publicEnvScript({ apiUrl: hostile, hosts: ["a b"] });
    expect(script).not.toContain("</script>");
    expect(script).not.toContain("<");
    expect(script).not.toContain(" ");
    expect(script.startsWith("window.__APP_ENV__=")).toBe(true);
    const parsed = JSON.parse(script.slice("window.__APP_ENV__=".length, -1));
    expect(parsed).toEqual({ apiUrl: hostile, hosts: ["a b"] });
  });

  it("a global name that is not an identifier is assigned through brackets", () => {
    const { publicEnvScript } = definePublicEnv({ globalName: "app-env", read });
    expect(publicEnvScript({ apiUrl: "x", hosts: [] })).toBe(
      'window["app-env"]={"apiUrl":"x","hosts":[]};',
    );
  });
});

describe("serializeForScript", () => {
  it("escapes < and the legacy line terminators", () => {
    expect(serializeForScript({ a: "<!--", b: " " })).toBe('{"a":"\\u003c!--","b":"\\u2029"}');
  });
});
