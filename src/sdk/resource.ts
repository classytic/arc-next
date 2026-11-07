/**
 * defineSdkResource: one definition per arc route group. Route path, cache key, display names and
 * the permission-matrix resource come from one place, so they cannot drift.
 *
 * Server-safe by construction: creates no hooks. The hooks half is a one-liner in a `"use client"`
 * file: `createCrudHooks(resource.hooksConfig)`.
 *
 * ## Query-key rule (every key in the sdk follows it)
 *
 * 1. The key root is the route path with `/` as `-` (`catalog/items` becomes `catalog-items`), one
 *    root per route group. The root is `resource.keyRoot` and `hooks.KEYS.all`. Routes with no CRUD
 *    resource declare theirs with `keyRoot("<path>")`.
 * 2. Every other query on that group extends the root through the hooks bundle:
 *    `hooks.KEYS.custom('mine')`, `hooks.KEYS.custom('summary', id)`. Hand-written key arrays do not exist.
 * 3. Invalidate by root (`invalidateRoots`), never by a hand-typed string.
 */

import type { QueryClient } from "@tanstack/react-query";
import { BaseApi, createCrudApi } from "../client/api.js";
import type { ArcClient } from "../client/client.js";
import type { CrudHooksConfig } from "../query/hooks.js";
import { registerCrudMessages } from "./messages.js";

export type KeyRoot = readonly [string];

/** The verbs of a resource's CRUD route: list (`GET /x`), get (`GET /x/:id`), create, update (`PATCH`), delete. */
export type CrudVerb = "list" | "get" | "create" | "update" | "delete";

/** The key root of a route (rule 1). */
export function keyRoot(path: string): KeyRoot {
  return [path.replace(/\//g, "-")] as const;
}

/** Invalidate several roots at once (rule 3). */
export function invalidateRoots(
  queryClient: QueryClient,
  roots: readonly KeyRoot[],
): Promise<void> {
  return Promise.all(roots.map((queryKey) => queryClient.invalidateQueries({ queryKey }))).then(
    () => undefined,
  );
}

export interface SdkResourceDef<TDoc, TCreate, TUpdate, TPermission extends string = string> {
  /** Route under the API base path, e.g. `catalog/items`. */
  path: string;
  /**
   * The CRUD verbs the server mounts on this route and the sdk may send (a routes-only resource
   * declares none). Host tests can assert each one exists in the server's OpenAPI document.
   */
  operations?: readonly CrudVerb[];
  /** Override the key root. Only for two resources on one route; otherwise leave unset. */
  key?: string;
  singular: string;
  plural: string;
  /** The permission-matrix resource that gates this API, or `null` when it is member-wide. */
  permission: TPermission | null;
  /** Primary key on the wire. Default `_id` (arc rows). */
  idField?: string;
  /** The server resource mounts no CRUD (custom routes only): CRUD toast keys are not registered. */
  routesOnly?: boolean;
  defaults?: CrudHooksConfig<TDoc, TCreate, TUpdate>["defaults"];
}

export interface SdkResource<TDoc, TCreate, TUpdate, TPermission extends string = string> {
  readonly def: SdkResourceDef<TDoc, TCreate, TUpdate, TPermission>;
  /** The global instance (reads the transport `initSDK` configured, at call time). */
  readonly api: BaseApi<TDoc, TCreate, TUpdate>;
  readonly keyRoot: KeyRoot;
  /** The same route bound to one isolated client. */
  bind(client: ArcClient, basePath: string): BaseApi<TDoc, TCreate, TUpdate>;
  readonly hooksConfig: CrudHooksConfig<TDoc, TCreate, TUpdate>;
}

export function defineSdkResource<
  TDoc = Record<string, unknown>,
  TCreate = Partial<TDoc>,
  TUpdate = Partial<TDoc>,
  TPermission extends string = string,
>(
  def: SdkResourceDef<TDoc, TCreate, TUpdate, TPermission>,
): SdkResource<TDoc, TCreate, TUpdate, TPermission> {
  const api = createCrudApi<TDoc, TCreate, TUpdate>(def.path);
  const root = def.key ?? keyRoot(def.path)[0];
  // Message KEYS resolved at display time (`initSDK({ messages })`); explicit per-resource messages
  // in `defaults` still win.
  const messages = def.routesOnly
    ? def.defaults?.messages
    : {
        ...registerCrudMessages(
          root,
          def.singular,
          def.permission ? { permission: def.permission } : {},
        ),
        ...def.defaults?.messages,
      };
  return {
    def,
    api,
    keyRoot: [root] as const,
    bind: (client, basePath) => new BaseApi<TDoc, TCreate, TUpdate>(def.path, { client, basePath }),
    hooksConfig: {
      api,
      entityKey: root,
      singular: def.singular,
      plural: def.plural,
      idField: def.idField ?? "_id",
      defaults: { ...def.defaults, ...(messages ? { messages } : {}) },
    },
  };
}
