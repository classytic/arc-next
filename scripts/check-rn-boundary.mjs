#!/usr/bin/env node
/**
 * React Native boundary gate.
 *
 * The RN-facing subpaths (listed below; README "Expo / React Native" documents the same list)
 * must run under Hermes/Metro: no DOM-only, Next-only or Node-only module may be reachable from
 * them. Over the BUILT dist, per RN subpath:
 *
 *   1. its local module closure (static + dynamic relative imports) contains no WEB_ONLY module;
 *   2. no module in that closure imports `next`, `next/*`, `react-dom`, or a `node:` builtin.
 *
 * Runtime importability without `window` / `document` is pinned by tests/runtime/rn-boundary.test.ts.
 *
 * Run after `npm run build`: node scripts/check-rn-boundary.mjs
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Subpaths a React Native (Expo) app may import. */
export const RN_SUBPATHS = [
  ".",
  "./client",
  "./api",
  "./cache",
  "./query",
  "./query-options",
  "./query-client",
  "./mutation",
  "./hooks",
  "./events",
  "./auth-gate",
  "./auth-token",
  "./auth-social",
  "./sse",
  "./ws",
  "./upload",
  "./encryption",
  "./field-encryption",
  "./react-native",
  "./presets/soft-delete",
  "./presets/history",
  "./presets/bulk",
  "./presets/slug",
  "./presets/tree",
  "./presets/search",
];

/** dist modules that are web / Next / Node only. */
const WEB_ONLY = [
  /^dist\/edge-cache\//,
  /^dist\/platform\/csp\.js$/,
  /^dist\/platform\/service-worker\.js$/,
  /^dist\/auth\/google-one-tap\.js$/,
  /^dist\/auth\/auth-proxy\.js$/,
  /^dist\/query\/devtools\.js$/,
  /^dist\/server\//,
];
const FORBIDDEN_SPECIFIER = /^(next(\/.*)?|react-dom(\/.*)?|node:.*)$/;

function closure(root, file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  let text;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    return seen;
  }
  const specs = [
    ...text.matchAll(/(?:import|export)[^'"]*?from\s*["']([^"']+)["']/g),
    ...text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
  for (const spec of specs) {
    if (spec.startsWith(".")) {
      closure(root, path.join(path.dirname(file), spec).replaceAll("\\", "/"), seen);
    }
  }
  return seen;
}

/** Code without comments (JSDoc examples mention `next/headers` and must not count). */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function bareImports(root, file) {
  let text = "";
  try {
    text = stripComments(readFileSync(path.join(root, file), "utf8"));
  } catch {
    return [];
  }
  return [
    ...text.matchAll(/(?:import|export)[^'"]*?from\s*["']([^"'.][^"']*)["']/g),
    ...text.matchAll(/import\(\s*["']([^"'.][^"']*)["']\s*\)/g),
  ].map((m) => m[1]);
}

export function checkRnBoundary(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const failures = [];
  for (const sub of RN_SUBPATHS) {
    const target = pkg.exports[sub];
    if (!target) {
      failures.push(`${sub}: listed as React Native-facing but not in package.json exports`);
      continue;
    }
    const entry = target.default.replace(/^\.\//, "");
    for (const mod of closure(root, entry)) {
      if (WEB_ONLY.some((re) => re.test(mod))) {
        failures.push(`${sub} reaches web-only module ${mod}`);
      }
      for (const spec of bareImports(root, mod)) {
        if (FORBIDDEN_SPECIFIER.test(spec)) failures.push(`${sub}: ${mod} imports "${spec}"`);
      }
    }
  }
  return failures;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  const failures = checkRnBoundary(process.cwd());
  if (failures.length > 0) {
    console.error(`\nX React Native boundary check failed (${failures.length}):\n`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(
    `OK React Native boundary - ${RN_SUBPATHS.length} RN-facing subpaths reach no web, Next or Node-only module.`,
  );
}
