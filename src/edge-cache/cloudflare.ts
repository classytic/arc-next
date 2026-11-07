/**
 * `@classytic/arc-next/edge-cache/cloudflare`: the Cloudflare adapter for `./edge-cache`.
 *
 * Credentials: a zone id and an API token with ONLY `Zone > Cache Purge` on that zone. They are
 * server secrets; never ship them to a browser bundle.
 */

import type { EdgeProvider, EdgePurgeTarget } from "./index.js";

/** Read only by Cloudflare and stripped before the browser: sets the EDGE copy's life alone. */
export const CLOUDFLARE_CDN_CACHE_CONTROL = "Cloudflare-CDN-Cache-Control";

/** `process.env` where it exists (Node); empty elsewhere. */
const processEnv = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

/** Cloudflare accepts at most this many tags / hosts per purge call. */
const MAX_PER_CALL = 30;

export interface CloudflareEdgeOptions {
  zoneId: string;
  apiToken: string;
  /** Inject for tests or runtimes without a global `fetch`. */
  fetch?: typeof fetch;
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** A Cloudflare {@link EdgeProvider}: purges by host, by tag (Enterprise) or everything. */
export function cloudflareEdge(options: CloudflareEdgeOptions): EdgeProvider {
  const endpoint = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(options.zoneId)}/purge_cache`;
  const send = async (body: Record<string, unknown>) => {
    const res = await (options.fetch ?? fetch)(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try {
        const json = (await res.json()) as { errors?: Array<{ message?: string }> };
        const messages = json.errors?.map((e) => e.message).filter(Boolean);
        if (messages?.length) reason = `${reason}: ${messages.join("; ")}`;
      } catch {
        // keep the status alone
      }
      throw new Error(`Cloudflare refused the purge (${reason})`);
    }
  };
  return {
    name: "cloudflare",
    header: CLOUDFLARE_CDN_CACHE_CONTROL,
    async purge(target: EdgePurgeTarget) {
      if (target.everything) return send({ purge_everything: true });
      for (const hosts of chunk(target.hosts ?? [], MAX_PER_CALL)) await send({ hosts });
      for (const tags of chunk(target.tags ?? [], MAX_PER_CALL)) await send({ tags });
    },
  };
}

/** Env variable names the helpers below read. */
export const CLOUDFLARE_ENV = {
  zoneId: "CLOUDFLARE_ZONE_ID",
  apiToken: "CLOUDFLARE_PURGE_TOKEN",
} as const;

/**
 * A provider from `CLOUDFLARE_ZONE_ID` + `CLOUDFLARE_PURGE_TOKEN`, or `null` when either is unset
 * (development, previews): pass it straight to `createEdgePurger`, which then does nothing.
 */
export function cloudflareEdgeFromEnv(
  env: Record<string, string | undefined> = processEnv(),
  fetchImpl?: typeof fetch,
): EdgeProvider | null {
  const zoneId = env[CLOUDFLARE_ENV.zoneId];
  const apiToken = env[CLOUDFLARE_ENV.apiToken];
  if (!zoneId || !apiToken) return null;
  return cloudflareEdge({ zoneId, apiToken, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

/**
 * Deploy purge: empty the site's host once the NEW build is live (cached pages point at the old
 * build's `_next/static` chunks). Purging before the new container serves re-caches old pages.
 * Resolves `{ ok, message }`; never prints the token.
 *
 * @example
 * // scripts/purge-cdn.mjs
 * const r = await purgeEdgeHost({ host: "example.com" });
 * console.log(r.message); process.exit(r.ok ? 0 : 1);
 */
export async function purgeEdgeHost(options: {
  host: string;
  zoneId?: string;
  apiToken?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): Promise<{ ok: boolean; message: string }> {
  const env = options.env ?? processEnv();
  const zoneId = options.zoneId ?? env[CLOUDFLARE_ENV.zoneId];
  const apiToken = options.apiToken ?? env[CLOUDFLARE_ENV.apiToken];
  if (!zoneId || !apiToken) {
    return {
      ok: false,
      message: `Set ${CLOUDFLARE_ENV.zoneId} and ${CLOUDFLARE_ENV.apiToken} to purge ${options.host}.`,
    };
  }
  try {
    await cloudflareEdge({
      zoneId,
      apiToken,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }).purge({ hosts: [options.host] });
    return { ok: true, message: `Cloudflare cache purged for ${options.host}.` };
  } catch (error) {
    return { ok: false, message: `${options.host}: ${(error as Error).message}` };
  }
}
