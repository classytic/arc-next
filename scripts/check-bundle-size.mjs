#!/usr/bin/env node
/**
 * Bundle-size budgets per published subpath.
 *
 * Measures the gzipped size of each entry's LOCAL module closure (the
 * package code a bundler must ship when an app imports that subpath —
 * externals like react/@tanstack are excluded, they're the host's cost).
 * Budgets are hard ceilings: growing past one fails the gate until the
 * budget is consciously raised in this file (that edit IS the review).
 *
 * Run after `npm run build`: node scripts/check-bundle-size.mjs
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/**
 * Gzip budgets (bytes) per subpath — local closure, minification NOT applied
 * (dist ships readable; app bundlers minify). Sizes were captured at 0.12.0
 * and rounded up ~20% for headroom.
 */
const BUDGETS = {
  ".": 53_500, // 0.22: useResourceSync loads ./ws lazily like ./sse (51,770 B gz with the identity partition); hooks (composition layer pulls query+mutation+cache+client+api); raised 0.17: change events + shared auth gate; raised 0.18: React Native runtime (injectable EventSource, header stream auth, uuid fallback); raised 0.18: sse.ts status-classified failures + Last-Event-ID + lazy FetchEventSource loader (sse-fetch itself is a dynamic import, not in this closure); Unreleased: useRealtimeSync loads ./sse on first use (dynamic import), so sse.ts left this closure (~45.3 kB gz) and the resumable-SSE raise to 57 kB was not needed
  "./client": 19_000, // raised 0.22: resolveRequestIdentity + case-insensitive header merge (client/headers.ts), both needed so keys match the wire (18,760 B gz)
  "./api": 24_000, // raised 0.22: client.ts identity + header merge, BaseApi.identity (23,600 B gz); raised 0.18: uuid fallback + stream config in the client.ts closure
  "./cache": 6_000,
  "./query": 30_000,
  "./mutation": 21_000, // raised 0.22: client.ts identity + header merge, variable-aware optimistic key sets (20,808 B gz)
  "./hooks": 53_500, // 0.22: see "."; // raised 0.17: change events (./events) + shared auth gate (./auth-gate); raised 0.18: React Native runtime + sse.ts header-transport wiring (see "."); Unreleased: ./sse loaded lazily (see ".")
  "./query-client": 20_500, // raised 0.22: makeQueryClient + networkMode/redaction defaults, TanStack retry forms, client.ts identity + header merge (20,256 B gz); raised 0.12: timeout/jitter/Retry-After landed in the client.ts closure; raised 0.18: uuid fallback + stream config
  "./query-options": 33_500, // raised 0.22: write mutationOptions, count, preset dispatch, auth/scope context, identity resolved before the key (33,094 B gz)
  "./prefetch": 21_500, // 0.22: createCrudPrefetcher gone; streamQueries/prefetchQueries + ./query-client closure incl. client.ts identity + header merge (21,022 B gz)
  "./edge-cache": 7_500, // new subpath 0.22: edge headers, route matcher, coalesced purger; raised: path-to-regexp 6 source parser for the reserved-segment guard (5,968 B gz); raised: literal-section alternations are static and a route left matching nothing throws (7,102 B gz)
  "./edge-cache/cloudflare": 1_800, // new subpath 0.22: Cloudflare purge adapter
  "./react-native": 1_500, // new subpath 0.22: focusManager/onlineManager wiring
  "./devtools": 800, // new subpath 0.22: lazy devtools wrapper (the devtools are an optional peer chunk)
  "./query-island": 1_800, // new subpath 0.22: lazy hydration island (React only; React Query is the lazy chunk, ~1.6 kB gz)
  "./server": 22_000, // new subpath: ./client's closure + header forwarding
  "./sse": 32_000, // raised 0.22: client.ts identity + header merge (31,624 B gz); raised 0.16.0: shareAcrossTabs (BroadcastChannel leader election) landed in the sse.ts closure; raised Unreleased: resumable SSE + status / control-frame relay (~2.9 kB gz); raised Unreleased: compareCursors exactly-once delivery (G-INT-1, 30,644 B gz)
  "./sse-fetch": 3_500, // new subpath 0.18: header-capable fetch EventSource (type-only import of ./client; ./sse loads it lazily, so ./sse's budget is unaffected)
  "./tab-leader": 2_500, // new subpath 0.16.0
  "./service-worker": 2_000, // new subpath (Unreleased): register + waiting-update hook
  "./events": 2_000, // new subpath 0.17: write events for server caches
  "./auth-gate": 20_000, // new subpath 0.17: ./client's closure + the enable rule; raised 0.22: client.ts identity + header merge (19,563 B gz)
  "./auth-token": 1_500, // new subpath 0.17: bearer-token sessions (no local imports; ~0.6 kB gzip)
  "./auth-social": 5_200, // new subpath 0.22: social sign-in handoff, error intents, last method (~4.3 kB gz)
  "./google-one-tap": 7_700, // new subpath 0.22: ./auth-social's closure + the One Tap hook (~6.4 kB gz)
  "./ws": 24_000, // raised 0.16.0: shareAcrossTabs (BroadcastChannel leader election) landed in the ws.ts closure
  "./upload": 27_000,
  "./encryption": 3_000,
  "./field-encryption": 5_000,
  "./presets/soft-delete": 25_000,
  "./presets/history": 25_000,
  "./presets/bulk": 25_000,
  "./presets/slug": 25_000,
  "./presets/tree": 25_000,
  "./presets/search": 25_000,
  "./runtime": 1_500, // new subpath (Unreleased)
  "./csp": 3_000, // new subpath (Unreleased)
  "./auth-proxy": 1_800, // new subpath (Unreleased)
  "./sdk/messages": 3_200, // new subpath (Unreleased)
  "./sdk/error-capture": 1_200, // new subpath (Unreleased)
  "./sdk/errors": 22_500, // new subpath (Unreleased)
  "./sdk/transport": 23_000, // new subpath (Unreleased)
  "./sdk/download": 26_000, // new subpath (Unreleased)
  "./sdk/actions": 4_500, // new subpath (Unreleased)
  "./sdk/route": 1_200, // new subpath (Unreleased)
  "./sdk/localized": 900, // new subpath (Unreleased)
  "./sdk/resource": 30_500, // new subpath (Unreleased)
  "./sdk/hooks": 31_500, // new subpath (Unreleased)
  "./sdk/init": 69_000, // new subpath (Unreleased)
};

function localClosure(distFile, seen = new Set()) {
  if (seen.has(distFile)) return seen;
  seen.add(distFile);
  let text;
  try {
    text = readFileSync(path.join(ROOT, distFile), "utf8");
  } catch {
    return seen;
  }
  for (const m of text.matchAll(/(?:import|export)[^'"]*?from\s*["'](\.[^"']+)["']/g)) {
    localClosure(path.join(path.dirname(distFile), m[1]).replaceAll("\\", "/"), seen);
  }
  return seen;
}

function gzipClosureBytes(entry) {
  let total = 0;
  for (const mod of localClosure(entry)) {
    try {
      total += gzipSync(readFileSync(path.join(ROOT, mod))).length;
    } catch {
      // type-only chunks may not exist at runtime
    }
  }
  return total;
}

const failures = [];
const rows = [];

for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (subpath === "./package.json") continue;
  const entry = typeof target === "object" ? (target.default ?? target.import) : target;
  if (!entry) continue;
  const size = gzipClosureBytes(entry.replace(/^\.\//, ""));
  const budget = BUDGETS[subpath];
  rows.push(`${subpath.padEnd(24)} ${String(size).padStart(7)} B gz${budget ? ` / budget ${budget}` : " (no budget!)"}`);
  if (budget === undefined) {
    failures.push(`${subpath}: no budget defined - add one to scripts/check-bundle-size.mjs`);
  } else if (size > budget) {
    failures.push(`${subpath}: ${size} B gz exceeds budget ${budget} B`);
  }
}

for (const r of rows) console.log(r);
if (failures.length > 0) {
  console.error(`\nX Bundle-size check failed (${failures.length}):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`\nOK Bundle sizes within budget - ${rows.length} subpaths.`);
