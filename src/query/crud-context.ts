"use client";

// Resource-level policy. Auth is resolved lazily; no per-request identity is captured here.
import { authGate } from "../auth/auth-gate.js";
import type { RequestAuth, ToastHandler, UseRouterHook } from "../client/client.js";
import { getAuthMode, getClientAuthContext, hasGlobalStaticAuth } from "../client/client.js";
import type { KeyPartition } from "./cache.js";
import { createCacheUtils, DEFAULT_QUERY_CONFIG, getItemId } from "./cache.js";
import type { CrudHooksConfig } from "./crud-types.js";
import type { InfiniteListQueryOptions, ListQueryOptions, RequestPassthrough } from "./query.js";
import { createEntityQueries, type EntityApi, type QueryFnContext } from "./query-options.js";

/** The shared rule (`authGate` in client.ts), which hand-written queries reach as `queryAuthEnabled`. */
function createEnabledRule(
  token: string | null,
  options: { public?: boolean; enabled?: boolean },
  authMode: "bearer" | "cookie" | "header" = getAuthMode(),
  hasStaticAuth = false,
): boolean {
  return authGate(token, options, authMode, hasStaticAuth);
}

export function createCrudContext<T, TCreate = Partial<T>, TUpdate = Partial<T>>({
  api,
  entityKey,
  singular,
  plural,
  idField,
  defaults = {},
  client,
}: CrudHooksConfig<T, TCreate, TUpdate>) {
  const pluralName = plural ?? `${singular}s`;

  /**
   * What the auth context knows (per-client auth first, then global), for FORWARDING: a value it
   * does not have is `undefined`, never `null`, because the transport reads `null` as "deliberately
   * none" and would then skip the api's own client auth. An explicit caller `null` still wins.
   */
  const resolveAuth = (): { token?: string; organizationId?: string } => {
    const auth = getClientAuthContext(client);
    return {
      ...(auth.token ? { token: auth.token } : {}),
      ...(auth.organizationId ? { organizationId: auth.organizationId } : {}),
    };
  };
  /** A caller's explicit value (`null` included) wins over the auth context's. */
  const pick = <V>(
    explicit: V | null | undefined,
    fallback: V | undefined,
  ): V | null | undefined => (explicit !== undefined ? explicit : fallback);

  /**
   * Whether auth is provided via static config — no per-request token needed.
   * Sources (in priority order):
   *   1. Per-client `defaultHeaders` / `internalApiKey` (when `client` is passed in).
   *   2. Per-client custom auth (e.g. `createClient({ getToken })`).
   *   3. Global `configureClient({ internalApiKey | defaultHeaders | authMode: 'cookie' })`.
   *
   * Resolved lazily on every render so that an app calling `configureClient`
   * inside a "use client" provider after factory creation still picks up the
   * global static-auth signal — previously a global `internalApiKey` was
   * ignored, leaving every protected query stuck in a permanently-disabled state.
   */
  const resolveHasStaticAuth = () =>
    !!(client?.config?.defaultHeaders || client?.config?.internalApiKey || client?.auth) ||
    hasGlobalStaticAuth();

  /** Extract ID from an item using configured idField, falling back to _id → id */
  function resolveItemId(item: unknown): string | null {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    if (idField) {
      const val = obj[idField];
      if (val != null) return String(val);
    }
    return getItemId(item);
  }
  /** The resource's option factories: the ONE source of every key and queryFn below. */
  const queries = createEntityQueries<T, TCreate, TUpdate>(api as unknown as EntityApi, entityKey);
  const KEYS = queries.keys;
  const cache = createCacheUtils<T>(KEYS);

  /**
   * The partition a write is made as: always signed in (`readAuth` governs reads only), with the
   * tenant the write sends. Optimistic updates, reconciliation and cache seeds stay inside it.
   */
  const writePartition = (vars: { organizationId?: string | null }): KeyPartition =>
    queries.partition({
      auth: "inherit",
      ...(vars.organizationId !== undefined ? { organizationId: vars.organizationId } : {}),
    });

  // Resolve toast handler: client instance → global
  const instanceToast: ToastHandler | undefined = client?.toast;
  // Resolve navigation hook: client instance → global
  const instanceNavigation: UseRouterHook | null = client?.navigation ?? null;
  // Resolve auth mode: client instance → global (fixes multi-client query enablement)
  // Lazy: read at query time, not factory time (global config can change after createCrudHooks)
  const resolveAuthMode = () => client?.config?.authMode ?? getAuthMode();

  const config = {
    ...DEFAULT_QUERY_CONFIG,
    ...defaults,
    structuralSharing: defaults.structuralSharing,
    messages: {
      createSuccess: `${singular} created successfully`,
      createError: `Failed to create ${singular.toLowerCase()}`,
      updateSuccess: `${singular} updated successfully`,
      updateError: `Failed to update ${singular.toLowerCase()}`,
      deleteSuccess: `${singular} deleted successfully`,
      deleteError: `Failed to delete ${singular.toLowerCase()}`,
      ...defaults.messages,
    },
  };

  // `enabled` for every read hook below. When this resource is declared
  // `defaultPublic: true` (its endpoints are `allowPublic` — e.g. a storefront
  // catalog), a token-less read is enabled by DEFAULT, so consumers never have
  // to remember `{ public: true }` per call (the bug class where a public read
  // silently returns empty for unauthenticated visitors). Crucially this is
  // PER-RESOURCE, not per-subtree: catalog defaults public; cart/orders/account
  // stay token-gated. An explicit per-call `public`/`enabled` still wins. A
  // plain function (not a hook) so it composes with each hook's own `extraGate`
  // (`!!id`, `!!api.getTree`) with no rules-of-hooks hazard. The auth token is
  // still SENT when present, so an authed caller (dashboard) is unaffected.
  const computeEnabled = (
    token: string | null,
    options: { public?: boolean; enabled?: boolean },
    extraGate = true,
  ): boolean => {
    const merged =
      options.public === undefined && config.defaultPublic ? { ...options, public: true } : options;
    return extraGate && createEnabledRule(token, merged, resolveAuthMode(), resolveHasStaticAuth());
  };

  // ========== Read hooks: thin wrappers over `queries` ==========
  //
  // Every read hook resolves WHO it reads for (token + org from the auth context, or anonymous),
  // asks the shared factory for { queryKey, queryFn }, and adds only hook concerns: the enable
  // gate, freshness defaults, `select`, placeholders. The key therefore cannot drift from a
  // Server Component prefetch or a `useQuery(hooks.queries.list(...))` call site.

  /** Who a read is for, the factory context that carries it, and the partition it is keyed in. */
  function readContext(
    params: Record<string, unknown>,
    options: {
      request?: RequestPassthrough;
      auth?: RequestAuth;
      scope?: string;
      organizationId?: string | null;
    },
  ): {
    token: string | null;
    params: Record<string, unknown>;
    ctx: QueryFnContext;
    partition: KeyPartition;
  } {
    const anonymous = isAnonymous(options.auth);
    const auth = anonymous ? {} : resolveAuth();
    // The tenant is `options.organizationId` (explicit, `null` = none) or the auth context's.
    // `params` are the query string, an `organizationId` filter included: never the tenant.
    const organizationId = anonymous
      ? undefined
      : pick(options.organizationId, auth.organizationId);
    const { headerOptions, ...request } = options.request ?? {};
    const ctx: QueryFnContext = {
      ...(auth.token !== undefined ? { token: auth.token } : {}),
      ...(organizationId !== undefined ? { organizationId } : {}),
      ...request,
      ...(headerOptions ? { headers: headerOptions } : {}),
      // The caller's explicit choice, `"inherit"` included: it overrides the resource's
      // `readAuth` on the wire and in the key, exactly as a factory `ctx.auth` does.
      ...(options.auth !== undefined ? { auth: options.auth } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    };
    return { token: auth.token ?? null, params, ctx, partition: queries.partition(ctx) };
  }

  /** Whether a read is anonymous: the explicit `auth`, else the resource's `readAuth`. */
  const isAnonymous = (auth: RequestAuth | undefined) =>
    (auth ?? (queries.anonymousReads ? "omit" : "inherit")) === "omit";

  /** Enable rule; an anonymous read is public by definition. */
  const readEnabled = (
    token: string | null,
    options: { public?: boolean; enabled?: boolean; auth?: RequestAuth },
    extraGate = true,
  ) =>
    computeEnabled(
      token,
      isAnonymous(options.auth) ? { ...options, public: options.public ?? true } : options,
      extraGate,
    );

  /** Freshness options shared by list-shaped reads. */
  const listFreshness = (o: ListQueryOptions | InfiniteListQueryOptions) => ({
    staleTime: o.staleTime ?? config.staleTime,
    gcTime: o.gcTime ?? config.gcTime,
    refetchOnWindowFocus: o.refetchOnWindowFocus ?? config.refetchOnWindowFocus,
    structuralSharing: o.structuralSharing ?? config.structuralSharing,
    // `??` so an explicit per-call `false` still disables polling.
    refetchInterval: o.refetchInterval ?? config.refetchInterval,
    refetchIntervalInBackground:
      o.refetchIntervalInBackground ?? config.refetchIntervalInBackground,
  });

  const seed = (o: { initialData?: unknown; initialDataUpdatedAt?: number }) =>
    o.initialData !== undefined
      ? {
          initialData: o.initialData,
          ...(o.initialDataUpdatedAt !== undefined
            ? { initialDataUpdatedAt: o.initialDataUpdatedAt }
            : {}),
        }
      : {};

  return {
    api,
    entityKey,
    singular,
    pluralName,
    idField,
    queries,
    KEYS,
    cache,
    config,
    resolveAuth,
    pick,
    resolveItemId,
    writePartition,
    instanceToast,
    instanceNavigation,
    readContext,
    readEnabled,
    listFreshness,
    seed,
  };
}

export type CrudContext<T, TCreate, TUpdate> = ReturnType<
  typeof createCrudContext<T, TCreate, TUpdate>
>;
