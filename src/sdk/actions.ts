/**
 * Typed action descriptors (server-safe half). Every verb a UI can send is ONE contract: wire name,
 * payload, result, message keys. Two transports exist because an arc server mounts both:
 *
 * - `defineCommitAction` / `defineAction`: a verb on arc's action router,
 *   `POST /<resource>/:id/action` with `{ action, ...payload }`. `runAction`.
 * - `defineRouteAction`: a verb on a custom route (`POST /progress`, a `GET` that mints a signed URL
 *   on click, `POST /sweep`). `runRouteAction`, and `useRouteAction` in `./hooks`.
 *
 * Message text is never English here: each descriptor carries message KEYS (see `./messages`) the
 * host maps to its locale. `silent: true` for verbs that must not toast (autosave, progress ping).
 */

import { type ActionFallback, registerActionMessages } from "./messages.js";

/** The wire body of an action is ALWAYS an object (`{ action, ...data }`), or nothing. */
export type ActionBody = Record<string, unknown>;

export interface DescriptorMessages {
  /** Message KEYS (resolved to text at display time). Absent = no toast. */
  success?: string;
  error?: string;
}

export interface ActionDescriptor<
  // biome-ignore lint/suspicious/noConfusingVoidType: a no-payload verb is typed `void`
  TInput extends ActionBody | void = void,
  TResult = unknown,
  TVerb extends string = string,
  TKind extends string = string,
> {
  readonly verb: TVerb;
  /** What kind of verb this is (`commit` for the plain router; hosts add their own, e.g. a chain verb). */
  readonly kind: TKind;
  /** Stable id of the action, e.g. `catalog.item.publish`: the message-key stem. */
  readonly key: string;
  readonly messages: DescriptorMessages;
  /** Phantom markers: erased at runtime, they carry the payload and result contract. */
  readonly __input?: TInput;
  readonly __result?: TResult;
}

export interface ActionOptions {
  /** Stable id, `<domain>.<resource>.<verb>`. */
  key: string;
  /** English defaults for the message keys (the host's translation wins). */
  fallback?: ActionFallback;
  /** No toast for this verb. */
  silent?: boolean;
}

/** The message keys of a descriptor: none when `silent`, else registered with their English fallbacks. */
export function messagesFor(options: ActionOptions): DescriptorMessages {
  return options.silent ? {} : registerActionMessages(options.key, options.fallback);
}

/** A verb on arc's action router, of any `kind` the host defines. */
export function defineAction<
  // biome-ignore lint/suspicious/noConfusingVoidType: a no-payload verb is typed `void`
  TInput extends ActionBody | void = void,
  TResult = unknown,
  TVerb extends string = string,
  TKind extends string = string,
>(
  verb: TVerb,
  kind: TKind,
  options: ActionOptions,
): ActionDescriptor<TInput, TResult, TVerb, TKind> {
  return { verb, kind, key: options.key, messages: messagesFor(options) };
}

export interface CommitActionDefinerOptions {
  /** Verbs another constructor owns (e.g. an approval chain's). `defineCommitAction` throws on them. */
  reservedVerbs?: readonly string[];
  /** Named in the error, e.g. `defineApprovalActions()`. */
  reservedBy?: string;
}

/**
 * A `defineCommitAction` that refuses the verbs another constructor owns, so a screen cannot smuggle
 * a chain verb onto a plain transition. Hosts with no reserved verbs use `defineCommitAction`.
 */
export function createCommitActionDefiner(options: CommitActionDefinerOptions = {}) {
  const reserved = new Set(options.reservedVerbs ?? []);
  return function defineCommitAction<
    // biome-ignore lint/suspicious/noConfusingVoidType: a no-payload verb is typed `void`
    TInput extends ActionBody | void = void,
    TResult = unknown,
    TVerb extends string = string,
  >(verb: TVerb, actionOptions: ActionOptions): ActionDescriptor<TInput, TResult, TVerb, "commit"> {
    if (reserved.has(verb)) {
      throw new Error(
        `defineCommitAction("${verb}"): a reserved verb is declared by ${options.reservedBy ?? "its own constructor"}`,
      );
    }
    return defineAction<TInput, TResult, TVerb, "commit">(verb, "commit", actionOptions);
  };
}

/** A verb on arc's action router: `POST /<resource>/:id/action`. */
export const defineCommitAction = createCommitActionDefiner();

/** Per-call request options a runner forwards (a `BaseApi` `RequestOptions` slice). */
export interface RunRequestOptions {
  /** `Idempotency-Key` for this call; reuse it on a retry of the same intent. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  headerOptions?: Record<string, string>;
}

/** The slice of a `BaseApi` the runners need (structural, so tests and isolated instances fit). */
export interface RouteApi {
  invokeRoute<T = unknown>(args: {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    data?: unknown;
    params?: Record<string, unknown>;
    options?: RunRequestOptions;
  }): Promise<T>;
  dispatchAction<T = unknown, B extends Record<string, unknown> = Record<string, unknown>>(args: {
    id: string;
    action: string;
    data?: B;
    /** Per-call request options (`runAction`'s last argument); absent when none were given. */
    options?: RunRequestOptions;
  }): Promise<T>;
}

/**
 * `runAction`'s arguments after the id: the payload, then optional per-call request options. A
 * no-payload verb takes no payload; to pass options it gives `undefined` in the payload's place.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a no-payload verb is typed `void`
export type RunActionArgs<TInput extends ActionBody | void> = TInput extends void
  ? [input?: undefined, options?: RunRequestOptions]
  : [input: TInput, options?: RunRequestOptions];

/**
 * The payload tuple of the explicit-type-argument overloads. With no type arguments `TInput` stays
 * `never` and the tuple `[never]` accepts no call, so those overloads never serve an inferred call.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a no-payload verb is typed `void`
type ExplicitInput<TInput extends ActionBody | void> = [TInput] extends [never]
  ? [never]
  : RunActionArgs<TInput>;

/**
 * Imperative dispatch of an action-router verb: `POST /<resource>/:id/action`. The payload and the
 * result are typed by the descriptor (its phantom `__input` / `__result` markers):
 * `runAction(api, d, id, input)` resolves to `d`'s result. A verb-only object still fits; then the
 * call's type arguments or its payload decide. Explicit type arguments that differ from a typed
 * descriptor's markers (0.19 callers) resolve to the second, verb-only overload.
 *
 * Per-call request options follow the payload (`runAction(api, d, id, input, { idempotencyKey })`;
 * a no-payload verb: `runAction(api, d, id, undefined, { idempotencyKey })`). They reach
 * `dispatchAction`'s `options`, never the body.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a no-payload verb is typed `void`
export function runAction<TInput extends ActionBody | void, TResult>(
  api: RouteApi,
  descriptor: Pick<ActionDescriptor<TInput, TResult>, "verb" | "__input" | "__result">,
  id: string,
  ...args: RunActionArgs<TInput>
): Promise<TResult>;
/** 0.19 signature, for explicit type arguments only: nothing is inferred here. */
// biome-ignore lint/suspicious/noConfusingVoidType: a no-payload verb is typed `void`
export function runAction<TInput extends ActionBody | void = never, TResult = never>(
  api: RouteApi,
  descriptor: Pick<ActionDescriptor<NoInfer<TInput>, NoInfer<TResult>>, "verb">,
  id: string,
  ...input: NoInfer<ExplicitInput<TInput>>
): Promise<TResult>;
// biome-ignore lint/suspicious/noConfusingVoidType: a no-payload verb is typed `void`
export function runAction<TInput extends ActionBody | void, TResult>(
  api: RouteApi,
  descriptor: Pick<ActionDescriptor<TInput, TResult>, "verb">,
  id: string,
  ...args: RunActionArgs<TInput>
): Promise<TResult> {
  const body = args[0] as ActionBody | undefined;
  const options = args[1];
  return api.dispatchAction<TResult, ActionBody>({
    id,
    action: descriptor.verb,
    ...(body !== undefined ? { data: body } : {}),
    ...(options ? { options } : {}),
  });
}

// ── Custom-route verbs ───────────────────────────────────────────────────────────────────────

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteActionDef<TInput, TRaw, TResult> extends ActionOptions {
  method: RouteMethod;
  /** Path under the resource base, built from the input. */
  path: (input: TInput) => string;
  /** The request body (default: none). */
  body?: (input: TInput) => unknown;
  /** Query params (default: none). */
  params?: (input: TInput) => Record<string, unknown> | undefined;
  /** Unwrap the response (`{ data }` envelopes). Default: identity. */
  select?: (raw: TRaw) => TResult;
}

export interface RouteActionDescriptor<TInput, TResult, TRaw = TResult> {
  readonly kind: "route";
  readonly key: string;
  readonly method: RouteMethod;
  readonly messages: DescriptorMessages;
  readonly path: (input: TInput) => string;
  readonly body: ((input: TInput) => unknown) | undefined;
  readonly params: ((input: TInput) => Record<string, unknown> | undefined) | undefined;
  readonly select: ((raw: TRaw) => TResult) | undefined;
}

export function defineRouteAction<TInput = void, TResult = unknown, TRaw = TResult>(
  def: RouteActionDef<TInput, TRaw, TResult>,
): RouteActionDescriptor<TInput, TResult, TRaw> {
  return {
    kind: "route",
    key: def.key,
    method: def.method,
    messages: messagesFor(def),
    path: def.path,
    body: def.body,
    params: def.params,
    select: def.select,
  };
}

/** Imperative dispatch of a custom-route verb; `options` carries per-call request options. */
export async function runRouteAction<TInput, TResult, TRaw>(
  api: RouteApi,
  descriptor: RouteActionDescriptor<TInput, TResult, TRaw>,
  input: TInput,
  options?: RunRequestOptions,
): Promise<TResult> {
  const body = descriptor.body?.(input);
  const params = descriptor.params?.(input);
  const raw = await api.invokeRoute<TRaw>({
    method: descriptor.method,
    path: descriptor.path(input),
    ...(body !== undefined ? { data: body } : {}),
    ...(params ? { params } : {}),
    ...(options ? { options } : {}),
  });
  return descriptor.select ? descriptor.select(raw) : (raw as unknown as TResult);
}
