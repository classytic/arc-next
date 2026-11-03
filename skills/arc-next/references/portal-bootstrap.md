# Portal bootstrap: `/runtime`, `/csp`, `/auth-proxy`

All three are server-safe and import nothing from `next`. The host supplies every origin, name and schema.

## `/runtime`: settings read at request time

One image runs in every environment: the server reads `process.env`, the root layout writes the values into the page, the browser reads them back.

```ts
// lib/env.ts
export const { publicEnv, publicEnvScript, readProcessEnv } = definePublicEnv({
  globalName: "__APP_ENV__",
  read: (source) => ({
    apiUrl: trimSlash(source.API_URL ?? "http://localhost:4000"),
    storageOrigin: trimSlash(source.STORAGE_ORIGIN ?? ""),
    embedHosts: csv(source.EMBED_HOSTS),
  }),
});
```

```tsx
// app/layout.tsx (server component; nonce from the x-nonce request header)
<head>
  <script nonce={nonce} dangerouslySetInnerHTML={{ __html: publicEnvScript() }} />
</head>
```

- `publicEnv` is frozen: the page value in the browser, `read(process.env)` elsewhere.
- `readProcessEnv(source)` takes an explicit map for tests.
- `publicEnvScript` escapes `<`, U+2028 and U+2029 so a value cannot close the script element. Still pass only public settings.
- Build-time `NEXT_PUBLIC_*` values are not runtime settings; keep only brand assets build-time.
- Helpers: `trimSlash`, `csv` (trim, lower-case, drop empties), `serializeForScript`.

## `/csp`: policy per request

```ts
contentSecurityPolicy({
  nonce, dev,
  apiOrigin: publicEnv.apiUrl,
  storageOrigin: publicEnv.storageOrigin,        // img, connect, frame, media
  mapOrigins: originsOf([styleUrl, tilesUrl]),   // img, connect
  embedOrigins: hostOrigins(publicEnv.embedHosts, /^[a-z0-9-]+\.example\.test$/),  // frame only
  extra: { "connect-src": ["https://metrics.example.test"] },
});
```

| Mode | Result |
|---|---|
| Production | `script-src 'self' 'nonce-N' 'strict-dynamic'`, `require-trusted-types-for 'script'`, `trusted-types nextjs nextjs#bundler default`, `upgrade-insecure-requests` for an https API |
| `dev: true` | adds `'unsafe-eval'` and `ws:`; Trusted Types and upgrade off |

Overrides: `trustedTypes`, `trustedTypesPolicies`, `upgradeInsecureRequests`. `extra` merges per directive; an unknown directive is appended. Origins are de-duplicated. `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'` are fixed.

- `frameSrc: "none"` emits `frame-src 'none'` for an app that frames nothing; combined with `embedOrigins` or `extra["frame-src"]` it throws. An array replaces the built-in `'self'` / storage / API list; embed and `extra` origins still merge. One source expression per entry (whitespace, `;`, `,` or `'none'` in an array throws).
- `connect-src blob:` is not in the default: add it with `extra: { "connect-src": ["blob:"] }` when a worker or download fetches a blob URL.

Trusted Types needs the default policy in `<head>` as a nonce'd inline script:

```tsx
<script nonce={nonce} dangerouslySetInnerHTML={{ __html: TRUSTED_TYPES_DEFAULT_POLICY }} />
```

It admits same-origin and `blob:` script URLs and refuses HTML and script strings. Add every other policy name your libraries create to `trustedTypesPolicies`.

### `createProxy` for Next's `proxy.ts`

```ts
import { NextResponse } from "next/server";
export const proxy = createProxy({
  NextResponse,
  policy: ({ nonce, dev }) => contentSecurityPolicy({ nonce, dev, apiOrigin: publicEnv.apiUrl }),
});
export const config = {      // must be a static literal in this file
  matcher: [{
    source: "/((?!api/|_next/static|_next/image|favicon.ico).*)",
    missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }],
  }],
};
```

Per request: a fresh nonce (`createNonce`), the CSP and `x-nonce` (`NONCE_HEADER`) on the forwarded request so Next stamps its own scripts, the CSP on the response. `requestHeaders: ({ request, nonce, dev }) => ({ "x-app-surface": surfaceOf(request) })` sets headers on the forwarded request only (`null` deletes one); `x-nonce` and the CSP cannot be overridden through it. Incoming headers pass through, so a browser can send `x-app-surface` itself: always set or delete (`null`) every trust hint the app reads. `dev` defaults to `NODE_ENV === "development"`. Pages become per-request rendered; the root layout reads `x-nonce` via `headers()`.

## `/auth-proxy`: same-origin auth service

```ts
// app/api/auth/[...path]/route.ts
export const { DELETE, GET, PATCH, POST, PUT } = createAuthProxy({
  upstream: () => publicEnv.apiUrl,
  internalUpstream: () => process.env.API_INTERNAL_URL,   // private network, optional
});
```

- Why a route handler: a `next.config` rewrite is fixed at build time; the upstream is a runtime setting. Both options are read per request.
- Forwards method, path, query and body; keeps `origin`, `cookie` and `x-forwarded-for`; drops hop-by-hop headers (`connection`, `keep-alive`, `te`, `trailer`, `upgrade`, `host`, `content-length`, `transfer-encoding`).
- Response: every `set-cookie` is kept as its own header; `content-encoding`, `content-length` and `transfer-encoding` are dropped because fetch already decoded the body.
- `redirect: "manual"`: a 3xx and its `location` reach the browser unchanged.
- Upstream down: 502 JSON `{ code: "auth.upstream_unavailable", message }`; override with `unavailable`.
- Extra headers to drop: `stripRequestHeaders`. Pass `fetch` in tests.

## `/service-worker`: installable app, update on request

```tsx
"use client";
const { updateReady, applyUpdate } = useServiceWorker({ url: "/sw.js", scope: "/station", checkEveryMs: 30 * 60_000, enabled: isProduction });
return updateReady ? <Button onClick={applyUpdate}>Update available, reload</Button> : null;
```

- A new worker installs and waits; nothing reloads until `applyUpdate()`. The first install is not an update.
- Your worker must answer `SKIP_WAITING_MESSAGE` (`{ type: "SKIP_WAITING" }`) with `self.skipWaiting()` and must not call it on install.
- Registers with `updateViaCache: "none"`; checks again when the page becomes visible and every `checkEveryMs`.
- Under Trusted Types the script URL must be same-origin (the `/csp` default policy admits it). The `/csp` policy already allows `worker-src 'self'` and `manifest-src 'self'`.
- What to cache is the host's: never cache API, auth or stream responses.
