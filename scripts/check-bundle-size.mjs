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
  ".": 50_000, // hooks (composition layer pulls query+mutation+cache+client+api)
  "./client": 18_000,
  "./api": 22_000,
  "./cache": 6_000,
  "./query": 30_000,
  "./mutation": 20_000,
  "./hooks": 50_000,
  "./query-client": 18_000, // raised 0.12: timeout/jitter/Retry-After landed in the client.ts closure
  "./query-options": 30_000,
  "./prefetch": 32_000,
  "./sse": 20_000,
  "./ws": 20_000,
  "./upload": 27_000,
  "./encryption": 3_000,
  "./field-encryption": 5_000,
  "./presets/soft-delete": 25_000,
  "./presets/history": 25_000,
  "./presets/bulk": 25_000,
  "./presets/slug": 25_000,
  "./presets/tree": 25_000,
  "./presets/search": 25_000,
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
