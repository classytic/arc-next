/**
 * Runtime public settings: one image runs in every environment (build once, promote the same image
 * from staging to production). On the server the host's `read` function turns `process.env` into a
 * typed settings object; the root layout writes that object into the page with a nonce'd inline
 * script (`publicEnvScript`); the browser bundle reads it back from `window[globalName]` before any
 * app script runs.
 *
 * Server-safe (no "use client", no `next` imports). The host owns the schema (the type returned by
 * `read`), the defaults and the global's name; nothing is hard-coded here.
 *
 * ```ts
 * // lib/env.ts
 * export const { publicEnv, publicEnvScript, readProcessEnv } = definePublicEnv({
 *   globalName: "__APP_ENV__",
 *   read: (source) => ({
 *     apiUrl: trimSlash(source.API_URL ?? "http://localhost:4000"),
 *     embedHosts: csv(source.EMBED_HOSTS),
 *   }),
 * });
 *
 * // app/layout.tsx (server component, <head>)
 * <script nonce={nonce} dangerouslySetInnerHTML={{ __html: publicEnvScript() }} />
 * ```
 */

/** The shape `read` receives: `process.env`, or any string map in tests. */
export type EnvSource = Record<string, string | undefined>;

export interface DefinePublicEnvOptions<T extends object> {
  /** Property of `window` the server's values are written to, e.g. `__APP_ENV__`. */
  globalName: string;
  /** Turn the raw environment into the typed settings object (parse, default, trim). */
  read: (source: EnvSource) => T;
}

export interface PublicEnvModule<T extends object> {
  /** Browser: the values the server wrote into the page. Server (and tests without a page): `read(process.env)`. Frozen. */
  readonly publicEnv: Readonly<T>;
  /** `read` against an explicit source (defaults to `process.env`). For tests and scripts. */
  readProcessEnv(source?: EnvSource): T;
  /** Inline script body that hands the server's values to the browser bundle. `<` is escaped. */
  publicEnvScript(env?: T): string;
}

/** Strip trailing slashes: `https://api.example.com//` becomes `https://api.example.com`. */
export function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** A comma list setting to trimmed, lower-cased, non-empty entries. */
export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * `JSON.stringify` that can be embedded in an inline `<script>`: `<` becomes `\u003c` so a value can
 * never close the element (or open a comment), and U+2028 / U+2029 (line terminators in older
 * engines) are escaped too.
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function definePublicEnv<T extends object>(
  options: DefinePublicEnvOptions<T>,
): PublicEnvModule<T> {
  const { globalName, read } = options;
  const target = /^[A-Za-z_$][\w$]*$/.test(globalName)
    ? `window.${globalName}`
    : `window[${JSON.stringify(globalName)}]`;
  const page = (): T | undefined =>
    typeof window === "undefined"
      ? undefined
      : (window as unknown as Record<string, T | undefined>)[globalName];
  const processEnv = (): EnvSource =>
    (globalThis as { process?: { env?: EnvSource } }).process?.env ?? {};
  const readProcessEnv = (source?: EnvSource): T => read(source ?? processEnv());
  const publicEnv = Object.freeze(page() ?? readProcessEnv()) as Readonly<T>;
  return {
    publicEnv,
    readProcessEnv,
    publicEnvScript: (env = publicEnv as T) => `${target}=${serializeForScript(env)};`,
  };
}
